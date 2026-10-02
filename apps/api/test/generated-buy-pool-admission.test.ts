import { randomUUID } from "node:crypto";
import {
  type OrderProcessJob,
  orderProcessBullMqQueueName,
  type orderProcessJobName,
} from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createRedisClient,
  demoPresets,
  demoRunSaleContexts,
  demoRuns,
  getInventoryStatus,
  initializeInventory,
  orderEvents,
  orders,
  products,
  promoteReservationIdempotencyToAccepted,
  reservationPendingPersistence,
  reservations,
  reserveInventoryStock,
  saleOffers,
} from "@checkout-surge/db";
import { requireTestDatabaseUrl, resetTestDatabase } from "@checkout-surge/db/testing";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBullMqOrderProcessJobPublisher } from "../src/queue/bullmq-order-process-job-publisher.js";
import type { OrderProcessJobPublisher } from "../src/services/order-process-job-publisher.js";
import { PostgresBuyPersistence } from "../src/services/postgres-buy-persistence.js";
import { ReserveOrderService } from "../src/services/reserve-order-service.js";

const poolSize = 4;
const readinessServiceLevelMs = 2_000;
const readinessDeadlineMs = readinessServiceLevelMs - 100;
const ids = {
  product: "10000000-0000-4000-8000-000000000001",
  preset: "10000000-0000-4000-8000-000000000002",
  run: "10000000-0000-4000-8000-000000000003",
  saleOffer: "10000000-0000-4000-8000-000000000004",
} as const;
const configSnapshot = {
  trafficConfig: {
    mode: "buyer-spike" as const,
    buyerCount: poolSize,
    duplicateEachBuyerAttempt: false,
    startDelaySeconds: 0,
    maxDurationSeconds: 2,
    quantityPerAttempt: 1,
  },
  inventoryConfig: {
    startingStock: poolSize,
  },
  erpConfig: {
    latencyMs: 0,
    maxTps: 100,
    errorRate: 0,
    forcedOutage: false,
  },
  backpressureConfig: {
    queueName: "orders:process" as const,
    physicalQueueName: "orders-process" as const,
    orderProcessConcurrency: poolSize,
  },
};

function redisUrl(): string {
  if (!process.env.TEST_REDIS_URL) throw new Error("TEST_REDIS_URL is required.");
  return process.env.TEST_REDIS_URL;
}

describe("generated buy bounded-pool admission", () => {
  let redis: ReturnType<typeof createRedisClient> | undefined;

  beforeAll(async () => {
    await resetTestDatabase();
    redis = createRedisClient(redisUrl(), { maxRetriesPerRequest: 3 });
    await redis.flushdb();
    const setup = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    try {
      await setup.db.insert(products).values({
        id: ids.product,
        sku: "POOL-ADMISSION-SKU",
        slug: "pool-admission-product",
        name: "Pool Admission Product",
        isActive: true,
      });
      await setup.db.insert(saleOffers).values({
        id: ids.saleOffer,
        productId: ids.product,
        name: "Pool Admission Offer",
        allocatedStock: poolSize,
        saleStartsAt: new Date("2026-01-01T00:00:00.000Z"),
        saleEndsAt: new Date("2035-01-01T00:00:00.000Z"),
        isActive: true,
      });
      await setup.db.insert(demoPresets).values({
        id: ids.preset,
        slug: "pool-admission",
        visibility: "admin",
        isEditable: true,
        display: {
          name: "Pool Admission",
          description: "Bounded-pool regression fixture.",
          sortOrder: 1,
          outcomeFocus: ["happy_path"],
        },
        ...configSnapshot,
      });
      await setup.db.insert(demoRuns).values({
        correlationId: "corr-test-run",
        id: ids.run,
        presetId: ids.preset,
        presetName: "Pool Admission",
        operatorMode: "admin",
        status: "active",
        trafficStatus: "active",
        configSnapshot,
        saleOfferId: ids.saleOffer,
        startedAt: new Date("2026-07-18T00:00:00.000Z"),
      });
      await setup.db.insert(demoRunSaleContexts).values({
        runId: ids.run,
        saleOfferId: ids.saleOffer,
      });
    } finally {
      await setup.close();
    }
    await initializeInventory(redis, {
      saleOfferId: ids.saleOffer,
      allocatedStock: poolSize,
      run: { runId: ids.run, status: "accepting" },
    });
  });

  afterAll(async () => {
    if (redis) {
      await redis.flushdb();
      redis.disconnect();
    }
  });

  it("terminates N simultaneous accepted buys using one pool of size N", async () => {
    if (!redis) throw new Error("Test Redis was not initialized.");
    const activeRedis = redis;
    const connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: poolSize });
    const queue = new Queue<OrderProcessJob, void, typeof orderProcessJobName>(
      orderProcessBullMqQueueName,
      { connection: { url: redisUrl(), maxRetriesPerRequest: 3 } },
    );
    const publisher = createBullMqOrderProcessJobPublisher({
      url: redisUrl(),
      maxRetriesPerRequest: 3,
    });
    await queue.obliterate({ force: true });

    let admissionEnqueueCount = 0;
    let releaseAdmissionEnqueues: (() => void) | undefined;
    let rejectAdmissionEnqueues: ((error: Error) => void) | undefined;
    let readinessPromise: Promise<number> | undefined;
    let readinessDeadline: ReturnType<typeof setTimeout> | undefined;
    let buyCompletion: Promise<unknown> | undefined;
    const allAdmissionEnqueues = new Promise<void>((resolve, reject) => {
      releaseAdmissionEnqueues = resolve;
      rejectAdmissionEnqueues = reject;
    });
    void allAdmissionEnqueues.catch(() => undefined);
    const barrierTimeout = setTimeout(
      () => rejectAdmissionEnqueues?.(new Error("Timed out waiting for shared admissions.")),
      3_000,
    );
    let burstDeadline: ReturnType<typeof setTimeout> | undefined;
    const admissionAwarePublisher: OrderProcessJobPublisher = {
      enqueue: async (job) => {
        admissionEnqueueCount += 1;
        if (admissionEnqueueCount === poolSize) {
          const readinessStartedAt = Date.now();
          const readinessQuery = connection.sql`select 1`.then(
            () => {
              clearTimeout(readinessDeadline);
              return Date.now() - readinessStartedAt;
            },
            (error: unknown) => {
              clearTimeout(readinessDeadline);
              throw error;
            },
          );
          readinessPromise = Promise.race([
            readinessQuery,
            new Promise<never>((_, reject) => {
              readinessDeadline = setTimeout(
                () => reject(new Error("Readiness probe exceeded its two-second deadline.")),
                readinessDeadlineMs,
              );
            }),
          ]);
          void readinessPromise.catch(() => undefined);
          releaseAdmissionEnqueues?.();
        }
        await allAdmissionEnqueues;
        await publisher.enqueue(job);
      },
    };
    const service = new ReserveOrderService({
      persistence: new PostgresBuyPersistence(connection.db),
      orderProcessJobPublisher: admissionAwarePublisher,
      stockReservations: {
        reserve: (input) => reserveInventoryStock(activeRedis, input),
        markPendingPersistence: async () => undefined,
        promoteAccepted: (input) =>
          promoteReservationIdempotencyToAccepted(activeRedis, input).then(() => undefined),
      },
      reservationHoldMinutes: 15,
      idempotencyTtlSeconds: 1_800,
      pendingPersistenceRetryAfterSeconds: 5,
      pendingPersistenceRecovery: { recoverReservation: async () => null },
      generateId: randomUUID,
    });

    try {
      const buys = Promise.all(
        Array.from({ length: poolSize }, (_, index) =>
          service.reserve({
            request: {
              saleOfferId: ids.saleOffer,
              runId: ids.run,
              idempotencyKey: `pool-admission-${index}`,
              quantity: 1,
            },
            correlationId: `pool-admission-${index}`,
          }),
        ),
      );
      buyCompletion = buys;
      void buyCompletion.catch(() => undefined);
      const responses = await Promise.race([
        buys,
        new Promise<never>(
          (_, reject) =>
            (burstDeadline = setTimeout(
              () => reject(new Error("Generated buy burst exceeded its bounded deadline.")),
              8_000,
            )),
        ),
      ]);
      clearTimeout(burstDeadline);
      clearTimeout(barrierTimeout);

      expect(responses).toHaveLength(poolSize);
      expect(responses.every((response) => response.outcome === "reservation_secured")).toBe(true);
      expect(admissionEnqueueCount).toBe(poolSize);
      const readinessDurationMs = await readinessPromise;
      clearTimeout(readinessDeadline);
      expect(readinessDurationMs).toBeLessThan(readinessServiceLevelMs);
      expect(await connection.db.select().from(reservations)).toHaveLength(poolSize);
      expect(await connection.db.select().from(orders)).toHaveLength(poolSize);
      expect(await connection.db.select().from(orderEvents)).toHaveLength(poolSize * 2);
      expect(await connection.db.select().from(reservationPendingPersistence)).toEqual([]);
      expect(await getInventoryStatus(activeRedis, ids.saleOffer)).toMatchObject({
        remainingStock: 0,
        reservedStock: poolSize,
        pendingPersistenceCount: 0,
      });

      const jobs = await queue.getJobs(["waiting", "delayed", "paused"]);
      expect(jobs).toHaveLength(poolSize);
      for (const job of jobs) {
        expect(job.opts).toMatchObject({ attempts: 1 });
      }
      const advisoryLocks = await connection.sql`
        select count(*)::integer as count
        from pg_locks
        where locktype = 'advisory'
          and database = (select oid from pg_database where datname = current_database())
      `;
      expect(advisoryLocks[0]?.count).toBe(0);
    } finally {
      clearTimeout(barrierTimeout);
      clearTimeout(burstDeadline);
      clearTimeout(readinessDeadline);
      releaseAdmissionEnqueues?.();
      await Promise.all([
        Promise.allSettled(
          [buyCompletion, readinessPromise].filter(
            (promise): promise is Promise<unknown> => promise !== undefined,
          ),
        ),
        Promise.allSettled([publisher.close(), queue.close(), connection.close()]),
      ]);
    }
  });
});
