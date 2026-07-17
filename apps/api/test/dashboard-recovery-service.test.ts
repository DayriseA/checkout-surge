import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DemoRunSnapshot,
  demoRunSnapshotSchema,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  createDatabaseConnection,
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
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("does not turn an active in-window catalog offer into recovery scope", async () => {
    if (!connection) throw new Error("Test database connection was not initialized.");

    await expect(new PostgresDashboardRecoveryContextReader(connection.db).readContext()).resolves.toEqual(
      { currentRun: null, saleOfferId: null },
    );
  });
});

describe("PostgresDashboardRecoveryContextReader", () => {
  it("returns no scope after the recoverable-run query finds no row", async () => {
    const database = controlledDatabase([]);

    await expect(new PostgresDashboardRecoveryContextReader(database.db).readContext()).resolves.toEqual(
      { currentRun: null, saleOfferId: null },
    );
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
      recoveredAt: now.toISOString(),
    });
    expect(harness.inventory).not.toHaveBeenCalled();
    expect(harness.business).not.toHaveBeenCalled();
    expect(harness.lag).not.toHaveBeenCalled();
    expect(harness.completion).not.toHaveBeenCalled();
    expect(harness.metrics).not.toHaveBeenCalled();
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
  options: { lagError?: Error } = {},
) {
  const inventory = vi.fn(async () => null);
  const business = vi.fn(async () => null);
  const lag = options.lagError
    ? vi.fn(async () => Promise.reject(options.lagError))
    : vi.fn(async () => null);
  const completion = vi.fn(async () => []);
  const metrics = vi.fn(async () => []);
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
