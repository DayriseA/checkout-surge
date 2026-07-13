import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AcceptedRunConfigSnapshot } from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createRedisClient,
  demoPresets,
  demoRunSaleContexts,
  demoRunSummaries,
  demoRuns,
  initializeInventory,
  isRunSaleEligible,
  products,
  saleOffers,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoRunStartupReconciliationService } from "../src/services/demo-run-startup-reconciliation-service.js";
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
    const postgresTerminalRunWriter = new PostgresTerminalDemoRunSummaryWriter(db);
    const writeTerminalRun = vi.fn(postgresTerminalRunWriter.write.bind(postgresTerminalRunWriter));
    const service = new DemoRunStartupReconciliationService({
      db,
      terminalRunWriter: { write: writeTerminalRun },
      redis: redisClient,
      logger: createSilentLogger("api"),
      pendingPersistenceReconciler: { reconcileSaleOffer },
      now: () => new Date("2026-06-20T00:00:10.000Z"),
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
      interruptedRunCount: 0,
      closedSaleOfferCount: 0,
      summaryCreatedCount: 0,
      recoverableDrainingRunCount: 0,
    });
    expect(writeTerminalRun).not.toHaveBeenCalled();
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
      db,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      redis: redisClient,
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });

    await seedRunFixtures(db, redisClient, "starting");

    await service.reconcile();
    const second = await service.reconcile();
    const summaries = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.failureReason, "api_restart_interrupted_run"));

    expect(second.interruptedRunCount).toBe(0);
    expect(second.summaryCreatedCount).toBe(0);
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
    const writeTerminalRun = vi.fn(async () => true);
    const service = new DemoRunStartupReconciliationService({
      db,
      terminalRunWriter: { write: writeTerminalRun },
      redis: redisClient,
      logger: createSilentLogger("api"),
      pendingPersistenceReconciler: { reconcileSaleOffer },
      completionEnrichmentService: { completePendingEnrichment },
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });
    await seedRunFixtures(db, redisClient, "draining");

    await expect(service.reconcile()).resolves.toEqual({
      interruptedRunCount: 0,
      closedSaleOfferCount: 1,
      summaryCreatedCount: 0,
      recoverableDrainingRunCount: 1,
    });
    expect(writeTerminalRun).not.toHaveBeenCalled();
    expect(reconcileSaleOffer).toHaveBeenCalledWith(ids.drainingOffer, {
      runId: ids.drainingRun,
    });
    expect(completePendingEnrichment).toHaveBeenCalledWith(ids.drainingRun);
    expect(lifecycleOrder).toEqual(["enrichment", "pending-persistence"]);
  });
});

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
