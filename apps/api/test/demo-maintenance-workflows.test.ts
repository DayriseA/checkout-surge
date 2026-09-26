import { once } from "node:events";
import {
  type AcceptedRunConfigSnapshot,
  type DashboardProjection,
  destructiveResetReasonValues,
  emptyHttpTimingBreakdownSummary,
  emptyRequestArrivalSummary,
  orderProcessBullMqQueueName,
  orderProcessJobName,
  orderProcessJobSchema,
  trafficDeliverySummarySchema,
} from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createRedisClient,
  createRedisDashboardProjectionDirtySubscriber,
  deleteGeneratedRunDurable,
  deleteGeneratedRunRedisState,
  demoPresets,
  demoRunFinalizations,
  demoRunSaleContexts,
  demoRunSoldOutCounts,
  demoRunSummaries,
  demoRuns,
  erpAttempts,
  erpDispatchCalls,
  initializeInventory,
  inspectGeneratedRunTeardown,
  inventoryKeys,
  isRunSaleEligible,
  markReservationPendingPersistence,
  orderDeadLetters,
  orderEvents,
  orderRecoveryJobs,
  orders,
  products,
  promoteReservationIdempotencyToAccepted,
  purgeResetRunDurable,
  reservationPendingPersistence,
  reservations,
  reserveInventoryStock,
  saleOffers,
  simulatedNotifications,
} from "@checkout-surge/db";
import { requireTestDatabaseUrl, resetTestDatabase } from "@checkout-surge/db/testing";
import { type CheckoutSurgeLogger, createSilentLogger } from "@checkout-surge/logger";
import { Queue, QueueEvents, Worker } from "bullmq";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDashboardProjectionState,
  dashboardProjectionStateReducer,
} from "../../web/src/app/lib/dashboard-projection-state.js";
import { createOrderProcessJobHandler } from "../../worker/src/application/order-process-job-handler.js";
import { PostgresOrderTransitionPersistence } from "../../worker/src/persistence/postgres-order-transition-persistence.js";
import { createBullMqDemoQueueMaintenance } from "../src/queue/bullmq-demo-queue-maintenance.js";
import { createDashboardRecoveryOperationFactory } from "../src/runtime/dashboard-recovery-operation-factory.js";
import { ApiHttpError } from "../src/runtime/errors.js";
import { AdminDemoResetService } from "../src/services/admin-demo-reset-service.js";
import { AutomaticRunResetService } from "../src/services/automatic-run-reset-service.js";
import { DashboardProjectionPublicationScheduler } from "../src/services/dashboard-projection-publication-scheduler.js";
import { DashboardProjectionService } from "../src/services/dashboard-recovery-service.js";
import { RedisDashboardTrafficMetricStore } from "../src/services/dashboard-traffic-metric-store.js";
import {
  type DemoMaintenanceAuthority,
  ProcessLocalDemoMaintenanceAuthority,
} from "../src/services/demo-maintenance-authority.js";
import type { ExactRunQueueMaintenance } from "../src/services/demo-queue-maintenance.js";
import { toDemoRunSnapshot } from "../src/services/demo-run-projections.js";
import { GeneratedRunRetentionService } from "../src/services/generated-run-retention-service.js";
import { GeneratedRunTeardownService } from "../src/services/generated-run-teardown-service.js";
import { PostgresBuyPersistence } from "../src/services/postgres-buy-persistence.js";
import {
  ReserveOrderService,
  type StockReservationGateway,
} from "../src/services/reserve-order-service.js";
import { RunHistoryService } from "../src/services/run-history-service.js";
import { PostgresTerminalDemoRunSummaryWriter } from "../src/services/terminal-demo-run-transition.js";

const ids = {
  product: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  preset: "33333333-3333-4333-8333-333333333331",
  startingRun: "55555555-5555-4555-8555-555555555551",
  activeRun: "55555555-5555-4555-8555-555555555552",
  drainingRun: "55555555-5555-4555-8555-555555555553",
  completedRun: "55555555-5555-4555-8555-555555555554",
  failedRun: "55555555-5555-4555-8555-555555555555",
  catalogRun: "55555555-5555-4555-8555-555555555556",
  startingOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  activeOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
  drainingOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
  completedOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
  failedOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5",
  catalogOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6",
  activeReservation: "77777777-7777-4777-8777-777777777771",
  completedReservation: "77777777-7777-4777-8777-777777777772",
  activeOrder: "88888888-8888-4888-8888-888888888881",
  completedOrder: "88888888-8888-4888-8888-888888888882",
} as const;

type MaintenanceTestContext = {
  db: ReturnType<typeof createDatabaseConnection>["db"];
  redis: ReturnType<typeof createRedisClient>;
  logger: CheckoutSurgeLogger;
  now?: () => Date;
  maintenanceAuthority?: DemoMaintenanceAuthority;
};

type TeardownTestOptions = MaintenanceTestContext & {
  queueMaintenance: ExactRunQueueMaintenance;
  deleteGeneratedRunRedisState?: typeof deleteGeneratedRunRedisState;
  inspectGeneratedRunTeardown?: typeof inspectGeneratedRunTeardown;
  deleteGeneratedRunDurable?: typeof deleteGeneratedRunDurable;
};

type ResetTestOptions = MaintenanceTestContext & {
  queueMaintenance: ExactRunQueueMaintenance;
  terminalRunWriter: ConstructorParameters<typeof AdminDemoResetService>[0]["terminalRunWriter"];
  trafficAborter?: ConstructorParameters<typeof AdminDemoResetService>[0]["trafficAborter"];
  dashboardLiveStateReset?: ConstructorParameters<
    typeof AdminDemoResetService
  >[0]["dashboardLiveStateReset"];
  resetWorkflowFence?: ConstructorParameters<typeof AdminDemoResetService>[0]["resetWorkflowFence"];
  purgeResetRunDurable?: typeof purgeResetRunDurable;
};

function createTeardownService(options: TeardownTestOptions): GeneratedRunTeardownService {
  return new GeneratedRunTeardownService({
    db: options.db,
    redis: options.redis,
    deleteGeneratedRunRedisState,
    inspectGeneratedRunTeardown,
    deleteGeneratedRunDurable,
    ...pickDefined(options, [
      "deleteGeneratedRunRedisState",
      "inspectGeneratedRunTeardown",
      "deleteGeneratedRunDurable",
    ]),
    queueMaintenance: options.queueMaintenance,
    maintenanceAuthority:
      options.maintenanceAuthority ?? new ProcessLocalDemoMaintenanceAuthority(),
    logger: options.logger,
    ...(options.now ? { now: options.now } : {}),
  });
}

function createIntegratedRetentionService(
  options: TeardownTestOptions,
): GeneratedRunRetentionService {
  const maintenanceAuthority =
    options.maintenanceAuthority ?? new ProcessLocalDemoMaintenanceAuthority();
  return new GeneratedRunRetentionService({
    db: options.db,
    generatedRunTeardown: createTeardownService({ ...options, maintenanceAuthority }),
    maintenanceAuthority,
    ...(options.now ? { now: options.now } : {}),
  });
}

function createResetService(options: ResetTestOptions): AdminDemoResetService {
  return new AdminDemoResetService({
    queueLimits: { synchronize: async () => {} },
    db: options.db,
    redis: options.redis,
    queueMaintenance: options.queueMaintenance,
    terminalRunWriter: options.terminalRunWriter,
    logger: options.logger,
    trafficAborter: options.trafficAborter ?? {
      abortCurrent: async () => ({ outcome: "no_current_run" as const }),
    },
    dashboardLiveStateReset: options.dashboardLiveStateReset ?? {
      fenceRun: async () => undefined,
      clearRun: async () => undefined,
      hasRunState: async () => false,
    },
    resetWorkflowFence: options.resetWorkflowFence ?? {
      runExclusive: async (operation) => operation(),
    },
    maintenanceAuthority:
      options.maintenanceAuthority ?? new ProcessLocalDemoMaintenanceAuthority(),
    ...(options.purgeResetRunDurable ? { purgeResetRunDurable: options.purgeResetRunDurable } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

function noOpGeneratedRunQueueMaintenance(): ExactRunQueueMaintenance {
  return {
    cleanRuns: async (runIds) => ({
      cleanedQueueCount: runIds.length > 0 ? 2 : 0,
      cleanedJobCount: 0,
    }),
  };
}

function pickDefined<T extends object, K extends keyof T>(
  source: T,
  keys: K[],
): Partial<Pick<T, K>> {
  return Object.fromEntries(
    keys.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])),
  ) as Partial<Pick<T, K>>;
}

describe("focused demo maintenance workflows", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;
  let redis: ReturnType<typeof createRedisClient> | null = null;

  beforeEach(async () => {
    await connection?.close();
    redis?.disconnect();
    connection = null;
    redis = null;

    await resetTestDatabase();
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    redis = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    await redis.flushdb();
  });

  describe("exact generated-run teardown workflow", () => {
    it("keeps durable identity through queue and Redis failures, then deletes the exact graph", async () => {
      const dbConnection = requireConnection(connection);
      const db = dbConnection.db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.completedRun,
        saleOfferId: ids.completedOffer,
        status: "completed",
        trafficStatus: "succeeded",
        failureReason: null,
        runInventoryStatus: "closed",
      });
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
        runInventoryStatus: "accepting",
      });
      await seedCleanupDurableGraph(db);
      await redisClient.set(`demo-run:${ids.completedRun}:traffic-metrics`, "metric");
      await redisClient.set(`demo-run:${ids.activeRun}:traffic-metrics`, "active-metric");
      await redisClient.set(`demo-run:${ids.completedRun}:traffic-metrics-reset-fence`, "reset");
      await redisClient.hset(
        `demo-run:${ids.completedRun}:traffic-metrics-pinned`,
        "traffic.request_arrival_rate",
        "metric",
      );
      await redisClient.hset(
        `demo-run:${ids.activeRun}:traffic-metrics-pinned`,
        "traffic.request_arrival_rate",
        "active-metric",
      );

      let queueFailure: Error | undefined = new Error("queue unavailable");
      let redisFailure: Error | undefined;
      const cleanedRunIds: string[][] = [];
      const service = createTeardownService({
        db,
        redis: redisClient,
        queueMaintenance: {
          cleanRuns: async (runIds) => {
            cleanedRunIds.push([...runIds]);
            if (queueFailure) throw queueFailure;
            return { cleanedQueueCount: 2, cleanedJobCount: 2 };
          },
        },
        deleteGeneratedRunRedisState: async (...args) => {
          if (redisFailure) throw redisFailure;
          return deleteGeneratedRunRedisState(...args);
        },
        logger: createSilentLogger("api"),
        now: () => new Date("2026-07-13T00:00:00.000Z"),
      });

      await expect(
        service.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-queue" }),
      ).rejects.toThrow("queue unavailable");
      expect(
        await db.select().from(demoRuns).where(eq(demoRuns.id, ids.completedRun)),
      ).toHaveLength(1);

      queueFailure = undefined;
      redisFailure = new Error("redis unavailable");
      await expect(
        service.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-redis" }),
      ).rejects.toThrow("redis unavailable");
      expect(
        await db.select().from(demoRuns).where(eq(demoRuns.id, ids.completedRun)),
      ).toHaveLength(1);

      redisFailure = undefined;
      await expect(
        service.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-success" }),
      ).resolves.toEqual({
        outcome: "deleted",
        runId: ids.completedRun,
        saleOfferId: ids.completedOffer,
        cleanup: { redisKeysDeleted: 7, queueJobsDeleted: 2 },
        cleanedAt: "2026-07-13T00:00:00.000Z",
        correlationId: "corr-success",
      });
      expect(cleanedRunIds).toEqual([[ids.completedRun], [ids.completedRun], [ids.completedRun]]);
      expect(await readRunScopedGraphCounts(db, ids.completedRun)).toEqual({
        erpAttempts: 0,
        finalizations: 0,
        notifications: 0,
        orderEvents: 0,
        orders: 0,
        outcomes: 0,
        pendingPersistence: 0,
        reservations: 0,
        summaries: 0,
      });
      expect(await db.select().from(demoRuns).where(eq(demoRuns.id, ids.activeRun))).toHaveLength(
        1,
      );
      expect(await redisClient.get(`demo-run:${ids.activeRun}:traffic-metrics`)).toBe(
        "active-metric",
      );
      expect(await redisClient.exists(`demo-run:${ids.completedRun}:traffic-metrics-pinned`)).toBe(
        0,
      );
      expect(await redisClient.exists(`demo-run:${ids.activeRun}:traffic-metrics-pinned`)).toBe(1);
      await expect(
        service.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-absent" }),
      ).resolves.toMatchObject({ outcome: "already_absent", runId: ids.completedRun });
      expect(cleanedRunIds).toHaveLength(3);
    });

    it("leaves the full durable graph retryable when transactional deletion fails", async () => {
      const dbConnection = requireConnection(connection);
      const db = dbConnection.db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.completedRun,
        saleOfferId: ids.completedOffer,
        status: "completed",
        trafficStatus: "succeeded",
        failureReason: null,
        runInventoryStatus: "closed",
      });
      await seedCleanupDurableGraph(db);
      await dbConnection.sql`
        CREATE TABLE task_35_order_delete_blocker (
          order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT
        )
      `;
      await dbConnection.sql`
        INSERT INTO task_35_order_delete_blocker (order_id) VALUES (${ids.completedOrder})
      `;
      const service = createTeardownService({
        db,
        redis: redisClient,
        queueMaintenance: {
          cleanRuns: async () => ({ cleanedQueueCount: 2, cleanedJobCount: 0 }),
        },
        logger: createSilentLogger("api"),
      });
      try {
        await expect(
          service.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-db-fail" }),
        ).rejects.toThrow();
        expect(await readRunScopedGraphCounts(db, ids.completedRun)).toEqual({
          erpAttempts: 1,
          finalizations: 1,
          notifications: 1,
          orderEvents: 1,
          orders: 1,
          outcomes: 1,
          pendingPersistence: 1,
          reservations: 1,
          summaries: 1,
        });
        expect(
          await db.select().from(demoRuns).where(eq(demoRuns.id, ids.completedRun)),
        ).toHaveLength(1);
      } finally {
        await dbConnection.sql`DROP TABLE IF EXISTS task_35_order_delete_blocker`;
      }

      await expect(
        service.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-db-retry" }),
      ).resolves.toMatchObject({ outcome: "deleted", saleOfferId: ids.completedOffer });
    });

    it("rejects an active run before infrastructure cleanup", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.completedRun,
        saleOfferId: ids.completedOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
      });
      const cleanRuns = vi.fn(async () => ({ cleanedQueueCount: 2, cleanedJobCount: 0 }));
      const service = createTeardownService({
        db,
        redis: redisClient,
        queueMaintenance: { cleanRuns },
        logger: createSilentLogger("api"),
      });

      await expect(
        service.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-guard" }),
      ).rejects.toMatchObject({
        statusCode: 409,
        details: { conflictReason: "non_terminal" },
      });
      expect(cleanRuns).not.toHaveBeenCalled();
    });

    it("rejects outstanding work before queue or Redis cleanup", async () => {
      const cleanRuns = vi.fn(async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }));
      const deleteRedisState = vi.fn(async () => ({ deletedKeyCount: 0 }));
      const deleteDurable = vi.fn(async () => ({ outcome: "deleted" as const }));
      const service = createTeardownService({
        db: requireConnection(connection).db,
        redis: requireRedis(redis),
        queueMaintenance: { cleanRuns },
        inspectGeneratedRunTeardown: async () => ({ outcome: "outstanding_work" }),
        deleteGeneratedRunRedisState: deleteRedisState,
        deleteGeneratedRunDurable: deleteDurable,
        logger: createSilentLogger("api"),
      });

      await expect(
        service.teardownGeneratedRun({
          runId: ids.completedRun,
          correlationId: "corr-outstanding-work",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        details: { conflictReason: "outstanding_work" },
      });
      expect(cleanRuns).not.toHaveBeenCalled();
      expect(deleteRedisState).not.toHaveBeenCalled();
      expect(deleteDurable).not.toHaveBeenCalled();
    });

    it("rejects catalog ownership without queue, Redis, or durable mutation", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedCatalogReferencedTerminalRun(db);
      const cleanRuns = vi.fn(async () => ({ cleanedQueueCount: 2, cleanedJobCount: 0 }));
      const service = createTeardownService({
        db,
        redis: redisClient,
        queueMaintenance: { cleanRuns },
        logger: createSilentLogger("api"),
      });

      await expect(
        service.teardownGeneratedRun({ runId: ids.catalogRun, correlationId: "corr-catalog" }),
      ).rejects.toMatchObject({
        statusCode: 409,
        details: { conflictReason: "ownership_mismatch" },
      });
      expect(cleanRuns).not.toHaveBeenCalled();
      expect(await db.select().from(demoRuns).where(eq(demoRuns.id, ids.catalogRun))).toHaveLength(
        1,
      );
      expect(
        await db.select().from(saleOffers).where(eq(saleOffers.id, ids.catalogOffer)),
      ).toHaveLength(1);
    });

    it("fails closed when a terminal run is missing its generated sale context", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.completedRun,
        saleOfferId: ids.completedOffer,
        status: "completed",
        trafficStatus: "succeeded",
        failureReason: null,
      });
      await db.delete(demoRunSaleContexts).where(eq(demoRunSaleContexts.runId, ids.completedRun));
      const cleanRuns = vi.fn(async () => ({ cleanedQueueCount: 2, cleanedJobCount: 0 }));
      const deleteRedisState = vi.fn(async () => ({ deletedKeyCount: 0 }));
      const service = createTeardownService({
        db,
        redis: redisClient,
        queueMaintenance: { cleanRuns },
        deleteGeneratedRunRedisState: deleteRedisState,
        logger: createSilentLogger("api"),
      });

      await expect(
        service.teardownGeneratedRun({
          runId: ids.completedRun,
          correlationId: "corr-missing-sale-context",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        details: { conflictReason: "ownership_mismatch" },
      });
      expect(cleanRuns).not.toHaveBeenCalled();
      expect(deleteRedisState).not.toHaveBeenCalled();
      await expect(
        db.select().from(demoRuns).where(eq(demoRuns.id, ids.completedRun)),
      ).resolves.toHaveLength(1);
    });
  });

  describe("shared maintenance authority", () => {
    it("finishes an exact teardown before admitting reset queue maintenance", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.completedRun,
        saleOfferId: ids.completedOffer,
        status: "completed",
        trafficStatus: "succeeded",
        failureReason: null,
        runInventoryStatus: "closed",
      });
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
        runInventoryStatus: "accepting",
      });

      const events: string[] = [];
      let allowTeardown!: () => void;
      let teardownEntered!: () => void;
      const teardownGate = new Promise<void>((resolve) => {
        allowTeardown = resolve;
      });
      const teardownStarted = new Promise<void>((resolve) => {
        teardownEntered = resolve;
      });
      const queueMaintenance: ExactRunQueueMaintenance = {
        cleanRuns: async (runIds) => {
          events.push(`clean:${runIds.join(",")}`);
          if (runIds.includes(ids.completedRun)) {
            teardownEntered();
            await teardownGate;
          }
          return { cleanedQueueCount: 2, cleanedJobCount: 0 };
        },
      };
      const maintenanceAuthority = new ProcessLocalDemoMaintenanceAuthority();
      const logger = createSilentLogger("api");
      const teardown = createTeardownService({
        db,
        redis: redisClient,
        queueMaintenance,
        maintenanceAuthority,
        logger,
      });
      const reset = createResetService({
        db,
        redis: redisClient,
        queueMaintenance,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
          synchronize: async () => {},
        }),
        maintenanceAuthority,
        logger,
        resetWorkflowFence: {
          runExclusive: async (operation) => {
            events.push("reset-started");
            return operation();
          },
        },
      });

      const teardownPromise = teardown.teardownGeneratedRun({
        runId: ids.completedRun,
        correlationId: "corr-teardown",
      });
      await teardownStarted;
      const resetPromise = reset.reset("corr-reset");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events).not.toContain("reset-started");

      allowTeardown();
      await expect(teardownPromise).resolves.toMatchObject({ outcome: "deleted" });
      await expect(resetPromise).resolves.toMatchObject({ failedRunCount: 1 });
      expect(events).toEqual([
        `clean:${ids.completedRun}`,
        "reset-started",
        `clean:${ids.activeRun}`,
      ]);
    });
  });

  afterAll(async () => {
    await connection?.close();
    if (redis) {
      await redis.flushdb();
      redis.disconnect();
    }
  });

  describe("automatic reset deadline checks", () => {
    it.each([
      "starting",
      "active",
      "draining",
    ] as const)("checks %s against durable acceptance, including the first check after restart", async (status) => {
      const db = requireConnection(connection).db;
      await seedBase(db);
      await seedRun(db, requireRedis(redis), {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status,
        trafficStatus: status === "draining" ? "succeeded" : status,
        failureReason: null,
      });
      let now = new Date("2026-06-20T00:14:59.999Z");
      const reset = vi.fn().mockResolvedValue({});
      const createService = () =>
        new AutomaticRunResetService({
          db,
          resetWorkflow: { reset, hasPendingAutomaticResetCleanup: async () => false },
          now: () => now,
        });
      const service = createService();
      await service.check();
      expect(reset).not.toHaveBeenCalled();
      const [run] = await db.select().from(demoRuns);
      if (!run) throw new Error("Missing run");
      expect(toDemoRunSnapshot(run).autoResetAt).toBe("2026-06-20T00:15:00.000Z");
      now = new Date("2026-06-20T00:15:00.001Z");
      await service.check();
      expect(reset).toHaveBeenCalledWith(expect.any(String), "auto_reset");
      reset.mockClear();
      await createService().check();
      expect(reset).toHaveBeenCalledOnce();
      await service.close();
      reset.mockClear();
      await service.check();
      expect(reset).not.toHaveBeenCalled();
    });

    it.each(["completed", "failed"] as const)("never resets an overdue %s run", async (status) => {
      const db = requireConnection(connection).db;
      await seedBase(db);
      await seedRun(db, requireRedis(redis), {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status,
        trafficStatus: status === "completed" ? "succeeded" : "failed",
        failureReason: status === "failed" ? "traffic_failed" : null,
      });
      const reset = vi.fn();
      await new AutomaticRunResetService({
        db,
        resetWorkflow: { reset, hasPendingAutomaticResetCleanup: async () => false },
        now: () => new Date("2026-06-20T00:16:00.000Z"),
      }).check();
      expect(reset).not.toHaveBeenCalled();
    });

    it("resumes an interrupted automatic reset on the first check after restart", async () => {
      const db = requireConnection(connection).db;
      await seedBase(db);
      await seedRun(db, requireRedis(redis), {
        runId: ids.failedRun,
        saleOfferId: ids.failedOffer,
        status: "failed",
        trafficStatus: "failed",
        failureReason: "auto_reset",
      });
      const reset = vi.fn().mockResolvedValue({});
      await new AutomaticRunResetService({
        db,
        resetWorkflow: { reset, hasPendingAutomaticResetCleanup: async () => false },
        now: () => new Date("2026-06-20T00:16:00.000Z"),
      }).check();
      expect(reset).toHaveBeenCalledWith(expect.any(String), "auto_reset");
    });

    it("finishes failed post-purge shared cleanup on a later automatic check", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
        runInventoryStatus: "accepting",
      });
      await seedActiveRunBusinessState(db, redisClient);
      const now = () => new Date("2026-06-20T00:15:01.000Z");
      const metrics = new RedisDashboardTrafficMetricStore(redisClient);
      const clearRun = vi
        .fn()
        .mockRejectedValueOnce(new Error("Redis unavailable"))
        .mockImplementation((runId: string) => metrics.clearRun(runId));
      const cleanRuns = vi.fn().mockResolvedValue({ cleanedQueueCount: 2, cleanedJobCount: 0 });
      const createWorkflow = () =>
        createResetService({
          db,
          redis: redisClient,
          now,
          terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
            synchronize: async () => {},
          }),
          queueMaintenance: { cleanRuns },
          dashboardLiveStateReset: {
            fenceRun: (runId) => metrics.fenceRun(runId),
            hasRunState: (runId) => metrics.hasRunState(runId),
            clearRun,
          },
          logger: createSilentLogger("api"),
        });
      await expect(
        new AutomaticRunResetService({ db, now, resetWorkflow: createWorkflow() }).check(),
      ).rejects.toThrow("Retry reset to finish projection cleanup");
      expect(await db.select().from(orders)).toHaveLength(0);
      expect((await db.select().from(demoRuns))[0]).toMatchObject({
        status: "failed",
        failureReason: "auto_reset",
        adminResetCompletedAt: now(),
      });
      const summaries = await db.select().from(demoRunSummaries);
      expect(summaries).toHaveLength(1);
      const workflow = createWorkflow();
      expect(await workflow.hasPendingAutomaticResetCleanup()).toBe(true);
      const automaticReset = new AutomaticRunResetService({ db, now, resetWorkflow: workflow });
      await automaticReset.check();
      expect(clearRun).toHaveBeenCalledTimes(2);
      expect(cleanRuns).toHaveBeenCalledOnce();
      expect(await metrics.hasRunState(ids.activeRun)).toBe(false);
      expect(await workflow.hasPendingAutomaticResetCleanup()).toBe(false);
      expect(await db.select().from(demoRunSummaries)).toEqual(summaries);
      await automaticReset.check();
      expect(clearRun).toHaveBeenCalledTimes(2);
    });

    it("rechecks the deadline under the reset fence so a successor is untouched", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
      });
      const now = () => new Date("2026-06-20T00:15:01.000Z");
      const reset = createResetService({
        db,
        redis: redisClient,
        now,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
          synchronize: async () => {},
        }),
        queueMaintenance: noOpGeneratedRunQueueMaintenance(),
        logger: createSilentLogger("api"),
      });
      await new AutomaticRunResetService({
        db,
        now,
        resetWorkflow: {
          hasPendingAutomaticResetCleanup: () => reset.hasPendingAutomaticResetCleanup(),
          reset: async (correlationId, reason) => {
            await reset.reset("admin-race", "admin_reset");
            await seedRun(db, redisClient, {
              runId: ids.startingRun,
              saleOfferId: ids.startingOffer,
              status: "starting",
              trafficStatus: "starting",
              failureReason: null,
              createdAt: now(),
            });
            return reset.reset(correlationId, reason);
          },
        },
      }).check();
      expect(await db.select().from(demoRuns).where(eq(demoRuns.status, "starting"))).toHaveLength(
        1,
      );
      expect(await db.select().from(demoRunSummaries)).toHaveLength(1);
    });
  });

  describe("admin reset workflow", () => {
    it.each(
      destructiveResetReasonValues,
    )("%s purges queued, processing, and unresolved dispatched work without ERP coordination", async (reason) => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      const queuedReservationId = "77777777-7777-4777-8777-777777777773";
      const queuedOrderId = "88888888-8888-4888-8888-888888888883";
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
        runInventoryStatus: "accepting",
      });
      await seedActiveRunBusinessState(db, redisClient);
      await db
        .update(orders)
        .set({ status: "processing", processingAt: new Date("2026-06-20T00:00:04.000Z") })
        .where(eq(orders.id, ids.activeOrder));
      await db.insert(orderRecoveryJobs).values({
        recoveryKey: `order:${ids.activeOrder}`,
        jobId: "active-processing-job",
        orderId: ids.activeOrder,
        payload: {},
        reason: "initial_dispatch_ownership",
        status: "enqueued",
      });
      await db.insert(erpDispatchCalls).values({
        orderId: ids.activeOrder,
        processingGeneration: 0,
        idempotencyKey: `erp-confirmation:${ids.activeOrder}`,
        publicOrderId: "active-order",
        reservationId: ids.activeReservation,
        saleOfferId: ids.activeOffer,
        runId: ids.activeRun,
        quantity: 1,
        correlationId: "corr-active-business",
        dispatchedAt: new Date("2026-06-20T00:00:05.000Z"),
      });
      await db.insert(reservations).values({
        id: queuedReservationId,
        saleOfferId: ids.activeOffer,
        runId: ids.activeRun,
        correlationId: "corr-queued-business",
        quantity: 1,
        reservationToken: "queued-token",
        securedAt: new Date("2026-06-20T00:00:02.000Z"),
        expiresAt: new Date("2026-06-20T00:15:02.000Z"),
      });
      await db.insert(orders).values({
        id: queuedOrderId,
        publicOrderId: "queued-order",
        saleOfferId: ids.activeOffer,
        reservationId: queuedReservationId,
        runId: ids.activeRun,
        correlationId: "corr-queued-business",
        quantity: 1,
        status: "queued",
        queuedAt: new Date("2026-06-20T00:00:03.000Z"),
      });
      const service = createResetService({
        db,
        redis: redisClient,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
          synchronize: async () => {},
        }),
        queueMaintenance: noOpGeneratedRunQueueMaintenance(),
        logger: createSilentLogger("api"),
      });

      await expect(service.reset("corr-destructive-reset", reason)).resolves.toMatchObject({
        failedRunCount: 1,
      });
      await expect(db.select().from(orders)).resolves.toHaveLength(0);
      await expect(db.select().from(reservations)).resolves.toHaveLength(0);
      await expect(db.select().from(orderRecoveryJobs)).resolves.toHaveLength(0);
      await expect(db.select().from(erpDispatchCalls)).resolves.toHaveLength(0);
      await expect(db.select().from(demoRunSummaries)).resolves.toHaveLength(1);
      await expect(
        db.select().from(demoRunSaleContexts).where(eq(demoRunSaleContexts.runId, ids.activeRun)),
      ).resolves.toHaveLength(1);
      await expect(
        db.select().from(saleOffers).where(eq(saleOffers.id, ids.activeOffer)),
      ).resolves.toHaveLength(1);
      expect(await redisClient.keys(`inventory:${ids.activeOffer}:*`)).toEqual([]);
      expect(await redisClient.keys(`demo-run:${ids.activeRun}:*`)).toEqual([]);
      expect(await db.select({ failureReason: demoRuns.failureReason }).from(demoRuns)).toEqual([
        { failureReason: reason },
      ]);
      const history = new RunHistoryService({ db });
      const detail = await history.detail(ids.activeRun);
      expect(detail?.summary.dataDiscarded).toBe(true);
      expect(detail?.summary.failureCategory).toBe(
        reason === "auto_reset" ? "automatic_reset" : "operator",
      );
      await seedRun(db, redisClient, {
        runId: ids.startingRun,
        saleOfferId: ids.startingOffer,
        status: "starting",
        trafficStatus: "starting",
        failureReason: null,
      });
      expect(await db.select().from(demoRuns).where(eq(demoRuns.status, "starting"))).toHaveLength(
        1,
      );
    });

    it("purges a held real order after bounded queue settlement and keeps its summary", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "draining",
        trafficStatus: "succeeded",
        failureReason: null,
        runInventoryStatus: "accepting",
      });
      await seedActiveRunBusinessState(db, redisClient);
      let observedAt = new Date("2026-06-20T00:00:10.000Z");
      const queueConnection = { url: requireTestRedisUrl() };
      const queue = new Queue(orderProcessBullMqQueueName, { connection: queueConnection });
      const events = new QueueEvents(orderProcessBullMqQueueName, { connection: queueConnection });
      await events.waitUntilReady();
      const release = releaseBarrier();
      const processing = releaseBarrier();
      const handler = createOrderProcessJobHandler({
        confirmation: {
          confirm: async () => {
            processing.resolve();
            await release.promise;
            observedAt = new Date("2026-06-20T00:00:11.000Z");
          },
        },
        persistence: new PostgresOrderTransitionPersistence(db, () => observedAt),
        publishBusinessOutcomeUpdate: async () => undefined,
        notificationRecordPublisher: {
          publishForConfirmedOrder: async () => {
            throw new Error("Run publication fenced after operator stop");
          },
        },
        recovery: { handoff: async () => undefined, resolve: async () => undefined },
        logger: createSilentLogger("worker"),
      });
      const worker = new Worker(
        orderProcessBullMqQueueName,
        async (job) => {
          await handler.handle(orderProcessJobSchema.parse(job.data), {
            attemptNumber: 1,
            attemptsMade: 0,
            maxAttempts: 1,
            ...(job.id ? { deliveryId: job.id } : {}),
          });
          observedAt = new Date("2026-06-20T00:00:12.000Z");
        },
        { connection: queueConnection },
      );
      const maintenance = createBullMqDemoQueueMaintenance(queueConnection);
      const abortCurrent = vi.fn(async () => ({ outcome: "no_current_run" as const }));
      const service = createResetService({
        db,
        redis: redisClient,
        logger: createSilentLogger("api"),
        now: () => observedAt,
        trafficAborter: { abortCurrent },
        queueMaintenance: {
          cleanRuns: (ids) => maintenance.cleanRuns(ids, { deadline: performance.now() - 1 }),
        },
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
          synchronize: async () => {},
        }),
      });
      try {
        await queue.add(orderProcessJobName, {
          orderId: ids.activeOrder,
          publicOrderId: "active-order",
          reservationId: ids.activeReservation,
          saleOfferId: ids.activeOffer,
          runId: ids.activeRun,
          correlationId: "corr-active-business",
          quantity: 1,
          queuedAt: "2026-06-20T00:00:03.000Z",
          processingGeneration: 0,
        });
        await boundedResetBarrier(processing.promise);
        const failed = once(events, "failed", { signal: AbortSignal.timeout(5_000) });
        await expect(service.reset("held-active")).resolves.toMatchObject({ failedRunCount: 1 });
        expect(await queue.isPaused()).toBe(false);
        const summaries = await db.select().from(demoRunSummaries);
        expect(summaries).toHaveLength(1);
        expect(summaries[0]).toMatchObject({
          status: "failed",
          failureReason: "admin_reset",
          endedAt: new Date("2026-06-20T00:00:10.000Z"),
          capturedAt: observedAt,
          businessOutcomeSummary: { processingOrders: 1, notificationsRecorded: 0 },
        });
        const [run] = await db.select().from(demoRuns).where(eq(demoRuns.id, ids.activeRun));
        expect(run?.adminResetCompletedAt).toEqual(observedAt);
        expect(await db.select().from(orders)).toHaveLength(0);
        const historyService = new RunHistoryService({ db, now: () => observedAt });
        const history = await historyService.detail(ids.activeRun);
        expect(history?.run.adminResetCompletedAt).toBe(observedAt.toISOString());
        expect(history?.summary.businessOutcomeSummary).toMatchObject({
          processingOrders: 1,
          notificationsRecorded: 0,
        });
        expect(await historyService.detail(ids.activeRun)).toEqual(history);
        await service.reset("held-repeated");
        expect(await db.select().from(demoRunSummaries)).toEqual(summaries);
        expect(abortCurrent).toHaveBeenCalledOnce();
        await expect(
          db.insert(demoRuns).values({
            id: ids.startingRun,
            presetId: ids.preset,
            presetName: "Reset Preset",
            operatorMode: "admin",
            status: "starting",
            trafficStatus: "starting",
            configSnapshot: configSnapshotFixture(),
            startedAt: observedAt,
          }),
        ).resolves.toBeDefined();
        release.resolve();
        await failed;
        expect(await db.select().from(orders)).toHaveLength(0);
        expect(await db.select().from(simulatedNotifications)).toHaveLength(0);
        expect(await db.select().from(orderDeadLetters)).toHaveLength(0);
      } finally {
        release.resolve();
        await worker.close();
        await Promise.all([maintenance.close(), queue.close(), events.close()]);
      }
    });

    it.each([
      "immediate",
      "coalesced",
    ])("publishes every %s reset frame in an order that converges the real client reducer", async (delivery) => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      const logger = createSilentLogger("api");
      let observedAt = new Date("2026-06-20T00:00:10.000Z");
      const now = () => observedAt;
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
        runInventoryStatus: "accepting",
      });
      const config = configSnapshotFixture();
      await db
        .update(demoRuns)
        .set({
          configSnapshot: {
            ...config,
            trafficConfig: { ...config.trafficConfig, startDelaySeconds: 20 },
          },
        })
        .where(eq(demoRuns.id, ids.activeRun));
      const metrics = new RedisDashboardTrafficMetricStore(redisClient);
      await metrics.appendIfLive({
        batchId: "77777777-7777-4777-8777-777777777101",
        runId: ids.activeRun,
        correlationId: "corr-pre-dispatch",
        observedAt: "2026-06-20T00:00:02.000Z",
        samples: [
          {
            metricName: "traffic.attempts_dispatched",
            value: 0,
            unit: "requests",
            timestamp: "2026-06-20T00:00:02.000Z",
          },
        ],
      });
      const projectionService = new DashboardProjectionService({
        logger,
        now,
        openOperation: createDashboardRecoveryOperationFactory({
          databaseUrl: requireTestDatabaseUrl(),
          redisUrl: requireTestRedisUrl(),
          timeoutMs: 2_000,
          logger,
        }),
      });
      const active = await projectionService.build({ correlationId: "corr-active" });
      expect(active.currentRun?.status).toBe("active");
      expect(active.recentMetrics).toHaveLength(1);
      observedAt = new Date("2026-06-20T00:00:11.000Z");
      const buildRelease = releaseBarrier();
      if (delivery === "immediate") buildRelease.resolve();
      const frames: DashboardProjection[] = [];
      const finalFrame = releaseBarrier();
      let observer = createDashboardProjectionState({ status: "available", data: active });
      let idleObserver = createDashboardProjectionState({ status: "loading" });
      const scheduler = new DashboardProjectionPublicationScheduler({
        projectionService: {
          build: async (input) => {
            await buildRelease.promise;
            observedAt = new Date(observedAt.getTime() + 1);
            return projectionService.build(input);
          },
        },
        logger,
        buildTimeoutMs: 5_000,
        publish: (projection) => {
          frames.push(projection);
          if (projection.resetRecovery === "ready" && projection.recentMetrics.length === 0)
            finalFrame.resolve();
          observer = dashboardProjectionStateReducer(observer, {
            type: "live-projection-received",
            projection,
          });
          idleObserver = dashboardProjectionStateReducer(idleObserver, {
            type: "live-projection-received",
            projection,
          });
        },
      });
      const allSignals = releaseBarrier();
      const subscriberRedis = redisClient.duplicate();
      const onDirty = vi.fn((signal) => {
        scheduler.markDirty(signal);
        if (onDirty.mock.calls.length === 3) allSignals.resolve();
      });
      const subscriber = createRedisDashboardProjectionDirtySubscriber(subscriberRedis, {
        onDirty,
      });
      try {
        await subscriber.start();
        const service = createResetService({
          db,
          redis: redisClient,
          logger,
          terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
            synchronize: async () => {},
          }),
          queueMaintenance: noOpGeneratedRunQueueMaintenance(),
          dashboardLiveStateReset: metrics,
          now,
        });
        await expect(service.reset("corr-reset-stream")).resolves.toMatchObject({
          failedRunCount: 1,
        });
        await boundedResetBarrier(allSignals.promise);
        buildRelease.resolve();
        await scheduler.flush();
        await boundedResetBarrier(finalFrame.promise);
        await scheduler.flush();
        expect(onDirty.mock.calls).toEqual([
          ...Array.from({ length: 2 }, () => [
            {
              type: "dashboard.projection.dirty",
              correlationId: "corr-reset-stream",
              scope: { runId: ids.activeRun, saleOfferId: ids.activeOffer },
            },
          ]),
          [{ type: "dashboard.projection.dirty", correlationId: "corr-reset-stream" }],
        ]);
        expect(frames.length).toBeGreaterThan(0);
        const terminal = frames.at(-1);
        if (!terminal) throw new Error("Reset projection was not published");
        expect(observer.acceptedProjection).toEqual(terminal);
        expect(observer.retainedTerminalRun).toBeNull();
        expect(terminal.resetRecovery).toBe("ready");
        expect(terminal.resetRecoveryRunId).toBe(ids.activeRun);
        expect(idleObserver.acceptedProjection).toEqual(terminal);
        const recovered = await projectionService.build({ correlationId: "idle-observer-read" });
        idleObserver = dashboardProjectionStateReducer(idleObserver, {
          type: "refresh-completed",
          recovery: { status: "available", data: recovered },
          preserveAvailableRecoveryOnFailure: false,
        });
        expect(idleObserver.acceptedProjection?.resetRecoveryRunId).toBe(ids.activeRun);
        expect(terminal.scope).toBeNull();
        expect(terminal.scopeId).toBe("idle");
        expect(terminal.currentRun).toBeNull();
        expect(terminal.recentMetrics).toEqual([]);
        expect((await db.select().from(demoRunSummaries))[0]?.transportAttemptCounts).toMatchObject(
          { startedRequests: 0 },
        );
        expect(
          await db
            .select({ failureReason: demoRuns.failureReason })
            .from(demoRuns)
            .where(eq(demoRuns.id, ids.activeRun)),
        ).toEqual([{ failureReason: "admin_reset" }]);
        expect(await db.select().from(demoRunSummaries)).toHaveLength(1);
        expect(await metrics.hasRunState(ids.activeRun)).toBe(false);
        expect(await metrics.readRecent(ids.activeRun)).toEqual([]);
      } finally {
        buildRelease.resolve();
        await subscriber.close();
        subscriberRedis.disconnect();
        await scheduler.close();
      }
    });

    it("keeps reset successful when advisory dirty publication fails", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
        runInventoryStatus: "accepting",
      });
      const metrics = new RedisDashboardTrafficMetricStore(redisClient);
      await redisClient.sadd(`demo-run:${ids.activeRun}:traffic-metric-batches`, "batch");
      const logger = createSilentLogger("api");
      const warn = vi.spyOn(logger, "warn");
      const failure = new Error("publication unavailable");
      const publish = vi.spyOn(redisClient, "publish").mockRejectedValueOnce(failure);
      try {
        const service = createResetService({
          db,
          redis: redisClient,
          logger,
          dashboardLiveStateReset: metrics,
          terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
            synchronize: async () => {},
          }),
          queueMaintenance: noOpGeneratedRunQueueMaintenance(),
        });
        await expect(service.reset("corr-advisory")).resolves.toMatchObject({
          failedRunCount: 1,
          closedSaleOfferCount: 1,
          cleanedQueueCount: 2,
          cleanedJobCount: 0,
          correlationId: "corr-advisory",
        });
        expect(publish).toHaveBeenCalledTimes(3);
        expect(warn).toHaveBeenCalledWith(
          { err: failure, runId: ids.activeRun },
          "Could not publish run projection dirty signal.",
        );
        expect(await db.select().from(demoRunSummaries)).toHaveLength(1);
        expect(await metrics.hasRunState(ids.activeRun)).toBe(false);
        expect(await metrics.readRecent(ids.activeRun)).toEqual([]);
      } finally {
        publish.mockRestore();
      }
    });

    it("fails in-progress runs, closes sale eligibility, and cleans reset-owned queues", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      const writerOperations: string[] = [];
      const postgresTerminalRunWriter = new PostgresTerminalDemoRunSummaryWriter(db, {
        synchronize: async () => {},
      });
      const claimTerminalRun = vi.fn(
        async (...args: Parameters<typeof postgresTerminalRunWriter.claimTerminalRun>) => {
          writerOperations.push("claim");
          return postgresTerminalRunWriter.claimTerminalRun(...args);
        },
      );
      const writeAfterTerminalClaims = vi.fn(
        async (...args: Parameters<typeof postgresTerminalRunWriter.writeAfterTerminalClaims>) => {
          writerOperations.push("write");
          return postgresTerminalRunWriter.writeAfterTerminalClaims(...args);
        },
      );
      const queueMaintenance = {
        cleanRuns: vi.fn(async (_runIds: readonly string[]) => {
          writerOperations.push("cleanup");
          const runsAtCleanup = await db
            .select({ id: demoRuns.id, status: demoRuns.status })
            .from(demoRuns)
            .where(inArray(demoRuns.id, [ids.startingRun, ids.activeRun, ids.drainingRun]));
          expect(runsAtCleanup.every((run) => run.status === "failed")).toBe(true);
          await expect(
            isRunSaleEligible(redisClient, {
              runId: ids.activeRun,
              saleOfferId: ids.activeOffer,
            }),
          ).resolves.toBe(false);
          expect(await db.select().from(demoRunSummaries)).toHaveLength(0);
          return { cleanedQueueCount: 2, cleanedJobCount: 5 };
        }),
      };
      const abortCurrent = vi.fn(async () => {
        writerOperations.push("abort");
        return { outcome: "current_run_aborted" as const };
      });
      const fenceRun = vi.fn(async () => {
        writerOperations.push("metric-fence");
      });
      const clearRun = vi.fn(async () => {
        writerOperations.push("metric-clear");
      });
      const service = createResetService({
        db,
        terminalRunWriter: { claimTerminalRun, writeAfterTerminalClaims },
        redis: redisClient,
        queueMaintenance,
        trafficAborter: { abortCurrent },
        dashboardLiveStateReset: { fenceRun, clearRun, hasRunState: async () => false },
        logger: createSilentLogger("api"),
        now: () => new Date("2026-06-20T00:00:10.000Z"),
      });

      await seedRuns(db, redisClient);
      await seedActiveRunBusinessState(db, redisClient);

      const response = await service.reset("corr-reset");
      const runs = await db
        .select()
        .from(demoRuns)
        .where(
          inArray(demoRuns.id, [
            ids.startingRun,
            ids.activeRun,
            ids.drainingRun,
            ids.completedRun,
            ids.failedRun,
          ]),
        );
      const summaries = await db
        .select()
        .from(demoRunSummaries)
        .where(inArray(demoRunSummaries.runId, [ids.startingRun, ids.activeRun, ids.drainingRun]));

      expect(response).toEqual({
        failedRunCount: 3,
        closedSaleOfferCount: 3,
        cleanedQueueCount: 2,
        cleanedJobCount: 5,
        resetAt: "2026-06-20T00:00:10.000Z",
        correlationId: "corr-reset",
      });
      expect(queueMaintenance.cleanRuns).toHaveBeenCalledOnce();
      expect(new Set(queueMaintenance.cleanRuns.mock.calls[0]?.[0])).toEqual(
        new Set([ids.startingRun, ids.activeRun, ids.drainingRun]),
      );
      expect(claimTerminalRun).toHaveBeenCalledOnce();
      expect(claimTerminalRun).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: ids.activeRun,
          allowedCurrentStatuses: ["starting", "active", "draining"],
        }),
      );
      expect(writeAfterTerminalClaims).toHaveBeenCalledOnce();
      expect(writeAfterTerminalClaims.mock.calls[0]?.[0]).toHaveLength(3);
      expect(abortCurrent).toHaveBeenCalledTimes(3);
      expect(abortCurrent).toHaveBeenCalledWith({
        runId: ids.activeRun,
        reason: "admin_reset",
        correlationId: "corr-reset",
      });
      expect(clearRun).toHaveBeenCalledTimes(3);
      expect(writerOperations).toEqual([
        "claim",
        "metric-fence",
        "abort",
        "metric-fence",
        "abort",
        "metric-fence",
        "abort",
        "cleanup",
        "write",
        "metric-clear",
        "metric-clear",
        "metric-clear",
      ]);
      const inProgressRunIds = new Set<string>([ids.startingRun, ids.activeRun, ids.drainingRun]);
      expect(
        runs
          .filter((run) => inProgressRunIds.has(run.id))
          .map((run) => ({
            id: run.id,
            status: run.status,
            trafficStatus: run.trafficStatus,
            failureReason: run.failureReason,
            finalizedAt: run.finalizedAt,
          })),
      ).toEqual(
        expect.arrayContaining([
          {
            id: ids.startingRun,
            status: "failed",
            trafficStatus: "failed",
            failureReason: "admin_reset",
            finalizedAt: new Date("2026-06-20T00:00:06.000Z"),
          },
          {
            id: ids.activeRun,
            status: "failed",
            trafficStatus: "failed",
            failureReason: "admin_reset",
            finalizedAt: new Date("2026-06-20T00:00:10.000Z"),
          },
          {
            id: ids.drainingRun,
            status: "failed",
            trafficStatus: "failed",
            failureReason: "admin_reset",
            finalizedAt: new Date("2026-06-20T00:00:06.000Z"),
          },
        ]),
      );
      expect(runs.find((run) => run.id === ids.completedRun)?.status).toBe("completed");
      expect(runs.find((run) => run.id === ids.failedRun)?.failureReason).toBe("traffic_failed");
      expect(summaries).toHaveLength(3);
      expect(
        summaries.map((summary) => ({
          runId: summary.runId,
          status: summary.status,
          failureReason: summary.failureReason,
          endedAt: summary.endedAt,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            runId: ids.startingRun,
            status: "failed",
            failureReason: "admin_reset",
            endedAt: new Date("2026-06-20T00:00:06.000Z"),
          },
          {
            runId: ids.activeRun,
            status: "failed",
            failureReason: "admin_reset",
            endedAt: new Date("2026-06-20T00:00:10.000Z"),
          },
          {
            runId: ids.drainingRun,
            status: "failed",
            failureReason: "admin_reset",
            endedAt: new Date("2026-06-20T00:00:06.000Z"),
          },
        ]),
      );
      expect(summaries.find((summary) => summary.runId === ids.activeRun)).toMatchObject({
        businessOutcomeSummary: {
          acceptedReservations: 1,
          soldOutRejections: 4,
          queuedOrders: 1,
          pendingPersistenceCount: 0,
        },
        terminalInventorySnapshot: {
          saleOfferId: ids.activeOffer,
          startingStock: 10,
          remainingStock: 9,
          reservedStock: 1,
          acceptedReservations: 1,
          soldOutRejections: 4,
          pendingPersistenceCount: 0,
          source: "redis",
        },
      });
      expect(summaries.find((summary) => summary.runId === ids.drainingRun)).toMatchObject({
        transportAttemptCounts: {
          plannedRequests: 10,
          startedRequests: 0,
          completedRequests: 0,
          interruptedRequests: 0,
          unstartedRequests: 10,
        },
        trafficDeliverySummary: {
          droppedIterations: 0,
          completedIterations: 0,
          trafficDeliveryStatus: "failed",
        },
      });
      await expect(
        isRunSaleEligible(redisClient, {
          runId: ids.startingRun,
          saleOfferId: ids.startingOffer,
        }),
      ).resolves.toBe(false);
      await expect(
        isRunSaleEligible(redisClient, {
          runId: ids.activeRun,
          saleOfferId: ids.activeOffer,
        }),
      ).resolves.toBe(false);
      await expect(
        isRunSaleEligible(redisClient, {
          runId: ids.drainingRun,
          saleOfferId: ids.drainingOffer,
        }),
      ).resolves.toBe(false);
    });

    it("allows reset after all runs are terminal without changing history", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      const queueMaintenance = {
        cleanRuns: vi.fn().mockResolvedValue({ cleanedQueueCount: 2, cleanedJobCount: 0 }),
      };
      const service = createResetService({
        db,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
          synchronize: async () => {},
        }),
        redis: redisClient,
        queueMaintenance,
        logger: createSilentLogger("api"),
        now: () => new Date("2026-06-20T00:00:10.000Z"),
      });

      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.completedRun,
        saleOfferId: ids.completedOffer,
        status: "completed",
        trafficStatus: "succeeded",
        failureReason: null,
      });
      await seedTerminalSummary(db, {
        runId: ids.completedRun,
        saleOfferId: ids.completedOffer,
        status: "completed",
        failureReason: null,
      });
      await seedRun(db, redisClient, {
        runId: ids.failedRun,
        saleOfferId: ids.failedOffer,
        status: "failed",
        trafficStatus: "failed",
        failureReason: "traffic_failed",
      });
      await seedTerminalSummary(db, {
        runId: ids.failedRun,
        saleOfferId: ids.failedOffer,
        status: "failed",
        failureReason: "traffic_failed",
      });
      const summariesBeforeReset = await readTerminalSummaryRows(db);

      const response = await service.reset("corr-reset-terminal");
      const terminalRuns = await db
        .select()
        .from(demoRuns)
        .where(inArray(demoRuns.id, [ids.completedRun, ids.failedRun]));
      const summariesAfterReset = await readTerminalSummaryRows(db);

      expect(response.failedRunCount).toBe(0);
      expect(response.closedSaleOfferCount).toBe(0);
      expect(response.cleanedQueueCount).toBe(0);
      expect(response.cleanedJobCount).toBe(0);
      expect(queueMaintenance.cleanRuns).not.toHaveBeenCalled();
      expect(summariesAfterReset).toEqual(summariesBeforeReset);
      expect(terminalRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: ids.completedRun, status: "completed" }),
          expect.objectContaining({
            id: ids.failedRun,
            status: "failed",
            failureReason: "traffic_failed",
          }),
        ]),
      );
    });

    it("preserves a mismatched orchestrator run and does not clean, summarize, or clear", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
        runInventoryStatus: "accepting",
      });
      const cleanRuns = vi.fn(async () => ({
        cleanedQueueCount: 2,
        cleanedJobCount: 0,
      }));
      const clearRun = vi.fn(async () => undefined);
      const service = createResetService({
        db,
        redis: redisClient,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
          synchronize: async () => {},
        }),
        queueMaintenance: { cleanRuns },
        trafficAborter: {
          abortCurrent: async () => {
            throw new ApiHttpError({
              statusCode: 409,
              code: "load_orchestrator_run_mismatch",
              message: "A different run is active.",
            });
          },
        },
        dashboardLiveStateReset: {
          fenceRun: async () => undefined,
          clearRun,
          hasRunState: async () => false,
        },
        logger: createSilentLogger("api"),
      });

      await expect(service.reset("corr-mismatch")).rejects.toMatchObject({
        statusCode: 409,
        code: "load_orchestrator_run_mismatch",
      });
      expect(cleanRuns).not.toHaveBeenCalled();
      expect(clearRun).not.toHaveBeenCalled();
      expect(await db.select().from(demoRunSummaries)).toHaveLength(0);
    });

    it("leaves an unconfirmed abort claimed and retryable without cleanup, summary, or clear", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
        runInventoryStatus: "accepting",
      });
      const cleanRuns = vi.fn(async () => ({
        cleanedQueueCount: 2,
        cleanedJobCount: 0,
      }));
      const clearRun = vi.fn(async () => undefined);
      const service = createResetService({
        db,
        redis: redisClient,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
          synchronize: async () => {},
        }),
        queueMaintenance: { cleanRuns },
        trafficAborter: {
          abortCurrent: async () => {
            throw new ApiHttpError({
              statusCode: 502,
              code: "load_orchestrator_abort_unconfirmed",
              message: "Traffic termination could not be confirmed.",
            });
          },
        },
        dashboardLiveStateReset: {
          fenceRun: async () => undefined,
          clearRun,
          hasRunState: async () => false,
        },
        logger: createSilentLogger("api"),
      });

      await expect(service.reset("corr-abort-unconfirmed")).rejects.toMatchObject({
        statusCode: 502,
        code: "load_orchestrator_abort_unconfirmed",
      });
      expect(cleanRuns).not.toHaveBeenCalled();
      expect(clearRun).not.toHaveBeenCalled();
      expect(await db.select().from(demoRunSummaries)).toHaveLength(0);
      expect(await db.select().from(demoRuns).where(eq(demoRuns.id, ids.activeRun))).toEqual([
        expect.objectContaining({
          status: "failed",
          trafficStatus: "failed",
          failureReason: "admin_reset",
        }),
      ]);
    });

    it("retries only dashboard projection cleanup after a post-summary Redis failure", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
        runInventoryStatus: "accepting",
      });
      const abortCurrent = vi.fn(async () => ({ outcome: "no_current_run" as const }));
      const cleanRuns = vi.fn(async () => ({
        cleanedQueueCount: 2,
        cleanedJobCount: 0,
      }));
      let failClear = true;
      const metrics = new RedisDashboardTrafficMetricStore(redisClient);
      await redisClient.sadd(`demo-run:${ids.activeRun}:traffic-metric-batches`, "batch");
      const publish = vi.spyOn(redisClient, "publish");
      const logger = createSilentLogger("api");
      const errorLog = vi.spyOn(logger, "error");
      const clearRun = vi.fn(async () => {
        if (failClear) throw new Error("Redis unavailable");
        await metrics.clearRun(ids.activeRun);
      });
      const service = createResetService({
        db,
        redis: redisClient,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
          synchronize: async () => {},
        }),
        queueMaintenance: { cleanRuns },
        trafficAborter: { abortCurrent },
        dashboardLiveStateReset: {
          fenceRun: async () => undefined,
          clearRun,
          hasRunState: (runId) => metrics.hasRunState(runId),
        },
        logger,
      });

      await expect(service.reset("corr-clear-failure")).rejects.toThrow(
        "Retry reset to finish projection cleanup",
      );
      expect(await db.select().from(demoRunSummaries)).toHaveLength(1);
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({ runId: ids.activeRun, correlationId: "corr-clear-failure" }),
        expect.stringContaining("dashboard live traffic metrics"),
      );
      expect(abortCurrent).toHaveBeenCalledOnce();
      expect(cleanRuns).toHaveBeenCalledOnce();

      expect(publish).toHaveBeenCalledTimes(2);
      failClear = false;
      await expect(service.reset("corr-clear-retry")).resolves.toMatchObject({ failedRunCount: 0 });
      expect(publish).toHaveBeenCalledTimes(3);
      expect(JSON.parse(String(publish.mock.calls[2]?.[1]))).toEqual({
        type: "dashboard.projection.dirty",
        correlationId: "corr-clear-retry",
      });
      expect(await metrics.hasRunState(ids.activeRun)).toBe(false);
      await service.reset("corr-already-clean");
      expect(publish).toHaveBeenCalledTimes(3);
      publish.mockRestore();
      expect(clearRun).toHaveBeenCalledTimes(2);
      expect(abortCurrent).toHaveBeenCalledOnce();
      expect(cleanRuns).toHaveBeenCalledOnce();
      expect(await db.select().from(demoRunSummaries)).toHaveLength(1);
    });

    it("prunes orphaned pending projection retries", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      const pendingKey = "demo-reset:pending-projection-runs";
      await redisClient.sadd(pendingKey, ids.completedRun);
      const service = createResetService({
        db,
        redis: redisClient,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
          synchronize: async () => {},
        }),
        queueMaintenance: noOpGeneratedRunQueueMaintenance(),
        logger: createSilentLogger("api"),
      });

      await service.reset("corr-prune-orphan");
      expect(await redisClient.smembers(pendingKey)).toEqual([]);
      await service.reset("corr-prune-orphan-again");
      expect(await redisClient.smembers(pendingKey)).toEqual([]);
    });

    it("stamps reset completion when retry finds an existing summary without a marker", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "failed",
        trafficStatus: "failed",
        failureReason: "admin_reset",
      });
      await seedTerminalSummary(db, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "failed",
        failureReason: "admin_reset",
      });
      const service = createResetService({
        db,
        redis: redisClient,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
          synchronize: async () => {},
        }),
        queueMaintenance: {
          cleanRuns: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
        },
        logger: createSilentLogger("api"),
        now: () => new Date("2026-06-20T00:00:20.000Z"),
      });

      await expect(service.reset("corr-reset-existing-summary")).resolves.toMatchObject({
        failedRunCount: 0,
      });
      await expect(
        db
          .select({ adminResetCompletedAt: demoRuns.adminResetCompletedAt })
          .from(demoRuns)
          .where(eq(demoRuns.id, ids.activeRun)),
      ).resolves.toEqual([{ adminResetCompletedAt: new Date("2026-06-20T00:00:20.000Z") }]);
      await expect(
        db.select().from(demoRunSummaries).where(eq(demoRunSummaries.runId, ids.activeRun)),
      ).resolves.toHaveLength(1);
    });

    it.each(
      destructiveResetReasonValues,
    )("retains %s when the other reset reason retries a purge failure", async (reason) => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
        runInventoryStatus: "accepting",
      });
      await seedActiveRunBusinessState(db, redisClient);
      let failPurge = true;
      const service = createResetService({
        db,
        redis: redisClient,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
          synchronize: async () => {},
        }),
        queueMaintenance: noOpGeneratedRunQueueMaintenance(),
        logger: createSilentLogger("api"),
        purgeResetRunDurable: async (...args) => {
          if (failPurge) throw new Error("purge unavailable");
          await purgeResetRunDurable(...args);
        },
      });

      await expect(service.reset("corr-purge-failure", reason)).rejects.toThrow(
        "purge unavailable",
      );
      expect(await db.select().from(demoRunSummaries)).toHaveLength(1);
      expect(await db.select().from(orders)).not.toHaveLength(0);
      expect(
        (await db.select().from(demoRuns).where(eq(demoRuns.id, ids.activeRun)))[0]
          ?.adminResetCompletedAt,
      ).toBeNull();

      failPurge = false;
      await expect(
        service.reset("corr-purge-retry", reason === "admin_reset" ? "auto_reset" : "admin_reset"),
      ).resolves.toMatchObject({
        failedRunCount: 0,
      });
      expect(await db.select().from(demoRunSummaries)).toHaveLength(1);
      expect(await db.select().from(orders)).toHaveLength(0);
      expect(await db.select({ failureReason: demoRuns.failureReason }).from(demoRuns)).toEqual([
        { failureReason: reason },
      ]);
      expect(
        await db.select({ failureReason: demoRunSummaries.failureReason }).from(demoRunSummaries),
      ).toEqual([{ failureReason: reason }]);
      expect(
        (await db.select().from(demoRuns).where(eq(demoRuns.id, ids.activeRun)))[0]
          ?.adminResetCompletedAt,
      ).not.toBeNull();
    });

    it("resets a starting run before it owns a generated sale offer", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await db.insert(demoRuns).values({
        id: ids.startingRun,
        presetId: ids.preset,
        presetName: "Reset Preset",
        operatorMode: "admin",
        status: "starting",
        trafficStatus: "starting",
        configSnapshot: configSnapshotFixture(),
        startedAt: new Date("2026-06-20T00:00:00.000Z"),
      });
      const service = createResetService({
        db,
        redis: redisClient,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
          synchronize: async () => {},
        }),
        queueMaintenance: noOpGeneratedRunQueueMaintenance(),
        logger: createSilentLogger("api"),
      });

      await expect(service.reset("corr-no-offer")).resolves.toMatchObject({
        failedRunCount: 1,
        closedSaleOfferCount: 0,
      });
      expect(await db.select().from(demoRunSummaries)).toHaveLength(1);
      expect(
        (await db.select().from(demoRuns).where(eq(demoRuns.id, ids.startingRun)))[0],
      ).toMatchObject({
        status: "failed",
        failureReason: "admin_reset",
        saleOfferId: null,
      });
    });

    it.each(
      destructiveResetReasonValues,
    )("preserves %s before summary creation when the other reset reason resumes it", async (reason) => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
        runInventoryStatus: "accepting",
      });

      const queueMaintenance = {
        cleanRuns: vi.fn().mockResolvedValue({ cleanedQueueCount: 2, cleanedJobCount: 0 }),
      };
      let resetNow = new Date("2026-06-20T00:15:10.000Z");
      const service = createResetService({
        db,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
          synchronize: async () => {},
        }),
        redis: redisClient,
        queueMaintenance,
        logger: createSilentLogger("api"),
        now: () => resetNow,
      });

      const evalSpy = vi
        .spyOn(redisClient, "eval")
        .mockRejectedValueOnce(new Error("temporary Redis outage"));
      await expect(service.reset("corr-reset-failure", reason)).rejects.toThrow(
        "Retry reset to resume the fenced transition",
      );
      evalSpy.mockRestore();

      await expect(
        db.select().from(demoRuns).where(eq(demoRuns.id, ids.activeRun)),
      ).resolves.toEqual([
        expect.objectContaining({
          status: "failed",
          trafficStatus: "failed",
          failureReason: reason,
        }),
      ]);
      expect(await db.select().from(demoRunSummaries)).toHaveLength(0);
      expect(queueMaintenance.cleanRuns).not.toHaveBeenCalled();
      await expect(
        db
          .select({ adminResetCompletedAt: demoRuns.adminResetCompletedAt })
          .from(demoRuns)
          .where(eq(demoRuns.id, ids.activeRun)),
      ).resolves.toEqual([{ adminResetCompletedAt: null }]);

      resetNow = new Date("2026-06-20T00:15:20.000Z");
      const response = await service.reset(
        "corr-reset-retry",
        reason === "admin_reset" ? "auto_reset" : "admin_reset",
      );
      expect(response).toMatchObject({
        failedRunCount: 1,
        closedSaleOfferCount: 1,
        cleanedQueueCount: 2,
        cleanedJobCount: 0,
        correlationId: "corr-reset-retry",
      });
      expect(queueMaintenance.cleanRuns).toHaveBeenCalledOnce();
      const [summary] = await db.select().from(demoRunSummaries);
      expect(summary).toMatchObject({
        failureReason: reason,
        endedAt: new Date("2026-06-20T00:15:10.000Z"),
        capturedAt: new Date("2026-06-20T00:15:20.000Z"),
      });
      await expect(
        db
          .select({ adminResetCompletedAt: demoRuns.adminResetCompletedAt })
          .from(demoRuns)
          .where(eq(demoRuns.id, ids.activeRun)),
      ).resolves.toEqual([{ adminResetCompletedAt: new Date("2026-06-20T00:15:20.000Z") }]);
      expect(summary?.loadRunDiagnosticsSummary).not.toHaveProperty("previousStatus");
    });

    it("rejects through Redis after reset closes admission without durable buy work", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
        runInventoryStatus: "accepting",
      });

      const reserveService = new ReserveOrderService({
        persistence: new PostgresBuyPersistence(db),
        stockReservations: {
          reserve: (input) => reserveInventoryStock(redisClient, input),
          markPendingPersistence: (input) => markReservationPendingPersistence(redisClient, input),
          promoteAccepted: async () => undefined,
        },
        orderProcessJobPublisher: { enqueue: async () => undefined },
        reservationHoldMinutes: 15,
        idempotencyTtlSeconds: 1800,
        pendingPersistenceRetryAfterSeconds: 30,
        pendingPersistenceRecovery: { recoverReservation: async () => null },
      });
      const maintenanceService = createResetService({
        db,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
          synchronize: async () => {},
        }),
        redis: redisClient,
        queueMaintenance: {
          cleanRuns: vi.fn().mockResolvedValue({ cleanedQueueCount: 2, cleanedJobCount: 0 }),
        },
        logger: createSilentLogger("api"),
        now: () => new Date("2026-06-20T00:00:10.000Z"),
      });

      await maintenanceService.reset("corr-reset-gate-race");
      const reservePromise = reserveService.reserve({
        request: {
          saleOfferId: ids.activeOffer,
          runId: ids.activeRun,
          idempotencyKey: "reset-gate-race",
          quantity: 1,
        },
        correlationId: "corr-reset-gate-race",
        now: new Date("2026-06-20T00:00:02.000Z"),
      });
      await expect(reservePromise).resolves.toMatchObject({
        outcome: "inventory_not_initialized",
      });
      expect(await db.select().from(reservations)).toHaveLength(0);
      expect(await db.select().from(orders)).toHaveLength(0);
    });

    it("rejects a Redis-secured hold that reaches persistence after reset fences the run", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
        runInventoryStatus: "accepting",
      });

      let releasePersistence: (() => void) | undefined;
      const persistenceRelease = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      let reservationReachedPersistence: (() => void) | undefined;
      const reservationReady = new Promise<void>((resolve) => {
        reservationReachedPersistence = resolve;
      });
      const reverse = vi.fn(async () => "reversed" as const);
      const stockReservations: StockReservationGateway = {
        reserve: async ({ reservation }) => {
          reservationReachedPersistence?.();
          await persistenceRelease;
          return { outcome: "reservation_secured", reservation };
        },
        markPendingPersistence: async () => undefined,
        promoteAccepted: async () => undefined,
        reverse,
      };
      const service = createResetService({
        db,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
          synchronize: async () => {},
        }),
        redis: redisClient,
        queueMaintenance: {
          cleanRuns: vi.fn().mockResolvedValue({ cleanedQueueCount: 2, cleanedJobCount: 0 }),
        },
        logger: createSilentLogger("api"),
        now: () => new Date("2026-06-20T00:00:10.000Z"),
      });
      const reserveService = new ReserveOrderService({
        persistence: new PostgresBuyPersistence(db),
        stockReservations,
        orderProcessJobPublisher: { enqueue: async () => undefined },
        reservationHoldMinutes: 15,
        idempotencyTtlSeconds: 1800,
        pendingPersistenceRetryAfterSeconds: 30,
        pendingPersistenceRecovery: { recoverReservation: async () => null },
        generateId: (() => {
          const generatedIds = [
            "99999999-9999-4999-8999-999999999991",
            "99999999-9999-4999-8999-999999999992",
          ];
          let index = 0;
          return () => generatedIds[index++] ?? "99999999-9999-4999-8999-999999999991";
        })(),
      });

      const reservePromise = reserveService.reserve({
        request: {
          saleOfferId: ids.activeOffer,
          runId: ids.activeRun,
          idempotencyKey: "reset-persistence-race",
          quantity: 1,
        },
        correlationId: "corr-reset-persistence-race",
        now: new Date("2026-06-20T00:00:02.000Z"),
      });
      await reservationReady;
      await service.reset("corr-reset-persistence-race");
      releasePersistence?.();

      await expect(reservePromise).rejects.toMatchObject({
        code: "run_terminal",
        reason: "run_terminal",
        message: "Generated run is terminal and no longer accepts reservations.",
      });
      expect(reverse).toHaveBeenCalledOnce();
      expect(await db.select().from(reservations)).toHaveLength(0);
      expect(await db.select().from(orders)).toHaveLength(0);
      expect(await db.select().from(demoRunSummaries)).toHaveLength(1);
    });

    it("holds reset behind an admitted enqueue so cleanup cannot race its job handoff", async () => {
      const db = requireConnection(connection).db;
      const resetConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
        runInventoryStatus: "accepting",
      });

      let releaseEnqueue: (() => void) | undefined;
      const enqueueRelease = new Promise<void>((resolve) => {
        releaseEnqueue = resolve;
      });
      let enqueueStarted: (() => void) | undefined;
      const enqueueReady = new Promise<void>((resolve) => {
        enqueueStarted = resolve;
      });
      const enqueueConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
      const queuePublisher = {
        enqueue: vi.fn(async () => {
          const visibleOrders = await enqueueConnection.db
            .select()
            .from(orders)
            .where(eq(orders.saleOfferId, ids.activeOffer));
          expect(visibleOrders).toHaveLength(1);
          enqueueStarted?.();
          await enqueueRelease;
        }),
      };
      const stockReservations: StockReservationGateway = {
        reserve: async ({ reservation }) => ({ outcome: "reservation_secured", reservation }),
        markPendingPersistence: async () => undefined,
        promoteAccepted: async () => undefined,
      };
      const reserveService = new ReserveOrderService({
        persistence: new PostgresBuyPersistence(db),
        stockReservations,
        orderProcessJobPublisher: queuePublisher,
        reservationHoldMinutes: 15,
        idempotencyTtlSeconds: 1800,
        pendingPersistenceRetryAfterSeconds: 30,
        pendingPersistenceRecovery: { recoverReservation: async () => null },
        generateId: (() => {
          const generatedIds = [
            "99999999-9999-4999-8999-999999999981",
            "99999999-9999-4999-8999-999999999982",
          ];
          let index = 0;
          return () => generatedIds[index++] ?? "99999999-9999-4999-8999-999999999981";
        })(),
      });
      const queueMaintenance = {
        cleanRuns: vi.fn(async () => {
          expect(await db.select().from(demoRunSummaries)).toHaveLength(0);
          return { cleanedQueueCount: 2, cleanedJobCount: 0 };
        }),
      };
      const maintenanceService = createResetService({
        db: resetConnection.db,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(resetConnection.db, {
          synchronize: async () => {},
        }),
        redis: redisClient,
        queueMaintenance,
        logger: createSilentLogger("api"),
        now: () => new Date("2026-06-20T00:00:10.000Z"),
      });

      let reservePromise: ReturnType<typeof reserveService.reserve> | undefined;
      let resetPromise: ReturnType<typeof maintenanceService.reset> | undefined;
      try {
        reservePromise = reserveService.reserve({
          request: {
            saleOfferId: ids.activeOffer,
            runId: ids.activeRun,
            idempotencyKey: "reset-enqueue-race",
            quantity: 1,
          },
          correlationId: "corr-reset-enqueue-race",
          now: new Date("2026-06-20T00:00:02.000Z"),
        });
        await enqueueReady;
        let resetFinished = false;
        resetPromise = maintenanceService.reset("corr-reset-enqueue-race").then((response) => {
          resetFinished = true;
          return response;
        });
        void resetPromise.catch(() => undefined);
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const [row] = await enqueueConnection.sql`
            select count(*)::integer as waiting_count from pg_locks
            where locktype = 'advisory' and granted = false
          `;
          if ((row?.waiting_count ?? 0) > 0) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
        const [waiting] = await enqueueConnection.sql`
          select count(*)::integer as waiting_count from pg_locks
          where locktype = 'advisory' and granted = false
        `;
        expect(waiting?.waiting_count).toBeGreaterThan(0);
        expect(resetFinished).toBe(false);
        releaseEnqueue?.();

        await expect(reservePromise).resolves.toMatchObject({ outcome: "reservation_secured" });
        await expect(resetPromise).resolves.toMatchObject({ failedRunCount: 1 });
        expect(queuePublisher.enqueue).toHaveBeenCalledOnce();
        expect(queueMaintenance.cleanRuns).toHaveBeenCalledOnce();
        await expect(db.select().from(demoRunSummaries)).resolves.toHaveLength(1);
        await expect(db.select().from(orders)).resolves.toHaveLength(0);
      } finally {
        releaseEnqueue?.();
        await Promise.allSettled([reservePromise, resetPromise]);
        await enqueueConnection.close();
        await resetConnection.close();
      }
    });

    it.each(
      destructiveResetReasonValues,
    )("serializes a %s racing the other reset reason", async (reason) => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        status: "active",
        trafficStatus: "active",
        failureReason: null,
        runInventoryStatus: "accepting",
      });

      let releaseCleanup: (() => void) | undefined;
      const cleanupRelease = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      let cleanupStarted: (() => void) | undefined;
      const cleanupReady = new Promise<void>((resolve) => {
        cleanupStarted = resolve;
      });
      const queueMaintenance = {
        cleanRuns: vi.fn(async () => {
          cleanupStarted?.();
          await cleanupRelease;
          return { cleanedQueueCount: 2, cleanedJobCount: 0 };
        }),
      };
      const service = createResetService({
        db,
        terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db, {
          synchronize: async () => {},
        }),
        redis: redisClient,
        queueMaintenance,
        logger: createSilentLogger("api"),
        now: () => new Date("2026-06-20T00:15:01.000Z"),
      });

      const firstReset = service.reset("corr-reset-concurrent-1", reason);
      await cleanupReady;
      let secondFinished = false;
      const secondReset = service
        .reset("corr-reset-concurrent-2", reason === "admin_reset" ? "auto_reset" : "admin_reset")
        .then((response) => {
          secondFinished = true;
          return response;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(secondFinished).toBe(false);
      releaseCleanup?.();

      await expect(firstReset).resolves.toMatchObject({ failedRunCount: 1 });
      await expect(secondReset).resolves.toMatchObject({
        failedRunCount: 0,
        closedSaleOfferCount: 0,
        cleanedQueueCount: 0,
        cleanedJobCount: 0,
      });
      expect(await db.select({ failureReason: demoRuns.failureReason }).from(demoRuns)).toEqual([
        { failureReason: reason },
      ]);
      expect(queueMaintenance.cleanRuns).toHaveBeenCalledOnce();
      expect(await db.select().from(demoRunSummaries)).toHaveLength(1);
    });
  });

  describe("old generated-run retention workflow", () => {
    it("preserves a terminal run exactly at the retention cutoff and deletes one millisecond older", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      for (const [runId, saleOfferId, createdAt] of [
        [ids.completedRun, ids.completedOffer, "2026-06-23T23:59:59.999Z"],
        [ids.failedRun, ids.failedOffer, "2026-06-24T00:00:00.000Z"],
        [ids.activeRun, ids.activeOffer, "2026-06-24T12:00:00.000Z"],
      ] as const) {
        await seedRun(db, redisClient, {
          runId,
          saleOfferId,
          createdAt: new Date(createdAt),
          status: "completed",
          trafficStatus: "succeeded",
          failureReason: null,
          runInventoryStatus: "closed",
        });
      }
      const service = createIntegratedRetentionService({
        db,
        redis: redisClient,
        queueMaintenance: noOpGeneratedRunQueueMaintenance(),
        logger: createSilentLogger("api"),
        now: () => new Date("2026-06-25T00:00:00.000Z"),
      });
      const result = await service.cleanupOldRuns({
        keepLatest: 1,
        olderThanDays: 1,
        correlationId: "qa-exact-retention-cutoff",
      });
      expect(result.deletedRunCount).toBe(1);
      expect(result.cutoffBefore).toBe("2026-06-24T00:00:00.000Z");
      expect((await db.select().from(demoRuns)).map((run) => run.id).sort()).toEqual(
        [ids.failedRun, ids.activeRun].sort(),
      );
      expect(await redisClient.exists(inventoryKeys(ids.failedOffer).state)).toBe(1);
      expect(await redisClient.exists(inventoryKeys(ids.completedOffer).state)).toBe(0);
    });

    it("cleans eligible terminal generated-run sale offers through sale contexts", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      const service = createIntegratedRetentionService({
        db,
        redis: redisClient,
        queueMaintenance: noOpGeneratedRunQueueMaintenance(),
        logger: createSilentLogger("api"),
        now: () => new Date("2026-06-25T00:00:00.000Z"),
      });

      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.completedRun,
        saleOfferId: ids.completedOffer,
        status: "completed",
        trafficStatus: "succeeded",
        failureReason: null,
        runInventoryStatus: "closed",
      });
      await seedCleanupDurableGraph(db);
      const completedInventoryKeys = inventoryKeys(ids.completedOffer);
      const dynamicInventoryKey = completedInventoryKeys.idempotency("cleanup-dynamic-key");
      await redisClient.set(dynamicInventoryKey, "stored");
      await redisClient.hset(
        `demo-run:${ids.completedRun}:traffic-metrics-pinned`,
        "traffic.request_arrival_rate",
        "metric",
      );

      await seedRun(db, redisClient, {
        runId: ids.failedRun,
        saleOfferId: ids.failedOffer,
        status: "failed",
        trafficStatus: "failed",
        failureReason: "traffic_failed",
        runInventoryStatus: "closed",
        createdAt: new Date("2026-06-24T12:00:00.000Z"),
      });
      const retainedInventoryKeys = inventoryKeys(ids.failedOffer);
      await redisClient.hset(
        `demo-run:${ids.failedRun}:traffic-metrics-pinned`,
        "traffic.request_arrival_rate",
        "retained-metric",
      );

      const response = await service.cleanupOldRuns({
        keepLatest: 1,
        olderThanDays: 1,
        correlationId: "corr-cleanup-generated",
      });
      const runRows = await db.select().from(demoRuns).where(eq(demoRuns.id, ids.completedRun));
      const contextRows = await db
        .select()
        .from(demoRunSaleContexts)
        .where(eq(demoRunSaleContexts.runId, ids.completedRun));
      const saleOfferRows = await db
        .select()
        .from(saleOffers)
        .where(eq(saleOffers.id, ids.completedOffer));

      expect(response).toEqual({
        deletedRunCount: 1,
        deletedSaleOfferCount: 1,
        preservedLatestCount: 1,
        preservedActiveRunCount: 0,
        cutoffBefore: "2026-06-24T00:00:00.000Z",
        cleanedAt: "2026-06-25T00:00:00.000Z",
        correlationId: "corr-cleanup-generated",
      });
      expect(runRows).toHaveLength(0);
      expect(contextRows).toHaveLength(0);
      expect(saleOfferRows).toHaveLength(0);
      expect(await redisClient.keys(`${completedInventoryKeys.prefix}:*`)).toHaveLength(0);
      expect(await redisClient.get(`demo-run:${ids.completedRun}:sale-eligibility`)).toBeNull();
      expect(await redisClient.exists(`demo-run:${ids.completedRun}:traffic-metrics-pinned`)).toBe(
        0,
      );
      expect(await redisClient.exists(retainedInventoryKeys.state)).toBe(1);
      expect(await redisClient.get(`demo-run:${ids.failedRun}:sale-eligibility`)).not.toBeNull();
      expect(await redisClient.exists(`demo-run:${ids.failedRun}:traffic-metrics-pinned`)).toBe(1);
      expect(await readRunScopedGraphCounts(db, ids.completedRun)).toEqual({
        erpAttempts: 0,
        finalizations: 0,
        notifications: 0,
        orderEvents: 0,
        orders: 0,
        outcomes: 0,
        pendingPersistence: 0,
        reservations: 0,
        summaries: 0,
      });
    });

    it("leaves catalog sale offers untouched when an old terminal run references one", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      const service = createIntegratedRetentionService({
        db,
        redis: redisClient,
        queueMaintenance: noOpGeneratedRunQueueMaintenance(),
        logger: createSilentLogger("api"),
        now: () => new Date("2026-06-25T00:00:00.000Z"),
      });

      await seedBase(db);
      await seedCatalogReferencedTerminalRun(db);

      const response = await service.cleanupOldRuns({
        keepLatest: 0,
        olderThanDays: 1,
        correlationId: "corr-cleanup-catalog",
      });
      const runRows = await db.select().from(demoRuns).where(eq(demoRuns.id, ids.catalogRun));
      const summaryRows = await db
        .select()
        .from(demoRunSummaries)
        .where(eq(demoRunSummaries.runId, ids.catalogRun));
      const saleOfferRows = await db
        .select({ id: saleOffers.id, purpose: saleOffers.purpose })
        .from(saleOffers)
        .where(eq(saleOffers.id, ids.catalogOffer));

      expect(response).toMatchObject({
        deletedRunCount: 0,
        deletedSaleOfferCount: 0,
        preservedLatestCount: 0,
        preservedActiveRunCount: 0,
        correlationId: "corr-cleanup-catalog",
      });
      expect(runRows).toHaveLength(1);
      expect(summaryRows).toHaveLength(1);
      expect(saleOfferRows).toEqual([{ id: ids.catalogOffer, purpose: "catalog" }]);
    });

    it("keeps earlier per-run commits when a later durable deletion fails", async () => {
      const dbConnection = requireConnection(connection);
      const db = dbConnection.db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.completedRun,
        saleOfferId: ids.completedOffer,
        status: "completed",
        trafficStatus: "succeeded",
        failureReason: null,
        createdAt: new Date("2026-06-18T00:00:00.000Z"),
      });
      await seedRun(db, redisClient, {
        runId: ids.failedRun,
        saleOfferId: ids.failedOffer,
        status: "failed",
        trafficStatus: "failed",
        failureReason: "traffic_failed",
        createdAt: new Date("2026-06-19T00:00:00.000Z"),
      });
      await dbConnection.sql`
      CREATE TABLE maintenance_delete_blocker (
        run_id uuid PRIMARY KEY REFERENCES demo_runs(id) ON DELETE RESTRICT
      )
    `;
      try {
        await dbConnection.sql`
        INSERT INTO maintenance_delete_blocker (run_id) VALUES (${ids.failedRun})
      `;
        const service = createRetentionTestService(db, redisClient);

        await expect(
          service.cleanupOldRuns({
            keepLatest: 0,
            olderThanDays: 1,
            correlationId: "corr-cleanup-isolation",
          }),
        ).rejects.toThrow();

        expect(
          await db.select().from(demoRuns).where(eq(demoRuns.id, ids.completedRun)),
        ).toHaveLength(0);
        expect(await db.select().from(demoRuns).where(eq(demoRuns.id, ids.failedRun))).toHaveLength(
          1,
        );
        expect(
          await db
            .select()
            .from(demoRunSaleContexts)
            .where(eq(demoRunSaleContexts.runId, ids.failedRun)),
        ).toHaveLength(1);
        expect(
          await db.select().from(saleOffers).where(eq(saleOffers.id, ids.failedOffer)),
        ).toHaveLength(1);
      } finally {
        await dbConnection.sql`DROP TABLE IF EXISTS maintenance_delete_blocker`;
      }
    });

    it("surfaces final durable revalidation conflicts after external cleanup and permits exact retry", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.completedRun,
        saleOfferId: ids.completedOffer,
        status: "completed",
        trafficStatus: "succeeded",
        failureReason: null,
      });
      const cleanRuns = vi.fn(async () => ({ cleanedQueueCount: 2, cleanedJobCount: 3 }));
      const deleteRedisState = vi.fn(deleteGeneratedRunRedisState);
      let refuseFinalDelete = true;
      const revalidateAtDurableDelete = vi.fn(
        async (...args: Parameters<typeof deleteGeneratedRunDurable>) => {
          if (!refuseFinalDelete) return deleteGeneratedRunDurable(...args);
          await db
            .update(demoRuns)
            .set({ status: "active", trafficStatus: "active" })
            .where(eq(demoRuns.id, ids.completedRun));
          refuseFinalDelete = false;
          return deleteGeneratedRunDurable(...args);
        },
      );
      const service = createRetentionTestService(db, redisClient, {
        queueMaintenance: { cleanRuns },
        deleteGeneratedRunRedisState: deleteRedisState,
        deleteGeneratedRunDurable: revalidateAtDurableDelete,
      });

      const firstAttempt = service.cleanupOldRuns({
        keepLatest: 0,
        olderThanDays: 1,
        correlationId: "corr-cleanup-stale-status",
      });
      await expect(firstAttempt).rejects.toMatchObject({
        code: "run_cleanup_conflict",
        details: { conflictReason: "non_terminal" },
      });

      expect(cleanRuns).toHaveBeenCalledWith([ids.completedRun]);
      expect(deleteRedisState).toHaveBeenCalledOnce();
      expect(revalidateAtDurableDelete).toHaveBeenCalledOnce();
      expect(await db.select().from(demoRuns).where(eq(demoRuns.id, ids.completedRun))).toEqual([
        expect.objectContaining({ status: "active" }),
      ]);
      await expect(
        db
          .select()
          .from(demoRunSaleContexts)
          .where(eq(demoRunSaleContexts.runId, ids.completedRun)),
      ).resolves.toHaveLength(1);
      await expect(
        db.select().from(saleOffers).where(eq(saleOffers.id, ids.completedOffer)),
      ).resolves.toHaveLength(1);
      expect(await readRunScopedGraphCounts(db, ids.completedRun)).toEqual({
        erpAttempts: 0,
        finalizations: 0,
        notifications: 0,
        orderEvents: 0,
        orders: 0,
        outcomes: 0,
        pendingPersistence: 0,
        reservations: 0,
        summaries: 0,
      });

      await db
        .update(demoRuns)
        .set({ status: "completed", trafficStatus: "succeeded" })
        .where(eq(demoRuns.id, ids.completedRun));
      await expect(
        service.cleanupOldRuns({
          keepLatest: 0,
          olderThanDays: 1,
          correlationId: "corr-cleanup-stale-status-retry",
        }),
      ).resolves.toMatchObject({ deletedRunCount: 1 });
      await expect(
        db.select().from(demoRuns).where(eq(demoRuns.id, ids.completedRun)),
      ).resolves.toHaveLength(0);
    });

    it("makes retention infrastructure failures visible and stops before later candidates", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.completedRun,
        saleOfferId: ids.completedOffer,
        status: "completed",
        trafficStatus: "succeeded",
        failureReason: null,
        createdAt: new Date("2026-06-18T00:00:00.000Z"),
      });
      await seedRun(db, redisClient, {
        runId: ids.failedRun,
        saleOfferId: ids.failedOffer,
        status: "failed",
        trafficStatus: "failed",
        failureReason: "traffic_failed",
        createdAt: new Date("2026-06-19T00:00:00.000Z"),
      });
      const deleteRedisState = vi
        .fn()
        .mockRejectedValueOnce(new Error("Redis unavailable"))
        .mockResolvedValueOnce({ deletedKeyCount: 0 });
      const service = createRetentionTestService(db, redisClient, {
        deleteGeneratedRunRedisState: deleteRedisState,
      });

      await expect(
        service.cleanupOldRuns({
          keepLatest: 0,
          olderThanDays: 1,
          correlationId: "corr-cleanup-redis-warning",
        }),
      ).rejects.toThrow("Redis unavailable");

      expect(deleteRedisState).toHaveBeenCalledOnce();
      await expect(
        db.select().from(demoRuns).where(eq(demoRuns.id, ids.completedRun)),
      ).resolves.toHaveLength(1);
      await expect(
        db.select().from(demoRuns).where(eq(demoRuns.id, ids.failedRun)),
      ).resolves.toHaveLength(1);
    });
  });

  describe("admin reset summary mapping", () => {
    it("rejects malformed stored finalization evidence during admin reset", async () => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        runId: ids.drainingRun,
        saleOfferId: ids.drainingOffer,
        status: "draining",
        trafficStatus: "succeeded",
        failureReason: null,
        runInventoryStatus: "closed",
      });
      await db
        .update(demoRunFinalizations)
        .set({ transportAttemptCounts: { completedRequests: 10 } as never })
        .where(eq(demoRunFinalizations.runId, ids.drainingRun));
      const postgresTerminalRunWriter = new PostgresTerminalDemoRunSummaryWriter(db, {
        synchronize: async () => {},
      });
      const service = createResetService({
        db,
        redis: redisClient,
        queueMaintenance: {
          cleanRuns: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
        },
        terminalRunWriter: postgresTerminalRunWriter,
        logger: createSilentLogger("api"),
        now: () => new Date("2026-06-20T00:00:10.000Z"),
      });

      await expect(service.reset("corr-invalid-finalization")).rejects.toThrow(
        new RegExp(`${ids.drainingRun}.*transportAttemptCounts`),
      );
      await expect(
        db.select().from(demoRunSummaries).where(eq(demoRunSummaries.runId, ids.drainingRun)),
      ).resolves.toHaveLength(0);
    });

    it.each([
      {
        status: "starting" as const,
        trafficStatus: "starting" as const,
        runId: ids.startingRun,
        saleOfferId: ids.startingOffer,
        runInventoryStatus: "accepting" as const,
      },
      {
        status: "active" as const,
        trafficStatus: "active" as const,
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
        runInventoryStatus: "accepting" as const,
      },
      {
        status: "draining" as const,
        trafficStatus: "succeeded" as const,
        runId: ids.drainingRun,
        saleOfferId: ids.drainingOffer,
        runInventoryStatus: "closed" as const,
      },
    ])("freshly claims and summarizes one $status run", async (fixture) => {
      const db = requireConnection(connection).db;
      const redisClient = requireRedis(redis);
      await seedBase(db);
      await seedRun(db, redisClient, {
        ...fixture,
        failureReason: null,
      });
      const postgresTerminalRunWriter = new PostgresTerminalDemoRunSummaryWriter(db, {
        synchronize: async () => {},
      });
      const claimTerminalRun = vi.fn(
        postgresTerminalRunWriter.claimTerminalRun.bind(postgresTerminalRunWriter),
      );
      const service = createResetService({
        db,
        redis: redisClient,
        queueMaintenance: {
          cleanRuns: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
        },
        terminalRunWriter: {
          claimTerminalRun,
          writeAfterTerminalClaims:
            postgresTerminalRunWriter.writeAfterTerminalClaims.bind(postgresTerminalRunWriter),
        },
        logger: createSilentLogger("api"),
        now: () => new Date("2026-06-20T00:00:10.000Z"),
      });

      await expect(service.reset(`corr-reset-${fixture.status}`)).resolves.toMatchObject({
        failedRunCount: 1,
      });
      expect(claimTerminalRun).toHaveBeenCalledOnce();
      expect(claimTerminalRun).toHaveBeenCalledWith({
        runId: fixture.runId,
        terminalStatus: "failed",
        failureReason: "admin_reset",
        finalizedAt: new Date("2026-06-20T00:00:10.000Z"),
        allowedCurrentStatuses: ["starting", "active", "draining"],
        terminalTrafficStatus: "failed",
      });
      await expect(
        db.select().from(demoRunSummaries).where(eq(demoRunSummaries.runId, fixture.runId)),
      ).resolves.toEqual([
        expect.objectContaining({
          runId: fixture.runId,
          status: "failed",
          failureReason: "admin_reset",
        }),
      ]);
    });
  });
});

async function seedRuns(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  redis: ReturnType<typeof createRedisClient>,
): Promise<void> {
  await seedBase(db);
  await seedRun(db, redis, {
    runId: ids.startingRun,
    saleOfferId: ids.startingOffer,
    status: "failed",
    trafficStatus: "failed",
    failureReason: "admin_reset",
    runInventoryStatus: "accepting",
  });
  await seedRun(db, redis, {
    runId: ids.activeRun,
    saleOfferId: ids.activeOffer,
    status: "active",
    trafficStatus: "active",
    failureReason: null,
    runInventoryStatus: "accepting",
  });
  await seedRun(db, redis, {
    runId: ids.drainingRun,
    saleOfferId: ids.drainingOffer,
    status: "failed",
    trafficStatus: "failed",
    failureReason: "admin_reset",
    runInventoryStatus: "closed",
  });
  await seedRun(db, redis, {
    runId: ids.completedRun,
    saleOfferId: ids.completedOffer,
    status: "completed",
    trafficStatus: "succeeded",
    failureReason: null,
  });
  await seedRun(db, redis, {
    runId: ids.failedRun,
    saleOfferId: ids.failedOffer,
    status: "failed",
    trafficStatus: "failed",
    failureReason: "traffic_failed",
  });
}

async function seedBase(db: ReturnType<typeof createDatabaseConnection>["db"]): Promise<void> {
  await db.insert(products).values({
    id: ids.product,
    sku: "RESET-001",
    slug: "reset-product",
    name: "Reset Product",
    isActive: true,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await db.insert(demoPresets).values({
    id: ids.preset,
    slug: "reset-preset",
    visibility: "public",
    isEditable: false,
    isCustom: false,
    display: {
      name: "Reset Preset",
      description: "Reset fixture.",
      sortOrder: 1,
      outcomeFocus: ["recovery"],
    },
    ...configSnapshotFixture(),
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
}

async function seedRun(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  redis: ReturnType<typeof createRedisClient>,
  input: {
    runId: string;
    saleOfferId: string;
    status: "starting" | "active" | "draining" | "completed" | "failed";
    trafficStatus: "starting" | "active" | "succeeded" | "failed";
    failureReason: string | null;
    runInventoryStatus?: "accepting" | "closed";
    createdAt?: Date;
  },
): Promise<void> {
  const now = input.createdAt ?? new Date("2026-06-20T00:00:00.000Z");
  await db.insert(saleOffers).values({
    id: input.saleOfferId,
    productId: ids.product,
    name: `${input.status} Offer`,
    allocatedStock: 10,
    saleStartsAt: now,
    saleEndsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    isActive: true,
    purpose: "generated_run",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(demoRuns).values({
    id: input.runId,
    presetId: ids.preset,
    presetName: "Reset Preset",
    operatorMode: "admin",
    status: input.status,
    trafficStatus: input.trafficStatus,
    configSnapshot: configSnapshotFixture(),
    saleOfferId: input.saleOfferId,
    startedAt: now,
    trafficStartedAt: input.status === "starting" ? null : new Date("2026-06-20T00:00:01.000Z"),
    trafficEndedAt:
      input.status === "draining" || input.status === "completed" || input.status === "failed"
        ? new Date("2026-06-20T00:00:05.000Z")
        : null,
    finalizedAt:
      input.status === "completed" || input.status === "failed"
        ? new Date("2026-06-20T00:00:06.000Z")
        : null,
    failureReason: input.failureReason,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(demoRunSaleContexts).values({
    runId: input.runId,
    saleOfferId: input.saleOfferId,
    createdAt: now,
    updatedAt: now,
  });
  if (input.runInventoryStatus) {
    await initializeInventory(redis, {
      saleOfferId: input.saleOfferId,
      allocatedStock: 10,
      initializedAt: now,
      run: { runId: input.runId, status: input.runInventoryStatus },
    });
  }
  if (input.status === "draining") {
    await db.insert(demoRunFinalizations).values({
      runId: input.runId,
      exitCode: 0,
      errorMessage: null,
      transportAttemptCounts: {
        plannedRequests: 10,
        startedRequests: 10,
        completedRequests: 10,
        interruptedRequests: 0,
        unstartedRequests: 0,
      },
      httpSummary: {
        failedRequests: 0,
        acceptedResponses: 8,
        soldOutResponses: 2,
        transportFailures: 0,
        unexpectedResponses: 0,
        failureRate: 0,
      },
      trafficOutcomeSummary: {},
      trafficDeliverySummary: trafficDeliverySummarySchema.parse({
        trafficMode: null,
        plannedBuyers: null,
        scheduledRatePerSecond: null,
        configuredDurationSeconds: null,
        preAllocatedVUs: null,
        maxVUs: null,
        droppedIterations: 0,
        completedIterations: null,
        requestArrivalSummary: emptyRequestArrivalSummary,
        trafficDeliveryStatus: "complete",
        notes: [],
      }),
      httpTimingBreakdownSummary: {
        ...emptyHttpTimingBreakdownSummary,
        waiting: { averageMs: 30, p95Ms: 42 },
      },
      loadRunDiagnosticsSummary: currentFinalizationDiagnosticsFixture(10),
      trafficSummaryReceivedAt: new Date("2026-06-20T00:00:05.000Z"),
      createdAt: new Date("2026-06-20T00:00:05.000Z"),
      updatedAt: new Date("2026-06-20T00:00:05.000Z"),
    });
  }
}

async function seedCatalogReferencedTerminalRun(
  db: ReturnType<typeof createDatabaseConnection>["db"],
): Promise<void> {
  const now = new Date("2026-06-20T00:00:00.000Z");
  await db.insert(saleOffers).values({
    id: ids.catalogOffer,
    productId: ids.product,
    name: "Catalog Offer",
    allocatedStock: 10,
    saleStartsAt: now,
    saleEndsAt: new Date("2026-06-21T00:00:00.000Z"),
    isActive: true,
    purpose: "catalog",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(demoRuns).values({
    id: ids.catalogRun,
    presetId: ids.preset,
    presetName: "Reset Preset",
    operatorMode: "admin",
    status: "completed",
    trafficStatus: "succeeded",
    configSnapshot: configSnapshotFixture(),
    saleOfferId: ids.catalogOffer,
    startedAt: now,
    trafficStartedAt: new Date("2026-06-20T00:00:01.000Z"),
    trafficEndedAt: new Date("2026-06-20T00:00:05.000Z"),
    finalizedAt: new Date("2026-06-20T00:00:06.000Z"),
    failureReason: null,
    createdAt: now,
    updatedAt: now,
  });
  await seedTerminalSummary(db, {
    runId: ids.catalogRun,
    saleOfferId: ids.catalogOffer,
    status: "completed",
    failureReason: null,
  });
}

async function seedActiveRunBusinessState(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  redis: ReturnType<typeof createRedisClient>,
): Promise<void> {
  const reservation = {
    id: ids.activeReservation,
    saleOfferId: ids.activeOffer,
    runId: ids.activeRun,
    quantity: 1,
    reservationToken: "active-token",
    correlationId: "corr-active-business",
    securedAt: "2026-06-20T00:00:02.000Z",
    expiresAt: "2026-06-20T00:15:02.000Z",
  };

  await reserveInventoryStock(redis, {
    idempotencyKey: "active-idempotency",
    idempotencyTtlSeconds: 1800,
    reservation,
  });
  await promoteReservationIdempotencyToAccepted(redis, {
    idempotencyKey: "active-idempotency",
    idempotencyTtlSeconds: 1800,
    reservation,
  });
  await db.insert(reservations).values({
    id: ids.activeReservation,
    saleOfferId: ids.activeOffer,
    runId: ids.activeRun,
    correlationId: "corr-active-business",
    quantity: 1,
    reservationToken: "active-token",
    securedAt: new Date("2026-06-20T00:00:02.000Z"),
    expiresAt: new Date("2026-06-20T00:15:02.000Z"),
    createdAt: new Date("2026-06-20T00:00:02.000Z"),
    updatedAt: new Date("2026-06-20T00:00:02.000Z"),
  });
  await db.insert(orders).values({
    id: ids.activeOrder,
    publicOrderId: "active-order",
    saleOfferId: ids.activeOffer,
    reservationId: ids.activeReservation,
    runId: ids.activeRun,
    correlationId: "corr-active-business",
    quantity: 1,
    status: "queued",
    queuedAt: new Date("2026-06-20T00:00:03.000Z"),
    createdAt: new Date("2026-06-20T00:00:03.000Z"),
    updatedAt: new Date("2026-06-20T00:00:03.000Z"),
  });
  await db.insert(demoRunSoldOutCounts).values({
    runId: ids.activeRun,
    count: 4,
    latestObservedAt: new Date("2026-06-20T00:00:04.000Z"),
    capturedAt: new Date("2026-06-20T00:00:04.000Z"),
    createdAt: new Date("2026-06-20T00:00:04.000Z"),
  });
}

async function seedCleanupDurableGraph(
  db: ReturnType<typeof createDatabaseConnection>["db"],
): Promise<void> {
  const now = new Date("2026-06-20T00:00:04.000Z");
  await db.insert(reservations).values({
    id: ids.completedReservation,
    saleOfferId: ids.completedOffer,
    runId: ids.completedRun,
    correlationId: "corr-cleanup-graph",
    quantity: 1,
    reservationToken: "cleanup-token",
    securedAt: now,
    expiresAt: new Date("2026-06-20T00:15:04.000Z"),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(orders).values({
    id: ids.completedOrder,
    publicOrderId: "cleanup-order",
    saleOfferId: ids.completedOffer,
    reservationId: ids.completedReservation,
    runId: ids.completedRun,
    correlationId: "corr-cleanup-graph",
    quantity: 1,
    status: "confirmed",
    queuedAt: now,
    processingAt: now,
    confirmedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(erpAttempts).values({
    orderId: ids.completedOrder,
    deliveryId: "cleanup-delivery",
    correlationId: "corr-cleanup-graph",
    runId: ids.completedRun,
    attemptNumber: 1,
    status: "succeeded",
    terminal: true,
    httpStatus: 200,
    latencyMs: 5,
    startedAt: now,
    finishedAt: now,
    idempotencyKey: "cleanup-erp-idempotency",
    createdAt: now,
  });
  await db.insert(orderEvents).values({
    orderId: ids.completedOrder,
    reservationId: ids.completedReservation,
    saleOfferId: ids.completedOffer,
    correlationId: "corr-cleanup-graph",
    runId: ids.completedRun,
    eventName: "order.confirmed",
    payload: {},
    source: "test",
    occurredAt: now,
    createdAt: now,
  });
  await db.insert(simulatedNotifications).values({
    orderId: ids.completedOrder,
    saleOfferId: ids.completedOffer,
    correlationId: "corr-cleanup-graph",
    runId: ids.completedRun,
    recipientPlaceholder: "buyer@example.invalid",
    recordedAt: now,
    createdAt: now,
  });
  await db.insert(reservationPendingPersistence).values({
    reservationId: "99999999-9999-4999-8999-999999999991",
    saleOfferId: ids.completedOffer,
    correlationId: "corr-cleanup-graph-pending",
    runId: ids.completedRun,
    status: "pending_reconciliation",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(demoRunSoldOutCounts).values({
    runId: ids.completedRun,
    count: 2,
    latestObservedAt: now,
    capturedAt: now,
    createdAt: now,
  });
  await db.insert(demoRunFinalizations).values({
    runId: ids.completedRun,
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
      soldOutResponses: 0,
      transportFailures: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    trafficOutcomeSummary: {},
    trafficDeliverySummary: trafficDeliverySummarySchema.parse({
      trafficMode: null,
      plannedBuyers: null,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: null,
      requestArrivalSummary: emptyRequestArrivalSummary,
      trafficDeliveryStatus: "complete",
      notes: [],
    }),
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    loadRunDiagnosticsSummary: currentFinalizationDiagnosticsFixture(10),
    trafficSummaryReceivedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await seedTerminalSummary(db, {
    runId: ids.completedRun,
    saleOfferId: ids.completedOffer,
    status: "completed",
    failureReason: null,
  });
}

function currentFinalizationDiagnosticsFixture(plannedRequests: number) {
  return {
    startedAt: "2026-06-20T00:00:00.000Z",
    completedAt: "2026-06-20T00:00:05.000Z",
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
      maxDurationSeconds: 10,
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

async function readRunScopedGraphCounts(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  runId: string,
): Promise<Record<string, number>> {
  const [
    notificationRows,
    erpRows,
    eventRows,
    orderRows,
    reservationRows,
    pendingRows,
    outcomeRows,
    finalizationRows,
    summaryRows,
  ] = await Promise.all([
    db.select().from(simulatedNotifications).where(eq(simulatedNotifications.runId, runId)),
    db.select().from(erpAttempts).where(eq(erpAttempts.runId, runId)),
    db.select().from(orderEvents).where(eq(orderEvents.runId, runId)),
    db.select().from(orders).where(eq(orders.runId, runId)),
    db.select().from(reservations).where(eq(reservations.runId, runId)),
    db
      .select()
      .from(reservationPendingPersistence)
      .where(eq(reservationPendingPersistence.runId, runId)),
    db.select().from(demoRunSoldOutCounts).where(eq(demoRunSoldOutCounts.runId, runId)),
    db.select().from(demoRunFinalizations).where(eq(demoRunFinalizations.runId, runId)),
    db.select().from(demoRunSummaries).where(eq(demoRunSummaries.runId, runId)),
  ]);
  return {
    erpAttempts: erpRows.length,
    finalizations: finalizationRows.length,
    notifications: notificationRows.length,
    orderEvents: eventRows.length,
    orders: orderRows.length,
    outcomes: outcomeRows.length,
    pendingPersistence: pendingRows.length,
    reservations: reservationRows.length,
    summaries: summaryRows.length,
  };
}

async function seedTerminalSummary(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  input: {
    runId: string;
    saleOfferId: string;
    status: "completed" | "failed";
    failureReason: string | null;
  },
): Promise<void> {
  await db.insert(demoRunSummaries).values({
    runId: input.runId,
    presetName: "Reset Preset",
    status: input.status,
    failureReason: input.failureReason,
    replayPossible: false,
    startedAt: new Date("2026-06-20T00:00:00.000Z"),
    endedAt: new Date("2026-06-20T00:00:06.000Z"),
    transportAttemptCounts: {
      plannedRequests: 10,
      startedRequests: 10,
      completedRequests: 10,
      interruptedRequests: 0,
      unstartedRequests: 0,
    },
    httpSummary: {
      failedRequests: 0,
      acceptedResponses: input.status === "completed" ? 10 : 8,
      soldOutResponses: input.status === "completed" ? 0 : 2,
      transportFailures: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    trafficDeliverySummary: trafficDeliverySummarySchema.parse({
      trafficMode: null,
      plannedBuyers: null,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: null,
      requestArrivalSummary: emptyRequestArrivalSummary,
      trafficDeliveryStatus: input.status === "completed" ? "complete" : "failed",
      notes: [],
    }),
    httpTimingBreakdownSummary: {
      ...emptyHttpTimingBreakdownSummary,
      waiting: { averageMs: 20, p95Ms: 30 },
    },
    loadRunDiagnosticsSummary: { source: "existing-summary" },
    businessOutcomeSummary: {
      acceptedReservations: input.status === "completed" ? 10 : 8,
      reservedUnits: input.status === "completed" ? 10 : 8,
      soldOutRejections: input.status === "completed" ? 0 : 2,
      queuedOrders: 0,
      processingOrders: 0,
      retryingOrders: 0,
      confirmedOrders: input.status === "completed" ? 10 : 6,
      failedOrders: input.status === "completed" ? 0 : 2,
      pendingPersistenceCount: 0,
      notificationsRecorded: input.status === "completed" ? 10 : 6,
    },
    terminalInventorySnapshot: {
      saleOfferId: input.saleOfferId,
      startingStock: 10,
      remainingStock: input.status === "completed" ? 0 : 2,
      reservedStock: input.status === "completed" ? 10 : 8,
      acceptedReservations: input.status === "completed" ? 10 : 8,
      soldOutRejections: input.status === "completed" ? 0 : 2,
      pendingPersistenceCount: 0,
      capturedAt: "2026-06-20T00:00:06.000Z",
      source: "redis",
    },
    capturedAt: new Date("2026-06-20T00:00:06.000Z"),
    createdAt: new Date("2026-06-20T00:00:06.000Z"),
  });
}

async function readTerminalSummaryRows(
  db: ReturnType<typeof createDatabaseConnection>["db"],
): Promise<(typeof demoRunSummaries.$inferSelect)[]> {
  const rows = await db
    .select()
    .from(demoRunSummaries)
    .where(inArray(demoRunSummaries.runId, [ids.completedRun, ids.failedRun]));

  return rows.sort((left, right) => left.runId.localeCompare(right.runId));
}

function createRetentionTestService(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  redis: ReturnType<typeof createRedisClient>,
  overrides: {
    logger?: CheckoutSurgeLogger;
    queueMaintenance?: ExactRunQueueMaintenance;
    deleteGeneratedRunRedisState?: typeof deleteGeneratedRunRedisState;
    inspectGeneratedRunTeardown?: typeof inspectGeneratedRunTeardown;
    deleteGeneratedRunDurable?: typeof deleteGeneratedRunDurable;
  } = {},
): GeneratedRunRetentionService {
  return createIntegratedRetentionService({
    db,
    redis,
    queueMaintenance: overrides.queueMaintenance ?? noOpGeneratedRunQueueMaintenance(),
    logger: overrides.logger ?? createSilentLogger("api"),
    now: () => new Date("2026-06-25T00:00:00.000Z"),
    ...(overrides.deleteGeneratedRunRedisState
      ? { deleteGeneratedRunRedisState: overrides.deleteGeneratedRunRedisState }
      : {}),
    ...(overrides.inspectGeneratedRunTeardown
      ? { inspectGeneratedRunTeardown: overrides.inspectGeneratedRunTeardown }
      : {}),
    ...(overrides.deleteGeneratedRunDurable
      ? { deleteGeneratedRunDurable: overrides.deleteGeneratedRunDurable }
      : {}),
  });
}

function configSnapshotFixture(): AcceptedRunConfigSnapshot {
  return {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 10,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 1,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 10,
    },
    erpConfig: {
      latencyMs: 10,
      maxTps: 10,
      errorRate: 0,
      forcedOutage: false,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 2,
    },
  };
}

function requireTestRedisUrl(): string {
  const redisUrl = process.env.TEST_REDIS_URL;

  if (!redisUrl) {
    throw new Error("TEST_REDIS_URL is required for API maintenance tests.");
  }

  return redisUrl;
}

function requireConnection(
  connection: ReturnType<typeof createDatabaseConnection> | null,
): ReturnType<typeof createDatabaseConnection> {
  if (!connection) {
    throw new Error("Test database connection was not initialized.");
  }

  return connection;
}

function requireRedis(
  redis: ReturnType<typeof createRedisClient> | null,
): ReturnType<typeof createRedisClient> {
  if (!redis) {
    throw new Error("Test Redis client was not initialized.");
  }

  return redis;
}

async function boundedResetBarrier<T>(promise: Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(5_000);
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    ),
  ]);
}

function releaseBarrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
