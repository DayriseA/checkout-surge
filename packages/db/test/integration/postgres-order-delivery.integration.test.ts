import { randomUUID } from "node:crypto";
import type { OrderProcessJob } from "@checkout-surge/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createDatabaseConnection,
  PostgresOrderDelivery,
  products,
  saleOffers,
} from "../../src/index.js";
import {
  createPurchaseRunFixture,
  requireTestDatabaseUrl,
  resetTestDatabase,
} from "../../src/testing.js";

let connection: ReturnType<typeof createDatabaseConnection>;
let delivery: PostgresOrderDelivery;
let runId: string;
let saleOfferId: string;

async function createRun(mode: "demo" | "without_redis", status: "active" | "completed") {
  const id = randomUUID();
  const offerId = randomUUID();
  const productId = randomUUID();
  await connection.db
    .insert(products)
    .values({ id: productId, sku: productId, slug: productId, name: "Delivery test" });
  await connection.db.insert(saleOffers).values({
    id: offerId,
    productId,
    name: "Delivery test",
    allocatedStock: 10,
    saleStartsAt: new Date(),
    saleEndsAt: new Date(Date.now() + 60_000),
  });
  await createPurchaseRunFixture(connection.db, { runId: id, saleOfferId: offerId, status });
  await connection.sql`update demo_runs set execution_mode=${mode} where id=${id}`;
  return { runId: id, saleOfferId: offerId };
}

function job(context = { runId, saleOfferId }): OrderProcessJob {
  return {
    ...context,
    orderId: randomUUID(),
    publicOrderId: randomUUID(),
    reservationId: randomUUID(),
    correlationId: "delivery-test",
    quantity: 1,
    queuedAt: new Date().toISOString(),
    processingGeneration: 0,
  };
}

beforeEach(async () => {
  await resetTestDatabase();
  connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 2 });
  delivery = new PostgresOrderDelivery(connection.sql);
  ({ runId, saleOfferId } = await createRun("without_redis", "active"));
});
afterEach(async () => {
  await connection.close();
});

it("publishes the canonical payload idempotently on the supplied session", async () => {
  const payload = job();
  const session = await connection.sql.reserve();
  try {
    await delivery.publish(session, payload);
    await delivery.publish(session, payload);
  } finally {
    session.release();
  }
  const rows = await connection.sql`select * from postgres_order_deliveries`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    publication_id: payload.orderId,
    run_id: runId,
    payload,
    delivery_generation: 0,
    lease_until: null,
    settled_at: null,
  });
});

it("bounds concurrent claims and preserves distinct publication identities", async () => {
  const payload = job();
  await delivery.publish(connection.sql, payload);
  await delivery.publish(connection.sql, payload, { jobId: `recovery-${payload.orderId}-1` });
  await delivery.publish(connection.sql, job());
  const batches = await Promise.all([
    delivery.claim({ limit: 2, leaseSeconds: 30 }),
    delivery.claim({ limit: 2, leaseSeconds: 30 }),
  ]);
  expect(batches.every((batch) => batch.length <= 2)).toBe(true);
  expect(new Set(batches.flat().map((claim) => claim.publicationId)).size).toBe(3);
  expect(batches.flat()).toHaveLength(3);
  expect(await delivery.claim({ limit: 2, leaseSeconds: 30 })).toEqual([]);
});

it("requires a fresh matching delivery generation through expiry, reclaim and settled republication", async () => {
  const payload = job();
  await delivery.publish(connection.sql, payload);
  const [first] = await delivery.claim({ limit: 1, leaseSeconds: 1 });
  if (!first) throw new Error("Missing first claim.");
  expect(await delivery.renew(first, 1)).toBe(true);
  await connection.sql`select pg_sleep(1.1)`;
  expect(await delivery.renew(first, 30)).toBe(false);
  expect(await delivery.settle(first)).toBe(false);
  const [second] = await delivery.claim({ limit: 1, leaseSeconds: 30 });
  if (!second) throw new Error("Missing reclaimed delivery.");
  expect(second.deliveryGeneration).toBeGreaterThan(first.deliveryGeneration);
  expect(second.job.processingGeneration).toBe(payload.processingGeneration);
  expect(await delivery.renew(first, 30)).toBe(false);
  expect(await delivery.settle(first)).toBe(false);
  await delivery.publish(connection.sql, payload);
  expect(await delivery.renew(second, 30)).toBe(true);
  expect(await delivery.settle(second)).toBe(true);
  await delivery.publish(connection.sql, payload);
  expect(await delivery.settle(second)).toBe(false);
  const [third] = await delivery.claim({ limit: 1, leaseSeconds: 30 });
  if (!third) throw new Error("Missing republished delivery.");
  expect(third.deliveryGeneration).toBeGreaterThan(second.deliveryGeneration);
  expect(await delivery.renew(second, 30)).toBe(false);
  expect(await delivery.settle(second)).toBe(false);
  expect(await delivery.settle(third)).toBe(true);
});

it("filters backend, terminal status and due time before the claim limit", async () => {
  await connection.sql`update demo_runs set status='completed' where id=${runId}`;
  const earlier = new Date(Date.now() - 60_000);
  await delivery.publish(connection.sql, job(), { dueAt: earlier });
  const demo = await createRun("demo", "active");
  await delivery.publish(connection.sql, job(demo), { dueAt: earlier });
  expect(await delivery.claim({ limit: 1, leaseSeconds: 30 })).toEqual([]);
  await connection.sql`update demo_runs set status='completed' where id=${demo.runId}`;
  const eligible = await createRun("without_redis", "active");
  await delivery.publish(connection.sql, job(eligible), { dueAt: new Date(Date.now() + 60_000) });
  const ready = job(eligible);
  await delivery.publish(connection.sql, ready);
  const claims = await delivery.claim({ limit: 1, leaseSeconds: 30 });
  expect(claims).toHaveLength(1);
  expect(claims[0]?.job).toEqual(ready);
});

it.each([
  "renew",
  "settle",
] as const)("refuses %s when a duplicate publication lock wait crosses lease expiry", async (operation) => {
  const payload = job();
  await delivery.publish(connection.sql, payload);
  const [claim] = await delivery.claim({ limit: 1, leaseSeconds: 2 });
  if (!claim) throw new Error("Missing claim.");
  const waiter = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
  const waitingDelivery = new PostgresOrderDelivery(waiter.sql);
  const [backend] = await waiter.sql`select pg_backend_pid() as pid`;
  const blocker = await connection.sql.reserve();
  try {
    await blocker`begin`;
    await delivery.publish(blocker, payload);
    const result =
      operation === "renew" ? waitingDelivery.renew(claim, 30) : waitingDelivery.settle(claim);
    try {
      const deadline = Date.now() + 5000;
      let observedWait = false;
      while (Date.now() < deadline) {
        const [activity] =
          await connection.sql`select wait_event_type from pg_stat_activity where pid=${backend?.pid}`;
        if (activity?.wait_event_type === "Lock") {
          observedWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedWait).toBe(true);
      await blocker`select pg_sleep(greatest(0,extract(epoch from (lease_until-clock_timestamp())))+0.05)
          from postgres_order_deliveries where publication_id=${claim.publicationId}`;
    } finally {
      await blocker`rollback`;
    }
    expect(await result).toBe(false);
    const [stored] = await connection.sql`select settled_at,lease_until>clock_timestamp() as fresh
        from postgres_order_deliveries where publication_id=${claim.publicationId}`;
    expect(stored).toEqual({ settled_at: null, fresh: false });
  } finally {
    blocker.release();
    await waiter.close();
  }
});
