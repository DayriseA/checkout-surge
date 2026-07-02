import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AcceptedRunConfigSnapshot } from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createRedisClient,
  demoPresets,
  demoRunFinalizations,
  demoRunReservationOutcomes,
  demoRunSaleContexts,
  demoRunSummaries,
  demoRuns,
  initializeInventory,
  isRunSaleEligible,
  orders,
  products,
  promoteReservationIdempotencyToAccepted,
  reservations,
  reserveInventoryStock,
  saleOffers,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoMaintenanceService } from "../src/services/demo-maintenance-service.js";

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
  startingOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  activeOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
  drainingOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
  completedOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
  failedOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5",
  activeReservation: "77777777-7777-4777-8777-777777777771",
  activeOrder: "88888888-8888-4888-8888-888888888881",
} as const;

describe("demo maintenance lifecycle reset", () => {
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
    const queueMaintenance = {
      cleanResetOwnedQueues: vi
        .fn()
        .mockResolvedValue({ cleanedQueueCount: 2, cleanedJobCount: 5 }),
    };
    const service = new DemoMaintenanceService({
      db,
      redis: redisClient,
      queueMaintenance,
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
    expect(queueMaintenance.cleanResetOwnedQueues).toHaveBeenCalledOnce();
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
          finalizedAt: new Date("2026-06-20T00:00:10.000Z"),
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
          finalizedAt: new Date("2026-06-20T00:00:10.000Z"),
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
          endedAt: new Date("2026-06-20T00:00:10.000Z"),
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
          endedAt: new Date("2026-06-20T00:00:10.000Z"),
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
        emittedRequests: 10,
        completedRequests: 10,
      },
      trafficDeliverySummary: {
        plannedRequests: 10,
        emittedRequests: 10,
        droppedIterations: 0,
        trafficDeliveryStatus: "complete",
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
    const service = new DemoMaintenanceService({
      db,
      redis: redisClient,
      queueMaintenance: {
        cleanResetOwnedQueues: vi
          .fn()
          .mockResolvedValue({ cleanedQueueCount: 2, cleanedJobCount: 0 }),
      },
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
});

async function seedRuns(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  redis: ReturnType<typeof createRedisClient>,
): Promise<void> {
  await seedBase(db);
  await seedRun(db, redis, {
    runId: ids.startingRun,
    saleOfferId: ids.startingOffer,
    status: "starting",
    trafficStatus: "starting",
    failureReason: null,
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
    status: "draining",
    trafficStatus: "succeeded",
    failureReason: null,
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
  },
): Promise<void> {
  const now = new Date("2026-06-20T00:00:00.000Z");
  await db.insert(saleOffers).values({
    id: input.saleOfferId,
    productId: ids.product,
    name: `${input.status} Offer`,
    allocatedStock: 10,
    saleStartsAt: now,
    saleEndsAt: new Date("2026-06-21T00:00:00.000Z"),
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
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
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
