import { emptyHttpTimingBreakdownSummary } from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createRedisClient,
  demoPresets,
  demoRunFinalizations,
  demoRuns,
  initializeInventory,
  isRunSaleEligible,
  products,
  saleOffers,
  setRunSaleEligibility,
} from "@checkout-surge/db";
import { requireTestDatabaseUrl, resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyBusinessOutcomeSummary } from "../src/services/demo-run-projections.js";
import {
  DemoRunStartupReconciliationService,
  PostgresStartingDemoRunReconciliationStore,
} from "../src/services/demo-run-startup-reconciliation-service.js";
import { TrafficCompletionEnrichmentService } from "../src/services/traffic-completion-enrichment-service.js";

const drainingRun = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as never;

describe("DemoRunStartupReconciliationService", () => {
  it("replays a durable starting intent with the same run identity and activates it", async () => {
    const start = vi.fn(async (request) => ({
      runId: request.runId,
      status: "active" as const,
      startedAt: "2026-06-20T00:00:11.000Z",
      correlationId: request.correlationId,
    }));
    const activateStartingRun = vi.fn(async () => true);
    const service = new DemoRunStartupReconciliationService({
      ...unusedStartingRunOptions(),
      logger: createSilentLogger("api"),
      startingRunStore: {
        listStartingRuns: async () => [
          {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            saleOfferId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            configSnapshot: acceptedRunConfigSnapshot(),
          } as never,
        ],
        activateStartingRun,
      },
      trafficExecutionGateway: { start },
    });

    await expect(service.reconcileStartingRuns()).resolves.toBe(1);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        saleOfferId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        correlationId: "traffic-reconcile-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }),
    );
    expect(activateStartingRun).toHaveBeenCalledOnce();
  });

  it("repairs only startup-owned sale closure and completion enrichment", async () => {
    const closeRunSaleEligibility = vi.fn(async () => true);
    const completePendingEnrichment = vi.fn(async () => "completed" as const);
    const service = new DemoRunStartupReconciliationService({
      ...unusedStartingRunOptions(),
      logger: createSilentLogger("api"),
      listDrainingRuns: async () => [drainingRun],
      closeRunSaleEligibility,
      completionEnrichmentService: { completePendingEnrichment },
    });

    await expect(service.reconcile()).resolves.toEqual({
      discoveredRunCount: 1,
      succeededRunCount: 1,
      failedRunCount: 0,
      closedSaleOfferCount: 1,
      completionEnrichedRunCount: 1,
      failures: [],
    });
    expect(closeRunSaleEligibility).toHaveBeenCalledOnce();
    expect(completePendingEnrichment).toHaveBeenCalledOnce();
  });

  it("isolates each draining run's startup-owned failures", async () => {
    const service = new DemoRunStartupReconciliationService({
      ...unusedStartingRunOptions(),
      logger: createSilentLogger("api"),
      listDrainingRuns: async () => [drainingRun],
      closeRunSaleEligibility: async () => {
        throw new Error("redis unavailable");
      },
      completionEnrichmentService: { completePendingEnrichment: async () => "completed" },
    });

    await expect(service.reconcile()).resolves.toMatchObject({
      discoveredRunCount: 1,
      failedRunCount: 1,
      failures: [{ stages: ["eligibility_close"] }],
    });
  });
});

describe("DemoRunStartupReconciliationService restart recovery", () => {
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
    await seedPendingCompletion(requireConnection(connection));
    await initializeInventory(requireRedis(redis), {
      saleOfferId: restartSaleOfferId,
      allocatedStock: 10,
      source: "demo_run_start",
      initializedAt: restartAcceptedAt,
      run: { runId: restartRunId, status: "accepting" },
    });
  });

  afterAll(async () => {
    await connection?.close();
    if (redis) {
      await redis.flushdb();
      redis.disconnect();
    }
  });

  it("converges a durable pending enrichment after restart without a periodic scanner", async () => {
    const activeConnection = requireConnection(connection);
    const redisClient = requireRedis(redis);
    const enrichmentService = new TrafficCompletionEnrichmentService({
      db: activeConnection.db,
      redis: redisClient,
      businessOutcomeReader: { read: async () => emptyBusinessOutcomeSummary() },
      logger: createSilentLogger("api"),
      now: () => new Date("2026-07-20T00:00:11.000Z"),
    });
    const service = new DemoRunStartupReconciliationService({
      logger: createSilentLogger("api"),
      completionEnrichmentService: enrichmentService,
      startingRunStore: new PostgresStartingDemoRunReconciliationStore(activeConnection.db),
      trafficExecutionGateway: {
        start: async () => {
          throw new Error("No starting traffic intent should exist.");
        },
      },
      apiBaseUrl: "http://api.test",
      buyEndpointPath: "/buy",
      listDrainingRuns: () =>
        activeConnection.db.select().from(demoRuns).where(eq(demoRuns.status, "draining")),
      closeRunSaleEligibility: ({ runId, saleOfferId }) =>
        setRunSaleEligibility(redisClient, { runId, saleOfferId, status: "closed" }),
    });

    await expect(service.reconcile()).resolves.toMatchObject({
      discoveredRunCount: 1,
      succeededRunCount: 1,
      completionEnrichedRunCount: 1,
    });
    const [finalization] = await activeConnection.db
      .select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, restartRunId));
    expect(finalization?.completionEnrichmentStatus).toBe("completed");
    expect(finalization?.trafficOutcomeSummary).toMatchObject({
      businessOutcomeAtTrafficCompletion: emptyBusinessOutcomeSummary(),
      terminalInventorySnapshot: { saleOfferId: restartSaleOfferId, source: "redis" },
    });
    await expect(
      isRunSaleEligible(redisClient, {
        runId: restartRunId,
        saleOfferId: restartSaleOfferId,
      }),
    ).resolves.toBe(false);
  });
});

function unusedStartingRunOptions() {
  return {
    listDrainingRuns: async () => [],
    closeRunSaleEligibility: async () => false,
    completionEnrichmentService: {
      completePendingEnrichment: async () => "already_completed" as const,
    },
    startingRunStore: {
      listStartingRuns: async () => [],
      activateStartingRun: async () => false,
    },
    trafficExecutionGateway: {
      start: async () => {
        throw new Error("No starting run should be reconciled.");
      },
    },
    apiBaseUrl: "http://api.test",
    buyEndpointPath: "/buy",
  };
}

function acceptedRunConfigSnapshot() {
  return {
    trafficConfig: {
      mode: "buyer-spike" as const,
      buyerCount: 10,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 5,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 10,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 100,
      maxTps: 10,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 2_000,
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

const restartRunId = "11111111-1111-4111-8111-111111111112";
const restartPresetId = "22222222-2222-4222-8222-222222222223";
const restartProductId = "33333333-3333-4333-8333-333333333334";
const restartSaleOfferId = "44444444-4444-4444-8444-444444444445";
const restartAcceptedAt = new Date("2026-07-20T00:00:00.000Z");

async function seedPendingCompletion(
  connection: ReturnType<typeof createDatabaseConnection>,
): Promise<void> {
  const configSnapshot = acceptedRunConfigSnapshot();
  await connection.db.insert(products).values({
    id: restartProductId,
    sku: "STARTUP-RECOVERY-001",
    slug: "startup-recovery-product",
    name: "Startup Recovery Product",
    isActive: true,
    createdAt: restartAcceptedAt,
    updatedAt: restartAcceptedAt,
  });
  await connection.db.insert(demoPresets).values({
    id: restartPresetId,
    slug: "startup-recovery-preset",
    visibility: "admin",
    isEditable: false,
    isCustom: false,
    display: {
      name: "Startup Recovery Preset",
      description: "Pending completion startup fixture.",
      sortOrder: 1,
      outcomeFocus: [],
    },
    ...configSnapshot,
    createdAt: restartAcceptedAt,
    updatedAt: restartAcceptedAt,
  });
  await connection.db.insert(saleOffers).values({
    id: restartSaleOfferId,
    productId: restartProductId,
    name: "Startup Recovery Offer",
    allocatedStock: 10,
    saleStartsAt: restartAcceptedAt,
    saleEndsAt: new Date("2026-07-21T00:00:00.000Z"),
    isActive: true,
    purpose: "generated_run",
    createdAt: restartAcceptedAt,
    updatedAt: restartAcceptedAt,
  });
  await connection.db.insert(demoRuns).values({
    id: restartRunId,
    presetId: restartPresetId,
    presetName: "Startup Recovery Preset",
    operatorMode: "admin",
    status: "draining",
    trafficStatus: "succeeded",
    configSnapshot,
    saleOfferId: restartSaleOfferId,
    startedAt: restartAcceptedAt,
    trafficStartedAt: new Date("2026-07-20T00:00:01.000Z"),
    trafficEndedAt: new Date("2026-07-20T00:00:10.000Z"),
    createdAt: restartAcceptedAt,
    updatedAt: new Date("2026-07-20T00:00:10.000Z"),
  });
  await connection.db.insert(demoRunFinalizations).values({
    runId: restartRunId,
    exitCode: 0,
    errorMessage: null,
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
      droppedIterations: 10,
      completedIterations: 0,
      trafficDeliveryStatus: "failed",
      notes: [],
    },
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    loadRunDiagnosticsSummary: restartDiagnostics(),
    completionEnrichmentStatus: "pending",
    trafficSummaryReceivedAt: new Date("2026-07-20T00:00:10.000Z"),
    createdAt: new Date("2026-07-20T00:00:10.000Z"),
    updatedAt: new Date("2026-07-20T00:00:10.000Z"),
  });
}

function restartDiagnostics() {
  const completedAt = "2026-07-20T00:00:10.000Z";
  return {
    startedAt: "2026-07-20T00:00:01.000Z",
    completedAt,
    nproc: null,
    ulimitNofile: null,
    processMaxOpenFiles: null,
    networkDiagnostics: null,
    k6Version: null,
    executionPlan: {
      trafficMode: "buyer-spike" as const,
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
