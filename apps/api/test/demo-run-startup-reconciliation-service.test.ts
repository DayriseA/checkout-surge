import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AcceptedRunConfigSnapshot, OrderProcessJob } from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createRedisClient,
  demoPresets,
  demoRunSaleContexts,
  demoRunSummaries,
  demoRuns,
  initializeInventory,
  isRunSaleEligible,
  orderEvents,
  orders,
  products,
  promoteReservationIdempotencyToAccepted,
  reservations,
  reserveInventoryStock,
  saleOffers,
  setRunSaleEligibility,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoRunStartupReconciliationService } from "../src/services/demo-run-startup-reconciliation-service.js";
import { PendingPersistenceReconciler } from "../src/services/pending-persistence-reconciler.js";
import { PostgresBuyPersistence } from "../src/services/postgres-buy-persistence.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPackageRoot = path.resolve(packageRoot, "../../packages/db");
const migrationsFolder = path.join(dbPackageRoot, "drizzle");

const ids = {
  product: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  preset: "33333333-3333-4333-8333-333333333331",
  startingRun: "55555555-5555-4555-8555-555555555551",
  activeRun: "55555555-5555-4555-8555-555555555552",
  drainingRun: "55555555-5555-4555-8555-555555555553",
  startingOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  activeOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
  drainingOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
} as const;

describe("demo run startup reconciliation service", () => {
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

  it("preserves an orchestrator-owned active run across an API restart", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const reconcileSaleOffer = vi.fn(async () => ({
      found: 0,
      materialized: 0,
      reconciled: 0,
      reversed: 0,
      failed: 0,
    }));
    const service = new DemoRunStartupReconciliationService({
      ...startupInfrastructure(db, redisClient),
      logger: createSilentLogger("api"),
      pendingPersistenceReconciler: { reconcileSaleOffer },
      completionEnrichmentService: {
        completePendingEnrichment: vi.fn(async () => "already_completed" as const),
      },
    });

    await seedRunFixtures(db, redisClient, "active");

    const summary = await service.reconcile();
    const runs = await db
      .select()
      .from(demoRuns)
      .where(inArray(demoRuns.id, [ids.startingRun, ids.activeRun, ids.drainingRun]));
    const summaries = await db
      .select()
      .from(demoRunSummaries)
      .where(inArray(demoRunSummaries.runId, [ids.startingRun, ids.activeRun, ids.drainingRun]));

    expect(summary).toEqual({
      discoveredRunCount: 0,
      succeededRunCount: 0,
      failedRunCount: 0,
      closedSaleOfferCount: 0,
      completionEnrichedRunCount: 0,
      pendingPersistenceEffectCount: 0,
      failures: [],
    });
    expect(reconcileSaleOffer).not.toHaveBeenCalled();
    expect(runs.find((run) => run.id === ids.activeRun)).toMatchObject({
      status: "active",
      trafficStatus: "active",
      failureReason: null,
    });
    expect(summaries).toHaveLength(0);
    await expect(
      isRunSaleEligible(redisClient, {
        runId: ids.activeRun,
        saleOfferId: ids.activeOffer,
      }),
    ).resolves.toBe(true);
  });

  it("is idempotent when startup reconciliation runs more than once", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = new DemoRunStartupReconciliationService({
      ...startupInfrastructure(db, redisClient),
      logger: createSilentLogger("api"),
      pendingPersistenceReconciler: {
        reconcileSaleOffer: vi.fn(async () => ({
          found: 0,
          materialized: 0,
          reconciled: 0,
          reversed: 0,
          failed: 0,
        })),
      },
      completionEnrichmentService: {
        completePendingEnrichment: vi.fn(async () => "already_completed" as const),
      },
    });

    await seedRunFixtures(db, redisClient, "starting");

    await service.reconcile();
    const second = await service.reconcile();
    const summaries = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.startingRun));

    expect(second.discoveredRunCount).toBe(0);
    expect(second.succeededRunCount).toBe(0);
    expect(summaries).toHaveLength(0);
  });

  it("keeps a draining run recoverable and reconciles its pending persistence", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const lifecycleOrder: string[] = [];
    const completePendingEnrichment = vi.fn(async () => {
      lifecycleOrder.push("enrichment");
      return "completed" as const;
    });
    const reconcileSaleOffer = vi.fn(async () => {
      lifecycleOrder.push("pending-persistence");
      return {
        found: 0,
        materialized: 0,
        reconciled: 0,
        reversed: 0,
        failed: 0,
      };
    });
    const service = new DemoRunStartupReconciliationService({
      ...startupInfrastructure(db, redisClient),
      logger: createSilentLogger("api"),
      pendingPersistenceReconciler: { reconcileSaleOffer },
      completionEnrichmentService: { completePendingEnrichment },
    });
    await seedRunFixtures(db, redisClient, "draining");

    await expect(service.reconcile()).resolves.toEqual({
      discoveredRunCount: 1,
      succeededRunCount: 1,
      failedRunCount: 0,
      closedSaleOfferCount: 0,
      completionEnrichedRunCount: 1,
      pendingPersistenceEffectCount: 0,
      failures: [],
    });
    expect(reconcileSaleOffer).toHaveBeenCalledWith(ids.drainingOffer, {
      runId: ids.drainingRun,
    });
    expect(completePendingEnrichment).toHaveBeenCalledWith(ids.drainingRun);
    expect(lifecycleOrder).toEqual(["enrichment", "pending-persistence"]);
  });

  it("isolates per-run stage failures and reports only real effects", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    await seedRunFixtures(db, redisClient, "draining");
    const [seeded] = await db.select().from(demoRuns).where(eq(demoRuns.id, ids.drainingRun));
    if (!seeded) throw new Error("Expected draining fixture.");

    const candidates = [
      { ...seeded, id: "60000000-0000-4000-8000-000000000001", saleOfferId: null },
      { ...seeded, id: "60000000-0000-4000-8000-000000000002" },
      { ...seeded, id: "60000000-0000-4000-8000-000000000003" },
      { ...seeded, id: "60000000-0000-4000-8000-000000000004" },
      { ...seeded, id: "60000000-0000-4000-8000-000000000005" },
    ];
    const closeRunSaleEligibility = vi.fn(async ({ runId }: { runId: string }) => {
      if (runId.endsWith("2")) throw new Error("Redis unavailable");
      return true;
    });
    const completePendingEnrichment = vi.fn(async (runId: string) => {
      if (runId.endsWith("3")) throw new Error("projection read failed");
      return "completed" as const;
    });
    const reconcileSaleOffer = vi.fn(async (_saleOfferId: string, input: { runId?: string }) => ({
      found: 1,
      materialized: input.runId?.endsWith("5") ? 1 : 0,
      reconciled: input.runId?.endsWith("4") ? 0 : 1,
      reversed: 0,
      failed: input.runId?.endsWith("4") ? 1 : 0,
    }));
    const service = new DemoRunStartupReconciliationService({
      ...startupInfrastructure(db, redisClient),
      logger: createSilentLogger("api"),
      listDrainingRuns: async () => candidates,
      closeRunSaleEligibility,
      completionEnrichmentService: { completePendingEnrichment },
      pendingPersistenceReconciler: { reconcileSaleOffer },
    });

    await expect(service.reconcile()).resolves.toEqual({
      discoveredRunCount: 5,
      succeededRunCount: 1,
      failedRunCount: 4,
      closedSaleOfferCount: 3,
      completionEnrichedRunCount: 3,
      pendingPersistenceEffectCount: 3,
      failures: [
        {
          runId: candidates[0]?.id,
          saleOfferId: null,
          stages: ["missing_sale_offer"],
        },
        {
          runId: candidates[1]?.id,
          saleOfferId: ids.drainingOffer,
          stages: ["eligibility_close"],
        },
        {
          runId: candidates[2]?.id,
          saleOfferId: ids.drainingOffer,
          stages: ["completion_enrichment"],
        },
        {
          runId: candidates[3]?.id,
          saleOfferId: ids.drainingOffer,
          stages: ["pending_reconciliation"],
        },
      ],
    });
    expect(closeRunSaleEligibility).toHaveBeenCalledTimes(4);
    expect(completePendingEnrichment).toHaveBeenCalledTimes(4);
    expect(reconcileSaleOffer).toHaveBeenCalledTimes(4);
  });

  it("converges a real draining-run pending hold before returning and remains idempotent", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    await seedRunFixtures(db, redisClient, "draining");
    await setRunSaleEligibility(redisClient, {
      runId: ids.drainingRun,
      saleOfferId: ids.drainingOffer,
      status: "accepting",
    });
    const decision = await reserveInventoryStock(redisClient, {
      idempotencyKey: "startup-recovery-real-hold",
      idempotencyTtlSeconds: 1800,
      reservation: {
        id: "70000000-0000-4000-8000-000000000001",
        saleOfferId: ids.drainingOffer,
        runId: ids.drainingRun,
        correlationId: "startup-recovery-real-hold",
        quantity: 1,
        reservationToken: "startup-recovery-token",
        securedAt: "2026-06-20T00:00:05.000Z",
        expiresAt: "2026-06-20T00:15:05.000Z",
      },
    });
    expect(decision.outcome).toBe("reservation_secured");

    const jobs: OrderProcessJob[] = [];
    const pendingPersistenceReconciler = new PendingPersistenceReconciler({
      redis: redisClient,
      persistence: new PostgresBuyPersistence(db),
      stockReservations: {
        promoteAccepted: (input) =>
          promoteReservationIdempotencyToAccepted(redisClient, input).then(() => undefined),
      },
      orderProcessJobPublisher: {
        enqueue: async (job) => {
          jobs.push(job);
        },
      },
      idempotencyTtlSeconds: 1800,
      logger: createSilentLogger("api"),
    });
    const service = new DemoRunStartupReconciliationService({
      ...startupInfrastructure(db, redisClient),
      logger: createSilentLogger("api"),
      pendingPersistenceReconciler,
      completionEnrichmentService: {
        completePendingEnrichment: async () => "already_completed",
      },
    });

    const first = await service.reconcile();
    const second = await service.reconcile();
    const [run] = await db.select().from(demoRuns).where(eq(demoRuns.id, ids.drainingRun));
    const durableReservations = await db
      .select()
      .from(reservations)
      .where(eq(reservations.runId, ids.drainingRun));
    const durableOrders = await db.select().from(orders).where(eq(orders.runId, ids.drainingRun));
    const durableEvents = await db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.reservationId, decision.reservation?.id ?? ""));
    const summaries = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.drainingRun));

    expect(first).toMatchObject({
      discoveredRunCount: 1,
      succeededRunCount: 1,
      failedRunCount: 0,
      closedSaleOfferCount: 1,
      pendingPersistenceEffectCount: 1,
    });
    expect(second).toMatchObject({
      discoveredRunCount: 1,
      succeededRunCount: 1,
      failedRunCount: 0,
      closedSaleOfferCount: 0,
      pendingPersistenceEffectCount: 0,
    });
    expect(run?.status).toBe("draining");
    expect(durableReservations).toHaveLength(1);
    expect(durableOrders).toHaveLength(1);
    expect(durableEvents.map((event) => event.eventName).sort()).toEqual([
      "order.queued",
      "reservation.secured",
    ]);
    expect(summaries).toHaveLength(0);
    expect(jobs).toHaveLength(1);
  });
});

function startupInfrastructure(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  redis: ReturnType<typeof createRedisClient>,
) {
  return {
    listDrainingRuns: () => db.select().from(demoRuns).where(eq(demoRuns.status, "draining")),
    closeRunSaleEligibility: ({ runId, saleOfferId }: { runId: string; saleOfferId: string }) =>
      setRunSaleEligibility(redis, { runId, saleOfferId, status: "closed" }),
  };
}

async function seedRunFixtures(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  redis: ReturnType<typeof createRedisClient>,
  status: "starting" | "active" | "draining",
): Promise<void> {
  await db.insert(products).values({
    id: ids.product,
    sku: "RECONCILE-001",
    slug: "reconcile-product",
    name: "Reconcile Product",
    isActive: true,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await db.insert(demoPresets).values({
    id: ids.preset,
    slug: "reconcile-preset",
    visibility: "public",
    isEditable: false,
    isCustom: false,
    display: {
      name: "Reconcile Preset",
      description: "Startup reconciliation fixture.",
      sortOrder: 1,
      outcomeFocus: ["run_history"],
    },
    ...configSnapshotFixture(),
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });

  const fixtureByStatus = {
    starting: {
      runId: ids.startingRun,
      saleOfferId: ids.startingOffer,
      trafficStatus: "starting" as const,
      runInventoryStatus: "accepting" as const,
    },
    active: {
      runId: ids.activeRun,
      saleOfferId: ids.activeOffer,
      trafficStatus: "active" as const,
      runInventoryStatus: "accepting" as const,
    },
    draining: {
      runId: ids.drainingRun,
      saleOfferId: ids.drainingOffer,
      trafficStatus: "succeeded" as const,
      runInventoryStatus: "closed" as const,
    },
  };
  await seedRun(db, redis, {
    ...fixtureByStatus[status],
    status,
    configSnapshot: configSnapshotFixture({ duplicateEachBuyerAttempt: status === "starting" }),
  });
}

async function seedRun(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  redis: ReturnType<typeof createRedisClient>,
  input: {
    runId: string;
    saleOfferId: string;
    status: "starting" | "active" | "draining";
    trafficStatus: "starting" | "active" | "succeeded";
    configSnapshot: AcceptedRunConfigSnapshot;
    runInventoryStatus: "accepting" | "closed";
  },
): Promise<void> {
  await db.insert(saleOffers).values({
    id: input.saleOfferId,
    productId: ids.product,
    name: `${input.status} Offer`,
    allocatedStock: input.configSnapshot.inventoryConfig.startingStock,
    saleStartsAt: new Date("2026-06-20T00:00:00.000Z"),
    saleEndsAt: new Date("2026-06-21T00:00:00.000Z"),
    isActive: true,
    purpose: "generated_run",
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await db.insert(demoRuns).values({
    id: input.runId,
    presetId: ids.preset,
    presetName: "Reconcile Preset",
    operatorMode: "public",
    status: input.status,
    trafficStatus: input.trafficStatus,
    configSnapshot: input.configSnapshot,
    saleOfferId: input.saleOfferId,
    startedAt: new Date("2026-06-20T00:00:00.000Z"),
    trafficStartedAt:
      input.status === "active" || input.status === "draining"
        ? new Date("2026-06-20T00:00:01.000Z")
        : null,
    trafficEndedAt: input.status === "draining" ? new Date("2026-06-20T00:00:05.000Z") : null,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:05.000Z"),
  });
  await db.insert(demoRunSaleContexts).values({
    runId: input.runId,
    saleOfferId: input.saleOfferId,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await initializeInventory(redis, {
    saleOfferId: input.saleOfferId,
    allocatedStock: input.configSnapshot.inventoryConfig.startingStock,
    initializedAt: new Date("2026-06-20T00:00:00.000Z"),
    run: { runId: input.runId, status: input.runInventoryStatus },
  });
}

function configSnapshotFixture(
  options: { duplicateEachBuyerAttempt?: boolean } = {},
): AcceptedRunConfigSnapshot {
  return {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 10,
      duplicateEachBuyerAttempt: options.duplicateEachBuyerAttempt ?? false,
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
    throw new Error("TEST_DATABASE_URL is required for API startup reconciliation tests.");
  }

  return databaseUrl;
}

function requireTestRedisUrl(): string {
  const redisUrl = process.env.TEST_REDIS_URL;

  if (!redisUrl) {
    throw new Error("TEST_REDIS_URL is required for API startup reconciliation tests.");
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
