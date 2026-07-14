import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AcceptedRunConfigSnapshot } from "@checkout-surge/contracts";
import {
  completeGeneratedRunTeardown,
  createDatabaseConnection,
  createRedisClient,
  deleteGeneratedRunDurable,
  type deleteGeneratedRunRedisState,
  demoPresets,
  demoRunFinalizations,
  demoRunReservationOutcomes,
  demoRunSaleContexts,
  demoRunSummaries,
  demoRuns,
  demoRunTeardownReceipts,
  erpAttempts,
  initializeInventory,
  inventoryKeys,
  isRunSaleEligible,
  markReservationPendingPersistence,
  orderEvents,
  orders,
  prepareGeneratedRunTeardown,
  products,
  promoteReservationIdempotencyToAccepted,
  reservationPendingPersistence,
  reservations,
  reserveInventoryStock,
  saleOffers,
  simulatedNotifications,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { type CheckoutSurgeLogger, createSilentLogger } from "@checkout-surge/logger";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiHttpError } from "../src/runtime/errors.js";
import {
  DemoQueueMaintenanceConflict,
  type DemoQueueQuiescenceRelease,
  DemoMaintenanceService as ProductionDemoMaintenanceService,
} from "../src/services/demo-maintenance-service.js";
import { PostgresBuyPersistence } from "../src/services/postgres-buy-persistence.js";
import {
  ReserveOrderService,
  type StockReservationGateway,
} from "../src/services/reserve-order-service.js";
import { PostgresTerminalDemoRunSummaryWriter } from "../src/services/terminal-demo-run-transition.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPackageRoot = path.resolve(packageRoot, "../../packages/db");
const migrationsFolder = path.join(dbPackageRoot, "drizzle");

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

class DemoMaintenanceService extends ProductionDemoMaintenanceService {
  constructor(options: ConstructorParameters<typeof ProductionDemoMaintenanceService>[0]) {
    super({
      trafficAborter: {
        abortCurrent: async () => ({ outcome: "no_current_run" }),
      },
      dashboardLiveStateReset: {
        fenceRun: async () => undefined,
        clearRun: async () => undefined,
        hasRunState: async () => false,
      },
      resetWorkflowFence: { runExclusive: async (operation) => operation() },
      ...options,
    });
  }
}

describe("demo maintenance service", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;
  let redis: ReturnType<typeof createRedisClient> | null = null;

  beforeEach(async () => {
    await connection?.close();
    redis?.disconnect();
    connection = null;
    redis = null;

    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    redis = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    await redis.flushdb();
  });

  it("tears down the full terminal graph and safely retries every post-commit stage", async () => {
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
    await seedCleanupDurableGraph(db);
    await redisClient.set(`demo-run:${ids.completedRun}:traffic-metrics`, "metric");
    const preflightGeneratedRun = vi.fn(async () => undefined);
    const cleanGeneratedRun = vi.fn(async () => ({ deletedJobCount: 2 }));
    const releaseDispositions: DemoQueueQuiescenceRelease["disposition"][] = [];
    let failRedis = true;
    let failReceiptCompletion = true;
    const service = new DemoMaintenanceService({
      db,
      redis: redisClient,
      queueMaintenance: {
        cleanResetOwnedQueues: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
        acquireGeneratedRunQuiescence: async (_runId) => ({
          release: async (options) => {
            releaseDispositions.push(options.disposition);
            await restoreQueueLease(options);
          },
        }),
        preflightGeneratedRun,
        cleanGeneratedRun,
      },
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      logger: createSilentLogger("api"),
      deleteGeneratedRunRedisState: async (...args) => {
        if (failRedis) throw new Error("redis unavailable");
        const { deleteGeneratedRunRedisState } = await import("@checkout-surge/db");
        return deleteGeneratedRunRedisState(...args);
      },
      completeGeneratedRunTeardown: async (...args) => {
        if (failReceiptCompletion) throw new Error("receipt completion unavailable");
        return completeGeneratedRunTeardown(...args);
      },
      now: () => new Date("2026-07-13T00:00:00.000Z"),
    });

    await expect(
      service.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-first" }),
    ).rejects.toThrow("redis unavailable");
    expect(await db.select().from(demoRuns).where(eq(demoRuns.id, ids.completedRun))).toHaveLength(
      0,
    );
    expect(await db.select().from(demoRunTeardownReceipts)).toHaveLength(1);
    expect(releaseDispositions).toEqual(["restore_owned_pauses"]);
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

    failRedis = false;
    await expect(
      service.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-retry" }),
    ).rejects.toThrow("receipt completion unavailable");
    expect(await db.select().from(demoRunTeardownReceipts)).toHaveLength(1);

    failReceiptCompletion = false;
    await expect(
      service.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-complete" }),
    ).resolves.toMatchObject({ outcome: "deleted", saleOfferId: ids.completedOffer });
    expect(await db.select().from(demoRunTeardownReceipts)).toHaveLength(0);
    expect(await redisClient.get(`demo-run:${ids.completedRun}:traffic-metrics`)).toBeNull();
    await expect(
      service.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-absent" }),
    ).resolves.toMatchObject({ outcome: "already_absent", runId: ids.completedRun });
    expect(preflightGeneratedRun).toHaveBeenCalledTimes(4);
    expect(cleanGeneratedRun).toHaveBeenCalledTimes(3);
  });

  it("re-reads a concurrently committed receipt after the run disappears", async () => {
    const primary = requireConnection(connection);
    const redisClient = requireRedis(redis);
    await seedBase(primary.db);
    await seedRun(primary.db, redisClient, {
      runId: ids.completedRun,
      saleOfferId: ids.completedOffer,
      status: "completed",
      trafficStatus: "succeeded",
      failureReason: null,
      runInventoryStatus: "closed",
    });
    const blocker = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    const contender = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    let releaseRunLock: (() => void) | undefined;
    const runLockRelease = new Promise<void>((resolve) => {
      releaseRunLock = resolve;
    });
    let reportRunLocked: (() => void) | undefined;
    const runLocked = new Promise<void>((resolve) => {
      reportRunLocked = resolve;
    });
    const lock = blocker.db.transaction(async (tx) => {
      await tx
        .select({ id: demoRuns.id })
        .from(demoRuns)
        .where(eq(demoRuns.id, ids.completedRun))
        .for("update");
      reportRunLocked?.();
      await runLockRelease;
    });
    try {
      await runLocked;
      const first = prepareGeneratedRunTeardown(
        primary.db,
        ids.completedRun,
        new Date("2026-07-13T00:00:00.000Z"),
      );
      const racing = prepareGeneratedRunTeardown(
        contender.db,
        ids.completedRun,
        new Date("2026-07-13T00:00:01.000Z"),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      releaseRunLock?.();
      await lock;
      const results = await Promise.all([first, racing]);
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outcome: "ready", durableDeleted: true }),
          expect.objectContaining({
            outcome: "ready",
            runId: ids.completedRun,
            saleOfferId: ids.completedOffer,
            durableDeleted: false,
          }),
        ]),
      );
    } finally {
      releaseRunLock?.();
      await lock;
      await blocker.close();
      await contender.close();
    }
  });

  it("rolls back the receipt and every child deletion when the durable transaction fails", async () => {
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
      CREATE TABLE task_32_order_delete_blocker (
        order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT
      )
    `;
    try {
      await dbConnection.sql`
        INSERT INTO task_32_order_delete_blocker (order_id) VALUES (${ids.completedOrder})
      `;

      await expect(
        prepareGeneratedRunTeardown(db, ids.completedRun, new Date("2026-07-13T00:00:00.000Z")),
      ).rejects.toThrow();

      expect(await db.select().from(demoRunTeardownReceipts)).toHaveLength(0);
      expect(
        await db.select().from(demoRuns).where(eq(demoRuns.id, ids.completedRun)),
      ).toHaveLength(1);
      expect(
        await db.select().from(saleOffers).where(eq(saleOffers.id, ids.completedOffer)),
      ).toHaveLength(1);
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
    } finally {
      await dbConnection.sql`DROP TABLE IF EXISTS task_32_order_delete_blocker`;
    }
  });

  it.each([
    "starting",
    "active",
    "draining",
  ] as const)("rejects %s targeted teardown without mutation", async (status) => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    await seedBase(db);
    await seedRun(db, redisClient, {
      runId: ids.completedRun,
      saleOfferId: ids.completedOffer,
      status,
      trafficStatus:
        status === "starting" ? "starting" : status === "active" ? "active" : "succeeded",
      failureReason: null,
    });
    const release = vi.fn(restoreQueueLease);
    const service = new DemoMaintenanceService({
      db,
      redis: redisClient,
      queueMaintenance: {
        cleanResetOwnedQueues: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
        acquireGeneratedRunQuiescence: async (_runId) => ({
          release,
        }),
        preflightGeneratedRun: async () => undefined,
        cleanGeneratedRun: async () => ({ deletedJobCount: 0 }),
      },
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      logger: createSilentLogger("api"),
    });
    await expect(
      service.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-active" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "run_not_terminal" });
    expect(await db.select().from(demoRuns).where(eq(demoRuns.id, ids.completedRun))).toHaveLength(
      1,
    );
    expect(release).toHaveBeenCalledWith({ disposition: "restore_owned_pauses" });
  });

  it("accepts a terminal failed run and retries a post-commit queue failure", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    await seedBase(db);
    await seedRun(db, redisClient, {
      runId: ids.failedRun,
      saleOfferId: ids.failedOffer,
      status: "failed",
      trafficStatus: "failed",
      failureReason: "traffic_failed",
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
    let failQueue = true;
    let maintenanceOwner: string | null = null;
    let pauseCalls = 0;
    const acquireRunIds: string[] = [];
    const preflightGeneratedRun = vi.fn(async () => undefined);
    const cleanGeneratedRun = vi.fn(async () => {
      if (failQueue) throw new Error("queue unavailable");
      return { deletedJobCount: 0 };
    });
    const releaseDispositions: DemoQueueQuiescenceRelease["disposition"][] = [];
    const service = new DemoMaintenanceService({
      db,
      redis: redisClient,
      queueMaintenance: {
        cleanResetOwnedQueues: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
        acquireGeneratedRunQuiescence: async (requestedRunId) => {
          acquireRunIds.push(requestedRunId);
          if (maintenanceOwner && maintenanceOwner !== requestedRunId) {
            throw new DemoQueueMaintenanceConflict(
              "maintenance_owned_by_other_run",
              `maintenance belongs to ${maintenanceOwner}`,
            );
          }
          if (!maintenanceOwner) pauseCalls += 1;
          maintenanceOwner = requestedRunId;
          return {
            release: async (options) => {
              releaseDispositions.push(options.disposition);
              if (options.disposition === "retain_owned_pauses") return;
              maintenanceOwner = null;
              await options.afterRestored?.();
            },
          };
        },
        preflightGeneratedRun,
        cleanGeneratedRun,
      },
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      logger: createSilentLogger("api"),
    });
    await expect(
      service.teardownGeneratedRun({ runId: ids.failedRun, correlationId: "corr-queue-fail" }),
    ).rejects.toThrow("queue unavailable");
    expect(await db.select().from(demoRuns).where(eq(demoRuns.id, ids.failedRun))).toHaveLength(0);
    expect(await db.select().from(demoRunTeardownReceipts)).toHaveLength(1);
    expect(maintenanceOwner).toBe(ids.failedRun);
    expect(pauseCalls).toBe(1);
    expect(releaseDispositions).toEqual(["retain_owned_pauses"]);

    for (const blockedRunId of [ids.completedRun, ids.activeRun]) {
      await expect(
        service.teardownGeneratedRun({
          runId: blockedRunId,
          correlationId: `corr-foreign-${blockedRunId}`,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "run_queue_maintenance_owned_by_other_run",
      });
    }
    await seedRun(db, redisClient, {
      runId: ids.completedRun,
      saleOfferId: ids.completedOffer,
      status: "completed",
      trafficStatus: "succeeded",
      failureReason: null,
      runInventoryStatus: "closed",
    });
    await expect(
      service.teardownGeneratedRun({
        runId: ids.completedRun,
        correlationId: "corr-foreign-terminal",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "run_queue_maintenance_owned_by_other_run",
    });
    expect(maintenanceOwner).toBe(ids.failedRun);
    expect(pauseCalls).toBe(1);
    expect(preflightGeneratedRun).toHaveBeenCalledTimes(1);
    expect(cleanGeneratedRun).toHaveBeenCalledTimes(1);
    expect(await db.select().from(demoRuns).where(eq(demoRuns.id, ids.activeRun))).toHaveLength(1);
    expect(await db.select().from(demoRuns).where(eq(demoRuns.id, ids.completedRun))).toHaveLength(
      1,
    );
    expect(await db.select().from(demoRunTeardownReceipts)).toHaveLength(1);

    failQueue = false;
    await expect(
      service.teardownGeneratedRun({ runId: ids.failedRun, correlationId: "corr-queue-retry" }),
    ).resolves.toMatchObject({ outcome: "deleted", saleOfferId: ids.failedOffer });
    expect(await db.select().from(demoRunTeardownReceipts)).toHaveLength(0);
    expect(maintenanceOwner).toBeNull();
    expect(pauseCalls).toBe(1);
    expect(releaseDispositions).toEqual(["retain_owned_pauses", "restore_owned_pauses"]);
    expect(acquireRunIds).toEqual([
      ids.failedRun,
      ids.completedRun,
      ids.activeRun,
      ids.completedRun,
      ids.failedRun,
    ]);
  });

  it("retains retry coordinates until queue pause state is restored", async () => {
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
    let failRelease = true;
    const service = new DemoMaintenanceService({
      db,
      redis: redisClient,
      queueMaintenance: {
        cleanResetOwnedQueues: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
        acquireGeneratedRunQuiescence: async (_runId) => ({
          release: async (options) => {
            if (options.disposition === "retain_owned_pauses") return;
            if (failRelease) throw new Error("resume unavailable");
            await options.afterRestored?.();
          },
        }),
        preflightGeneratedRun: async () => undefined,
        cleanGeneratedRun: async () => ({ deletedJobCount: 0 }),
      },
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      logger: createSilentLogger("api"),
    });

    await expect(
      service.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-resume-fail" }),
    ).rejects.toThrow("resume unavailable");
    expect(await db.select().from(demoRunTeardownReceipts)).toHaveLength(1);

    failRelease = false;
    await expect(
      service.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-resume-retry" }),
    ).resolves.toMatchObject({ outcome: "deleted", saleOfferId: ids.completedOffer });
    expect(await db.select().from(demoRunTeardownReceipts)).toHaveLength(0);
  });

  it("rejects catalog ownership and missing context without mutation", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    await seedBase(db);
    await seedCatalogReferencedTerminalRun(db);
    const queueMaintenance = {
      cleanResetOwnedQueues: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
      acquireGeneratedRunQuiescence: async (_runId: string) => ({
        release: restoreQueueLease,
      }),
      preflightGeneratedRun: async () => undefined,
      cleanGeneratedRun: async () => ({ deletedJobCount: 0 }),
    };
    const service = new DemoMaintenanceService({
      db,
      redis: redisClient,
      queueMaintenance,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      logger: createSilentLogger("api"),
    });
    await expect(
      service.teardownGeneratedRun({ runId: ids.catalogRun, correlationId: "corr-catalog" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "run_ownership_mismatch" });
    expect(await db.select().from(demoRuns).where(eq(demoRuns.id, ids.catalogRun))).toHaveLength(1);
    expect(
      await db.select().from(saleOffers).where(eq(saleOffers.id, ids.catalogOffer)),
    ).toHaveLength(1);

    await seedRun(db, redisClient, {
      runId: ids.completedRun,
      saleOfferId: ids.completedOffer,
      status: "completed",
      trafficStatus: "succeeded",
      failureReason: null,
      runInventoryStatus: "closed",
    });
    await db.delete(demoRunSaleContexts).where(eq(demoRunSaleContexts.runId, ids.completedRun));
    await expect(
      service.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-missing" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "run_ownership_mismatch" });
    expect(await db.select().from(demoRuns).where(eq(demoRuns.id, ids.completedRun))).toHaveLength(
      1,
    );
    expect(
      await db.select().from(saleOffers).where(eq(saleOffers.id, ids.completedOffer)),
    ).toHaveLength(1);
  });

  it("validates targeted queue capability before mutation and preserves primary release failure", async () => {
    const prepare = vi.fn();
    const incomplete = new DemoMaintenanceService({
      db: requireConnection(connection).db,
      redis: requireRedis(redis),
      queueMaintenance: {
        cleanResetOwnedQueues: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
      },
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(requireConnection(connection).db),
      logger: createSilentLogger("api"),
      prepareGeneratedRunTeardown: prepare,
    });
    await expect(
      incomplete.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-miswired" }),
    ).rejects.toThrow("not fully configured");
    expect(prepare).not.toHaveBeenCalled();

    const primary = new Error("primary queue conflict");
    const release = new Error("release failed");
    const service = new DemoMaintenanceService({
      db: requireConnection(connection).db,
      redis: requireRedis(redis),
      queueMaintenance: {
        cleanResetOwnedQueues: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
        acquireGeneratedRunQuiescence: async (_runId) => ({
          release: async () => {
            throw release;
          },
        }),
        preflightGeneratedRun: async () => {
          throw primary;
        },
        cleanGeneratedRun: async () => ({ deletedJobCount: 0 }),
      },
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(requireConnection(connection).db),
      logger: createSilentLogger("api"),
    });
    await expect(
      service.teardownGeneratedRun({ runId: ids.completedRun, correlationId: "corr-release" }),
    ).rejects.toMatchObject({ errors: [primary, release] });
  });

  afterAll(async () => {
    await connection?.close();
    if (redis) {
      await redis.flushdb();
      redis.disconnect();
    }
  });

  it("fails in-progress runs, closes sale eligibility, and cleans reset-owned queues", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const writerOperations: string[] = [];
    const postgresTerminalRunWriter = new PostgresTerminalDemoRunSummaryWriter(db);
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
      cleanResetOwnedQueues: vi.fn(async () => {
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
    const clearErpCircuitBreakerState = vi.fn().mockResolvedValue(undefined);
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
    const service = new DemoMaintenanceService({
      db,
      terminalRunWriter: { claimTerminalRun, writeAfterTerminalClaims },
      redis: redisClient,
      queueMaintenance,
      clearErpCircuitBreakerState,
      trafficAborter: { abortCurrent },
      dashboardLiveStateReset: { fenceRun, clearRun, hasRunState: async () => false },
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });

    await seedRuns(db, redisClient);
    await seedActiveRunBusinessState(db, redisClient);

    const response = await service.reset("corr-reset");
    expect(clearErpCircuitBreakerState).toHaveBeenCalledOnce();
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
    expect(queueMaintenance.cleanResetOwnedQueues).toHaveBeenCalledOnce();
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
      httpSummary: {
        plannedRequests: 10,
        emittedRequests: 0,
        completedRequests: 0,
      },
      trafficDeliverySummary: {
        plannedRequests: 10,
        emittedRequests: 0,
        droppedIterations: 0,
        completedIterations: 0,
        unstartedIterations: 10,
        requestShortfall: 10,
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
      cleanResetOwnedQueues: vi
        .fn()
        .mockResolvedValue({ cleanedQueueCount: 2, cleanedJobCount: 0 }),
    };
    const service = new DemoMaintenanceService({
      db,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
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
    expect(response.cleanedQueueCount).toBe(2);
    expect(response.cleanedJobCount).toBe(0);
    expect(queueMaintenance.cleanResetOwnedQueues).toHaveBeenCalledOnce();
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
    const cleanResetOwnedQueues = vi.fn(async () => ({ cleanedQueueCount: 2, cleanedJobCount: 0 }));
    const clearRun = vi.fn(async () => undefined);
    const service = new DemoMaintenanceService({
      db,
      redis: redisClient,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      queueMaintenance: { cleanResetOwnedQueues },
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
    expect(cleanResetOwnedQueues).not.toHaveBeenCalled();
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
    const cleanResetOwnedQueues = vi.fn(async () => ({ cleanedQueueCount: 2, cleanedJobCount: 0 }));
    const clearRun = vi.fn(async () => undefined);
    const service = new DemoMaintenanceService({
      db,
      redis: redisClient,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      queueMaintenance: { cleanResetOwnedQueues },
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
    expect(cleanResetOwnedQueues).not.toHaveBeenCalled();
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
    const cleanResetOwnedQueues = vi.fn(async () => ({ cleanedQueueCount: 2, cleanedJobCount: 0 }));
    let failClear = true;
    const logger = createSilentLogger("api");
    const errorLog = vi.spyOn(logger, "error");
    const clearRun = vi.fn(async () => {
      if (failClear) throw new Error("Redis unavailable");
    });
    const service = new DemoMaintenanceService({
      db,
      redis: redisClient,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      queueMaintenance: { cleanResetOwnedQueues },
      trafficAborter: { abortCurrent },
      dashboardLiveStateReset: {
        fenceRun: async () => undefined,
        clearRun,
        hasRunState: async () => true,
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
    expect(cleanResetOwnedQueues).toHaveBeenCalledOnce();

    failClear = false;
    await expect(service.reset("corr-clear-retry")).resolves.toMatchObject({ failedRunCount: 0 });
    expect(clearRun).toHaveBeenCalledTimes(2);
    expect(abortCurrent).toHaveBeenCalledOnce();
    expect(cleanResetOwnedQueues).toHaveBeenCalledTimes(2);
    expect(await db.select().from(demoRunSummaries)).toHaveLength(1);
  });

  it("leaves a fenced run resumable when admission closure fails", async () => {
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
      cleanResetOwnedQueues: vi
        .fn()
        .mockResolvedValue({ cleanedQueueCount: 2, cleanedJobCount: 0 }),
    };
    let resetNow = new Date("2026-06-20T00:00:10.000Z");
    const service = new DemoMaintenanceService({
      db,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      redis: redisClient,
      queueMaintenance,
      logger: createSilentLogger("api"),
      now: () => resetNow,
    });

    const evalSpy = vi
      .spyOn(redisClient, "eval")
      .mockRejectedValueOnce(new Error("temporary Redis outage"));
    await expect(service.reset("corr-reset-failure")).rejects.toThrow(
      "Retry reset to resume the fenced transition",
    );
    evalSpy.mockRestore();

    await expect(db.select().from(demoRuns).where(eq(demoRuns.id, ids.activeRun))).resolves.toEqual(
      [
        expect.objectContaining({
          status: "failed",
          trafficStatus: "failed",
          failureReason: "admin_reset",
        }),
      ],
    );
    expect(await db.select().from(demoRunSummaries)).toHaveLength(0);
    expect(queueMaintenance.cleanResetOwnedQueues).not.toHaveBeenCalled();

    resetNow = new Date("2026-06-20T00:00:20.000Z");
    const response = await service.reset("corr-reset-retry");
    expect(response).toMatchObject({
      failedRunCount: 1,
      closedSaleOfferCount: 1,
      cleanedQueueCount: 2,
      cleanedJobCount: 0,
      correlationId: "corr-reset-retry",
    });
    expect(queueMaintenance.cleanResetOwnedQueues).toHaveBeenCalledOnce();
    const [summary] = await db.select().from(demoRunSummaries);
    expect(summary).toMatchObject({
      endedAt: new Date("2026-06-20T00:00:10.000Z"),
      capturedAt: new Date("2026-06-20T00:00:20.000Z"),
    });
    expect(summary?.loadRunDiagnosticsSummary).not.toHaveProperty("previousStatus");
    expect(summary?.apiRequestLifecycleSummary).not.toHaveProperty("previousStatus");
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
    });
    const maintenanceService = new DemoMaintenanceService({
      db,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      redis: redisClient,
      queueMaintenance: {
        cleanResetOwnedQueues: vi
          .fn()
          .mockResolvedValue({ cleanedQueueCount: 2, cleanedJobCount: 0 }),
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
      outcome: "run_not_accepting_traffic",
      reason: "run_not_accepting_traffic",
      simulatedStatus: "sale_not_active",
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
    const service = new DemoMaintenanceService({
      db,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      redis: redisClient,
      queueMaintenance: {
        cleanResetOwnedQueues: vi
          .fn()
          .mockResolvedValue({ cleanedQueueCount: 2, cleanedJobCount: 0 }),
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
      cleanResetOwnedQueues: vi.fn(async () => {
        expect(await db.select().from(demoRunSummaries)).toHaveLength(0);
        return { cleanedQueueCount: 2, cleanedJobCount: 0 };
      }),
    };
    const maintenanceService = new DemoMaintenanceService({
      db,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      redis: redisClient,
      queueMaintenance,
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });

    try {
      const reservePromise = reserveService.reserve({
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
      const resetPromise = maintenanceService.reset("corr-reset-enqueue-race").then((response) => {
        resetFinished = true;
        return response;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(resetFinished).toBe(false);
      releaseEnqueue?.();

      await expect(reservePromise).resolves.toMatchObject({ outcome: "reservation_secured" });
      await expect(resetPromise).resolves.toMatchObject({ failedRunCount: 1 });
      expect(queuePublisher.enqueue).toHaveBeenCalledOnce();
      expect(queueMaintenance.cleanResetOwnedQueues).toHaveBeenCalledOnce();
      await expect(db.select().from(demoRunSummaries)).resolves.toHaveLength(1);
      await expect(db.select().from(orders)).resolves.toHaveLength(1);
    } finally {
      await enqueueConnection.close();
    }
  });

  it("serializes concurrent resets so a losing caller cannot clean after summary commit", async () => {
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
      cleanResetOwnedQueues: vi.fn(async () => {
        cleanupStarted?.();
        await cleanupRelease;
        return { cleanedQueueCount: 2, cleanedJobCount: 0 };
      }),
    };
    const service = new DemoMaintenanceService({
      db,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      redis: redisClient,
      queueMaintenance,
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });

    const firstReset = service.reset("corr-reset-concurrent-1");
    await cleanupReady;
    let secondFinished = false;
    const secondReset = service.reset("corr-reset-concurrent-2").then((response) => {
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
    expect(queueMaintenance.cleanResetOwnedQueues).toHaveBeenCalledOnce();
    expect(await db.select().from(demoRunSummaries)).toHaveLength(1);
  });

  it("cleans eligible terminal generated-run sale offers through sale contexts", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = new DemoMaintenanceService({
      db,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      redis: redisClient,
      queueMaintenance: {
        cleanResetOwnedQueues: vi
          .fn()
          .mockResolvedValue({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
      },
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
    expect(await redisClient.exists(retainedInventoryKeys.state)).toBe(1);
    expect(await redisClient.get(`demo-run:${ids.failedRun}:sale-eligibility`)).not.toBeNull();
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
    const service = new DemoMaintenanceService({
      db,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      redis: redisClient,
      queueMaintenance: {
        cleanResetOwnedQueues: vi
          .fn()
          .mockResolvedValue({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
      },
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
      const service = createCleanupService(db, redisClient);

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

  it("revalidates terminal status inside the per-run transaction before deleting", async () => {
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
    const deleteRedisState = vi.fn();
    const changeStatusBeforeDelete = vi.fn(
      async (...args: Parameters<typeof deleteGeneratedRunDurable>) => {
        await db
          .update(demoRuns)
          .set({ status: "active", trafficStatus: "active" })
          .where(eq(demoRuns.id, ids.completedRun));
        return deleteGeneratedRunDurable(...args);
      },
    );
    const service = createCleanupService(db, redisClient, {
      deleteGeneratedRunDurable: changeStatusBeforeDelete,
      deleteGeneratedRunRedisState: deleteRedisState,
    });

    await expect(
      service.cleanupOldRuns({
        keepLatest: 0,
        olderThanDays: 1,
        correlationId: "corr-cleanup-stale-status",
      }),
    ).resolves.toMatchObject({ deletedRunCount: 0, deletedSaleOfferCount: 0 });

    expect(await db.select().from(demoRuns).where(eq(demoRuns.id, ids.completedRun))).toEqual([
      expect.objectContaining({ status: "active" }),
    ]);
    expect(deleteRedisState).not.toHaveBeenCalled();
  });

  it("warns on Redis cleanup failure and continues with truthful durable counts", async () => {
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
    const logger = createSilentLogger("api");
    const warn = vi.spyOn(logger, "warn");
    const deleteRedisState = vi
      .fn()
      .mockRejectedValueOnce(new Error("Redis unavailable"))
      .mockResolvedValueOnce(undefined);
    const service = createCleanupService(db, redisClient, {
      logger,
      deleteGeneratedRunRedisState: deleteRedisState,
    });

    await expect(
      service.cleanupOldRuns({
        keepLatest: 0,
        olderThanDays: 1,
        correlationId: "corr-cleanup-redis-warning",
      }),
    ).resolves.toMatchObject({ deletedRunCount: 2, deletedSaleOfferCount: 2 });

    expect(deleteRedisState).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: ids.completedRun,
        saleOfferId: ids.completedOffer,
        correlationId: "corr-cleanup-redis-warning",
      }),
      "Could not remove generated-run Redis state after durable cleanup.",
    );
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
    const postgresTerminalRunWriter = new PostgresTerminalDemoRunSummaryWriter(db);
    const claimTerminalRun = vi.fn(
      postgresTerminalRunWriter.claimTerminalRun.bind(postgresTerminalRunWriter),
    );
    const service = new DemoMaintenanceService({
      db,
      redis: redisClient,
      queueMaintenance: {
        cleanResetOwnedQueues: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
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
      httpSummary: {
        plannedRequests: 10,
        emittedRequests: 10,
        completedRequests: 10,
        failedRequests: 0,
        acceptedResponses: 8,
        soldOutResponses: 2,
        unexpectedResponses: 0,
        failureRate: 0,
      },
      trafficOutcomeSummary: {},
      trafficDeliverySummary: {
        plannedRequests: 10,
        emittedRequests: 10,
        droppedIterations: 0,
        trafficDeliveryStatus: "complete",
        notes: [],
      },
      httpTimingBreakdownSummary: { p95: 42 },
      loadRunDiagnosticsSummary: { source: "fixture" },
      apiRequestLifecycleSummary: { source: "fixture" },
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
    status: "secured" as const,
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
    reservation,
  });
  await db.insert(reservations).values({
    id: ids.activeReservation,
    saleOfferId: ids.activeOffer,
    runId: ids.activeRun,
    correlationId: "corr-active-business",
    quantity: 1,
    status: "secured",
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
  await db.insert(demoRunReservationOutcomes).values({
    runId: ids.activeRun,
    outcome: "api_sold_out_decision",
    count: 4,
    latestObservedAt: new Date("2026-06-20T00:00:04.000Z"),
    source: "redis",
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
    status: "secured",
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
    channel: "email",
    recipientPlaceholder: "buyer@example.invalid",
    status: "recorded",
    recordedAt: now,
    createdAt: now,
  });
  await db.insert(reservationPendingPersistence).values({
    reservationId: "99999999-9999-4999-8999-999999999991",
    saleOfferId: ids.completedOffer,
    correlationId: "corr-cleanup-graph-pending",
    runId: ids.completedRun,
    idempotencyKey: "cleanup-pending-idempotency",
    quantity: 1,
    reservationToken: "cleanup-pending-token",
    status: "pending_reconciliation",
    securedAt: now,
    expiresAt: new Date("2026-06-20T00:15:04.000Z"),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(demoRunReservationOutcomes).values({
    runId: ids.completedRun,
    outcome: "api_sold_out_decision",
    count: 2,
    latestObservedAt: now,
    source: "redis",
    capturedAt: now,
    createdAt: now,
  });
  await db.insert(demoRunFinalizations).values({
    runId: ids.completedRun,
    exitCode: 0,
    httpSummary: {},
    trafficOutcomeSummary: {},
    trafficDeliverySummary: {},
    httpTimingBreakdownSummary: {},
    loadRunDiagnosticsSummary: {},
    apiRequestLifecycleSummary: {},
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
    db.select().from(demoRunReservationOutcomes).where(eq(demoRunReservationOutcomes.runId, runId)),
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
    startedAt: new Date("2026-06-20T00:00:00.000Z"),
    endedAt: new Date("2026-06-20T00:00:06.000Z"),
    httpSummary: {
      plannedRequests: 10,
      emittedRequests: 10,
      completedRequests: 10,
      failedRequests: 0,
      acceptedResponses: input.status === "completed" ? 10 : 8,
      soldOutResponses: input.status === "completed" ? 0 : 2,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    trafficDeliverySummary: {
      plannedRequests: 10,
      emittedRequests: 10,
      droppedIterations: 0,
      trafficDeliveryStatus: input.status === "completed" ? "complete" : "failed",
      notes: [],
    },
    httpTimingBreakdownSummary: { p95: 30 },
    loadRunDiagnosticsSummary: { source: "existing-summary" },
    apiRequestLifecycleSummary: { source: "existing-summary" },
    businessOutcomeSummary: {
      acceptedReservations: input.status === "completed" ? 10 : 8,
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

function createCleanupService(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  redis: ReturnType<typeof createRedisClient>,
  overrides: {
    logger?: CheckoutSurgeLogger;
    deleteGeneratedRunDurable?: typeof deleteGeneratedRunDurable;
    deleteGeneratedRunRedisState?: typeof deleteGeneratedRunRedisState;
  } = {},
): DemoMaintenanceService {
  return new DemoMaintenanceService({
    db,
    redis,
    queueMaintenance: {
      cleanResetOwnedQueues: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
    },
    terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
    logger: overrides.logger ?? createSilentLogger("api"),
    now: () => new Date("2026-06-25T00:00:00.000Z"),
    ...(overrides.deleteGeneratedRunDurable
      ? { deleteGeneratedRunDurable: overrides.deleteGeneratedRunDurable }
      : {}),
    ...(overrides.deleteGeneratedRunRedisState
      ? { deleteGeneratedRunRedisState: overrides.deleteGeneratedRunRedisState }
      : {}),
  });
}

async function restoreQueueLease(options: DemoQueueQuiescenceRelease): Promise<void> {
  if (options.disposition === "restore_owned_pauses") {
    await options.afterRestored?.();
  }
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
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 10,
      maxTps: 10,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 1000,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 2,
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

  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for API maintenance tests.");
  }

  return databaseUrl;
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
