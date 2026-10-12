import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OrderProcessJob } from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import {
  createDatabaseConnection,
  demoRuns,
  orders,
  postgresOrderQueue,
  postgresOrderQueueChannel,
  products,
  reservations,
  saleOffers,
} from "@checkout-surge/db";
import { createPurchaseRunFixture, resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderDispatchScanner } from "../../src/application/order-dispatch-scanner.js";
import {
  createOrderProcessJobHandler,
  type OrderProcessDeliveryMetadata,
  type OrderProcessJobHandler,
  type RecoverableOrderHandoff,
} from "../../src/application/order-process-job-handler.js";
import { PostgresOrderDispatchPersistence } from "../../src/persistence/postgres-order-dispatch-persistence.js";
import { PostgresOrderQueuePersistence } from "../../src/persistence/postgres-order-queue-persistence.js";
import { PostgresOrderTransitionPersistence } from "../../src/persistence/postgres-order-transition-persistence.js";
import { createPostgresOrderQueueConsumer } from "../../src/queue/postgres-order-queue-consumer.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = path.resolve(packageRoot, "../../packages/db/drizzle");
const databaseUrl = requireTestEnv("TEST_DATABASE_URL");
const runId = "66666666-6666-4666-8666-666666666666";
const saleOfferId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb66";
const orderIds = ["dddddddd-dddd-4ddd-8ddd-dddddddddd61", "dddddddd-dddd-4ddd-8ddd-dddddddddd62"];
const queuedAt = new Date("2026-06-21T00:00:00.000Z");

describe("PostgreSQL order queue", () => {
  let connection!: ReturnType<typeof createDatabaseConnection>;
  const logger = createSilentLogger("worker");

  beforeAll(() => {
    connection = createDatabaseConnection(databaseUrl, { max: 4 });
  });

  beforeEach(async () => {
    await resetTestDatabase({ databaseUrl, migrationsFolder });
    await seedQueuedOrders();
  });

  afterAll(async () => {
    await connection?.close();
  });

  function consumerWith(options: {
    handle: OrderProcessJobHandler["handle"];
    maxTps?: number;
    recordRecoverable?: (input: RecoverableOrderHandoff) => Promise<void>;
  }) {
    const snapshot = previewRunConfigSnapshotFixture();
    snapshot.erpConfig.maxTps = options.maxTps ?? 1000;
    return createPostgresOrderQueueConsumer({
      queue: new PostgresOrderQueuePersistence(connection.db),
      listen: (wake) => connection.sql.listen(postgresOrderQueueChannel, wake, wake),
      runConfig: { read: async () => snapshot },
      handler: { handle: options.handle },
      recovery: {
        recordRecoverable: options.recordRecoverable ?? (async () => undefined),
        recordDeadLetter: async () => undefined,
      },
      logger,
    });
  }

  it("delivers a job queued with its order at the commit's notification, once, and settles it", async () => {
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: async () => undefined },
      persistence: new PostgresOrderTransitionPersistence(connection.db),
      logger,
      publishBusinessOutcomeUpdate: async () => undefined,
      notificationRecordPublisher: { publishForConfirmedOrder: async () => undefined },
      recovery: { handoff: async () => undefined, resolve: async () => undefined },
    });
    const handle = vi.fn((job: OrderProcessJob, delivery: OrderProcessDeliveryMetadata) =>
      handler.handle(job, delivery),
    );
    const consumer = consumerWith({ handle });
    consumer.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await connection.db.transaction(async (tx) => {
        await tx.insert(postgresOrderQueue).values({ orderId: orderIds[0] as string });
        await tx.execute(sql`select pg_notify(${postgresOrderQueueChannel}, '')`);
      });

      await vi.waitFor(async () => {
        const [order] = await connection.db
          .select({ status: orders.status })
          .from(orders)
          .where(eq(orders.id, orderIds[0] as string));
        expect(order?.status).toBe("confirmed");
      });
      await vi.waitFor(async () =>
        expect(await connection.db.select().from(postgresOrderQueue)).toEqual([]),
      );
      expect(handle).toHaveBeenCalledOnce();
    } finally {
      await consumer.close();
    }
  });

  it("never claims one job twice", async () => {
    await connection.db.insert(postgresOrderQueue).values({ orderId: orderIds[0] as string });
    const queue = new PostgresOrderQueuePersistence(connection.db);

    const claims = await Promise.all([queue.claim(60_000), queue.claim(60_000)]);

    expect(claims.flatMap((claim) => ("job" in claim ? [claim.job.orderId] : []))).toEqual([
      orderIds[0],
    ]);
  });

  it("paces deliveries at the run's rate", async () => {
    const deliveredAt: number[] = [];
    const consumer = consumerWith({
      maxTps: 5,
      handle: async () => {
        deliveredAt.push(Date.now());
      },
    });
    await connection.db.insert(postgresOrderQueue).values(orderIds.map((orderId) => ({ orderId })));
    consumer.start();
    try {
      await vi.waitFor(() => expect(deliveredAt).toHaveLength(2), { timeout: 5_000 });
    } finally {
      await consumer.close();
    }
    // At 5 orders per second less the safety margin, one delivery every 211 ms.
    expect((deliveredAt[1] ?? 0) - (deliveredAt[0] ?? 0)).toBeGreaterThanOrEqual(200);
  });

  it("delivers a job again once the lease of a delivery that never settled expires", async () => {
    // A worker that stopped mid-delivery left this job leased.
    await connection.db.insert(postgresOrderQueue).values({
      orderId: orderIds[0] as string,
      lockedUntil: sql`now() + interval '500 milliseconds'`,
    });
    const handle = vi.fn(async () => undefined);
    const consumer = consumerWith({ handle });
    const startedAt = Date.now();
    consumer.start();
    try {
      await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce(), { timeout: 5_000 });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
      await vi.waitFor(async () =>
        expect(await connection.db.select().from(postgresOrderQueue)).toEqual([]),
      );
    } finally {
      await consumer.close();
    }
  });

  it("settles a failed job once the recovery path took it, and keeps it leased otherwise", async () => {
    class DeliveryPersistenceError extends Error {
      override readonly name = "DeliveryPersistenceError";
    }
    const consumer = consumerWith({
      handle: async () => Promise.reject(new DeliveryPersistenceError("database unavailable")),
      recordRecoverable: async ({ job }) => {
        if (job.orderId === orderIds[1]) throw new Error("recovery handoff failed");
      },
    });
    await connection.db.insert(postgresOrderQueue).values(orderIds.map((orderId) => ({ orderId })));
    consumer.start();
    try {
      await vi.waitFor(async () => {
        const rows = await connection.db.select().from(postgresOrderQueue);
        expect(rows.map((row) => row.orderId)).toEqual([orderIds[1]]);
        expect(rows[0]?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
      });
    } finally {
      await consumer.close();
    }
  });

  it("leaves the dispatch repair to BullMQ orders only", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const scanner = createOrderDispatchScanner({
      persistence: new PostgresOrderDispatchPersistence(connection.db),
      publisher: { enqueue },
      logger,
      scanIntervalMs: 10_000,
      batchSize: 10,
      minimumQueuedAgeMs: 0,
      now: () => new Date("2026-06-21T00:00:10.000Z"),
    });

    await expect(scanner.scanOnce()).resolves.toMatchObject({ candidates: 0 });
    await scanner.close();
    expect(enqueue).not.toHaveBeenCalled();
  });

  async function seedQueuedOrders(): Promise<void> {
    const db = connection.db;
    await db.insert(products).values({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa66",
      sku: "PG-QUEUE-SKU",
      slug: "pg-queue-product",
      name: "PostgreSQL Queue Product",
    });
    await db.insert(saleOffers).values({
      id: saleOfferId,
      productId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa66",
      name: "PostgreSQL Queue Offer",
      allocatedStock: 2,
      saleStartsAt: new Date("2026-01-01T00:00:00.000Z"),
      saleEndsAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    await createPurchaseRunFixture(db, { runId, saleOfferId, status: "active" });
    await db.update(demoRuns).set({ comparisonMode: "postgres" }).where(eq(demoRuns.id, runId));
    for (const [index, orderId] of orderIds.entries()) {
      const reservationId = `cccccccc-cccc-4ccc-8ccc-cccccccccc6${index}`;
      await db.insert(reservations).values({
        id: reservationId,
        saleOfferId,
        runId,
        correlationId: `corr-pg-queue-${index}`,
        quantity: 1,
        reservationToken: `pg-queue-${index}`,
        securedAt: queuedAt,
        expiresAt: new Date(queuedAt.getTime() + 900_000),
      });
      await db.insert(orders).values({
        id: orderId,
        publicOrderId: `ord_pg_queue_${index}`,
        saleOfferId,
        reservationId,
        runId,
        correlationId: `corr-pg-queue-${index}`,
        quantity: 1,
        status: "queued",
        queuedAt,
      });
    }
  }
});

function requireTestEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
