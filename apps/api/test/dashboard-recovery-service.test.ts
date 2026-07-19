import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DemoRunSnapshot,
  demoRunSnapshotSchema,
  type TrafficDeliverySummary,
  type TrafficHttpSummary,
  type TransportAttemptCounts,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  createDatabaseConnection,
  demoPresets,
  demoRunFinalizations,
  demoRuns,
  products,
  saleOffers,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DashboardRecoveryService,
  PostgresDashboardRecoveryContextReader,
  PostgresDashboardTransportAccountingReader,
} from "../src/services/dashboard-recovery-service.js";

const now = new Date("2026-07-14T12:00:00.000Z");
const runId = "11111111-1111-4111-8111-111111111111";
const saleOfferId = "22222222-2222-4222-8222-222222222222";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsFolder = path.resolve(packageRoot, "../../packages/db/drizzle");

describe("PostgresDashboardRecoveryContextReader integration", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;

  beforeAll(async () => {
    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    await connection.db.insert(products).values({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sku: "RECOVERY-CATALOG",
      slug: "recovery-catalog",
      name: "Recovery catalog product",
    });
    await connection.db.insert(saleOffers).values({
      id: saleOfferId,
      productId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Active catalog offer",
      allocatedStock: 10,
      saleStartsAt: new Date("2026-07-14T00:00:00.000Z"),
      saleEndsAt: new Date("2026-07-15T00:00:00.000Z"),
      isActive: true,
      purpose: "catalog",
    });
    await connection.db.insert(demoPresets).values({
      id: "33333333-3333-4333-8333-333333333333",
      slug: "recovery-transport-accounting",
      visibility: "admin",
      isEditable: true,
      display: {
        name: "Recovery transport accounting",
        description: "Transport accounting projection fixture.",
        sortOrder: 1,
        outcomeFocus: [],
      },
      ...configSnapshot(),
    });
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("does not turn an active in-window catalog offer into recovery scope", async () => {
    if (!connection) throw new Error("Test database connection was not initialized.");

    await expect(
      new PostgresDashboardRecoveryContextReader(connection.db).readContext(),
    ).resolves.toEqual({ currentRun: null, saleOfferId: null });
  });

  it("projects canonical transport accounting from persisted completion evidence", async () => {
    if (!connection) throw new Error("Test database connection was not initialized.");
    const db = connection.db;
    await db.insert(demoRuns).values({
      id: runId,
      presetId: "33333333-3333-4333-8333-333333333333",
      presetName: "Preview 1k",
      operatorMode: "public",
      status: "draining",
      trafficStatus: "succeeded",
      saleOfferId,
      configSnapshot: configSnapshot(),
      startedAt: now,
      trafficStartedAt: now,
      trafficEndedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(demoRunFinalizations).values({
      runId,
      exitCode: 0,
      httpSummary: {
        plannedRequests: 1_000,
        startedRequests: 1_000,
        completedRequests: 750,
        interruptedRequests: 250,
        unstartedRequests: 0,
        failedRequests: 0,
        acceptedResponses: 250,
        soldOutResponses: 500,
        unexpectedResponses: 0,
        failureRate: 0,
      },
      trafficOutcomeSummary: {},
      trafficDeliverySummary: {
        plannedRequests: 1_000,
        startedRequests: 1_000,
        completedRequests: 750,
        interruptedRequests: 250,
        unstartedRequests: 0,
        trafficMode: "buyer-spike",
        plannedBuyers: 1_000,
        scheduledRatePerSecond: null,
        configuredDurationSeconds: null,
        preAllocatedVUs: null,
        maxVUs: null,
        droppedIterations: 0,
        completedIterations: 750,
        trafficDeliveryStatus: "complete",
        notes: [],
      },
      httpTimingBreakdownSummary: {},
      loadRunDiagnosticsSummary: {},
      apiRequestLifecycleSummary: {},
      trafficSummaryReceivedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const reader = new PostgresDashboardTransportAccountingReader(db);

    await expect(reader.read(runId)).resolves.toEqual({
      plannedRequests: 1_000,
      startedRequests: 1_000,
      completedRequests: 750,
      interruptedRequests: 250,
      unstartedRequests: 0,
    });
    await expect(reader.read("99999999-9999-4999-8999-999999999999")).resolves.toBeNull();
  });

  it("normalizes legacy emitted-era finalization rows when projecting transport accounting", async () => {
    if (!connection) throw new Error("Test database connection was not initialized.");
    const db = connection.db;
    const legacyRunId = "44444444-4444-4444-8444-444444444444";
    await db.insert(demoRuns).values({
      id: legacyRunId,
      presetId: "33333333-3333-4333-8333-333333333333",
      presetName: "Preview 1k",
      operatorMode: "public",
      status: "failed",
      trafficStatus: "failed",
      saleOfferId: null,
      configSnapshot: configSnapshot(),
      startedAt: now,
      trafficStartedAt: now,
      trafficEndedAt: now,
      finalizedAt: now,
      failureReason: "legacy_traffic_failure",
      createdAt: now,
      updatedAt: now,
    });
    const legacyDeliverySummary = {
      plannedRequests: 1_000,
      emittedRequests: 750,
      trafficMode: "buyer-spike",
      plannedBuyers: 1_000,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: 750,
      unstartedIterations: 250,
      requestShortfall: 250,
      notes: [],
    } as unknown as TrafficDeliverySummary;
    const legacyHttpSummary = {
      plannedRequests: 1_000,
      emittedRequests: 750,
      completedRequests: 750,
      failedRequests: 0,
      acceptedResponses: 250,
      soldOutResponses: 500,
      unexpectedResponses: 0,
      failureRate: 0,
    } as unknown as TrafficHttpSummary;
    await db.insert(demoRunFinalizations).values({
      runId: legacyRunId,
      exitCode: 1,
      httpSummary: legacyHttpSummary,
      trafficOutcomeSummary: {},
      trafficDeliverySummary: legacyDeliverySummary,
      httpTimingBreakdownSummary: {},
      loadRunDiagnosticsSummary: {},
      apiRequestLifecycleSummary: {},
      trafficSummaryReceivedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // The old producer never recorded interrupted traffic: legacy rows map to
    // started = old emitted, completed = old emitted, interrupted = 0.
    await expect(
      new PostgresDashboardTransportAccountingReader(db).read(legacyRunId),
    ).resolves.toEqual({
      plannedRequests: 1_000,
      startedRequests: 750,
      completedRequests: 750,
      interruptedRequests: 0,
      unstartedRequests: 250,
    });
  });
});

describe("PostgresDashboardRecoveryContextReader", () => {
  it("returns no scope after the recoverable-run query finds no row", async () => {
    const database = controlledDatabase([]);

    await expect(
      new PostgresDashboardRecoveryContextReader(database.db).readContext(),
    ).resolves.toEqual({ currentRun: null, saleOfferId: null });
    expect(database.select).toHaveBeenCalledTimes(1);
  });

  it("orders recoverable runs by effective start with deterministic creation and ID ties", async () => {
    const newerEffectiveStart = databaseRun({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      startedAt: new Date("2026-07-14T11:00:00.000Z"),
      createdAt: new Date("2026-07-14T10:00:00.000Z"),
      updatedAt: new Date("2026-07-14T10:30:00.000Z"),
    });
    const database = controlledDatabase([newerEffectiveStart]);

    const context = await new PostgresDashboardRecoveryContextReader(database.db).readContext();
    const dialect = new PgDialect();
    const orderingSql = database.orderBy.mock.calls[0]?.map(
      (expression) => dialect.sqlToQuery(expression).sql,
    );

    expect(context.currentRun?.runId).toBe(newerEffectiveStart.id);
    expect(orderingSql).toEqual([
      'coalesce("demo_runs"."started_at", "demo_runs"."created_at") desc',
      '"demo_runs"."created_at" desc',
      '"demo_runs"."id" desc',
    ]);
  });
});

describe("DashboardRecoveryService", () => {
  it("skips every run-owned port without a current run while retaining global health", async () => {
    const harness = serviceHarness({ currentRun: null, saleOfferId: saleOfferId });

    const recovery = await harness.service.getRecovery({ correlationId: "corr-no-run" });

    expect(recovery).toMatchObject({
      correlationId: "corr-no-run",
      scope: null,
      currentRun: null,
      inventory: null,
      businessOutcome: null,
      consistencyLag: null,
      recentCompletionOutcomes: [],
      recentMetrics: [],
      transportAccounting: null,
      recoveredAt: now.toISOString(),
    });
    expect(harness.inventory).not.toHaveBeenCalled();
    expect(harness.business).not.toHaveBeenCalled();
    expect(harness.lag).not.toHaveBeenCalled();
    expect(harness.completion).not.toHaveBeenCalled();
    expect(harness.metrics).not.toHaveBeenCalled();
    expect(harness.transportAccounting).not.toHaveBeenCalled();
    expect(harness.queue).toHaveBeenCalledOnce();
    expect(harness.erp).toHaveBeenCalledOnce();
  });

  it("passes one selected run scope and one captured time to every owned projection", async () => {
    const currentRun = runSnapshot();
    const harness = serviceHarness({ currentRun, saleOfferId });

    const recovery = await harness.service.getRecovery({ correlationId: "corr-scoped" });

    const expectedScope = { runId, saleOfferId };
    expect(recovery.scope).toEqual(expectedScope);
    expect(harness.inventory).toHaveBeenCalledWith(saleOfferId);
    expect(harness.business).toHaveBeenCalledWith(expectedScope);
    expect(harness.lag).toHaveBeenCalledWith(expectedScope, now);
    expect(harness.completion).toHaveBeenCalledWith(expectedScope, now);
    expect(harness.metrics).toHaveBeenCalledWith(runId);
    expect(recovery.recoveredAt).toBe(now.toISOString());
  });

  it("keeps a legacy run without an offer visible and reads only its run-ID metrics", async () => {
    const currentRun = runSnapshot({ saleOfferId: undefined });
    const harness = serviceHarness({ currentRun, saleOfferId: null });

    const recovery = await harness.service.getRecovery({ correlationId: "corr-legacy" });

    expect(recovery.scope).toEqual({ runId, saleOfferId: null });
    expect(recovery.currentRun?.runId).toBe(runId);
    expect(harness.metrics).toHaveBeenCalledWith(runId);
    expect(harness.inventory).not.toHaveBeenCalled();
    expect(harness.business).not.toHaveBeenCalled();
    expect(harness.lag).not.toHaveBeenCalled();
    expect(harness.completion).not.toHaveBeenCalled();
  });

  it("degrades context failure to no scope and warns without invoking run-owned ports", async () => {
    const contextError = new Error("context unavailable");
    const harness = serviceHarness(null, contextError);

    const recovery = await harness.service.getRecovery({ correlationId: "corr-context-failure" });

    expect(recovery.scope).toBeNull();
    expect(recovery.currentRun).toBeNull();
    expect(harness.metrics).not.toHaveBeenCalled();
    expect(harness.loggerWarn).toHaveBeenCalledWith(
      { err: contextError, projection: "dashboard_run_context" },
      "Dashboard recovery projection unavailable.",
    );
  });

  it("degrades one scoped projection without losing the selected scope", async () => {
    const projectionError = new Error("lag unavailable");
    const harness = serviceHarness({ currentRun: runSnapshot(), saleOfferId }, undefined, {
      lagError: projectionError,
    });

    const recovery = await harness.service.getRecovery({ correlationId: "corr-lag-failure" });

    expect(recovery.scope).toEqual({ runId, saleOfferId });
    expect(recovery.currentRun?.runId).toBe(runId);
    expect(recovery.consistencyLag).toBeNull();
    expect(harness.business).toHaveBeenCalledOnce();
    expect(harness.loggerWarn).toHaveBeenCalledWith(
      { err: projectionError, projection: "dashboard_consistency_lag" },
      "Dashboard recovery projection unavailable.",
    );
  });

  it("exposes canonical transport accounting once traffic completion evidence exists", async () => {
    const counts = {
      plannedRequests: 1_000,
      startedRequests: 1_000,
      completedRequests: 750,
      interruptedRequests: 250,
      unstartedRequests: 0,
    };
    const harness = serviceHarness({ currentRun: runSnapshot(), saleOfferId }, undefined, {
      transportAccounting: counts,
    });

    const recovery = await harness.service.getRecovery({ correlationId: "corr-draining" });

    expect(harness.transportAccounting).toHaveBeenCalledWith(runId);
    expect(recovery.transportAccounting).toEqual(counts);
  });

  it("keeps transport accounting null while no completion evidence is available", async () => {
    const harness = serviceHarness({ currentRun: runSnapshot(), saleOfferId }, undefined, {
      transportAccounting: null,
    });

    const recovery = await harness.service.getRecovery({ correlationId: "corr-active" });

    expect(harness.transportAccounting).toHaveBeenCalledWith(runId);
    expect(recovery.transportAccounting).toBeNull();
  });

  it("degrades a transport accounting read failure to null without losing the scope", async () => {
    const projectionError = new Error("transport accounting unavailable");
    const harness = serviceHarness({ currentRun: runSnapshot(), saleOfferId }, undefined, {
      transportAccountingError: projectionError,
    });

    const recovery = await harness.service.getRecovery({ correlationId: "corr-ta-failure" });

    expect(recovery.scope).toEqual({ runId, saleOfferId });
    expect(recovery.transportAccounting).toBeNull();
    expect(harness.loggerWarn).toHaveBeenCalledWith(
      { err: projectionError, projection: "dashboard_transport_accounting" },
      "Dashboard recovery projection unavailable.",
    );
  });

  it("settles a never-ending projection on abort and closes operation resources", async () => {
    const close = vi.fn();
    const controller = new AbortController();
    const service = new DashboardRecoveryService({
      openOperation: async () => ({
        dependencies: {
          contextReader: { readContext: async () => await new Promise<never>(() => undefined) },
          businessOutcomeReader: { read: async () => null } as never,
          consistencyLagReader: { read: async () => null } as never,
          completionOutcomeReader: { read: async () => [] },
          inventoryStatusService: { getStatus: async () => null } as never,
          queueStatusService: { getStatus: async () => null } as never,
          erpStatusService: { getStatus: async () => null } as never,
        },
        close,
      }),
      logger: { warn: vi.fn() } as never,
    });
    const recovery = service.getRecovery({
      correlationId: "corr-abandoned",
      signal: controller.signal,
    });

    controller.abort(new Error("client disconnected"));

    await expect(recovery).rejects.toThrow("client disconnected");
    expect(close).toHaveBeenCalledOnce();
  });
});

function controlledDatabase(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const orderBy = vi.fn((..._expressions: SQL[]) => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as unknown as CheckoutSurgeDatabase, select, orderBy };
}

function databaseRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: runId,
    presetId: "33333333-3333-4333-8333-333333333333",
    presetName: "Preview 1k",
    operatorMode: "public",
    status: "active",
    trafficStatus: "active",
    configSnapshot: configSnapshot(),
    saleOfferId,
    startedAt: now,
    trafficStartedAt: now,
    trafficEndedAt: null,
    finalizedAt: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function serviceHarness(
  context: { currentRun: DemoRunSnapshot | null; saleOfferId: string | null } | null,
  contextError?: Error,
  options: {
    lagError?: Error;
    transportAccounting?: TransportAttemptCounts | null;
    transportAccountingError?: Error;
  } = {},
) {
  const inventory = vi.fn(async () => null);
  const business = vi.fn(async () => null);
  const lag = options.lagError
    ? vi.fn(async () => Promise.reject(options.lagError))
    : vi.fn(async () => null);
  const completion = vi.fn(async () => []);
  const metrics = vi.fn(async () => []);
  const transportAccounting = options.transportAccountingError
    ? vi.fn(async () => Promise.reject(options.transportAccountingError))
    : vi.fn(async () => options.transportAccounting ?? null);
  const queue = vi.fn(async () => null);
  const erp = vi.fn(async () => null);
  const loggerWarn = vi.fn();
  const service = new DashboardRecoveryService({
    contextReader: {
      readContext: contextError
        ? async () => Promise.reject(contextError)
        : async () => context ?? { currentRun: null, saleOfferId: null },
    },
    businessOutcomeReader: { read: business } as never,
    consistencyLagReader: { read: lag } as never,
    completionOutcomeReader: { read: completion } as never,
    inventoryStatusService: { getStatus: inventory } as never,
    queueStatusService: { getStatus: queue } as never,
    erpStatusService: { getStatus: erp } as never,
    trafficMetricReader: { readRecent: metrics },
    transportAccountingReader: { read: transportAccounting },
    logger: { warn: loggerWarn } as never,
    now: () => now,
  });
  return {
    service,
    inventory,
    business,
    lag,
    completion,
    metrics,
    transportAccounting,
    queue,
    erp,
    loggerWarn,
  };
}

function runSnapshot(overrides: Partial<DemoRunSnapshot> = {}): DemoRunSnapshot {
  return demoRunSnapshotSchema.parse({
    runId,
    presetId: "33333333-3333-4333-8333-333333333333",
    presetName: "Preview 1k",
    operatorMode: "public",
    status: "active",
    trafficStatus: "active",
    saleOfferId,
    configSnapshot: configSnapshot(),
    startedAt: now.toISOString(),
    trafficStartedAt: now.toISOString(),
    ...overrides,
  });
}

function configSnapshot() {
  return {
    trafficConfig: {
      mode: "buyer-spike" as const,
      buyerCount: 1000,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 2,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 250,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 80,
      maxTps: 250,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 2000,
    },
    backpressureConfig: {
      queueName: "orders:process" as const,
      physicalQueueName: "orders-process" as const,
      orderProcessConcurrency: 5,
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
    },
  };
}

function requireTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for API tests.");
  return databaseUrl;
}
