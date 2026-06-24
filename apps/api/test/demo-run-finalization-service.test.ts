import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AcceptedRunConfigSnapshot,
  BusinessOutcomeSummary,
  TrafficCompletionReport,
} from "@checkout-surge/contracts";
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
  orders,
  products,
  reservationPendingPersistence,
  reservations,
  saleOffers,
  simulatedNotifications,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DemoRunFinalizationService } from "../src/services/demo-run-finalization-service.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPackageRoot = path.resolve(packageRoot, "../../packages/db");
const migrationsFolder = path.join(dbPackageRoot, "drizzle");

const ids = {
  product: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  preset: "33333333-3333-4333-8333-333333333331",
  run: "55555555-5555-4555-8555-555555555555",
  saleOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  reservation1: "11111111-1111-4111-8111-111111111111",
  reservation2: "22222222-2222-4222-8222-222222222222",
  order1: "44444444-4444-4444-8444-444444444441",
  order2: "44444444-4444-4444-8444-444444444442",
  notification: "99999999-9999-4999-8999-999999999999",
} as const;

describe("demo run finalization service", () => {
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

  it("keeps a traffic-complete run draining while business work is unsettled", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);

    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await db.insert(reservations).values(reservationFixture(ids.reservation1));
    await db.insert(orders).values(orderFixture(ids.order1, ids.reservation1, "queued"));

    const finalized = await service.finalizeRun(ids.run, "corr-finalize-test");
    const [summaryCount] = await db
      .select({ value: count() })
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));

    expect(finalized?.status).toBe("draining");
    expect(summaryCount?.value).toBe(0);
  });

  it("writes one immutable completed summary after business work settles", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);

    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await db.insert(demoRunReservationOutcomes).values({
      runId: ids.run,
      outcome: "api_sold_out_decision",
      count: 7,
      latestObservedAt: new Date("2026-06-20T00:00:09.000Z"),
      source: "redis",
      capturedAt: new Date("2026-06-20T00:00:10.000Z"),
      createdAt: new Date("2026-06-20T00:00:10.000Z"),
    });
    await db
      .insert(reservations)
      .values([reservationFixture(ids.reservation1), reservationFixture(ids.reservation2)]);
    await db
      .insert(orders)
      .values([
        orderFixture(ids.order1, ids.reservation1, "confirmed"),
        orderFixture(ids.order2, ids.reservation2, "failed"),
      ]);
    await db.insert(simulatedNotifications).values({
      id: ids.notification,
      orderId: ids.order1,
      saleOfferId: ids.saleOffer,
      runId: ids.run,
      correlationId: "corr-finalize-test",
      channel: "email",
      recipientPlaceholder: "buyer@example.invalid",
      status: "recorded",
      recordedAt: new Date("2026-06-20T00:00:08.000Z"),
      createdAt: new Date("2026-06-20T00:00:08.000Z"),
    });

    const first = await service.finalizeRun(ids.run, "corr-finalize-test");
    const second = await service.finalizeRun(ids.run, "corr-finalize-test");
    const summaries = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));

    expect(first?.status).toBe("completed");
    expect(second?.status).toBe("completed");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.status).toBe("completed");
    expect(summaries[0]?.failureReason).toBeNull();
    expect(summaries[0]?.businessOutcomeSummary as BusinessOutcomeSummary).toMatchObject({
      acceptedReservations: 2,
      soldOutRejections: 7,
      confirmedOrders: 1,
      failedOrders: 1,
      notificationsRecorded: 1,
      pendingPersistenceCount: 0,
    });
    expect(summaries[0]?.terminalInventorySnapshot).toMatchObject({
      saleOfferId: ids.saleOffer,
      soldOutRejections: 7,
      acceptedReservations: 2,
      source: "redis",
    });
  });

  it("finalizes as failed for major traffic-delivery shortfall after business drain", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);

    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "failed" });

    const finalized = await service.finalizeRun(ids.run, "corr-finalize-test");
    const [summary] = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run))
      .limit(1);

    expect(finalized?.status).toBe("failed");
    expect(finalized?.failureReason).toBe("traffic_delivery_major_shortfall");
    expect(summary?.status).toBe("failed");
    expect(summary?.failureReason).toBe("traffic_delivery_major_shortfall");
  });

  it("finalizes as failed when business work exceeds the drain timeout", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);

    await seedDrainingRun({
      db,
      redis: redisClient,
      trafficDeliveryStatus: "complete",
      configSnapshot: configSnapshotFixture({ drainTimeoutSeconds: 1 }),
      trafficEndedAt: new Date("2026-06-20T00:00:00.000Z"),
    });
    await db.insert(reservationPendingPersistence).values({
      reservationId: ids.reservation1,
      saleOfferId: ids.saleOffer,
      runId: ids.run,
      correlationId: "corr-finalize-test",
      idempotencyKey: "pending-key",
      quantity: 1,
      reservationToken: "pending-token",
      status: "pending_reconciliation",
      securedAt: new Date("2026-06-20T00:00:00.000Z"),
      expiresAt: new Date("2026-06-20T00:15:00.000Z"),
      createdAt: new Date("2026-06-20T00:00:00.000Z"),
      updatedAt: new Date("2026-06-20T00:00:00.000Z"),
    });

    const finalized = await service.finalizeRun(ids.run, "corr-finalize-test");

    expect(finalized?.status).toBe("failed");
    expect(finalized?.failureReason).toBe("business_drain_timeout");
  });
});

function createService(
  connection: ReturnType<typeof createDatabaseConnection> | null,
  redis: ReturnType<typeof createRedisClient> | null,
): DemoRunFinalizationService {
  return new DemoRunFinalizationService({
    db: requireConnection(connection).db,
    redis: requireRedis(redis),
    logger: createSilentLogger("api"),
    now: () => new Date("2026-06-20T00:00:10.000Z"),
    generateId: () => "77777777-7777-4777-8777-777777777777",
  });
}

async function seedDrainingRun(input: {
  db: ReturnType<typeof createDatabaseConnection>["db"];
  redis: ReturnType<typeof createRedisClient>;
  trafficDeliveryStatus: "complete" | "failed";
  configSnapshot?: AcceptedRunConfigSnapshot;
  trafficEndedAt?: Date;
}): Promise<void> {
  const configSnapshot = input.configSnapshot ?? configSnapshotFixture();
  const trafficEndedAt = input.trafficEndedAt ?? new Date("2026-06-20T00:00:05.000Z");
  await input.db.insert(products).values({
    id: ids.product,
    sku: "FINALIZE-001",
    slug: "finalize-product",
    name: "Finalize Product",
    isActive: true,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await input.db.insert(demoPresets).values({
    id: ids.preset,
    slug: "finalize-preset",
    visibility: "public",
    isEditable: false,
    isCustom: false,
    display: {
      name: "Finalize Preset",
      description: "Finalization fixture.",
      sortOrder: 1,
      outcomeFocus: ["run_history"],
    },
    ...configSnapshot,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await input.db.insert(saleOffers).values({
    id: ids.saleOffer,
    productId: ids.product,
    name: "Finalize Offer",
    allocatedStock: configSnapshot.inventoryConfig.startingStock,
    saleStartsAt: new Date("2026-06-20T00:00:00.000Z"),
    saleEndsAt: new Date("2026-06-21T00:00:00.000Z"),
    isActive: true,
    purpose: "generated_run",
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await input.db.insert(demoRuns).values({
    id: ids.run,
    presetId: ids.preset,
    presetName: "Finalize Preset",
    operatorMode: "public",
    status: "draining",
    trafficStatus: "succeeded",
    configSnapshot,
    saleOfferId: ids.saleOffer,
    startedAt: new Date("2026-06-20T00:00:00.000Z"),
    trafficStartedAt: new Date("2026-06-20T00:00:01.000Z"),
    trafficEndedAt,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: trafficEndedAt,
  });
  await input.db.insert(demoRunSaleContexts).values({
    runId: ids.run,
    saleOfferId: ids.saleOffer,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await input.db.insert(demoRunFinalizations).values({
    runId: ids.run,
    exitCode: 0,
    httpSummary: trafficCompletionReportFixture(input.trafficDeliveryStatus).httpSummary,
    trafficOutcomeSummary: {},
    trafficDeliverySummary: trafficCompletionReportFixture(input.trafficDeliveryStatus)
      .trafficDeliverySummary,
    httpTimingBreakdownSummary: {},
    loadRunDiagnosticsSummary: {},
    apiRequestLifecycleSummary: {},
    trafficSummaryReceivedAt: trafficEndedAt,
    createdAt: trafficEndedAt,
    updatedAt: trafficEndedAt,
  });
  await initializeInventory(input.redis, {
    saleOfferId: ids.saleOffer,
    allocatedStock: configSnapshot.inventoryConfig.startingStock,
    initializedAt: new Date("2026-06-20T00:00:00.000Z"),
    run: { runId: ids.run, status: "closed" },
  });
}

function reservationFixture(id: string): typeof reservations.$inferInsert {
  return {
    id,
    saleOfferId: ids.saleOffer,
    runId: ids.run,
    correlationId: "corr-finalize-test",
    quantity: 1,
    status: "secured",
    reservationToken: `token-${id}`,
    securedAt: new Date("2026-06-20T00:00:02.000Z"),
    expiresAt: new Date("2026-06-20T00:15:02.000Z"),
    createdAt: new Date("2026-06-20T00:00:02.000Z"),
    updatedAt: new Date("2026-06-20T00:00:02.000Z"),
  };
}

function orderFixture(
  id: string,
  reservationId: string,
  status: "queued" | "confirmed" | "failed",
): typeof orders.$inferInsert {
  return {
    id,
    publicOrderId: `ord-${id}`,
    saleOfferId: ids.saleOffer,
    reservationId,
    runId: ids.run,
    correlationId: "corr-finalize-test",
    quantity: 1,
    status,
    queuedAt: new Date("2026-06-20T00:00:03.000Z"),
    ...(status === "confirmed"
      ? {
          processingAt: new Date("2026-06-20T00:00:04.000Z"),
          confirmedAt: new Date("2026-06-20T00:00:05.000Z"),
        }
      : {}),
    ...(status === "failed"
      ? {
          processingAt: new Date("2026-06-20T00:00:04.000Z"),
          failedAt: new Date("2026-06-20T00:00:05.000Z"),
          failureCode: "erp_failed",
          failureMessage: "ERP failed.",
        }
      : {}),
    createdAt: new Date("2026-06-20T00:00:03.000Z"),
    updatedAt: new Date("2026-06-20T00:00:05.000Z"),
  };
}

function configSnapshotFixture(
  options: { drainTimeoutSeconds?: number } = {},
): AcceptedRunConfigSnapshot {
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
      drainTimeoutSeconds: options.drainTimeoutSeconds ?? 300,
      pendingPersistenceRetryAfterSeconds: 30,
    },
  };
}

function trafficCompletionReportFixture(
  trafficDeliveryStatus: "complete" | "failed",
): TrafficCompletionReport {
  return {
    runId: ids.run,
    status: "succeeded",
    exitCode: 0,
    httpSummary: {
      plannedRequests: 10,
      emittedRequests: trafficDeliveryStatus === "failed" ? 5 : 10,
      completedRequests: trafficDeliveryStatus === "failed" ? 5 : 10,
      failedRequests: 0,
      acceptedResponses: 2,
      soldOutResponses: trafficDeliveryStatus === "failed" ? 3 : 8,
      unexpectedResponses: 0,
      p95LatencyMs: 25,
      failureRate: 0,
    },
    trafficOutcomeSummary: {},
    trafficDeliverySummary: {
      plannedRequests: 10,
      emittedRequests: trafficDeliveryStatus === "failed" ? 5 : 10,
      droppedIterations: trafficDeliveryStatus === "failed" ? 5 : 0,
      trafficDeliveryStatus,
      notes: trafficDeliveryStatus === "failed" ? ["Major request delivery shortfall."] : [],
    },
    httpTimingBreakdownSummary: {},
    loadRunDiagnosticsSummary: {},
    apiRequestLifecycleSummary: {},
    completedAt: "2026-06-20T00:00:05.000Z",
    correlationId: "corr-finalize-test",
  };
}

function requireTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for API finalization tests.");
  }

  return databaseUrl;
}

function requireTestRedisUrl(): string {
  const redisUrl = process.env.TEST_REDIS_URL;

  if (!redisUrl) {
    throw new Error("TEST_REDIS_URL is required for API finalization tests.");
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
