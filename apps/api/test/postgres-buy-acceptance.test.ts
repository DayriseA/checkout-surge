import { randomUUID } from "node:crypto";
import { type OrderProcessJob, securedReservationHoldSchema } from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  PostgresOrderDelivery,
  PostgresStockReservations,
  products,
  saleOffers,
} from "@checkout-surge/db";
import {
  createPurchaseRunFixture,
  requireTestDatabaseUrl,
  resetTestDatabase,
} from "@checkout-surge/db/testing";
import { expect, it } from "vitest";
import { PostgresBuyPersistence } from "../src/services/postgres-buy-persistence.js";
import { ReserveOrderService } from "../src/services/reserve-order-service.js";
import { createSessionBoundBuyAcceptance } from "../src/services/session-bound-buy-acceptance.js";

it("persists and publishes PostgreSQL acceptance on the same admission session with a pool of one", async () => {
  await resetTestDatabase();
  const connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
  const runId = randomUUID();
  const saleOfferId = randomUUID();
  const productId = randomUUID();
  try {
    await connection.db
      .insert(products)
      .values({ id: productId, sku: productId, slug: productId, name: "PG admission test" });
    await connection.db.insert(saleOffers).values({
      id: saleOfferId,
      productId,
      name: "PG admission test",
      allocatedStock: 1,
      saleStartsAt: new Date(),
      saleEndsAt: new Date(Date.now() + 60_000),
    });
    await createPurchaseRunFixture(connection.db, { runId, saleOfferId });
    await connection.sql`update demo_runs set execution_mode='without_redis' where id=${runId}`;
    const stock = new PostgresStockReservations(connection.sql);
    await stock.initialize({ runId, saleOfferId, allocatedStock: 1 });
    const delivery = new PostgresOrderDelivery(connection.sql);
    const [identity] = await connection.sql`select pg_backend_pid() as pid`;
    const publishedPids: number[] = [];
    let publishedJob: OrderProcessJob | undefined;
    const createScope = () =>
      createSessionBoundBuyAcceptance({
        persistence: new PostgresBuyPersistence(connection.db),
        publish: async (session, job) => {
          publishedJob = job;
          const [current] = await session`select pg_backend_pid() as pid`;
          publishedPids.push(current?.pid);
          await delivery.publish(session, job);
        },
      });
    const buy = async (finishAfterStockDecision = false) => {
      const scope = createScope();
      const service = new ReserveOrderService({
        persistence: scope.persistence,
        stockReservations: {
          reserve: async (input) => {
            const decision = await stock.reserve(input);
            if (finishAfterStockDecision) {
              await connection.sql`update demo_runs set status='completed' where id=${runId}`;
            }
            return decision;
          },
          markPendingPersistence: (input) => stock.markPendingPersistence(input),
          promoteAccepted: (input) => stock.promoteAccepted(input),
          reverse: (input) => stock.reverse(input),
        },
        orderProcessJobPublisher: scope.publisher,
        reservationHoldMinutes: 15,
        idempotencyTtlSeconds: 60,
        pendingPersistenceRetryAfterSeconds: 1,
        pendingPersistenceRecovery: { recoverReservation: async () => null },
      });
      return service.reserve({
        request: { runId, saleOfferId, quantity: 1, idempotencyKey: "pool-one" },
        correlationId: "pool-one",
      });
    };
    const accepted = await buy();
    const replay = await buy();
    expect(accepted.outcome).toBe("reservation_secured");
    expect(replay).toEqual(accepted);
    if (accepted.outcome !== "reservation_secured" || !publishedJob)
      throw new Error("Missing accepted order.");
    const [storedHold] =
      await connection.sql`select hold from postgres_reservation_holds where id=${accepted.reservation.id}`;
    const recoveredHold = securedReservationHoldSchema.parse(storedHold?.hold);
    const recoveryScope = createScope();
    const job = publishedJob;
    await recoveryScope.persistence.withRunPendingPersistenceLock({
      reservation: recoveredHold,
      operation: async (operations, disposition) => {
        expect(disposition).toBe("admissible");
        expect(
          await operations.getPersistedBuyByReservationId(accepted.reservation.id),
        ).not.toBeNull();
        await recoveryScope.publisher.enqueue(job);
      },
    });
    // A replay can observe accepting stock just before the terminal transition.
    // Its durable acceptance must still be reasserted on the reserved session.
    expect(await buy(true)).toEqual(accepted);
    expect(publishedPids).toEqual([identity?.pid, identity?.pid, identity?.pid, identity?.pid]);
    const [counts] =
      await connection.sql`select (select count(*)::int from reservations) as reservations,
      (select count(*)::int from orders) as orders,(select count(*)::int from order_events) as events,
      (select count(*)::int from postgres_order_deliveries) as publications`;
    expect(counts).toEqual({ reservations: 1, orders: 1, events: 2, publications: 1 });
    const [publication] = await connection.sql`select payload from postgres_order_deliveries`;
    expect(publication?.payload).toEqual(job);
    expect(await delivery.claim({ limit: 1, leaseSeconds: 30 })).toEqual([]);
  } finally {
    await connection.close();
  }
}, 10_000);
