import { randomUUID } from "node:crypto";
import {
  type AcceptedRunConfigSnapshot,
  type DemoRunSnapshot,
  deriveLoadExecutionPlan,
  emptyHttpTimingBreakdownSummary,
  realLoadRunDiagnosticsSummarySchema,
  type StartDemoRunResponse,
} from "@checkout-surge/contracts";
import {
  buildSeedPresets,
  type CheckoutSurgeDatabase,
  comparisonPresetRegistry,
  createDatabaseConnection,
  createRedisClient,
  deleteGeneratedRunDurable,
  deleteGeneratedRunRedisState,
  demoComparisons,
  demoPresets,
  demoRunFinalizations,
  demoRunSummaries,
  demoRuns,
  getInventoryStatus,
  getPostgresInventoryStatus,
  inspectGeneratedRunTeardown,
  products,
} from "@checkout-surge/db";
import { requireTestDatabaseUrl, resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createRunInventoryLifecycle } from "../src/runtime/run-inventory-lifecycle.js";
import { insertStartingRun } from "../src/services/accepted-demo-run.js";
import { AdminDemoResetService } from "../src/services/admin-demo-reset-service.js";
import { AutomaticRunResetService } from "../src/services/automatic-run-reset-service.js";
import { comparisonWorkloads } from "../src/services/comparison-workloads.js";
import { PostgresNonterminalRunReader } from "../src/services/core-idle-stop.js";
import { DemoComparisonService } from "../src/services/demo-comparison-service.js";
import { conservativeDurationEstimatorConstants } from "../src/services/demo-duration-estimator.js";
import { ProcessLocalDemoMaintenanceAuthority } from "../src/services/demo-maintenance-authority.js";
import { DemoRunFinalizationService } from "../src/services/demo-run-finalization-service.js";
import { emptyBusinessOutcomeSummary } from "../src/services/demo-run-projections.js";
import { GeneratedRunRetentionService } from "../src/services/generated-run-retention-service.js";
import { GeneratedRunTeardownService } from "../src/services/generated-run-teardown-service.js";
import { PostgresDemoResetWorkflowFence } from "../src/services/postgres-demo-reset-workflow-fence.js";
import { RunHistoryService } from "../src/services/run-history-service.js";
import { PostgresTerminalDemoRunSummaryWriter } from "../src/services/terminal-demo-run-transition.js";
import { syntheticFailedTrafficSummary } from "../src/services/traffic-delivery-plan.js";

describe("comparison runtime ownership", () => {
  let database: ReturnType<typeof createDatabaseConnection>;
  let fence: ReturnType<typeof createDatabaseConnection>;
  let redis: ReturnType<typeof createRedisClient>;
  let now: Date;
  const authority = new ProcessLocalDemoMaintenanceAuthority();
  const logger = createSilentLogger("api");
  const queueLimits = { synchronize: async () => {} };
  const queueMaintenance = {
    cleanRuns: vi.fn(async (_ids: string[]) => ({ cleanedQueueCount: 0, cleanedJobCount: 0 })),
  };
  const releaseBudget = vi.fn(async () => {});
  const abortCurrent = vi.fn(async () => ({ outcome: "no_current_run" as const }));
  const cancelRun = vi.fn(async () => {});
  const clearRun = vi.fn(async () => {});
  let reset: AdminDemoResetService;
  let service: DemoComparisonService;
  let launch: Mock<(run: DemoRunSnapshot, correlationId: string) => Promise<StartDemoRunResponse>>;

  beforeEach(async () => {
    await resetTestDatabase();
    database = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    fence = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    if (!process.env.TEST_REDIS_URL) throw new Error("Dedicated TEST_REDIS_URL is required.");
    redis = createRedisClient(process.env.TEST_REDIS_URL);
    await redis.flushdb();
    now = new Date("2026-06-20T00:00:00.000Z");
    vi.clearAllMocks();
    queueMaintenance.cleanRuns
      .mockReset()
      .mockResolvedValue({ cleanedQueueCount: 0, cleanedJobCount: 0 });
    clearRun.mockReset().mockResolvedValue(undefined);
    await database.db
      .insert(products)
      .values({ id: randomUUID(), sku: "COMPARISON", slug: "comparison", name: "Comparison" });
    const preset = buildSeedPresets().find((row) => row.id === comparisonPresetRegistry.id);
    if (!preset) throw new Error("Comparison preset missing.");
    await database.db.insert(demoPresets).values(preset);
    const inventory = createRunInventoryLifecycle(database.db, redis);
    const writer = new PostgresTerminalDemoRunSummaryWriter(database.db, queueLimits);
    reset = new AdminDemoResetService({
      db: database.db,
      inventory,
      redis,
      queueMaintenance,
      queueLimits,
      terminalRunWriter: writer,
      logger,
      trafficAborter: { abortCurrent },
      runnerOperations: { releaseAfterRun: () => {} },
      dashboardLiveStateReset: {
        fenceRun: async () => {},
        hasRunState: async () => false,
        clearRun,
      },
      resetWorkflowFence: new PostgresDemoResetWorkflowFence(fence.sql),
      maintenanceAuthority: authority,
      inlineConfirmation: { cancelRun },
      now: () => now,
    });
    launch = vi.fn(async (run: DemoRunSnapshot, correlationId: string) => {
      if (!run.saleOfferId) throw new Error("Missing generated offer.");
      await inventory.initialize(
        { runId: run.runId, saleOfferId: run.saleOfferId, executionMode: run.executionMode },
        run.configSnapshot.inventoryConfig.startingStock,
        now,
      );
      await database.db
        .update(demoRuns)
        .set({
          status: "active",
          trafficStatus: "active",
          runnerBootId: randomUUID(),
          trafficStartedAt: now,
        })
        .where(eq(demoRuns.id, run.runId));
      return {
        run,
        correlationId,
        recovery: { establishedAt: now.toISOString() },
        timestamp: now.toISOString(),
      };
    });
    service = new DemoComparisonService({
      db: database.db,
      maintenanceAuthority: authority,
      lifecycle: { launchAcceptedRunExclusive: launch },
      cleanupComparisonExclusive: (id, correlationId) =>
        reset.cleanupComparisonExclusive(id, correlationId),
      runtimePolicyReader: {
        readEffectivePolicy: async () => {
          throw new Error("Reconciliation does not read mutable policy.");
        },
      },
      publicRunBudgetStore: { reserve: vi.fn(), release: releaseBudget },
      publicClientCookieSecret: "comparison-test-cookie-secret",
      estimatorConstants: conservativeDurationEstimatorConstants,
      logger,
      now: () => now,
    });
  });

  afterEach(async () => {
    redis?.disconnect();
    await database?.close();
    await fence?.close();
  });

  async function seedParent() {
    const id = randomUUID();
    const children = comparisonWorkloads().map((stage) => ({
      runId: randomUUID(),
      saleOfferId: randomUUID(),
      executionMode: stage.executionMode,
      presetId: comparisonPresetRegistry.id,
      presetName: stage.name,
      snapshot: stage.snapshot,
    })) as typeof demoComparisons.$inferSelect.children;
    const run = await database.db.transaction(async (tx) => {
      await tx.insert(demoComparisons).values({
        id,
        acceptedAt: now,
        correlationId: "comparison-runtime",
        children,
        currentStage: 0,
        state: "running",
      });
      return insertStartingRun(tx, {
        ...children[0],
        operatorMode: "public",
        correlationId: "comparison-runtime",
        acceptedAt: now,
        comparisonId: id,
        comparisonAcceptedAt: now,
      });
    });
    await launch(run, "comparison-runtime");
    launch.mockClear();
    return { id, children, acceptedAt: now };
  }

  async function settle(runId: string, enrich = true) {
    const [run] = await database.db.select().from(demoRuns).where(eq(demoRuns.id, runId));
    if (!run?.saleOfferId) throw new Error("Current child missing.");
    now = new Date(now.getTime() + 1000);
    const traffic = syntheticFailedTrafficSummary(
      run.configSnapshot,
      ["Generator ended before its first request."],
      "no_traffic_started",
    );
    await createRunInventoryLifecycle(database.db, redis).close({
      runId,
      saleOfferId: run.saleOfferId,
      executionMode: run.executionMode,
    });
    await database.db
      .update(demoRuns)
      .set({ status: "draining", trafficStatus: "failed", trafficEndedAt: now })
      .where(eq(demoRuns.id, runId));
    await database.db.insert(demoRunFinalizations).values({
      runId,
      transportAttemptCounts: traffic.transportAttemptCounts,
      httpSummary: traffic.httpSummary,
      trafficOutcomeSummary: { businessOutcomeAtTrafficCompletion: emptyBusinessOutcomeSummary() },
      trafficDeliverySummary: traffic.trafficDeliverySummary,
      httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
      loadRunDiagnosticsSummary: diagnostics(run.configSnapshot, run.startedAt ?? now, now),
      completionEnrichmentStatus: enrich ? "completed" : "pending",
      trafficSummaryReceivedAt: now,
    });
    const finalizer = new DemoRunFinalizationService({
      db: database.db,
      inventory: createRunInventoryLifecycle(database.db, redis),
      redis,
      logger,
      queueLimits,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(database.db, queueLimits),
      runnerOperations: { releaseAfterRun: () => {} },
      terminalInventoryReadTimeoutMs: 2000,
      terminalInventoryRead: {
        read: (scope) =>
          scope.executionMode === "without_redis"
            ? getPostgresInventoryStatus(
                scope.db as CheckoutSurgeDatabase,
                scope.saleOfferId,
                scope.observedAt,
              )
            : getInventoryStatus(redis, scope.saleOfferId, scope.observedAt),
      },
      now: () => now,
    });
    await finalizer.finalizeRun(runId);
    return finalizer;
  }

  it("advances certified failed business runs once per pass and keeps the charge through final completion", async () => {
    const parent = await seedParent();
    for (let stage = 0; stage < 4; stage += 1) {
      const current = parent.children[stage];
      if (!current) throw new Error("Missing stage.");
      await settle(current.runId);
      const [summary] = await database.db
        .select()
        .from(demoRunSummaries)
        .where(eq(demoRunSummaries.runId, current.runId));
      expect(summary).toMatchObject({ status: "failed", businessSettledAt: now });
      await Promise.all([service.reconcile(), service.reconcile()]);
      const [stored] = await database.db.select().from(demoComparisons);
      expect(stored).toMatchObject({
        currentStage: Math.min(stage + 1, 3),
        state: stage === 3 ? "completed" : "running",
      });
      const rows = await database.db.select().from(demoRuns);
      expect(rows).toHaveLength(Math.min(stage + 2, 4));
      expect(
        rows.every((row) => row.comparisonAcceptedAt?.getTime() === parent.acceptedAt.getTime()),
      ).toBe(true);
    }
    expect(launch).toHaveBeenCalledTimes(3);
    expect(releaseBudget).not.toHaveBeenCalled();
    expect(await database.db.select().from(demoRunSummaries)).toHaveLength(4);
  });

  it("waits for enrichment and leaves existing starting children to startup recovery", async () => {
    const parent = await seedParent();
    const finalizer = await settle(parent.children[0].runId, false);
    await service.reconcile();
    expect(launch).not.toHaveBeenCalled();
    await database.db.update(demoRunFinalizations).set({ completionEnrichmentStatus: "completed" });
    await finalizer.finalizeRun(parent.children[0].runId);
    // A lost COMMIT acknowledgement leaves a durable starting successor before launch.
    const originalTransaction = database.db.transaction.bind(database.db);
    const transaction = vi
      .spyOn(database.db, "transaction")
      .mockImplementationOnce(async (callback) => {
        await originalTransaction(callback);
        throw new Error("Successor COMMIT response lost.");
      });
    await expect(service.reconcile()).rejects.toThrow("Successor COMMIT response lost.");
    transaction.mockRestore();
    await service.reconcile();
    expect(launch).not.toHaveBeenCalled();
    const [stored] = await database.db.select().from(demoComparisons);
    expect(stored?.currentStage).toBe(1);
  });

  it("preserves failed-child history while required cleanup fails, then releases only after exact cleanup", async () => {
    const parent = await seedParent();
    const [run] = await database.db.select().from(demoRuns);
    if (!run) throw new Error("Missing run.");
    const traffic = syntheticFailedTrafficSummary(run.configSnapshot, [], "unavailable");
    await new PostgresTerminalDemoRunSummaryWriter(database.db, queueLimits).write({
      run,
      terminalStatus: "failed",
      failureReason: "load_generator_lost",
      replayPossible: false,
      finalizedAt: now,
      ...traffic,
      httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
      serverReservationTimingSummary: {
        redisAtomicReservation: { sampleCount: 0, averageMs: null, p95Ms: null },
        reserveOrderService: { sampleCount: 0, averageMs: null, p95Ms: null },
      },
      loadRunDiagnosticsSummary: {},
      businessOutcome: emptyBusinessOutcomeSummary(),
      terminalInventorySnapshot: null,
      runSignalTimelineSummary: null,
      allowedCurrentStatuses: ["active"],
    });
    const [original] = await database.db.select().from(demoRunSummaries);
    queueMaintenance.cleanRuns.mockRejectedValueOnce(new Error("Queue settlement unavailable."));
    await expect(service.reconcile()).rejects.toThrow("Queue settlement unavailable.");
    expect((await database.db.select().from(demoComparisons))[0]?.state).toBe("cleanup_pending");
    expect((await database.db.select().from(demoRuns))[0]?.adminResetCompletedAt).toBeNull();
    await service.reconcile();
    expect((await database.db.select().from(demoComparisons))[0]).toMatchObject({
      state: "failed",
      terminalReason: "load_generator_lost",
    });
    expect((await database.db.select().from(demoRuns))[0]).toMatchObject({
      failureReason: "load_generator_lost",
      adminResetCompletedAt: now,
    });
    expect((await database.db.select().from(demoRunSummaries))[0]).toEqual(original);
    expect(releaseBudget).not.toHaveBeenCalled();
    expect(
      queueMaintenance.cleanRuns.mock.calls.every(
        ([ids]) => ids.length === 1 && ids[0] === parent.children[0].runId,
      ),
    ).toBe(true);
  });

  it.each([
    "manual",
    "deadline",
  ] as const)("closes an open settled stage gap on %s reset without purging its certified child", async (kind) => {
    const parent = await seedParent();
    await settle(parent.children[0].runId);
    const [original] = await database.db.select().from(demoRunSummaries);
    expect(await new PostgresNonterminalRunReader(database.db).hasNonterminalRun()).toBe(true);
    await expect(
      new RunHistoryService({ db: database.db }).delete(
        { deleteAllConfirmation: "DELETE" },
        "protected-history",
      ),
    ).rejects.toMatchObject({ code: "run_conflict" });
    if (kind === "deadline") {
      now = new Date(parent.acceptedAt.getTime() + 900_000);
      await new AutomaticRunResetService({
        db: database.db,
        resetWorkflow: reset,
        now: () => now,
      }).check();
    } else await reset.reset("manual-gap", "admin_reset");
    expect((await database.db.select().from(demoComparisons))[0]?.state).toBe("failed");
    expect((await database.db.select().from(demoRunSummaries))[0]).toEqual(original);
    expect((await database.db.select().from(demoRuns))[0]?.adminResetCompletedAt).toBeNull();
    expect(abortCurrent).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    "automatic",
    "coordinator",
  ] as const)("uses the parent deadline for a later active child through %s reset", async (path) => {
    const parent = await seedParent();
    await settle(parent.children[0].runId);
    const [prior] = await database.db.select().from(demoRunSummaries);
    await service.reconcile();
    now = new Date(parent.acceptedAt.getTime() + 900_000);
    if (path === "automatic") {
      await new AutomaticRunResetService({
        db: database.db,
        resetWorkflow: reset,
        now: () => now,
      }).check();
    } else await service.reconcile();
    const rows = await database.db.select().from(demoRuns);
    expect(
      rows.find((row) => row.id === parent.children[0].runId)?.adminResetCompletedAt,
    ).toBeNull();
    expect(rows.find((row) => row.id === parent.children[1].runId)).toMatchObject({
      status: "failed",
      failureReason: "auto_reset",
      adminResetCompletedAt: now,
    });
    expect(
      (await database.db.select().from(demoRunSummaries)).find((row) => row.runId === prior?.runId),
    ).toEqual(prior);
    expect((await database.db.select().from(demoComparisons))[0]).toMatchObject({
      state: "failed",
      terminalReason: "auto_reset",
    });
  });

  it("refuses to launch a successor after the parent deadline in a settled gap", async () => {
    const parent = await seedParent();
    await settle(parent.children[0].runId);
    now = new Date(parent.acceptedAt.getTime() + 900_000);
    await service.reconcile();
    expect(launch).not.toHaveBeenCalled();
    expect(abortCurrent).not.toHaveBeenCalled();
    expect((await database.db.select().from(demoComparisons))[0]).toMatchObject({
      state: "failed",
      terminalReason: "auto_reset",
    });
    expect(await new PostgresNonterminalRunReader(database.db).hasNonterminalRun()).toBe(false);
  });

  it("retains all four summaries through partial external cleanup failure and deletes the expired group atomically on retry", async () => {
    const parent = await seedParent();
    for (const child of parent.children) {
      await settle(child.runId);
      await service.reconcile();
    }
    const inventory = createRunInventoryLifecycle(database.db, redis);
    let cleanupNumber = 0;
    let failSecond = true;
    const teardown = new GeneratedRunTeardownService({
      db: database.db,
      inventory,
      redis,
      queueMaintenance: {
        cleanRuns: async () => {
          cleanupNumber += 1;
          if (failSecond && cleanupNumber === 2) throw new Error("Second member cleanup failed.");
          return { cleanedJobCount: 0, cleanedQueueCount: 0 };
        },
      },
      maintenanceAuthority: authority,
      logger,
      deleteGeneratedRunRedisState,
      inspectGeneratedRunTeardown,
      deleteGeneratedRunDurable,
    });
    await expect(
      teardown.teardownGeneratedRun({
        runId: parent.children[0].runId,
        correlationId: "single-delete",
      }),
    ).rejects.toMatchObject({ code: "run_cleanup_conflict" });
    const retention = new GeneratedRunRetentionService({
      db: database.db,
      generatedRunTeardown: teardown,
      maintenanceAuthority: authority,
      now: () => new Date(now.getTime() + 10 * 86_400_000),
    });
    await retention.cleanupOldRuns({
      keepLatest: 1,
      olderThanDays: 1,
      correlationId: "within-retention",
    });
    expect(await database.db.select().from(demoRunSummaries)).toHaveLength(4);
    expect(cleanupNumber).toBe(0);
    // An ordinary later acceptance supplies the existing positive keepLatest window.
    const ordinaryPreset = buildSeedPresets().find((row) => row.slug === "preview-1k");
    if (!ordinaryPreset) throw new Error("Ordinary preset missing.");
    await database.db.insert(demoPresets).values(ordinaryPreset);
    await database.db.transaction((tx) =>
      insertStartingRun(tx, {
        runId: randomUUID(),
        saleOfferId: randomUUID(),
        presetId: ordinaryPreset.id,
        presetName: ordinaryPreset.display.name,
        snapshot: {
          trafficConfig: ordinaryPreset.trafficConfig,
          inventoryConfig: ordinaryPreset.inventoryConfig,
          erpConfig: ordinaryPreset.erpConfig,
          backpressureConfig: ordinaryPreset.backpressureConfig,
        },
        executionMode: "demo",
        operatorMode: "admin",
        correlationId: "later-ordinary",
        acceptedAt: new Date(now.getTime() + 9 * 86_400_000),
      }),
    );
    await expect(
      retention.cleanupOldRuns({ keepLatest: 1, olderThanDays: 1, correlationId: "group-failed" }),
    ).rejects.toThrow("Second member cleanup failed.");
    expect(await database.db.select().from(demoRunSummaries)).toHaveLength(4);
    expect(await database.db.select().from(demoComparisons)).toHaveLength(1);
    failSecond = false;
    await retention.cleanupOldRuns({
      keepLatest: 1,
      olderThanDays: 1,
      correlationId: "group-retry",
    });
    expect(await database.db.select().from(demoRunSummaries)).toEqual([]);
    expect(await database.db.select().from(demoRuns)).toHaveLength(1);
    expect(await database.db.select().from(demoComparisons)).toEqual([]);
  });
});

function diagnostics(snapshot: AcceptedRunConfigSnapshot, startedAt: Date, completedAt: Date) {
  return realLoadRunDiagnosticsSummarySchema.parse({
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    nproc: null,
    ulimitNofile: null,
    processMaxOpenFiles: null,
    generatorCapacity: null,
    generatorUtilisation: null,
    networkDiagnostics: null,
    k6Version: null,
    executionPlan: deriveLoadExecutionPlan(snapshot.trafficConfig),
    stderrLines: [],
    stderrLineCountObserved: 0,
    stderrLineCountRetained: 0,
    stderrRetainedLineLimit: 50,
    stderrLineTruncationLength: 500,
    stderrLineTruncatedCount: 0,
    terminalMetricSources: {
      startedRequests: "summary_export",
      completedRequests: "summary_export",
      acceptedResponses: "summary_export",
      soldOutResponses: "summary_export",
      transportFailures: "summary_export",
      unexpectedResponses: "summary_export",
      droppedIterations: "summary_export",
      completedIterations: "summary_export",
    },
    summaryExportWarnings: [],
  });
}
