import { randomUUID } from "node:crypto";
import type {
  PublicRuntimePolicy,
  SecuredReservationHold,
  TrafficCompletionReport,
} from "@checkout-surge/contracts";
import {
  deriveLoadExecutionPlan,
  emptyHttpTimingBreakdownSummary,
  emptyRequestArrivalSummary,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import type { SqlClient } from "@checkout-surge/db";
import {
  createDatabaseConnection,
  createRedisClient,
  demoPresets,
  demoRunSummaries,
  demoRuns,
  inventoryKeys,
  PostgresOrderDelivery,
  products,
  readBusinessOutcomeSummary,
  saleOffers,
} from "@checkout-surge/db";
import {
  createPurchaseRunFixture,
  requireTestDatabaseUrl,
  resetTestDatabase,
} from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNotificationRecordJobHandler } from "../../worker/src/application/notification-record-job-handler.js";
import { createOrderProcessJobHandler } from "../../worker/src/application/order-process-job-handler.js";
import { createOrderRecoveryHandoff } from "../../worker/src/application/order-recovery-scanner.js";
import { PostgresGeneratedRunPublicationFence } from "../../worker/src/persistence/postgres-generated-run-publication-fence.js";
import { PostgresNotificationRecordPersistence } from "../../worker/src/persistence/postgres-notification-record-persistence.js";
import { PostgresOrderRecoveryPersistence } from "../../worker/src/persistence/postgres-order-recovery-persistence.js";
import { PostgresOrderTransitionPersistence } from "../../worker/src/persistence/postgres-order-transition-persistence.js";
import { createBullMqNotificationRecordConsumer } from "../../worker/src/queue/bullmq-notification-record-consumer.js";
import { createBullMqNotificationRecordPublisher } from "../../worker/src/queue/bullmq-notification-record-publisher.js";
import { createPostgresOrderProcessConsumer } from "../../worker/src/queue/postgres-order-process-consumer.js";
import { createPostgresReserveOrderService } from "../src/runtime/create-postgres-reserve-order-service.js";
import { createRunInventoryLifecycle } from "../src/runtime/run-inventory-lifecycle.js";
import { createTerminalInventoryReadOperation } from "../src/runtime/terminal-inventory-read-operation.js";
import {
  ActiveBuyingRunContext,
  PostgresBuyingRunContextReader,
} from "../src/services/active-buying-run-context.js";
import { AdminDemoResetService } from "../src/services/admin-demo-reset-service.js";
import { localDeploymentCapacity } from "../src/services/capacity-admission.js";
import { PostgresDashboardBusinessOutcomeReader } from "../src/services/dashboard-recovery-service.js";
import { conservativeDurationEstimatorConstants } from "../src/services/demo-duration-estimator.js";
import { ProcessLocalDemoMaintenanceAuthority } from "../src/services/demo-maintenance-authority.js";
import { DemoPresetService } from "../src/services/demo-preset-service.js";
import { DemoRunFinalizationService } from "../src/services/demo-run-finalization-service.js";
import { DemoRunLifecycleService } from "../src/services/demo-run-service.js";
import {
  DemoRunStartupReconciliationService,
  PostgresStartingDemoRunReconciliationStore,
} from "../src/services/demo-run-startup-reconciliation-service.js";
import { PostgresBuyPersistence } from "../src/services/postgres-buy-persistence.js";
import { PostgresDemoResetWorkflowFence } from "../src/services/postgres-demo-reset-workflow-fence.js";
import type { BuyPersistenceOperations } from "../src/services/reserve-order-service.js";
import { PostgresTerminalDemoRunSummaryWriter } from "../src/services/terminal-demo-run-transition.js";
import { TrafficCompletionEnrichmentService } from "../src/services/traffic-completion-enrichment-service.js";
import { TrafficCompletionService } from "../src/services/traffic-completion-service.js";

let database: ReturnType<typeof createDatabaseConnection>;
let redis: ReturnType<typeof createRedisClient>;
let scope: { runId: string; saleOfferId: string; executionMode: "without_redis" };
const logger = createSilentLogger("api");
const config = previewRunConfigSnapshotFixture();
config.inventoryConfig.startingStock = 3;
config.trafficConfig = {
  mode: "buyer-spike",
  buyerCount: 5,
  duplicateEachBuyerAttempt: false,
  startDelaySeconds: 0,
  maxDurationSeconds: 5,
  quantityPerAttempt: 1,
};
let startedAt: Date;
const queueLimits = { synchronize: async () => {} };

beforeEach(async () => {
  await resetTestDatabase();
  database = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
  redis = createRedisClient(requireRedisUrl(), { lazyConnect: true });
  await redis.flushdb();
  scope = { runId: randomUUID(), saleOfferId: randomUUID(), executionMode: "without_redis" };
  const productId = randomUUID();
  startedAt = new Date();
  await database.db
    .insert(products)
    .values({ id: productId, sku: productId, slug: productId, name: "PG activation" });
  await database.db.insert(saleOffers).values({
    id: scope.saleOfferId,
    productId,
    name: "PG activation",
    allocatedStock: 3,
    saleStartsAt: startedAt,
    saleEndsAt: new Date(startedAt.getTime() + 60_000),
  });
  await createPurchaseRunFixture(database.db, scope);
  // Trusted durable acceptance is seeded; public/custom start inputs still select demo.
  await database.db
    .update(demoRuns)
    .set({
      executionMode: scope.executionMode,
      status: "starting",
      trafficStatus: "starting",
      startedAt,
      runnerBootId: randomUUID(),
      configSnapshot: config,
    })
    .where(eq(demoRuns.id, scope.runId));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await redis.flushdb();
  redis.disconnect();
  await database.close();
});

async function startBuyer() {
  const timings = vi.fn();
  const dirty = { scheduleInventory: vi.fn(), scheduleQueue: vi.fn() };
  const reader = new PostgresBuyingRunContextReader(database.db);
  const readCurrent = vi.spyOn(reader, "readCurrent");
  const demoReserve = vi.fn(async () => {
    throw new Error("Unexpected demo buying");
  });
  const context = new ActiveBuyingRunContext({
    reader,
    services: {
      demo: { reserve: demoReserve },
      without_redis: createPostgresReserveOrderService(
        database,
        {
          reservationHoldMinutes: 15,
          idempotencyTtlSeconds: 60,
          pendingPersistenceRetryAfterSeconds: 1,
          pendingPersistenceRecovery: { recoverReservation: async () => null },
          reservationTimingObservations: { observe: timings },
          dashboardSourceDirtyScheduler: dirty,
        },
        logger,
      ),
    },
  });
  await context.hydrate();
  const inventory = createRunInventoryLifecycle(database.db, redis);
  await inventory.initialize(scope, 3, startedAt);
  const startup = new DemoRunStartupReconciliationService({
    maintenanceAuthority: new ProcessLocalDemoMaintenanceAuthority(),
    logger,
    completionEnrichmentService: { completePendingEnrichment: async () => "not_found" },
    startingRunStore: new PostgresStartingDemoRunReconciliationStore(database.db),
    trafficExecutionGateway: {
      start: async (request) => ({
        runId: request.runId,
        status: "active",
        startedAt: startedAt.toISOString(),
        correlationId: request.correlationId,
      }),
    },
    undispatchedRuns: { failUndispatchedRun: async () => undefined },
    apiBaseUrl: "http://injected-traffic-edge",
    prepareBuyingRun: (runId) => context.activate(runId),
    listDrainingRuns: async () => [],
    closeRunSaleEligibility: (value) => inventory.close(value),
  });
  expect(await startup.reconcileStartingRuns()).toBe(1);
  const buy = (key: string, quantity = 1) =>
    context.reserve({
      request: {
        runId: scope.runId,
        saleOfferId: scope.saleOfferId,
        quantity,
        idempotencyKey: key,
      },
      correlationId: key,
    });
  return { context, buy, readCurrent, reader, timings, dirty, demoReserve, inventory };
}

it.each([
  1, 2,
])("isolates concurrent request admission sessions with pool %i and hydrated mode", async (max) => {
  if (max !== 1) {
    await database.close();
    database = createDatabaseConnection(requireTestDatabaseUrl(), { max });
  }
  const buyer = await startBuyer();
  const actualAdmission = PostgresBuyPersistence.prototype.withRunAdmissionLockAndSession;
  const admittedSessions = new Map<string, unknown>();
  const overlappingAdmissionPids: unknown[] = [];
  let arrivals = 0;
  let release!: () => void;
  const overlap = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(PostgresBuyPersistence.prototype, "withRunAdmissionLockAndSession").mockImplementation(
    function <T>(
      this: PostgresBuyPersistence,
      input: {
        reservation: SecuredReservationHold;
        operation: (operations: BuyPersistenceOperations, session: SqlClient) => Promise<T>;
      },
    ): Promise<T> {
      return actualAdmission.call(this, {
        ...input,
        operation: async (operations, session) => {
          const admittedPid = (await session`select pg_backend_pid() as pid`)[0]?.pid;
          expect(typeof admittedPid).toBe("number");
          admittedSessions.set(input.reservation.id, admittedPid);
          return input.operation(
            {
              ...operations,
              persistSecuredReservation: async (value) => {
                if (max === 2 && ++arrivals <= 2) {
                  overlappingAdmissionPids.push(admittedPid);
                  if (arrivals === 2) release();
                  await overlap;
                }
                return operations.persistSecuredReservation(value);
              },
            },
            session,
          );
        },
      }) as Promise<T>;
    },
  );
  const actualPublish = PostgresOrderDelivery.prototype.publish;
  const sessions: unknown[] = [];
  vi.spyOn(PostgresOrderDelivery.prototype, "publish").mockImplementation(async function (
    this: PostgresOrderDelivery,
    session,
    job,
    options,
  ) {
    const publicationPid = (await session`select pg_backend_pid() as pid`)[0]?.pid;
    expect(typeof publicationPid).toBe("number");
    expect(admittedSessions.has(job.reservationId)).toBe(true);
    expect(publicationPid).toBe(admittedSessions.get(job.reservationId));
    sessions.push(publicationPid);
    await actualPublish.call(this, session, job, options);
  });
  const responses = await Promise.all([buyer.buy("one"), buyer.buy("two"), buyer.buy("three")]);
  expect(responses.map((value) => value.outcome)).toEqual([
    "reservation_secured",
    "reservation_secured",
    "reservation_secured",
  ]);
  expect(new Set(responses.map((value) => value.reservation?.id)).size).toBe(3);
  expect(sessions).toHaveLength(3);
  if (max === 1) expect(new Set(sessions).size).toBe(1);
  if (max === 2) {
    expect(overlappingAdmissionPids).toHaveLength(2);
    expect(new Set(overlappingAdmissionPids).size).toBe(2);
  }
  expect(await buyer.buy("one")).toEqual(responses[0]);
  expect((await buyer.buy("one", 2)).outcome).toBe("idempotency_conflict");
  expect((await buyer.buy("shortage")).outcome).toBe("sold_out");
  expect((await buyer.buy("shortage-two")).outcome).toBe("sold_out");
  expect(buyer.readCurrent).toHaveBeenCalledTimes(2); // hydration and activation only
  expect(buyer.demoReserve).not.toHaveBeenCalled();
  for (const [observation] of buyer.timings.mock.calls) {
    expect(observation.reserveOrderServiceMs).toBeGreaterThanOrEqual(0);
    expect(observation).not.toHaveProperty("redisAtomicReservationMs");
  }
  expect(buyer.dirty.scheduleInventory).toHaveBeenCalledWith(
    expect.objectContaining({ correlationId: "shortage" }),
  );
  expect(await redis.exists(inventoryKeys(scope.saleOfferId).state)).toBe(0);
  expect(await redis.keys("bull:orders-process:*")).toEqual([]);
  expect(await buyer.inventory.read(scope, new Date())).toMatchObject({
    remainingStock: 0,
    reservedStock: 3,
    pendingPersistenceCount: 0,
    soldOutPressure: { rejectionCount: 2 },
  });
  expect(
    (await database.sql`select count(*)::int as count from postgres_order_deliveries`)[0]?.count,
  ).toBe(3);
});

it("buys, drains real PostgreSQL delivery and common notifications, commits an immutable PG snapshot and retires at successor initialization", async () => {
  const buyer = await startBuyer();
  const notificationConnection = { url: requireRedisUrl(), maxRetriesPerRequest: null };
  const notifications = createBullMqNotificationRecordPublisher({
    connection: notificationConnection,
    publicationFence: new PostgresGeneratedRunPublicationFence(database.db),
  });
  const notificationConsumer = createBullMqNotificationRecordConsumer({
    connection: notificationConnection,
    concurrency: 1,
    logger,
    handler: createNotificationRecordJobHandler({
      persistence: new PostgresNotificationRecordPersistence(database.db),
      logger,
      publishBusinessOutcomeUpdate: async () => {},
    }),
  });
  // Only the external confirmation outcome is injected. Business transitions and both transports are real.
  const confirm = vi.fn(async () => ({ disposition: "succeeded" }));
  const recovery = new PostgresOrderRecoveryPersistence(database.db, undefined, "without_redis");
  const orderConsumer = createPostgresOrderProcessConsumer({
    delivery: new PostgresOrderDelivery(database.sql),
    sql: database.sql,
    recovery,
    logger,
    concurrency: 1,
    scanIntervalMs: 10,
    leaseSeconds: 30,
    closeDeadlineMs: 1000,
    handler: createOrderProcessJobHandler({
      confirmation: { confirm },
      persistence: new PostgresOrderTransitionPersistence(database.db),
      recovery: createOrderRecoveryHandoff(recovery),
      logger,
      notificationRecordPublisher: notifications,
      publishBusinessOutcomeUpdate: async () => {},
    }),
  });
  const terminalRunWriter = new PostgresTerminalDemoRunSummaryWriter(database.db, queueLimits);
  const finalization = new DemoRunFinalizationService({
    db: database.db,
    redis,
    inventory: buyer.inventory,
    logger,
    queueLimits,
    terminalRunWriter,
    runnerOperations: { releaseAfterRun: () => {} },
    terminalInventoryRead: createTerminalInventoryReadOperation({
      redisUrl: requireRedisUrl(),
      timeoutMs: 1000,
    }),
    terminalInventoryReadTimeoutMs: 1000,
  });
  const completion = new TrafficCompletionService({
    db: database.db,
    redis,
    logger,
    finalizationService: finalization,
    completionEnrichmentService: new TrafficCompletionEnrichmentService({
      db: database.db,
      redis,
      inventory: buyer.inventory,
      logger,
      businessOutcomeReader: new PostgresDashboardBusinessOutcomeReader(database.db),
    }),
  });
  try {
    await Promise.all([buyer.buy("one"), buyer.buy("two"), buyer.buy("three")]);
    await buyer.buy("shortage");
    await buyer.buy("shortage-two");
    const report = completionReport();
    expect((await completion.recordTrafficCompletion(report)).status).toBe("draining");
    // Restart hydration during draining still chooses PG and preserves closed-admission vocabulary.
    await buyer.context.hydrate();
    expect((await buyer.buy("late")).outcome).toBe("run_not_accepting_traffic");
    notificationConsumer.start();
    orderConsumer.start();
    await vi.waitFor(
      async () => {
        expect(await readBusinessOutcomeSummary(database.db, scope)).toMatchObject({
          confirmedOrders: 3,
          notificationsRecorded: 3,
        });
        expect(
          (
            await database.sql`select count(*)::int as count from postgres_order_deliveries where settled_at is null`
          )[0]?.count,
        ).toBe(0);
      },
      { timeout: 5000, interval: 20 },
    );
    expect((await finalization.finalizeRun(scope.runId))?.status).toBe("completed");
    const [snapshot] = await database.db.select().from(demoRunSummaries);
    expect(snapshot?.terminalInventorySnapshot).toMatchObject({
      source: "postgres",
      remainingStock: 0,
      reservedStock: 3,
      acceptedReservations: 3,
      soldOutRejections: 2,
      pendingPersistenceCount: 0,
    });
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(
      (await database.sql`select count(*)::int as count from postgres_run_inventory`)[0]?.count,
    ).toBe(1);
    await completion.recordTrafficCompletion(report);
    expect(await database.db.select().from(demoRunSummaries)).toEqual([snapshot]);
    // Ordinary successor admission sweeps the finished PG scope and still selects demo.
    const [preset] = await database.db.select().from(demoPresets);
    if (!preset) throw new Error("Missing seeded accepted preset");
    const successor = await new DemoRunLifecycleService({
      db: database.db,
      redis,
      inventory: buyer.inventory,
      maintenanceAuthority: new ProcessLocalDemoMaintenanceAuthority(),
      queueLimits,
      terminalRunWriter,
      presetReader: new DemoPresetService({ db: database.db }),
      runtimePolicyReader: { readEffectivePolicy: async () => runtimePolicy() },
      businessOutcomeReader: new PostgresDashboardBusinessOutcomeReader(database.db),
      onRunAccepted: (runId) => buyer.context.activate(runId),
      trafficExecutionGateway: {
        start: async (request) => ({
          runId: request.runId,
          status: "active",
          startedAt: new Date().toISOString(),
          correlationId: request.correlationId,
        }),
      },
      runnerOperations: {
        bootForRun: async () => ({ machineId: null, region: null, bootId: randomUUID() }),
        releaseAfterRun: () => {},
      },
      publicRunBudgetStore: {
        reserve: async () => {
          throw new Error("Admin start has no public budget");
        },
        release: async () => {},
      },
      apiBaseUrl: "http://injected-traffic-edge",
      logger,
      publicClientCookieSecret: "activation-test-cookie-secret-32-characters",
      estimatorConstants: conservativeDurationEstimatorConstants,
      deploymentCapacity: localDeploymentCapacity,
    }).startRun({ presetSlug: preset.slug, operatorMode: "admin" }, "successor-start");
    expect(successor.run.executionMode).toBe("demo");
    expect(successor.run.status).toBe("active");
    expect(await database.db.select().from(demoRunSummaries)).toEqual([snapshot]);
    expect(await database.sql`select run_id from postgres_run_inventory`).toEqual([]);
    expect(await redis.exists(inventoryKeys(successor.run.saleOfferId ?? "").state)).toBe(1);
  } finally {
    await orderConsumer.close();
    await notificationConsumer.close();
    await notifications.close();
  }
});

it("resets actual PG buys and rehydrates the authoritative buyer slot after cleanup", async () => {
  const buyer = await startBuyer();
  expect((await buyer.buy("reset-buy")).outcome).toBe("reservation_secured");
  const resetDatabase = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
  try {
    await new AdminDemoResetService({
      db: database.db,
      redis,
      inventory: buyer.inventory,
      queueLimits,
      queueMaintenance: { cleanRuns: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }) },
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(database.db, queueLimits),
      trafficAborter: { abortCurrent: async () => ({ outcome: "no_current_run" }) },
      runnerOperations: { releaseAfterRun: () => {} },
      dashboardLiveStateReset: {
        fenceRun: async () => {},
        clearRun: async () => {},
        hasRunState: async () => false,
      },
      resetWorkflowFence: new PostgresDemoResetWorkflowFence(resetDatabase.sql),
      maintenanceAuthority: new ProcessLocalDemoMaintenanceAuthority(),
      logger,
    }).reset("activation-reset", "admin_reset");
    await buyer.context.hydrate();
    expect(await buyer.reader.readCurrent()).toBeNull();
    expect(
      (await database.sql`select count(*)::int as count from postgres_run_inventory`)[0]?.count,
    ).toBe(0);
    expect(
      (await database.sql`select count(*)::int as count from postgres_order_deliveries`)[0]?.count,
    ).toBe(0);
    expect(
      (await database.db.select().from(demoRunSummaries))[0]?.terminalInventorySnapshot?.source,
    ).toBe("postgres");
  } finally {
    await resetDatabase.close();
  }
});

function requireRedisUrl() {
  const url = process.env.TEST_REDIS_URL;
  if (!url) throw new Error("TEST_REDIS_URL is required");
  return url;
}

// Injected traffic evidence, not a generator or load measurement.
function completionReport(): TrafficCompletionReport {
  const completedAt = new Date().toISOString();
  return {
    runId: scope.runId,
    status: "succeeded",
    exitCode: 0,
    transportAttemptCounts: {
      plannedRequests: 5,
      startedRequests: 5,
      completedRequests: 5,
      interruptedRequests: 0,
      unstartedRequests: 0,
    },
    httpSummary: {
      failedRequests: 0,
      acceptedResponses: 3,
      soldOutResponses: 2,
      transportFailures: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    trafficOutcomeSummary: {},
    trafficDeliverySummary: {
      trafficMode: "buyer-spike",
      plannedBuyers: 5,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: 5,
      requestArrivalSummary: emptyRequestArrivalSummary,
      notes: [],
    },
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    loadRunDiagnosticsSummary: {
      startedAt: startedAt.toISOString(),
      completedAt,
      nproc: null,
      ulimitNofile: null,
      processMaxOpenFiles: null,
      generatorCapacity: null,
      generatorUtilisation: null,
      networkDiagnostics: null,
      k6Version: null,
      executionPlan: deriveLoadExecutionPlan(config.trafficConfig),
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

function runtimePolicy(): PublicRuntimePolicy {
  return {
    estimatedDemoOccupancyCeilingSeconds: 600,
    isPublicRunBudgetEnforced: true,
    publicRunBudget: { windowSeconds: 300, perVisitorMaxStarts: 2, globalMaxStarts: 6 },
    publicCustomDefaults: config,
    publicCustomLimits: {
      maxTotalRequests: 10_000,
      maxBuyers: 10_000,
      maxRequestsPerSecond: 1000,
      maxTrafficDurationSeconds: 120,
      maxTrafficStartDelaySeconds: 10,
      maxPreAllocatedVus: 1000,
      maxVus: 1000,
      maxStartingStock: 1000,
      maxErpLatencyMs: 2000,
      minErpMaxTps: 1,
      maxErpMaxTps: 250,
      maxErpErrorRate: 0.25,
      allowForcedOutage: false,
      allowedTrafficModes: ["buyer-spike", "constant-arrival-rate"],
    },
    deploymentHardCaps: {
      estimatedDemoOccupancyCeilingSeconds: 600,
      maxBuyers: 100_000,
      maxTotalRequests: 100_000,
      maxRequestsPerSecond: 10_000,
      maxTrafficDurationSeconds: 300,
      maxTrafficStartDelaySeconds: 30,
      maxPreAllocatedVus: 10_000,
      maxVus: 10_000,
    },
  };
}
