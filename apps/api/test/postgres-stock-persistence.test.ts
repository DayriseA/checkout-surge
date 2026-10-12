import { randomUUID } from "node:crypto";
import type { SecuredReservationHold } from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createSqlClient,
  demoPresets,
  demoRunSaleContexts,
  demoRuns,
  orderEvents,
  orders,
  postgresOrderQueue,
  postgresRunStock,
  products,
  reservations,
  saleOffers,
} from "@checkout-surge/db";
import { requireTestDatabaseUrl, resetTestDatabase } from "@checkout-surge/db/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresBuyPersistence } from "../src/services/postgres-buy-persistence.js";
import { PostgresStockPersistence } from "../src/services/postgres-stock-persistence.js";
import { terminalDemoRunTransitionLockKey } from "../src/services/terminal-demo-run-transition.js";

const ids = {
  product: "20000000-0000-4000-8000-000000000001",
  preset: "20000000-0000-4000-8000-000000000002",
  run: "20000000-0000-4000-8000-000000000003",
  saleOffer: "20000000-0000-4000-8000-000000000004",
} as const;
const configSnapshot = {
  trafficConfig: {
    mode: "constant-arrival-rate" as const,
    ratePerSecond: 100,
    startDelaySeconds: 0,
    durationSeconds: 2,
    quantityPerAttempt: 1,
  },
  inventoryConfig: { startingStock: 5 },
  erpConfig: { latencyMs: 0, maxTps: 100, errorRate: 0, forcedOutage: false },
  backpressureConfig: {
    queueName: "orders:process" as const,
    physicalQueueName: "orders-process" as const,
    orderProcessConcurrency: 5,
  },
};

describe("PostgreSQL stock decision", () => {
  const connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 10 });
  const db = connection.db;
  const stock = new PostgresStockPersistence(db, new PostgresBuyPersistence(db));

  beforeEach(async () => {
    await resetTestDatabase();
    await seedRun(5);
  });

  afterAll(async () => {
    await connection.close();
  });

  it("commits a winner's reservation, order, events and queue job with the decrement", async () => {
    const result = await stock.reserve({ hold: hold(), idempotencyKey: "buyer-1" });

    expect(result).toMatchObject({ outcome: "reservation_secured", fresh: true });
    const [row] = await db.select().from(postgresRunStock);
    expect(row).toMatchObject({ remainingStock: 4, reservedStock: 1 });
    const [reservation] = await db.select().from(reservations);
    expect(reservation?.idempotencyKey).toBe("buyer-1");
    const [order] = await db.select().from(orders);
    expect(order?.status).toBe("queued");
    expect(await db.select().from(orderEvents)).toHaveLength(2);
    expect(await db.select().from(postgresOrderQueue)).toEqual([
      expect.objectContaining({ orderId: order?.id, deliveries: 0 }),
    ]);
  });

  it("replays a key's reservation and refuses the key for another quantity", async () => {
    const first = await stock.reserve({ hold: hold(), idempotencyKey: "buyer-1" });
    const replay = await stock.reserve({ hold: hold(), idempotencyKey: "buyer-1" });
    const conflict = await stock.reserve({ hold: hold(2), idempotencyKey: "buyer-1" });

    expect(first.outcome).toBe("reservation_secured");
    expect(replay).toMatchObject({ outcome: "reservation_secured", fresh: false });
    if (first.outcome === "reservation_secured" && replay.outcome === "reservation_secured")
      expect(replay.persisted.order.id).toBe(first.persisted.order.id);
    expect(conflict).toEqual({ outcome: "idempotency_conflict" });
    expect(await db.select().from(orders)).toHaveLength(1);
  });

  it("sells exactly the stock to concurrent buyers", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        stock.reserve({ hold: hold(), idempotencyKey: `buyer-${index}` }),
      ),
    );

    const outcomes = results.map((result) => result.outcome);
    expect(outcomes.filter((outcome) => outcome === "reservation_secured")).toHaveLength(5);
    expect(outcomes.filter((outcome) => outcome === "sold_out")).toHaveLength(45);
    expect(await db.select().from(reservations)).toHaveLength(5);
    expect(await db.select().from(postgresOrderQueue)).toHaveLength(5);
    const [row] = await db.select().from(postgresRunStock);
    expect(row).toMatchObject({ remainingStock: 0, reservedStock: 5 });
  });

  it("answers sold-out buyers without waiting on the stock row and without writing", async () => {
    await db.update(postgresRunStock).set({ remainingStock: 0 });
    const holder = createSqlClient(requireTestDatabaseUrl(), { max: 1 });
    try {
      await holder.begin(async (tx) => {
        // Another transaction holds the stock row locked for the whole burst.
        await tx`select * from postgres_run_stock where run_id = ${ids.run} for update`;
        const burst = Promise.all(
          Array.from({ length: 200 }, (_, index) =>
            stock.reserve({ hold: hold(), idempotencyKey: `turned-away-${index}` }),
          ),
        );
        const results = await Promise.race([
          burst,
          new Promise<null>((resolve) => setTimeout(resolve, 10_000, null)),
        ]);
        expect(results?.every((result) => result.outcome === "sold_out")).toBe(true);
      });
    } finally {
      await holder.end({ timeout: 5 });
    }
    expect(await db.select().from(reservations)).toHaveLength(0);
  });

  it("refuses a buyer when the run is no longer selling or has no stock", async () => {
    await db.update(demoRuns).set({ status: "draining" });
    await expect(stock.reserve({ hold: hold(), idempotencyKey: "late" })).resolves.toEqual({
      outcome: "run_not_accepting_traffic",
    });

    await db.update(demoRuns).set({ status: "active" });
    await db.delete(postgresRunStock);
    await expect(stock.reserve({ hold: hold(), idempotencyKey: "early" })).resolves.toEqual({
      outcome: "inventory_not_initialized",
    });
  });

  it("writes nothing for a winner whose run turns terminal while it waits on the fence", async () => {
    const terminal = createSqlClient(requireTestDatabaseUrl(), { max: 1 });
    try {
      let attempt: Promise<unknown> | undefined;
      await terminal.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${terminalDemoRunTransitionLockKey(ids.run)}))`;
        attempt = stock.reserve({ hold: hold(), idempotencyKey: "racing" });
        await waitForAdvisoryLockWaiter();
        await tx`update demo_runs set status = 'draining' where id = ${ids.run}`;
      });
      await expect(attempt).resolves.toEqual({ outcome: "run_not_accepting_traffic" });
    } finally {
      await terminal.end({ timeout: 5 });
    }
    expect(await db.select().from(reservations)).toHaveLength(0);
  });

  async function seedRun(startingStock: number): Promise<void> {
    await db.insert(products).values({
      id: ids.product,
      sku: "PG-STOCK-SKU",
      slug: "pg-stock-product",
      name: "PostgreSQL Stock Product",
    });
    await db.insert(saleOffers).values({
      id: ids.saleOffer,
      productId: ids.product,
      name: "PostgreSQL Stock Offer",
      allocatedStock: startingStock,
      saleStartsAt: new Date("2026-01-01T00:00:00.000Z"),
      saleEndsAt: new Date("2035-01-01T00:00:00.000Z"),
    });
    await db.insert(demoPresets).values({
      id: ids.preset,
      slug: "pg-stock",
      visibility: "admin",
      isEditable: true,
      display: {
        name: "PostgreSQL Stock",
        description: "PostgreSQL stock fixture.",
        sortOrder: 1,
        outcomeFocus: ["sold_out"],
      },
      ...configSnapshot,
    });
    await db.insert(demoRuns).values({
      id: ids.run,
      presetId: ids.preset,
      presetName: "PostgreSQL Stock",
      operatorMode: "admin",
      status: "active",
      trafficStatus: "active",
      configSnapshot,
      correlationId: "corr-pg-stock",
      saleOfferId: ids.saleOffer,
      comparisonMode: "postgres",
    });
    await db.insert(demoRunSaleContexts).values({ runId: ids.run, saleOfferId: ids.saleOffer });
    await db
      .insert(postgresRunStock)
      .values({ runId: ids.run, saleOfferId: ids.saleOffer, remainingStock: startingStock });
  }

  async function waitForAdvisoryLockWaiter(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await db.execute(
        sql`select 1 from pg_locks where locktype = 'advisory' and not granted limit 1`,
      );
      if (waiting.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("The winner never waited on the run fence.");
  }
});

function hold(quantity = 1): SecuredReservationHold {
  const securedAt = new Date();
  return {
    id: randomUUID(),
    saleOfferId: ids.saleOffer,
    correlationId: `corr-${randomUUID()}`,
    runId: ids.run,
    quantity,
    reservationToken: `res_${randomUUID()}`,
    securedAt: securedAt.toISOString(),
    expiresAt: new Date(securedAt.getTime() + 15 * 60_000).toISOString(),
  };
}
