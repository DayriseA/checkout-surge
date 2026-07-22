import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BusinessOutcomeSummary,
  type ConsistencyLagSummary,
  type DemoRunSnapshot,
  demoRunSnapshotSchema,
  type ErpResilienceStatus,
  emptyHttpTimingBreakdownSummary,
  type InventoryStatus,
  type QueueStatus,
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
      httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
      loadRunDiagnosticsSummary: currentDiagnosticsFixture(1_000),
      apiRequestLifecycleSummary: currentLifecycleFixture(1_000, 750, 250),
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

  it("rejects emitted-era finalization rows when projecting transport accounting", async () => {
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
      httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
      loadRunDiagnosticsSummary: currentDiagnosticsFixture(1_000),
      apiRequestLifecycleSummary: currentLifecycleFixture(1_000, 750, 0, 250),
      trafficSummaryReceivedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      new PostgresDashboardTransportAccountingReader(db).read(legacyRunId),
    ).rejects.toThrow(new RegExp(`${legacyRunId}.*trafficDeliverySummary`));
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

  it("orders current-shape recoverable runs by start with deterministic creation and ID ties", async () => {
    const newerStart = databaseRun({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      startedAt: new Date("2026-07-14T11:00:00.000Z"),
      createdAt: new Date("2026-07-14T10:00:00.000Z"),
      updatedAt: new Date("2026-07-14T10:30:00.000Z"),
    });
    const database = controlledDatabase([newerStart]);

    const context = await new PostgresDashboardRecoveryContextReader(database.db).readContext();
    const dialect = new PgDialect();
    const orderingSql = database.orderBy.mock.calls[0]?.map(
      (expression) => dialect.sqlToQuery(expression).sql,
    );

    expect(context.currentRun?.runId).toBe(newerStart.id);
    expect(orderingSql).toEqual([
      '"demo_runs"."started_at" desc',
      '"demo_runs"."created_at" desc',
      '"demo_runs"."id" desc',
    ]);
  });

  it.each([
    ["startedAt", { startedAt: null }],
    ["saleOfferId", { saleOfferId: null }],
  ])("rejects a current run missing %s", async (field, override) => {
    const row = databaseRun(override);
    const database = controlledDatabase([row]);

    await expect(
      new PostgresDashboardRecoveryContextReader(database.db).readContext(),
    ).rejects.toThrow(new RegExp(`${row.id}.*${field}`));
  });

  it("rejects a stored config snapshot that relies on wire defaults with run context", async () => {
    const row = databaseRun();
    const config = configSnapshot();
    const { quantityPerCheckout: _defaulted, ...incompleteInventoryConfig } =
      config.inventoryConfig;
    const malformedRow = {
      ...row,
      configSnapshot: {
        ...config,
        inventoryConfig: incompleteInventoryConfig,
      } as unknown as (typeof demoRuns.$inferSelect)["configSnapshot"],
    };
    const database = controlledDatabase([malformedRow]);

    await expect(
      new PostgresDashboardRecoveryContextReader(database.db).readContext(),
    ).rejects.toThrow(
      new RegExp(`${row.id}.*configSnapshot\\.inventoryConfig\\.quantityPerCheckout`),
    );
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
          businessOutcomeReader: { read: async () => businessOutcomeFixture() },
          consistencyLagReader: { read: async () => consistencyLagFixture() },
          completionOutcomeReader: { read: async () => [] },
          inventoryStatusService: { getStatus: async () => inventoryStatusFixture() },
          queueStatusService: { getStatus: async () => queueStatusFixture() },
          erpStatusService: { getStatus: async () => erpStatusFixture() },
          trafficMetricReader: { readRecent: async () => [] },
          transportAccountingReader: { read: async () => null },
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
  const inventory = vi.fn(async () => inventoryStatusFixture());
  const business = vi.fn(async () => businessOutcomeFixture());
  const lag = options.lagError
    ? vi.fn(async () => Promise.reject(options.lagError))
    : vi.fn(async () => consistencyLagFixture());
  const completion = vi.fn(async () => []);
  const metrics = vi.fn(async () => []);
  const transportAccounting = options.transportAccountingError
    ? vi.fn(async () => Promise.reject(options.transportAccountingError))
    : vi.fn(async () => options.transportAccounting ?? null);
  const queue = vi.fn(async () => queueStatusFixture());
  const erp = vi.fn(async () => erpStatusFixture());
  const loggerWarn = vi.fn();
  const service = new DashboardRecoveryService({
    openOperation: async () => ({
      dependencies: {
        contextReader: {
          readContext: contextError
            ? async () => Promise.reject(contextError)
            : async () => context ?? { currentRun: null, saleOfferId: null },
        },
        businessOutcomeReader: { read: business },
        consistencyLagReader: { read: lag },
        completionOutcomeReader: { read: completion },
        inventoryStatusService: { getStatus: inventory },
        queueStatusService: { getStatus: queue },
        erpStatusService: { getStatus: erp },
        trafficMetricReader: { readRecent: metrics },
        transportAccountingReader: { read: transportAccounting },
      },
      close: async () => undefined,
    }),
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

function inventoryStatusFixture(): InventoryStatus {
  return {
    saleOfferId,
    allocatedStock: 10,
    remainingStock: 0,
    reservedStock: 10,
    pendingPersistenceCount: 0,
    expiredReservationCount: 0,
    oldestPendingPersistenceAgeSeconds: 0,
    reservationThroughput: {
      windowSeconds: 60,
      successfulReservationCount: 10,
      rate: 1,
      unit: "reservations_per_second",
      measuredAt: now.toISOString(),
    },
    soldOutPressure: { rejectionCount: 0, latestObservedAt: null },
    lastUpdatedAt: now.toISOString(),
  };
}

function businessOutcomeFixture(): BusinessOutcomeSummary {
  return {
    acceptedReservations: 0,
    soldOutRejections: 0,
    queuedOrders: 0,
    processingOrders: 0,
    retryingOrders: 0,
    confirmedOrders: 0,
    failedOrders: 0,
    pendingPersistenceCount: 0,
    notificationsRecorded: 0,
  };
}

function consistencyLagFixture(): ConsistencyLagSummary {
  return {
    confirmedOrderCount: 0,
    pendingConfirmationCount: 0,
    averageLagMs: null,
    p95LagMs: null,
    maxLagMs: null,
    oldestPendingAgeSeconds: null,
    measuredAt: now.toISOString(),
  };
}

function queueStatusFixture(): QueueStatus {
  return {
    name: "orders:process",
    connectivity: "reachable",
    depth: 0,
    counts: { waiting: 0, prioritized: 0, paused: 0, delayed: 0, active: 0, failed: 0 },
    oldestWaitingAgeSeconds: null,
    retryPressure: {
      inspectedJobCount: 0,
      inspectionLimit: 100,
      retryingJobCount: 0,
      retryAttemptCount: 0,
      inspectionTruncated: false,
    },
    failedJobs: { totalCount: 0, recent: [], inspectionLimit: 20, inspectionTruncated: false },
    updatedAt: now.toISOString(),
  };
}

function erpStatusFixture(): ErpResilienceStatus {
  return {
    status: "healthy",
    reason: null,
    circuit: {
      state: "closed",
      consecutiveFailureCount: 0,
      failureThreshold: 5,
      resetTimeoutMs: 10_000,
      openedAt: null,
      nextAttemptAt: null,
      halfOpenProbeInFlight: false,
      updatedAt: now.toISOString(),
    },
    retryPressure: {
      retryingJobCount: 0,
      retryAttemptCount: 0,
      inspectedJobCount: 0,
      inspectionLimit: 100,
      inspectionTruncated: false,
    },
    latestAttempt: null,
    recentAttemptWindowSeconds: 60,
    recentAttemptCount: 0,
    recentFailureCount: 0,
    recentTimeoutCount: 0,
    confirmationDelay: {
      processingOrderCount: 0,
      oldestProcessingAgeSeconds: null,
      recentConfirmedCount: 0,
      averageConfirmationDelayMs: null,
    },
    updatedAt: now.toISOString(),
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

function currentDiagnosticsFixture(plannedRequests: number) {
  return {
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    nproc: null,
    ulimitNofile: null,
    processMaxOpenFiles: null,
    networkDiagnostics: null,
    k6Version: null,
    executionPlan: {
      trafficMode: "buyer-spike" as const,
      buyerCount: plannedRequests,
      duplicateEachBuyerAttempt: false,
      iterationsPerVu: 1,
      plannedEmittedAttempts: plannedRequests,
      startDelaySeconds: 0,
      maxDurationSeconds: 2,
    },
    stderrLines: [],
    stderrLineCountObserved: 0,
    stderrLineCountRetained: 0,
    stderrRetainedLineLimit: 50 as const,
    stderrLineTruncationLength: 500 as const,
    stderrLineTruncatedCount: 0,
    terminalMetricSources: {
      startedRequests: "summary_export" as const,
      completedRequests: "summary_export" as const,
      acceptedResponses: "summary_export" as const,
      soldOutResponses: "summary_export" as const,
      unexpectedResponses: "summary_export" as const,
      droppedIterations: "summary_export" as const,
      completedIterations: "summary_export" as const,
    },
    summaryExportWarnings: [],
  };
}

function currentLifecycleFixture(
  plannedRequests: number,
  completedRequests: number,
  interruptedRequests: number,
  unstartedRequests = 0,
) {
  return {
    plannedRequests,
    startedRequests: completedRequests + interruptedRequests,
    completedRequests,
    interruptedRequests,
    unstartedRequests,
    failedRequests: 0,
  };
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
