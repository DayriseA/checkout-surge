import {
  type AcceptedRunConfigSnapshot,
  emptyHttpTimingBreakdownSummary,
  emptyRequestArrivalSummary,
  type TrafficCompletionReport,
} from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createRedisClient,
  demoPresets,
  demoRunFinalizations,
  demoRunSummaries,
  demoRuns,
  getInventoryStatus,
  initializeInventory,
  isRunSaleEligible,
  products,
  saleOffers,
} from "@checkout-surge/db";
import { requireTestDatabaseUrl, resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoRunFinalizationService } from "../src/services/demo-run-finalization-service.js";
import { emptyBusinessOutcomeSummary } from "../src/services/demo-run-projections.js";
import { PostgresStartingDemoRunReconciliationStore } from "../src/services/demo-run-startup-reconciliation-service.js";
import { RunHistoryService } from "../src/services/run-history-service.js";
import { PostgresTerminalDemoRunSummaryWriter } from "../src/services/terminal-demo-run-transition.js";
import { TrafficCompletionEnrichmentService } from "../src/services/traffic-completion-enrichment-service.js";
import { TrafficCompletionService } from "../src/services/traffic-completion-service.js";

const runId = "11111111-1111-4111-8111-111111111111";
const presetId = "22222222-2222-4222-8222-222222222222";
const productId = "33333333-3333-4333-8333-333333333333";
const saleOfferId = "44444444-4444-4444-8444-444444444444";
const acceptedAt = new Date("2026-07-19T00:00:00.000Z");
const trafficStartedAt = new Date("2026-07-19T00:00:01.000Z");

describe("TrafficCompletionService", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;
  let redis: ReturnType<typeof createRedisClient> | null = null;

  beforeEach(async () => {
    await connection?.close();
    redis?.disconnect();
    connection = null;
    redis = null;

    await resetTestDatabase();
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 2 });
    redis = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    await redis.flushdb();
    await seedRun(requireConnection(connection), "active");
    await initializeInventory(requireRedis(redis), {
      saleOfferId,
      allocatedStock: 10,
      source: "demo_run_start",
      initializedAt: acceptedAt,
      run: { runId, status: "accepting" },
    });
  });

  afterAll(async () => {
    await connection?.close();
    if (redis) {
      await redis.flushdb();
      redis.disconnect();
    }
  });

  it("accepts immutable traffic evidence, closes admission, and hands draining to finalization", async () => {
    const finalizeRun = vi.fn(async () => null);
    const service = createCompletionService(requireConnection(connection), requireRedis(redis), {
      finalizeRun,
    });

    await expect(service.recordTrafficCompletion(completionReport())).resolves.toMatchObject({
      runId,
      status: "draining",
      trafficStatus: "succeeded",
    });

    const [run] = await requireConnection(connection)
      .db.select()
      .from(demoRuns)
      .where(eq(demoRuns.id, runId));
    const [finalization] = await requireConnection(connection)
      .db.select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, runId));
    expect(run).toMatchObject({
      status: "draining",
      trafficStatus: "succeeded",
      trafficEndedAt: new Date("2026-07-19T00:00:10.000Z"),
    });
    expect(finalization).toMatchObject({
      runId,
      completionEnrichmentStatus: "completed",
      transportAttemptCounts: completionReport().transportAttemptCounts,
    });
    await expect(isRunSaleEligible(requireRedis(redis), { runId, saleOfferId })).resolves.toBe(
      false,
    );
    expect(finalizeRun).toHaveBeenCalledWith(runId, "corr-completion");
  });

  it("accepts semantic redelivery and rejects conflicting evidence before side effects", async () => {
    const enrichment = createEnrichmentService(requireConnection(connection), requireRedis(redis));
    const completePendingEnrichment = vi.fn((id: string) =>
      enrichment.completePendingEnrichment(id),
    );
    const finalizeRun = vi.fn(async () => null);
    const service = new TrafficCompletionService({
      db: requireConnection(connection).db,
      redis: requireRedis(redis),
      completionEnrichmentService: { completePendingEnrichment },
      finalizationService: { finalizeRun },
      logger: createSilentLogger("api"),
      now: () => new Date("2026-07-19T00:00:11.000Z"),
    });
    const report = completionReport();

    await service.recordTrafficCompletion(report);
    await expect(service.recordTrafficCompletion(report)).resolves.toMatchObject({
      status: "draining",
    });
    await expect(
      service.recordTrafficCompletion({
        ...report,
        status: "failed",
        exitCode: 9,
        errorMessage: "conflicting redelivery",
      }),
    ).rejects.toMatchObject({ code: "traffic_report_rejected" });

    const [finalization] = await requireConnection(connection)
      .db.select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, runId));
    expect(finalization).toMatchObject({ exitCode: 0, errorMessage: null });
    expect(completePendingEnrichment).toHaveBeenCalledTimes(2);
    expect(finalizeRun).toHaveBeenCalledTimes(2);
  });

  it("rejects an initial accepted-config mismatch before mutation or downstream effects", async () => {
    const completePendingEnrichment = vi.fn(async () => "completed" as const);
    const finalizeRun = vi.fn(async () => null);
    const service = new TrafficCompletionService({
      db: requireConnection(connection).db,
      redis: requireRedis(redis),
      completionEnrichmentService: { completePendingEnrichment },
      finalizationService: { finalizeRun },
      logger: createSilentLogger("api"),
    });
    const report = completionReport();
    const executionPlan = report.loadRunDiagnosticsSummary.executionPlan;
    if (executionPlan.trafficMode !== "buyer-spike") {
      throw new Error("Expected the buyer-spike completion fixture.");
    }

    await expect(
      service.recordTrafficCompletion({
        ...report,
        loadRunDiagnosticsSummary: {
          ...report.loadRunDiagnosticsSummary,
          executionPlan: {
            ...executionPlan,
            maxDurationSeconds: 6,
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "traffic_report_rejected",
      details: { field: "loadRunDiagnosticsSummary.executionPlan" },
    });

    const [run] = await requireConnection(connection)
      .db.select()
      .from(demoRuns)
      .where(eq(demoRuns.id, runId));
    expect(run).toMatchObject({ status: "active", trafficStatus: "active" });
    expect(await requireConnection(connection).db.select().from(demoRunFinalizations)).toHaveLength(
      0,
    );
    await expect(isRunSaleEligible(requireRedis(redis), { runId, saleOfferId })).resolves.toBe(
      true,
    );
    expect(completePendingEnrichment).not.toHaveBeenCalled();
    expect(finalizeRun).not.toHaveBeenCalled();
  });

  it("rolls back immutable evidence when the draining claim write fails", async () => {
    const activeConnection = requireConnection(connection);
    const completePendingEnrichment = vi.fn(async () => "completed" as const);
    const finalizeRun = vi.fn(async () => null);
    const service = new TrafficCompletionService({
      db: activeConnection.db,
      redis: requireRedis(redis),
      completionEnrichmentService: { completePendingEnrichment },
      finalizationService: { finalizeRun },
      logger: createSilentLogger("api"),
    });
    await activeConnection.sql.unsafe(`
      CREATE FUNCTION reject_test_draining_claim() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'draining' THEN
          RAISE EXCEPTION 'injected draining claim failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_test_draining_claim
      BEFORE UPDATE ON demo_runs
      FOR EACH ROW EXECUTE FUNCTION reject_test_draining_claim();
    `);

    try {
      await expect(service.recordTrafficCompletion(completionReport())).rejects.toThrow(
        'Failed query: update "demo_runs"',
      );
      const [run] = await activeConnection.db.select().from(demoRuns).where(eq(demoRuns.id, runId));
      expect(run).toMatchObject({ status: "active", trafficStatus: "active" });
      expect(await activeConnection.db.select().from(demoRunFinalizations)).toHaveLength(0);
      expect(completePendingEnrichment).not.toHaveBeenCalled();
      expect(finalizeRun).not.toHaveBeenCalled();
    } finally {
      await activeConnection.sql.unsafe(`
        DROP TRIGGER IF EXISTS reject_test_draining_claim ON demo_runs;
        DROP FUNCTION IF EXISTS reject_test_draining_claim();
      `);
    }
  });

  it("claims a starting run before a delayed activation can resurrect it", async () => {
    await requireConnection(connection)
      .db.update(demoRuns)
      .set({ status: "starting", trafficStatus: "starting", trafficStartedAt: null })
      .where(eq(demoRuns.id, runId));
    const service = createCompletionService(requireConnection(connection), requireRedis(redis));

    await expect(service.recordTrafficCompletion(completionReport())).resolves.toMatchObject({
      status: "draining",
      trafficStartedAt: trafficStartedAt.toISOString(),
    });
    await expect(
      new PostgresStartingDemoRunReconciliationStore(
        requireConnection(connection).db,
      ).activateStartingRun(
        runId,
        {
          runId,
          status: "active",
          startedAt: trafficStartedAt.toISOString(),
          correlationId: "late-activation",
        },
        new Date("2026-07-19T00:00:12.000Z"),
      ),
    ).resolves.toBe(false);
    const [run] = await requireConnection(connection)
      .db.select()
      .from(demoRuns)
      .where(eq(demoRuns.id, runId));
    expect(run?.status).toBe("draining");
  });

  it("re-drives pending enrichment on exact redelivery before requesting finalization", async () => {
    const completePendingEnrichment = vi
      .fn(async () => "completed" as const)
      .mockRejectedValueOnce(new Error("injected enrichment failure"));
    const finalizeRun = vi.fn(async () => null);
    const service = new TrafficCompletionService({
      db: requireConnection(connection).db,
      redis: requireRedis(redis),
      completionEnrichmentService: { completePendingEnrichment },
      finalizationService: { finalizeRun },
      logger: createSilentLogger("api"),
    });
    const report = completionReport();

    await expect(service.recordTrafficCompletion(report)).rejects.toThrow(
      "injected enrichment failure",
    );
    expect(finalizeRun).not.toHaveBeenCalled();
    await expect(service.recordTrafficCompletion(report)).resolves.toMatchObject({
      status: "draining",
    });
    expect(completePendingEnrichment).toHaveBeenCalledTimes(2);
    expect(finalizeRun).toHaveBeenCalledOnce();
  });

  it("keeps a failed traffic-boundary capture immutable while finalization captures terminal inventory", async () => {
    const activeConnection = requireConnection(connection);
    const redisClient = requireRedis(redis);
    let failCapture = true;
    let captureReadCount = 0;
    const captureRedis = new Proxy(redisClient, {
      get(target, property) {
        if (property === "hgetall") {
          return async (...args: Parameters<typeof target.hgetall>) => {
            captureReadCount += 1;
            if (failCapture) throw new Error("injected Redis capture failure");
            return target.hgetall(...args);
          };
        }
        const value = target[property as keyof typeof target];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof redisClient;
    const completionService = new TrafficCompletionService({
      db: activeConnection.db,
      redis: redisClient,
      completionEnrichmentService: createEnrichmentService(activeConnection, captureRedis),
      finalizationService: createFinalizationService(activeConnection, redisClient),
      logger: createSilentLogger("api"),
      now: () => new Date("2026-07-19T00:00:11.000Z"),
    });
    const report = noStartedTrafficCompletionReport();

    await expect(completionService.recordTrafficCompletion(report)).resolves.toMatchObject({
      status: "failed",
      failureCategory: "traffic",
    });
    failCapture = false;
    await expect(completionService.recordTrafficCompletion(report)).resolves.toMatchObject({
      status: "failed",
    });

    const [finalization] = await activeConnection.db
      .select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, runId));
    const [summary] = await activeConnection.db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, runId));
    expect(finalization?.completionEnrichmentStatus).toBe("completed");
    expect(finalization?.trafficOutcomeSummary).not.toHaveProperty("terminalInventorySnapshot");
    expect(summary?.terminalInventorySnapshot).toMatchObject({ saleOfferId, source: "redis" });
    expect(captureReadCount).toBe(1);
  });

  it("fails a run whose server left requests unanswered and reports it from history", async () => {
    const activeConnection = requireConnection(connection);
    const redisClient = requireRedis(redis);
    const completionService = createCompletionService(
      activeConnection,
      redisClient,
      createFinalizationService(activeConnection, redisClient),
    );
    const report = completionReport();

    await expect(
      completionService.recordTrafficCompletion({
        ...report,
        transportAttemptCounts: {
          plannedRequests: 10,
          startedRequests: 10,
          completedRequests: 9,
          interruptedRequests: 1,
          unstartedRequests: 0,
        },
        httpSummary: { ...report.httpSummary, soldOutResponses: 9 },
        trafficDeliverySummary: { ...report.trafficDeliverySummary, completedIterations: 9 },
      }),
    ).resolves.toMatchObject({ status: "failed", failureCategory: "traffic" });

    const detail = await new RunHistoryService({ db: activeConnection.db }).detail(runId);
    expect(detail?.summary.trafficDeliverySummary.trafficDeliveryStatus).toBe("failed");
    expect(detail?.result.outcome).toBe("failed");
    expect(detail?.failureDiagnostic).toEqual({ cause: "interrupted_requests" });
  });

  it("stores request timeouts and names them as the cause of a transport-loss failure", async () => {
    const activeConnection = requireConnection(connection);
    const redisClient = requireRedis(redis);
    const completionService = createCompletionService(
      activeConnection,
      redisClient,
      createFinalizationService(activeConnection, redisClient),
    );
    const report = completionReport();
    const httpSummary = {
      ...report.httpSummary,
      failedRequests: 1,
      soldOutResponses: 9,
      transportFailures: 1,
      requestTimeouts: 1,
    };

    await expect(
      completionService.recordTrafficCompletion({ ...report, httpSummary }),
    ).resolves.toMatchObject({ status: "failed", failureCategory: "traffic" });

    const detail = await new RunHistoryService({ db: activeConnection.db }).detail(runId);
    expect(detail?.summary.httpSummary).toEqual(httpSummary);
    expect(detail?.failureDiagnostic).toEqual({ cause: "request_timeouts" });
  });
});

function createCompletionService(
  connection: ReturnType<typeof createDatabaseConnection>,
  redis: ReturnType<typeof createRedisClient>,
  finalizationService: Pick<DemoRunFinalizationService, "finalizeRun"> = {
    finalizeRun: async () => null,
  },
): TrafficCompletionService {
  return new TrafficCompletionService({
    db: connection.db,
    redis,
    completionEnrichmentService: createEnrichmentService(connection, redis),
    finalizationService,
    logger: createSilentLogger("api"),
    now: () => new Date("2026-07-19T00:00:11.000Z"),
  });
}

function createFinalizationService(
  connection: ReturnType<typeof createDatabaseConnection>,
  redis: ReturnType<typeof createRedisClient>,
): DemoRunFinalizationService {
  return new DemoRunFinalizationService({
    runnerOperations: { releaseAfterRun: () => undefined },
    queueLimits: { synchronize: async () => {} },
    db: connection.db,
    redis,
    logger: createSilentLogger("api"),
    terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(connection.db, {
      synchronize: async () => {},
    }),
    terminalInventoryRead: {
      read: ({ saleOfferId: currentSaleOfferId, observedAt }) =>
        getInventoryStatus(redis, currentSaleOfferId, observedAt),
    },
    terminalInventoryReadTimeoutMs: 2_000,
    now: () => new Date("2026-07-19T00:00:11.000Z"),
  });
}

function createEnrichmentService(
  connection: ReturnType<typeof createDatabaseConnection>,
  redis: ReturnType<typeof createRedisClient>,
): TrafficCompletionEnrichmentService {
  return new TrafficCompletionEnrichmentService({
    db: connection.db,
    redis,
    businessOutcomeReader: { read: async () => emptyBusinessOutcomeSummary() },
    logger: createSilentLogger("api"),
    now: () => new Date("2026-07-19T00:00:11.000Z"),
  });
}

async function seedRun(
  connection: ReturnType<typeof createDatabaseConnection>,
  status: "starting" | "active",
): Promise<void> {
  const snapshot = acceptedRunConfigSnapshot();
  await connection.db.insert(products).values({
    id: productId,
    sku: "COMPLETION-001",
    slug: "completion-product",
    name: "Completion Product",
    isActive: true,
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
  });
  await connection.db.insert(demoPresets).values({
    id: presetId,
    slug: "completion-preset",
    visibility: "admin",
    isEditable: false,
    isCustom: false,
    display: {
      name: "Completion Preset",
      description: "Traffic completion fixture.",
      sortOrder: 1,
      outcomeFocus: [],
    },
    ...snapshot,
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
  });
  await connection.db.insert(saleOffers).values({
    id: saleOfferId,
    productId,
    name: "Completion Offer",
    allocatedStock: 10,
    saleStartsAt: acceptedAt,
    saleEndsAt: new Date("2026-07-20T00:00:00.000Z"),
    isActive: true,

    createdAt: acceptedAt,
    updatedAt: acceptedAt,
  });
  await connection.db.insert(demoRuns).values({
    correlationId: "corr-test-run",
    id: runId,
    presetId,
    presetName: "Completion Preset",
    operatorMode: "admin",
    status,
    trafficStatus: status,
    configSnapshot: snapshot,
    saleOfferId,
    startedAt: acceptedAt,
    ...(status === "active" ? { trafficStartedAt } : {}),
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
  });
}

function acceptedRunConfigSnapshot(): AcceptedRunConfigSnapshot {
  return {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 10,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 5,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 10,
    },
    erpConfig: {
      latencyMs: 100,
      maxTps: 10,
      errorRate: 0,
      forcedOutage: false,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 5,
    },
  };
}

function completionReport(): TrafficCompletionReport {
  const completedAt = "2026-07-19T00:00:10.000Z";
  return {
    runId,
    status: "succeeded",
    exitCode: 0,
    transportAttemptCounts: {
      plannedRequests: 10,
      startedRequests: 10,
      completedRequests: 10,
      interruptedRequests: 0,
      unstartedRequests: 0,
    },
    httpSummary: {
      failedRequests: 0,
      acceptedResponses: 0,
      soldOutResponses: 10,
      transportFailures: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    trafficOutcomeSummary: {},
    trafficDeliverySummary: {
      trafficMode: "buyer-spike",
      plannedBuyers: 10,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: 10,
      requestArrivalSummary: emptyRequestArrivalSummary,
      notes: [],
    },
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    loadRunDiagnosticsSummary: {
      startedAt: trafficStartedAt.toISOString(),
      completedAt,
      nproc: null,
      ulimitNofile: null,
      processMaxOpenFiles: null,
      generatorCapacity: null,
      generatorUtilisation: null,
      networkDiagnostics: null,
      k6Version: null,
      executionPlan: {
        trafficMode: "buyer-spike",
        buyerCount: 10,
        duplicateEachBuyerAttempt: false,
        iterationsPerVu: 1,
        plannedEmittedAttempts: 10,
        startDelaySeconds: 0,
        maxDurationSeconds: 5,
      },
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
        transportFailures: "summary_export" as const,
        unexpectedResponses: "summary_export",
        droppedIterations: "summary_export",
        completedIterations: "summary_export",
      },
      summaryExportWarnings: [],
    },
    completedAt,
    correlationId: "corr-completion",
  };
}

function noStartedTrafficCompletionReport(): TrafficCompletionReport {
  const report = completionReport();
  return {
    ...report,
    transportAttemptCounts: {
      plannedRequests: 10,
      startedRequests: 0,
      completedRequests: 0,
      interruptedRequests: 0,
      unstartedRequests: 10,
    },
    httpSummary: {
      failedRequests: 0,
      acceptedResponses: 0,
      soldOutResponses: 0,
      transportFailures: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    trafficDeliverySummary: {
      ...report.trafficDeliverySummary,
      droppedIterations: 10,
      completedIterations: 0,
    },
  };
}

function requireTestRedisUrl(): string {
  const redisUrl = process.env.TEST_REDIS_URL;
  if (!redisUrl) throw new Error("TEST_REDIS_URL is required for API tests.");
  return redisUrl;
}

function requireConnection(
  connection: ReturnType<typeof createDatabaseConnection> | null,
): ReturnType<typeof createDatabaseConnection> {
  if (!connection) throw new Error("Test database connection was not initialized.");
  return connection;
}

function requireRedis(
  redis: ReturnType<typeof createRedisClient> | null,
): ReturnType<typeof createRedisClient> {
  if (!redis) throw new Error("Test Redis client was not initialized.");
  return redis;
}
