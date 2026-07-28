import {
  type ConsistencyLagSummary,
  type DemoRunSnapshot,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
  dashboardProjectionScopeId,
  demoRunSnapshotSchema,
  type ErpResilienceStatus,
  emptyHttpTimingBreakdownSummary,
  type InventoryStatus,
  type QueueStatus,
  type TransportAttemptCounts,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture as configSnapshot } from "@checkout-surge/contracts/testing";
import {
  type CheckoutSurgeDatabase,
  createDatabaseConnection,
  demoPresets,
  demoRunFinalizations,
  demoRuns,
  products,
  saleOffers,
} from "@checkout-surge/db";
import { requireTestDatabaseUrl, resetTestDatabase } from "@checkout-surge/db/testing";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DashboardProjectionService,
  PostgresDashboardRecoveryContextReader,
  PostgresDashboardTransportObservationReader,
} from "../src/services/dashboard-recovery-service.js";
import { emptyBusinessOutcomeSummary as businessOutcomeFixture } from "../src/services/demo-run-projections.js";

const now = new Date("2026-07-14T12:00:00.000Z");
const runId = "11111111-1111-4111-8111-111111111111";
const saleOfferId = "22222222-2222-4222-8222-222222222222";

describe("PostgresDashboardRecoveryContextReader integration", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;

  beforeAll(async () => {
    await resetTestDatabase();
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
      transportAttemptCounts: {
        plannedRequests: 1_000,
        startedRequests: 1_000,
        completedRequests: 750,
        interruptedRequests: 250,
        unstartedRequests: 0,
      },
      httpSummary: {
        failedRequests: 0,
        acceptedResponses: 250,
        soldOutResponses: 500,
        transportFailures: 0,
        unexpectedResponses: 0,
        failureRate: 0,
      },
      trafficOutcomeSummary: {},
      trafficDeliverySummary: {
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
      trafficSummaryReceivedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const reader = new PostgresDashboardTransportObservationReader(db);

    await expect(reader.read(runId)).resolves.toEqual({
      transportAttemptCounts: {
        plannedRequests: 1_000,
        startedRequests: 1_000,
        completedRequests: 750,
        interruptedRequests: 250,
        unstartedRequests: 0,
      },
      httpSummary: {
        failedRequests: 0,
        acceptedResponses: 250,
        soldOutResponses: 500,
        transportFailures: 0,
        unexpectedResponses: 0,
        failureRate: 0,
      },
    });
    await expect(reader.read("99999999-9999-4999-8999-999999999999")).resolves.toBeNull();
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

  it("prefers the current nonterminal run over a requested known terminal fallback", async () => {
    const knownRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const knownTerminal = databaseRun({
      id: knownRunId,
      status: "completed",
      trafficStatus: "succeeded",
      trafficEndedAt: now,
      finalizedAt: now,
    });
    const current = databaseRun();
    const database = controlledDatabase([knownTerminal, current]);

    const context = await new PostgresDashboardRecoveryContextReader(database.db).readContext(
      undefined,
      { runId: knownRunId, saleOfferId },
    );

    expect(context.currentRun?.runId).toBe(runId);
    expect(database.select).toHaveBeenCalledOnce();
  });

  it("prefers a current run when a known hint reuses its run ID with the wrong sale offer", async () => {
    const current = databaseRun();
    const database = controlledDatabase([current]);

    const context = await new PostgresDashboardRecoveryContextReader(database.db).readContext(
      undefined,
      {
        runId,
        saleOfferId: "99999999-9999-4999-8999-999999999999",
      },
    );

    expect(context.currentRun?.runId).toBe(runId);
    expect(context.saleOfferId).toBe(saleOfferId);
    expect(database.select).toHaveBeenCalledOnce();
  });

  it("falls back to only the explicitly known terminal run without promoting other history", async () => {
    const knownRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const knownTerminal = databaseRun({
      id: knownRunId,
      status: "failed",
      trafficStatus: "failed",
      trafficEndedAt: now,
      finalizedAt: now,
      failureReason: "terminal test",
    });
    const database = controlledDatabase([knownTerminal]);

    const context = await new PostgresDashboardRecoveryContextReader(database.db).readContext(
      undefined,
      { runId: knownRunId, saleOfferId },
    );

    expect(context.currentRun).toMatchObject({ runId: knownRunId, status: "failed" });
    expect(context.saleOfferId).toBe(saleOfferId);
    const dialect = new PgDialect();
    const selectionQuery = dialect.sqlToQuery(database.where.mock.calls[0]?.[0] as SQL);
    expect(selectionQuery.sql).toContain('"demo_runs"."id" =');
    expect(selectionQuery.sql).toContain('"demo_runs"."sale_offer_id" =');
    expect(selectionQuery.params).toContain(knownRunId);
    expect(selectionQuery.params).toContain(saleOfferId);
    expect(database.select).toHaveBeenCalledOnce();
  });

  it("treats a mismatched known terminal run and sale-offer pair as an idle advisory hint", async () => {
    const knownRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const mismatchedTerminal = databaseRun({
      id: knownRunId,
      status: "completed",
      trafficStatus: "succeeded",
      trafficEndedAt: now,
      finalizedAt: now,
    });
    const database = controlledDatabase([mismatchedTerminal]);

    await expect(
      new PostgresDashboardRecoveryContextReader(database.db).readContext(undefined, {
        runId: knownRunId,
        saleOfferId: "99999999-9999-4999-8999-999999999999",
      }),
    ).resolves.toEqual({ currentRun: null, saleOfferId: null });
    expect(database.select).toHaveBeenCalledOnce();
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

describe("DashboardProjectionService", () => {
  it("skips every run-owned port without a current run while retaining global health", async () => {
    const harness = serviceHarness({ currentRun: null, saleOfferId: null });

    const recovery = await harness.service.build({ correlationId: "corr-no-run" });

    expect(recovery).toMatchObject({
      schema: dashboardProjectionSchemaName,
      version: dashboardProjectionSchemaVersion,
      correlationId: "corr-no-run",
      scopeId: dashboardProjectionScopeId(null),
      revision: 1,
      scope: null,
      currentRun: null,
      inventory: null,
      businessOutcome: null,
      consistencyLag: null,
      recentCompletionOutcomes: [],
      recentMetrics: [],
      transportAttemptCounts: null,
      recoveredAt: now.toISOString(),
    });
    expect(harness.inventory).not.toHaveBeenCalled();
    expect(harness.business).not.toHaveBeenCalled();
    expect(harness.lag).not.toHaveBeenCalled();
    expect(harness.completion).not.toHaveBeenCalled();
    expect(harness.metrics).not.toHaveBeenCalled();
    expect(harness.transportAttemptCounts).not.toHaveBeenCalled();
    expect(harness.queue).toHaveBeenCalledOnce();
    expect(harness.erp).toHaveBeenCalledOnce();
  });

  it("passes one selected run scope and one captured time to every owned projection", async () => {
    const currentRun = runSnapshot();
    const harness = serviceHarness({ currentRun, saleOfferId });

    const recovery = await harness.service.build({ correlationId: "corr-scoped" });

    const expectedScope = { runId, saleOfferId };
    expect(recovery.scope).toEqual(expectedScope);
    expect(recovery.scopeId).toBe(dashboardProjectionScopeId(expectedScope));
    expect(recovery.revision).toBe(1);
    expect(harness.inventory).toHaveBeenCalledWith(saleOfferId);
    expect(harness.business).toHaveBeenCalledWith(expectedScope);
    expect(harness.lag).toHaveBeenCalledWith(expectedScope, now);
    expect(harness.completion).toHaveBeenCalledWith(expectedScope, now);
    expect(harness.metrics).toHaveBeenCalledWith(runId);
    expect(recovery.recoveredAt).toBe(now.toISOString());
  });

  it("builds the same complete schema for an explicitly selected terminal live scope", async () => {
    const terminalRun = runSnapshot({
      status: "completed",
      trafficStatus: "succeeded",
      trafficEndedAt: now.toISOString(),
      finalizedAt: now.toISOString(),
    });
    const harness = serviceHarness({ currentRun: terminalRun, saleOfferId });

    const projection = await harness.service.build({
      correlationId: "corr-terminal-live",
      scope: { runId, saleOfferId },
    });

    expect(projection.currentRun).toMatchObject({
      runId,
      saleOfferId,
      status: "completed",
      finalizedAt: now.toISOString(),
    });
    expect(projection.scopeId).toBe(dashboardProjectionScopeId({ runId, saleOfferId }));
  });

  it("passes a known recovery scope as a fallback rather than an exact live selection", async () => {
    const readContext = vi.fn(async () => ({
      currentRun: runSnapshot({
        status: "completed",
        trafficStatus: "succeeded",
        trafficEndedAt: now.toISOString(),
        finalizedAt: now.toISOString(),
      }),
      saleOfferId,
    }));
    const harness = serviceHarness({ currentRun: null, saleOfferId: null }, undefined, {
      contextReader: readContext,
    });
    const knownScope = { runId, saleOfferId };

    const projection = await harness.service.build({
      correlationId: "corr-known-terminal",
      knownScope,
    });

    expect(readContext).toHaveBeenCalledWith(undefined, knownScope);
    expect(projection.currentRun?.status).toBe("completed");
  });

  it("rejects context failure, closes resources, and does not allocate a revision", async () => {
    const contextError = new Error("context unavailable");
    const harness = serviceHarness(null, contextError);

    await expect(harness.service.build({ correlationId: "corr-context-failure" })).rejects.toBe(
      contextError,
    );

    expect(harness.inventory).not.toHaveBeenCalled();
    expect(harness.business).not.toHaveBeenCalled();
    expect(harness.lag).not.toHaveBeenCalled();
    expect(harness.completion).not.toHaveBeenCalled();
    expect(harness.metrics).not.toHaveBeenCalled();
    expect(harness.transportAttemptCounts).not.toHaveBeenCalled();
    expect(harness.queue).not.toHaveBeenCalled();
    expect(harness.erp).not.toHaveBeenCalled();
    expect(harness.allocateRevision).not.toHaveBeenCalled();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.loggerWarn).not.toHaveBeenCalled();
  });

  it("rejects an incoherent selected context before reading projections or allocating", async () => {
    const harness = serviceHarness({ currentRun: runSnapshot(), saleOfferId: null });

    await expect(
      harness.service.build({ correlationId: "corr-incoherent-context" }),
    ).rejects.toThrow(/context must select a run and sale offer together/i);

    expect(harness.inventory).not.toHaveBeenCalled();
    expect(harness.queue).not.toHaveBeenCalled();
    expect(harness.allocateRevision).not.toHaveBeenCalled();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("degrades one scoped projection without losing the selected scope", async () => {
    const projectionError = new Error("lag unavailable");
    const harness = serviceHarness({ currentRun: runSnapshot(), saleOfferId }, undefined, {
      lagError: projectionError,
    });

    const recovery = await harness.service.build({ correlationId: "corr-lag-failure" });

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
      transportAttemptCounts: counts,
    });

    const recovery = await harness.service.build({ correlationId: "corr-draining" });

    expect(harness.transportAttemptCounts).toHaveBeenCalledWith(runId);
    expect(recovery.transportAttemptCounts).toEqual(counts);
    expect(recovery.httpSummary).toEqual(dashboardHttpSummaryFixture());
  });

  it("keeps transport accounting null while no completion evidence is available", async () => {
    const harness = serviceHarness({ currentRun: runSnapshot(), saleOfferId }, undefined, {
      transportAttemptCounts: null,
    });

    const recovery = await harness.service.build({ correlationId: "corr-active" });

    expect(harness.transportAttemptCounts).toHaveBeenCalledWith(runId);
    expect(recovery.transportAttemptCounts).toBeNull();
    expect(recovery.httpSummary).toBeNull();
  });

  it("degrades a transport accounting read failure to null without losing the scope", async () => {
    const projectionError = new Error("transport accounting unavailable");
    const harness = serviceHarness({ currentRun: runSnapshot(), saleOfferId }, undefined, {
      transportAttemptCountsError: projectionError,
    });

    const recovery = await harness.service.build({ correlationId: "corr-ta-failure" });

    expect(recovery.scope).toEqual({ runId, saleOfferId });
    expect(recovery.transportAttemptCounts).toBeNull();
    expect(recovery.httpSummary).toBeNull();
    expect(harness.loggerWarn).toHaveBeenCalledWith(
      { err: projectionError, projection: "dashboard_transport_observation" },
      "Dashboard recovery projection unavailable.",
    );
  });

  it("serializes coherent builds before allocating their scoped revisions", async () => {
    let contextReadCount = 0;
    let releaseFirstRead!: () => void;
    let markFirstReadStarted!: () => void;
    const firstReadBlocked = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve;
    });
    const harness = serviceHarness({ currentRun: runSnapshot(), saleOfferId }, undefined, {
      contextReader: async () => {
        contextReadCount += 1;
        if (contextReadCount === 1) {
          markFirstReadStarted();
          await firstReadBlocked;
        }
        return { currentRun: runSnapshot(), saleOfferId };
      },
    });
    const first = harness.service.build({ correlationId: "first", scope: { runId, saleOfferId } });

    await firstReadStarted;
    const second = harness.service.build({
      correlationId: "second",
      scope: { runId, saleOfferId },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(contextReadCount).toBe(1);

    releaseFirstRead();
    const [firstProjection, secondProjection] = await Promise.all([first, second]);
    expect(firstProjection.revision).toBe(1);
    expect(secondProjection.revision).toBe(2);
    expect(contextReadCount).toBe(2);
  });

  it("settles a never-ending projection on abort and closes operation resources", async () => {
    const close = vi.fn();
    const controller = new AbortController();
    let markOpened!: () => void;
    const opened = new Promise<void>((resolve) => {
      markOpened = resolve;
    });
    const service = new DashboardProjectionService({
      openOperation: async () => {
        markOpened();
        return {
          dependencies: {
            contextReader: { readContext: async () => await new Promise<never>(() => undefined) },
            businessOutcomeReader: { read: async () => businessOutcomeFixture() },
            consistencyLagReader: { read: async () => consistencyLagFixture() },
            completionOutcomeReader: { read: async () => [] },
            inventoryStatusService: { getStatus: async () => inventoryStatusFixture() },
            queueStatusService: { getStatus: async () => queueStatusFixture() },
            erpStatusService: { getStatus: async () => erpStatusFixture() },
            trafficMetricReader: { readRecent: async () => [] },
            transportObservationReader: { read: async () => null },
            revisionAllocator: { allocate: async () => 1 },
          },
          close,
        };
      },
      logger: { warn: vi.fn() } as never,
    });
    const recovery = service.build({
      correlationId: "corr-abandoned",
      signal: controller.signal,
    });

    await opened;
    controller.abort(new Error("client disconnected"));

    await expect(recovery).rejects.toThrow("client disconnected");
    expect(close).toHaveBeenCalledOnce();
  });

  it("settles an aborted caller while keeping later assembly behind actual cleanup", async () => {
    const controller = new AbortController();
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let operationCount = 0;
    const service = new DashboardProjectionService({
      openOperation: async () => {
        operationCount += 1;
        return {
          dependencies: projectionDependencies({
            readContext:
              operationCount === 1
                ? async () => await new Promise<never>(() => undefined)
                : async () => ({ currentRun: null, saleOfferId: null }),
          }),
          close: operationCount === 1 ? async () => await cleanupGate : vi.fn(),
        };
      },
      logger: { warn: vi.fn() } as never,
      now: () => now,
    });
    const first = service.build({
      correlationId: "corr-abandoned-cleanup",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(operationCount).toBe(1));

    controller.abort(new Error("publication deadline"));
    await expect(first).rejects.toThrow("publication deadline");

    const second = service.build({ correlationId: "corr-after-abort" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(operationCount).toBe(1);

    releaseCleanup();
    await expect(second).resolves.toMatchObject({
      correlationId: "corr-after-abort",
      scope: null,
    });
    expect(operationCount).toBe(2);
  });
});

function controlledDatabase(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const orderBy = vi.fn((..._expressions: SQL[]) => ({ limit }));
  const where = vi.fn((_expression: SQL) => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as unknown as CheckoutSurgeDatabase, select, where, orderBy };
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

function projectionDependencies(options: {
  readContext: () => Promise<{
    currentRun: DemoRunSnapshot | null;
    saleOfferId: string | null;
  }>;
}) {
  return {
    contextReader: { readContext: options.readContext },
    businessOutcomeReader: { read: async () => businessOutcomeFixture() },
    consistencyLagReader: { read: async () => consistencyLagFixture() },
    completionOutcomeReader: { read: async () => [] },
    inventoryStatusService: { getStatus: async () => inventoryStatusFixture() },
    queueStatusService: { getStatus: async () => queueStatusFixture() },
    erpStatusService: { getStatus: async () => erpStatusFixture() },
    trafficMetricReader: { readRecent: async () => [] },
    transportObservationReader: { read: async () => null },
    revisionAllocator: { allocate: async () => 1 },
  };
}

function serviceHarness(
  context: { currentRun: DemoRunSnapshot | null; saleOfferId: string | null } | null,
  contextError?: Error,
  options: {
    contextReader?: () => Promise<{
      currentRun: DemoRunSnapshot | null;
      saleOfferId: string | null;
    }>;
    lagError?: Error;
    transportAttemptCounts?: TransportAttemptCounts | null;
    transportAttemptCountsError?: Error;
  } = {},
) {
  const inventory = vi.fn(async () => inventoryStatusFixture());
  const business = vi.fn(async () => businessOutcomeFixture());
  const lag = options.lagError
    ? vi.fn(async () => Promise.reject(options.lagError))
    : vi.fn(async () => consistencyLagFixture());
  const completion = vi.fn(async () => []);
  const metrics = vi.fn(async () => []);
  const transportAttemptCounts = options.transportAttemptCountsError
    ? vi.fn(async () => Promise.reject(options.transportAttemptCountsError))
    : vi.fn(async () =>
        options.transportAttemptCounts
          ? {
              transportAttemptCounts: options.transportAttemptCounts,
              httpSummary: dashboardHttpSummaryFixture(),
            }
          : null,
      );
  const queue = vi.fn(async () => queueStatusFixture());
  const erp = vi.fn(async () => erpStatusFixture());
  const loggerWarn = vi.fn();
  let revision = 0;
  const allocateRevision = vi.fn(async () => {
    revision += 1;
    return revision;
  });
  const close = vi.fn(async () => undefined);
  const service = new DashboardProjectionService({
    openOperation: async () => ({
      dependencies: {
        contextReader: {
          readContext: options.contextReader
            ? options.contextReader
            : contextError
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
        transportObservationReader: { read: transportAttemptCounts },
        revisionAllocator: { allocate: allocateRevision },
      },
      close,
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
    transportAttemptCounts,
    queue,
    erp,
    loggerWarn,
    allocateRevision,
    close,
  };
}

function dashboardHttpSummaryFixture() {
  return {
    failedRequests: 0,
    acceptedResponses: 0,
    soldOutResponses: 0,
    transportFailures: 0,
    unexpectedResponses: 0,
    failureRate: 0,
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
    generatorCapacity: null,
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
      transportFailures: "summary_export" as const,
      unexpectedResponses: "summary_export" as const,
      droppedIterations: "summary_export" as const,
      completedIterations: "summary_export" as const,
    },
    summaryExportWarnings: [],
  };
}
