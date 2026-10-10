import {
  type ConsistencyLagSummary,
  type DashboardProjectionScope,
  type DemoRunSnapshot,
  dashboardProjectionSchemaName,
  dashboardProjectionScopeId,
  demoRunSnapshotSchema,
  destructiveResetReasonValues,
  emptyHttpTimingBreakdownSummary,
  emptyRequestArrivalSummary,
  type InventoryStatus,
  type QueueStatus,
  type RunErpOutcomeSummary,
  type RunRuntimeProgress,
  runSignalBucketCount,
  type TrafficDeliveryStatus,
  type TransportAttemptCounts,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture as configSnapshot } from "@checkout-surge/contracts/testing";
import {
  type CheckoutSurgeDatabase,
  createDatabaseConnection,
  DashboardProjectionScopeRetiredError,
  demoPresets,
  demoRunFinalizations,
  demoRunSummaries,
  demoRuns,
  products,
  saleOffers,
} from "@checkout-surge/db";
import { requireTestDatabaseUrl, resetTestDatabase } from "@checkout-surge/db/testing";
import { eq, inArray, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DashboardProjectionService,
  PostgresDashboardRecoveryContextReader,
  PostgresDashboardTransportObservationReader,
} from "../src/services/dashboard-recovery-service.js";
import { emptyBusinessOutcomeSummary as businessOutcomeFixture } from "../src/services/demo-run-projections.js";
import { RunRuntimeProgressService } from "../src/services/run-runtime-progress-service.js";

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
      sku: "RECOVERY-RUN",
      slug: "recovery-run",
      name: "Recovery run product",
    });
    await connection.db.insert(saleOffers).values({
      id: saleOfferId,
      productId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Recovery run offer",
      allocatedStock: 10,
      saleStartsAt: new Date("2026-07-14T00:00:00.000Z"),
      saleEndsAt: new Date("2026-07-15T00:00:00.000Z"),
      isActive: true,
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

  it.each(
    destructiveResetReasonValues,
  )("recovers the %s null-marker gate without a sale offer across reader recreation and repair", async (reason) => {
    if (!connection) throw new Error("Test database connection was not initialized.");
    const id = "99999999-9999-4999-8999-999999999991";
    await connection.db.insert(demoRuns).values({
      correlationId: "corr-test-run",
      id,
      presetId: "33333333-3333-4333-8333-333333333333",
      presetName: "Startup failure",
      operatorMode: "admin",
      status: "failed",
      trafficStatus: "failed",
      failureReason: reason,
      finalizedAt: now,
      configSnapshot: configSnapshot(),
      startedAt: now,
    });
    for (let read = 0; read < 2; read++) {
      await expect(
        new PostgresDashboardRecoveryContextReader(connection.db).readContext(),
      ).resolves.toEqual({
        currentRun: null,
        saleOfferId: null,
        resetRecovery: "incomplete",
        resetRecoveryRunId: id,
      });
    }
    await connection.db
      .update(demoRuns)
      .set({ adminResetCompletedAt: now })
      .where(eq(demoRuns.id, id));
    await expect(
      new PostgresDashboardRecoveryContextReader(connection.db).readContext(),
    ).resolves.toEqual({
      currentRun: null,
      saleOfferId: null,
      resetRecoveryRunId: id,
      resetRecovery: "ready",
    });
    await connection.db.insert(demoRuns).values({
      correlationId: "corr-test-run",
      id: "99999999-9999-4999-8999-999999999992",
      presetId: "33333333-3333-4333-8333-333333333333",
      presetName: "Later ordinary failure",
      operatorMode: "admin",
      status: "failed",
      trafficStatus: "failed",
      failureReason: "traffic_failed",
      configSnapshot: configSnapshot(),
      startedAt: now,
      finalizedAt: new Date(now.getTime() + 1),
    });
    await expect(
      new PostgresDashboardRecoveryContextReader(connection.db).readContext(),
    ).resolves.toMatchObject({ resetRecovery: "ready", resetRecoveryRunId: null });
    await connection.db
      .delete(demoRuns)
      .where(inArray(demoRuns.id, [id, "99999999-9999-4999-8999-999999999992"]));
  });

  it("recovers transport accounting and the joined terminal signal timeline", async () => {
    if (!connection) throw new Error("Test database connection was not initialized.");
    const db = connection.db;
    const terminalStartedAt = new Date("2026-07-14T11:58:00.000Z");
    await db.insert(demoRuns).values({
      correlationId: "corr-test-run",
      id: runId,
      presetId: "33333333-3333-4333-8333-333333333333",
      presetName: "Preview 1k",
      operatorMode: "public",
      status: "failed",
      trafficStatus: "succeeded",
      failureReason: "traffic_delivery_major_shortfall",
      saleOfferId,
      configSnapshot: configSnapshot(),
      startedAt: terminalStartedAt,
      trafficStartedAt: terminalStartedAt,
      trafficEndedAt: now,
      finalizedAt: now,
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
        requestArrivalSummary: emptyRequestArrivalSummary,
        trafficDeliveryStatus: "failed",
        notes: [],
      },
      httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
      loadRunDiagnosticsSummary: currentDiagnosticsFixture(1_000),
      trafficSummaryReceivedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const runSignalTimelineSummary = terminalRunSignalTimelineFixture();
    const [finalizationRow] = await db.select().from(demoRunFinalizations);
    if (!finalizationRow) throw new Error("Expected persisted completion evidence.");
    await db.insert(demoRunSummaries).values({
      runId,
      presetName: "Preview 1k",
      status: "failed",
      replayPossible: false,
      startedAt: terminalStartedAt,
      endedAt: now,
      transportAttemptCounts: finalizationRow.transportAttemptCounts,
      httpSummary: finalizationRow.httpSummary,
      trafficDeliverySummary: finalizationRow.trafficDeliverySummary,
      httpTimingBreakdownSummary: finalizationRow.httpTimingBreakdownSummary,
      loadRunDiagnosticsSummary: finalizationRow.loadRunDiagnosticsSummary,
      businessOutcomeSummary: businessOutcomeFixture(),
      runSignalTimelineSummary,
      capturedAt: now,
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
      persistedTrafficDeliverySummary: expect.objectContaining({
        requestArrivalSummary: emptyRequestArrivalSummary,
      }),
      runSignalTimelineSummary,
    });
    await expect(reader.read("99999999-9999-4999-8999-999999999999")).resolves.toBeNull();
  });
});

describe("PostgresDashboardRecoveryContextReader", () => {
  it("returns no scope after the recoverable-run query finds no row", async () => {
    const database = controlledDatabase([]);

    await expect(
      new PostgresDashboardRecoveryContextReader(database.db).readContext(),
    ).resolves.toEqual({
      currentRun: null,
      saleOfferId: null,
      resetRecoveryRunId: null,
      resetRecovery: "ready",
    });
    expect(database.select).toHaveBeenCalledTimes(2);
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
    expect(database.select).toHaveBeenCalledTimes(2);
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
    expect(database.select).toHaveBeenCalledTimes(2);
  });

  it("falls back to only the explicitly known terminal run without promoting other history", async () => {
    const knownRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const knownTerminal = databaseRun({
      id: knownRunId,
      status: "failed",
      trafficStatus: "failed",
      trafficEndedAt: now,
      finalizedAt: now,
      failureReason: "traffic_failed",
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
    expect(database.select).toHaveBeenCalledTimes(2);
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
    ).resolves.toEqual({
      currentRun: null,
      saleOfferId: null,
      resetRecoveryRunId: null,
      resetRecovery: "ready",
    });
    expect(database.select).toHaveBeenCalledTimes(2);
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

  it("rejects a stored config snapshot missing starting stock with run context", async () => {
    const row = databaseRun();
    const config = configSnapshot();
    const { startingStock: _missing, ...incompleteInventoryConfig } = config.inventoryConfig;
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
    ).rejects.toThrow(new RegExp(`${row.id}.*configSnapshot\\.inventoryConfig\\.startingStock`));
  });
});

describe("DashboardProjectionService", () => {
  it("skips every run-owned port without a current run while retaining global health", async () => {
    const harness = serviceHarness({ currentRun: null, saleOfferId: null });

    const recovery = await harness.service.build({ correlationId: "corr-no-run" });

    expect(recovery).toMatchObject({
      schema: dashboardProjectionSchemaName,
      resetRecoveryRunId: null,
      resetRecovery: "ready",
      correlationId: "corr-no-run",
      scopeId: dashboardProjectionScopeId(null),
      revision: 1,
      scope: null,
      currentRun: null,
      inventory: null,
      businessOutcome: null,
      consistencyLag: null,
      recentMetrics: [],
      transportAttemptCounts: null,
      recoveredAt: now.toISOString(),
    });
    expect(harness.inventory).not.toHaveBeenCalled();
    expect(harness.business).not.toHaveBeenCalled();
    expect(harness.lag).not.toHaveBeenCalled();
    expect(harness.metrics).not.toHaveBeenCalled();
    expect(harness.transportAttemptCounts).not.toHaveBeenCalled();
    expect(harness.runtimeProgress).not.toHaveBeenCalled();
    expect(harness.queue).toHaveBeenCalledOnce();
    expect(harness.runErp).not.toHaveBeenCalled();
    expect(recovery.systemStatus).toEqual({ queue: queueStatusFixture() });
    expect(recovery.erp).toBeNull();
    expect(recovery.runtimeProgress).toBeNull();
  });

  it("omits shared status when the queue read fails", async () => {
    const harness = serviceHarness({ currentRun: null, saleOfferId: null });
    harness.queue.mockRejectedValueOnce(new Error("queue unavailable"));

    const recovery = await harness.service.build({ correlationId: "corr-queue-unavailable" });

    expect(recovery.systemStatus).toBeNull();
    expect(harness.queue).toHaveBeenCalledOnce();
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
    expect(harness.metrics).toHaveBeenCalledWith(runId);
    expect(harness.runErp).toHaveBeenCalledWith(expectedScope);
    expect(harness.runtimeProgress).toHaveBeenCalledWith(runId);
    expect(recovery.erp?.runId).toBe(runId);
    expect(recovery.runtimeProgress?.runId).toBe(runId);
    expect(recovery.recoveredAt).toBe(now.toISOString());
  });

  it("projects limiting, outage, reconciliation, technical failure and late settlement without ending at traffic completion", async () => {
    const currentRun = runSnapshot({
      status: "draining",
      trafficStatus: "succeeded",
      trafficEndedAt: now.toISOString(),
    });
    let observedAt = now;
    const harness = serviceHarness({ currentRun, saleOfferId }, undefined, {
      now: () => observedAt,
    });
    let status: RunRuntimeProgress["downstreamErpStatus"] = "nominal";
    let outstanding = 3;
    let confirmed = 0;
    let failed = 0;
    const progress = new RunRuntimeProgressService({
      progressReader: {
        read: async () => ({
          outstandingOrders: outstanding,
          oldestOutstandingAgeSeconds: outstanding
            ? (observedAt.getTime() - now.getTime()) / 1000 + 30
            : 0,
          confirmedOrdersInWindow: confirmed,
          processingStartedAt: new Date(now.getTime() - 30_000),
        }),
      },
      downstreamStatusReader: {
        read: async () => {
          if (status === null) throw new Error("status temporarily unreadable");
          return status;
        },
      },
      logger: { error: vi.fn() } as never,
      now: () => observedAt,
    });
    harness.runtimeProgress.mockImplementation(() => progress.getProgress(runId));
    harness.business.mockImplementation(async () => ({
      ...businessOutcomeFixture(),
      acceptedReservations: 3,
      reservedUnits: 3,
      processingOrders: outstanding,
      confirmedOrders: confirmed,
      notificationsRecorded: confirmed,
      failedOrders: failed,
    }));

    // Upstream DB/worker suites prove state production; this boundary proves their
    // combined public projection, including recovery from a failed status read.
    for (const next of ["nominal", "erp_limiting", "erp_unavailable", null, "nominal"] as const) {
      status = next;
      const projection = await harness.service.build({ correlationId: "corr-runtime-matrix" });
      expect(projection.currentRun?.status).toBe("draining");
      expect(projection.runtimeProgress).toMatchObject({
        outstandingOrders: 3,
        confirmationRatePerSecond: 0,
        downstreamErpStatus: next,
        downstreamErpStatusReadStatus: next === null ? "unavailable" : "available",
      });
      expect(projection.businessOutcome).toMatchObject({ confirmedOrders: 0, failedOrders: 0 });
    }

    // A reconciled confirmation and a terminal technical failure leave the third
    // accepted order recoverable after more than five minutes.
    observedAt = new Date(now.getTime() + 301_000);
    confirmed = 1;
    failed = 1;
    outstanding = 1;
    const draining = await harness.service.build({ correlationId: "corr-late-work" });
    expect(draining.currentRun?.status).toBe("draining");
    expect(draining.runtimeProgress).toMatchObject({
      outstandingOrders: 1,
      oldestOutstandingAgeSeconds: 331,
    });
    expect(draining.businessOutcome).toMatchObject({
      confirmedOrders: 1,
    });

    confirmed = 2;
    outstanding = 0;
    currentRun.status = "completed";
    currentRun.finalizedAt = observedAt.toISOString();
    const settled = await harness.service.build({ correlationId: "corr-late-settlement" });
    expect(settled.currentRun?.status).toBe("completed");
    expect(settled.runtimeProgress).toMatchObject({
      outstandingOrders: 0,
      oldestOutstandingAgeSeconds: 0,
    });
    expect(settled.businessOutcome).toMatchObject({
      confirmedOrders: 2,
      notificationsRecorded: 2,
      failedOrders: 1,
    });
    expect(settled.revision).toBeGreaterThan(draining.revision);
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

  it("answers a known run whose Redis state was removed with the current projection", async () => {
    const harness = serviceHarness({ currentRun: null, saleOfferId: null }, undefined, {
      contextReader: async (_scope, knownScope) =>
        knownScope
          ? {
              currentRun: runSnapshot({
                status: "completed",
                trafficStatus: "succeeded",
                trafficEndedAt: now.toISOString(),
                finalizedAt: now.toISOString(),
              }),
              saleOfferId,
            }
          : { currentRun: null, saleOfferId: null },
    });
    harness.allocateRevision.mockRejectedValueOnce(new DashboardProjectionScopeRetiredError(runId));

    const projection = await harness.service.build({
      correlationId: "corr-known-retired",
      knownScope: { runId, saleOfferId },
    });

    expect(projection).toMatchObject({ scope: null, currentRun: null });
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
    expect(harness.metrics).not.toHaveBeenCalled();
    expect(harness.transportAttemptCounts).not.toHaveBeenCalled();
    expect(harness.queue).not.toHaveBeenCalled();
    expect(harness.runErp).not.toHaveBeenCalled();
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

  it("degrades a runtime-progress read failure to null without losing the scope", async () => {
    const projectionError = new Error("runtime progress unavailable");
    const harness = serviceHarness({ currentRun: runSnapshot(), saleOfferId }, undefined, {
      runtimeProgressError: projectionError,
    });

    const recovery = await harness.service.build({ correlationId: "corr-progress-failure" });

    expect(recovery.scope).toEqual({ runId, saleOfferId });
    expect(recovery.runtimeProgress).toBeNull();
    expect(harness.business).toHaveBeenCalledOnce();
    expect(harness.loggerWarn).toHaveBeenCalledWith(
      { err: projectionError, projection: "dashboard_runtime_progress" },
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
      trafficDeliveryStatus: "failed",
    });

    const recovery = await harness.service.build({ correlationId: "corr-draining" });

    expect(harness.transportAttemptCounts).toHaveBeenCalledWith(runId);
    expect(recovery.transportAttemptCounts).toEqual(counts);
    expect(recovery.httpSummary).toEqual(dashboardHttpSummaryFixture());
    expect(recovery.requestArrivalSummary).toEqual(emptyRequestArrivalSummary);
  });

  it("keeps transport accounting null while no completion evidence is available", async () => {
    const harness = serviceHarness({ currentRun: runSnapshot(), saleOfferId }, undefined, {
      transportAttemptCounts: null,
    });

    const recovery = await harness.service.build({ correlationId: "corr-active" });

    expect(harness.transportAttemptCounts).toHaveBeenCalledWith(runId);
    expect(recovery.transportAttemptCounts).toBeNull();
    expect(recovery.httpSummary).toBeNull();
    expect(recovery.requestArrivalSummary).toBeNull();
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

  it("keeps valid transport evidence when persisted delivery status is corrupt", async () => {
    const counts = {
      plannedRequests: 1_000,
      startedRequests: 1_000,
      completedRequests: 1_000,
      interruptedRequests: 0,
      unstartedRequests: 0,
    };
    const harness = serviceHarness({ currentRun: runSnapshot(), saleOfferId }, undefined, {
      transportAttemptCounts: counts,
      trafficDeliveryStatus: "warning",
    });

    const recovery = await harness.service.build({ correlationId: "corr-arrival-corrupt" });

    expect(recovery.transportAttemptCounts).toEqual(counts);
    expect(recovery.httpSummary).toEqual(dashboardHttpSummaryFixture());
    expect(recovery.requestArrivalSummary).toBeNull();
    expect(harness.loggerWarn).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({
          message: expect.stringContaining("trafficDeliveryStatus must be complete"),
        }),
        projection: "dashboard_request_arrival_summary",
      },
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
            inventoryStatusService: { getStatus: async () => inventoryStatusFixture() },
            queueStatusService: { getStatus: async () => queueStatusFixture() },
            runErpOutcomeService: { getOutcomes: async () => runErpOutcomeFixture() },
            trafficMetricReader: { readRecent: async () => [] },
            transportObservationReader: { read: async () => null },
            runtimeProgressService: { getProgress: async () => runtimeProgressFixture() },
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
  const where = vi.fn((_expression: SQL) => ({ orderBy, limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn((fields?: unknown) =>
    fields
      ? { from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }
      : { from },
  );
  return { db: { select } as unknown as CheckoutSurgeDatabase, select, where };
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
    resetRecovery?: "ready" | "incomplete";
  }>;
}) {
  return {
    contextReader: {
      readContext: async () => ({
        resetRecoveryRunId: null,
        resetRecovery: "ready" as const,
        ...(await options.readContext()),
      }),
    },
    businessOutcomeReader: { read: async () => businessOutcomeFixture() },
    consistencyLagReader: { read: async () => consistencyLagFixture() },
    inventoryStatusService: { getStatus: async () => inventoryStatusFixture() },
    queueStatusService: { getStatus: async () => queueStatusFixture() },
    runErpOutcomeService: { getOutcomes: async () => runErpOutcomeFixture() },
    trafficMetricReader: { readRecent: async () => [] },
    transportObservationReader: { read: async () => null },
    runtimeProgressService: { getProgress: async () => runtimeProgressFixture() },
    revisionAllocator: { allocate: async () => 1 },
  };
}

function serviceHarness(
  context: { currentRun: DemoRunSnapshot | null; saleOfferId: string | null } | null,
  contextError?: Error,
  options: {
    contextReader?: (
      scope?: DashboardProjectionScope,
      knownScope?: DashboardProjectionScope,
    ) => Promise<{
      currentRun: DemoRunSnapshot | null;
      saleOfferId: string | null;
      resetRecovery?: "ready" | "incomplete";
    }>;
    lagError?: Error;
    transportAttemptCounts?: TransportAttemptCounts | null;
    transportAttemptCountsError?: Error;
    trafficDeliveryStatus?: TrafficDeliveryStatus;
    runtimeProgressError?: Error;
    now?: () => Date;
  } = {},
) {
  const inventory = vi.fn(async () => inventoryStatusFixture());
  const business = vi.fn(async () => businessOutcomeFixture());
  const lag = options.lagError
    ? vi.fn(async () => Promise.reject(options.lagError))
    : vi.fn(async () => consistencyLagFixture());
  const runtimeProgress = options.runtimeProgressError
    ? vi.fn(async () => Promise.reject(options.runtimeProgressError))
    : vi.fn(async () => runtimeProgressFixture());
  const metrics = vi.fn(async () => []);
  const transportAttemptCounts = options.transportAttemptCountsError
    ? vi.fn(async () => Promise.reject(options.transportAttemptCountsError))
    : vi.fn(async () =>
        options.transportAttemptCounts
          ? {
              transportAttemptCounts: options.transportAttemptCounts,
              httpSummary: dashboardHttpSummaryFixture(),
              persistedTrafficDeliverySummary: {
                trafficMode: "buyer-spike",
                plannedBuyers: options.transportAttemptCounts.plannedRequests,
                scheduledRatePerSecond: null,
                configuredDurationSeconds: null,
                preAllocatedVUs: null,
                maxVUs: null,
                droppedIterations: 0,
                completedIterations: options.transportAttemptCounts.completedRequests,
                requestArrivalSummary: emptyRequestArrivalSummary,
                trafficDeliveryStatus: options.trafficDeliveryStatus ?? "complete",
                notes: [],
              },
              runSignalTimelineSummary: null,
            }
          : null,
      );
  const queue = vi.fn(async () => queueStatusFixture());
  const runErp = vi.fn(async (scope: { runId: string }) => runErpOutcomeFixture(scope.runId));
  const loggerWarn = vi.fn();
  let revision = 0;
  const allocateRevision = vi.fn(async () => {
    revision += 1;
    return revision;
  });
  const close = vi.fn(async () => undefined);
  const readContext = options.contextReader;
  const service = new DashboardProjectionService({
    openOperation: async () => ({
      dependencies: {
        contextReader: {
          readContext: readContext
            ? async (scope, knownScope) => ({
                resetRecoveryRunId: null,
                resetRecovery: "ready" as const,
                ...(await readContext(scope, knownScope)),
              })
            : contextError
              ? async () => Promise.reject(contextError)
              : async () => ({
                  resetRecoveryRunId: null,
                  resetRecovery: "ready" as const,
                  ...(context ?? { currentRun: null, saleOfferId: null }),
                }),
        },
        businessOutcomeReader: { read: business },
        consistencyLagReader: { read: lag },
        inventoryStatusService: { getStatus: inventory },
        queueStatusService: { getStatus: queue },
        runErpOutcomeService: { getOutcomes: runErp },
        trafficMetricReader: { readRecent: metrics },
        transportObservationReader: { read: transportAttemptCounts },
        runtimeProgressService: { getProgress: runtimeProgress },
        revisionAllocator: { allocate: allocateRevision },
      },
      close,
    }),
    logger: { warn: loggerWarn } as never,
    now: options.now ?? (() => now),
  });
  return {
    service,
    inventory,
    business,
    lag,
    metrics,
    transportAttemptCounts,
    queue,
    runErp,
    runtimeProgress,
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

function terminalRunSignalTimelineFixture() {
  const elapsed = Array.from({ length: runSignalBucketCount }, (_, index) => index + 1);
  return {
    window: {
      anchoredAt: "2026-07-14T11:58:00.000Z",
      endedAt: now.toISOString(),
      bucketCount: runSignalBucketCount,
      bucketWidthSeconds: 1,
    },
    inventoryDrain: {
      startingStock: 10,
      remainingStock: 0,
      depletedAt: "2026-07-14T11:58:05.000Z",
      timeToDepletionSeconds: 5,
      remainingStockSeries: elapsed.map((elapsedSeconds) => ({
        elapsedSeconds,
        remainingStock: Math.max(0, 10 - elapsedSeconds),
      })),
    },
    queueBacklog: {
      peakBacklog: 4,
      peakAtElapsedSeconds: 2,
      backlogDrainedAt: "2026-07-14T11:58:10.000Z",
      drainDurationSeconds: 9,
      drainDurationBoundary: "first_order_queued_to_final_backlog_zero" as const,
      definition: "accepted_awaiting_first_processing_start" as const,
      backlogSeries: elapsed.map((elapsedSeconds) => ({
        elapsedSeconds,
        backlog: elapsedSeconds < 5 ? Math.min(4, elapsedSeconds) : 0,
      })),
    },
    confirmationConvergence: {
      confirmedOrderCount: 10,
      failedOrderCount: 0,
      pendingAtCaptureCount: 0,
      averageLagMs: 2_000,
      p95LagMs: 3_000,
      maxLagMs: 4_000,
      boundary: "reservation_secured_to_order_confirmed" as const,
      convergenceSeries: elapsed.map((elapsedSeconds) => ({
        elapsedSeconds,
        cumulativeConfirmedOrderCount: Math.min(10, elapsedSeconds),
        cumulativeSettledOrderCount: Math.min(10, elapsedSeconds),
      })),
    },
    convergenceDurationSeconds: 118,
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
      peakRatePerSecond: 1,
      peakWindowSeconds: 1,
      unit: "reservations_per_second",
      measuredAt: now.toISOString(),
    },
    soldOutPressure: { rejectionCount: 0, latestObservedAt: null },
    observedAt: now.toISOString(),
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
    failedJobs: { totalCount: 0, recent: [], inspectionLimit: 20, inspectionTruncated: false },
    observedAt: now.toISOString(),
  };
}

function runErpOutcomeFixture(scopedRunId = runId): RunErpOutcomeSummary {
  return {
    runId: scopedRunId,
    latestAttempt: null,
    recentAttemptWindowSeconds: 60,
    recentAttemptCount: 0,
    recentFailureCount: 0,
    recentTimeoutCount: 0,
    observedAt: now.toISOString(),
  };
}

function runtimeProgressFixture(): RunRuntimeProgress {
  return {
    runId,
    outstandingOrders: 2,
    oldestOutstandingAgeSeconds: 8.5,
    confirmationRatePerSecond: 0.4,
    confirmationRateWindowSeconds: 10,
    downstreamErpStatus: "nominal",
    downstreamErpStatusReadStatus: "available",
    observedAt: now.toISOString(),
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
    autoResetAt: new Date(now.getTime() + 900_000).toISOString(),
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
    generatorUtilisation: null,
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
