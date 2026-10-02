import path from "node:path";
import { fileURLToPath } from "node:url";
import { type OrderProcessJob, orderProcessBullMqQueueName } from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  demoRuns,
  orderEvents,
  orders,
  products,
  reservations,
  saleOffers,
} from "@checkout-surge/db";
import { createPurchaseRunFixture, resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderDispatchScanner } from "../../src/application/order-dispatch-scanner.js";
import { createOrderProcessJobHandler } from "../../src/application/order-process-job-handler.js";
import { PostgresGeneratedRunPublicationFence } from "../../src/persistence/postgres-generated-run-publication-fence.js";
import { PostgresOrderDispatchPersistence } from "../../src/persistence/postgres-order-dispatch-persistence.js";
import { PostgresOrderTransitionPersistence } from "../../src/persistence/postgres-order-transition-persistence.js";
import { createBullMqOrderProcessJobPublisher } from "../../src/queue/bullmq-order-process-job-publisher.js";
import { createBullMqOrderProcessConsumer } from "./order-process-consumer-test-helper.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = path.resolve(packageRoot, "../../packages/db/drizzle");
const databaseUrl = requireTestEnv("TEST_DATABASE_URL");
const redisUrl = requireTestEnv("TEST_REDIS_URL");
const ids = {
  product: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
  saleOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01",
  reservation: "cccccccc-cccc-4ccc-8ccc-cccccccccc01",
  order: "dddddddd-dddd-4ddd-8ddd-dddddddddd01",
};
const queuedAt = new Date("2026-06-21T00:00:00.000Z");
const job: OrderProcessJob = {
  runId: "44444444-4444-4444-8444-444444444444",
  orderId: ids.order,
  publicOrderId: "ord_dispatch_recovery",
  reservationId: ids.reservation,
  saleOfferId: ids.saleOffer,
  correlationId: "corr-dispatch-recovery",
  quantity: 1,
  queuedAt: queuedAt.toISOString(),
  processingGeneration: 0,
};

describe("queued order dispatch recovery", () => {
  let connection!: ReturnType<typeof createDatabaseConnection>;

  beforeAll(async () => {
    await resetTestDatabase({ databaseUrl, migrationsFolder });
    connection = createDatabaseConnection(databaseUrl, { max: 8 });
  });

  beforeEach(async () => {
    await resetTestDatabase({ databaseUrl, migrationsFolder });
    await seedQueuedOrder();
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("recovers an order when the API never successfully enqueued its initial job", async () => {
    const queue = new Queue(orderProcessBullMqQueueName, { connection: { url: redisUrl } });
    await queue.obliterate({ force: true });
    const publisher = createBullMqOrderProcessJobPublisher(
      {
        url: redisUrl,
        maxRetriesPerRequest: null,
      },
      new PostgresGeneratedRunPublicationFence(connection.db),
    );
    const scanner = createOrderDispatchScanner({
      persistence: new PostgresOrderDispatchPersistence(connection.db),
      publisher,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 10_000,
      batchSize: 10,
      minimumQueuedAgeMs: 0,
      now: () => new Date("2026-06-21T00:00:10.000Z"),
    });
    const consumer = createBullMqOrderProcessConsumer({
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      concurrency: 1,
      handler: createOrderProcessJobHandler({
        confirmation: { confirm: async () => undefined },
        persistence: new PostgresOrderTransitionPersistence(connection.db),
        logger: createSilentLogger("worker"),
        publishBusinessOutcomeUpdate: async () => undefined,
        notificationRecordPublisher: { publishForConfirmedOrder: async () => undefined },
        recovery: { handoff: async () => undefined, resolve: async () => undefined },
      }),
      logger: createSilentLogger("worker"),
    });

    try {
      await expect(scanner.scanOnce()).resolves.toEqual({
        candidates: 1,
        published: 1,
        failed: 0,
      });
      await expect(scanner.scanOnce()).resolves.toEqual({
        candidates: 1,
        published: 1,
        failed: 0,
      });
      const waitingJobs = await queue.getJobs(["waiting", "delayed", "prioritized"]);
      expect(waitingJobs.map((queuedJob) => queuedJob.id)).toEqual([job.orderId]);

      consumer.start();
      await waitForOrderStatus("confirmed");

      const [order] = await connection.db.select().from(orders).where(eq(orders.id, ids.order));
      expect(order?.status).toBe("confirmed");
      expect(await queue.getJob(job.orderId).then((queuedJob) => queuedJob?.id)).toBe(job.orderId);
    } finally {
      await scanner.close();
      await consumer.close();
      await publisher.close();
      await queue.close();
    }
  });

  it("filters terminal-run orders before limiting the dispatch batch", async () => {
    const runId = "55555555-5555-4555-8555-555555555555";
    const terminalOfferId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc";
    await connection.db.insert(saleOffers).values({
      id: terminalOfferId,
      productId: ids.product,
      name: "Terminal run offer",
      allocatedStock: 10,
      saleStartsAt: queuedAt,
      saleEndsAt: new Date(queuedAt.getTime() + 900_000),
    });
    await createPurchaseRunFixture(connection.db, {
      runId,
      saleOfferId: terminalOfferId,
      status: "completed",
    });
    await connection.db
      .update(demoRuns)
      .set({ status: "completed", trafficStatus: "succeeded", finalizedAt: queuedAt })
      .where(eq(demoRuns.id, runId));
    for (const [index, suffix] of ["02", "03"].entries()) {
      const reservationId = `cccccccc-cccc-4ccc-8ccc-cccccccccc${suffix}`;
      const orderId = `dddddddd-dddd-4ddd-8ddd-dddddddddd${suffix}`;
      const olderQueuedAt = new Date(queuedAt.getTime() - (index + 1) * 1_000);
      await connection.db.insert(reservations).values({
        id: reservationId,
        saleOfferId: terminalOfferId,
        runId,
        correlationId: `corr-terminal-${suffix}`,
        quantity: 1,
        reservationToken: `terminal-dispatch-${suffix}`,
        securedAt: olderQueuedAt,
        expiresAt: new Date(queuedAt.getTime() + 900_000),
      });
      await connection.db.insert(orders).values({
        id: orderId,
        publicOrderId: `ord_terminal_${suffix}`,
        saleOfferId: terminalOfferId,
        reservationId,
        runId,
        correlationId: `corr-terminal-${suffix}`,
        quantity: 1,
        status: "queued",
        queuedAt: olderQueuedAt,
      });
    }
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const scanner = createOrderDispatchScanner({
      persistence: new PostgresOrderDispatchPersistence(connection.db),
      publisher: { enqueue },
      logger: createSilentLogger("worker"),
      scanIntervalMs: 10_000,
      batchSize: 2,
      minimumQueuedAgeMs: 0,
      now: () => new Date("2026-06-21T00:00:10.000Z"),
    });

    await expect(scanner.scanOnce()).resolves.toEqual({ candidates: 1, published: 1, failed: 0 });
    expect(enqueue).toHaveBeenCalledWith(job);
    await scanner.close();
  });

  async function waitForOrderStatus(status: "confirmed"): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [order] = await connection.db.select().from(orders).where(eq(orders.id, ids.order));
      if (order?.status === status) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Order did not reach ${status} before the timeout.`);
  }

  async function seedQueuedOrder(): Promise<void> {
    await connection.db.insert(products).values({
      id: ids.product,
      sku: "DISPATCH-RECOVERY-SKU",
      slug: "dispatch-recovery-product",
      name: "Dispatch Recovery Product",
    });
    await connection.db.insert(saleOffers).values({
      id: ids.saleOffer,
      productId: ids.product,
      name: "Dispatch Recovery Offer",
      allocatedStock: 10,
      saleStartsAt: new Date("2026-01-01T00:00:00.000Z"),
      saleEndsAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    await createPurchaseRunFixture(connection.db, {
      runId: "44444444-4444-4444-8444-444444444444",
      saleOfferId: ids.saleOffer,
      status: "draining",
    });
    await connection.db.insert(reservations).values({
      runId: "44444444-4444-4444-8444-444444444444",
      id: ids.reservation,
      saleOfferId: ids.saleOffer,
      correlationId: job.correlationId,
      quantity: job.quantity,
      reservationToken: "dispatch-recovery-token",
      securedAt: queuedAt,
      expiresAt: new Date("2026-06-21T00:15:00.000Z"),
    });
    await connection.db.insert(orders).values({
      runId: "44444444-4444-4444-8444-444444444444",
      id: ids.order,
      publicOrderId: job.publicOrderId,
      saleOfferId: ids.saleOffer,
      reservationId: ids.reservation,
      correlationId: job.correlationId,
      quantity: job.quantity,
      status: "queued",
      queuedAt,
    });
    await connection.db.insert(orderEvents).values([
      {
        runId: "44444444-4444-4444-8444-444444444444",
        orderId: ids.order,
        reservationId: ids.reservation,
        saleOfferId: ids.saleOffer,
        correlationId: job.correlationId,
        eventName: "reservation.secured",
        payload: { quantity: job.quantity },
        source: "api",
        occurredAt: queuedAt,
      },
      {
        runId: "44444444-4444-4444-8444-444444444444",
        orderId: ids.order,
        reservationId: ids.reservation,
        saleOfferId: ids.saleOffer,
        correlationId: job.correlationId,
        eventName: "order.queued",
        payload: { quantity: job.quantity },
        source: "api",
        occurredAt: queuedAt,
      },
    ]);
  }
});

function requireTestEnv(name: "TEST_DATABASE_URL" | "TEST_REDIS_URL"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for order dispatch integration tests.`);
  }
  return value;
}
