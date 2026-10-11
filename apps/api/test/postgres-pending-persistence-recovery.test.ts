import { randomUUID } from "node:crypto";
import type { SecuredReservationHold } from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  PostgresPendingPersistence,
  PostgresStockReservations,
  products,
  saleOffers,
} from "@checkout-surge/db";
import {
  createPurchaseRunFixture,
  requireTestDatabaseUrl,
  resetTestDatabase,
} from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { expect, it } from "vitest";
import { createPostgresPendingPersistenceAttempt } from "../src/runtime/postgres-pending-persistence-attempt.js";
import { PendingPersistenceRecoveryService } from "../src/services/pending-persistence-recovery-service.js";

it("recovers through real PostgreSQL acceptance/publication with pool one, backoff, audit and exhaustion", async () => {
  await resetTestDatabase();
  const database = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
  const runId = randomUUID();
  const saleOfferId = randomUUID();
  const productId = randomUUID();
  let now = new Date();
  const storage = new PostgresPendingPersistence(database.sql);
  const stock = new PostgresStockReservations(database.sql);
  let losePublicationResponse = true;
  let rejectPublication = false;
  const openAttemptScope = async ({ signal }: { signal: AbortSignal }) => {
    const scope = createPostgresPendingPersistenceAttempt({
      database,
      signal,
      close: async () => undefined,
    });
    const publisher = scope.orderProcessJobPublisher;
    scope.orderProcessJobPublisher = {
      enqueue: async (job) => {
        if (rejectPublication) throw new Error("Publication unavailable.");
        await publisher.enqueue(job);
        if (losePublicationResponse) {
          losePublicationResponse = false;
          throw new Error("Publication response lost.");
        }
      },
    };
    return scope;
  };
  const base = await openAttemptScope({ signal: new AbortController().signal });
  const service = new PendingPersistenceRecoveryService({
    ...base,
    storage,
    openAttemptScope,
    listRunScopes: async () => [{ runId, saleOfferId }],
    idempotencyTtlSeconds: 60,
    maxAttempts: 2,
    initialBackoffMs: 100,
    maxBackoffMs: 100,
    logger: createSilentLogger("api"),
    now: () => now,
  });
  const reserve = async (key: string) => {
    const reservation: SecuredReservationHold = {
      id: randomUUID(),
      runId,
      saleOfferId,
      quantity: 1,
      correlationId: key,
      reservationToken: `token-${key}`,
      securedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    };
    await stock.reserve({ reservation, idempotencyKey: key, idempotencyTtlSeconds: 60 });
    return reservation;
  };
  try {
    await database.db
      .insert(products)
      .values({ id: productId, sku: productId, slug: productId, name: "PG recovery" });
    await database.db.insert(saleOffers).values({
      id: saleOfferId,
      productId,
      name: "PG recovery",
      allocatedStock: 2,
      saleStartsAt: now,
      saleEndsAt: new Date(now.getTime() + 60_000),
    });
    await createPurchaseRunFixture(database.db, { runId, saleOfferId });
    await database.sql`update demo_runs set execution_mode='without_redis' where id=${runId}`;
    await stock.initialize({ runId, saleOfferId, allocatedStock: 2 });
    const reservation = await reserve("retry");
    expect(await service.runOnce()).toMatchObject({ discovered: 1, attempted: 1, deferred: 1 });
    expect(
      (await storage.readRecord({ saleOfferId, reservationId: reservation.id })).record,
    ).toMatchObject({
      recoveryAttemptCount: 1,
      recoveryStatus: "pending",
      nextRecoveryAt: new Date(now.getTime() + 100).toISOString(),
    });
    expect(await service.recoverReservation({ reservation, idempotencyKey: "retry" })).toBeNull();
    now = new Date(now.getTime() + 100);
    const accepted = await service.recoverReservation({ reservation, idempotencyKey: "retry" });
    expect(accepted?.reservation.id).toBe(reservation.id);
    expect(
      (await storage.readRecord({ saleOfferId, reservationId: reservation.id })).record,
    ).toBeNull();
    const [publication] = await database.sql`select payload from postgres_order_deliveries`;
    expect(publication?.payload).toMatchObject({
      orderId: accepted?.order.id,
      reservationId: reservation.id,
      runId,
    });
    const [audit] =
      await database.sql`select status,attempt_count from reservation_pending_persistence where reservation_id=${reservation.id}`;
    expect(audit).toEqual({ status: "reconciled", attempt_count: 2 });
    rejectPublication = true;
    const exhausted = await reserve("exhaust");
    await service.runOnce();
    now = new Date(now.getTime() + 100);
    expect(await service.runOnce()).toMatchObject({ exhausted: 1 });
    expect(
      (await storage.readRecord({ saleOfferId, reservationId: exhausted.id })).record,
    ).toMatchObject({
      recoveryAttemptCount: 2,
      recoveryStatus: "exhausted",
      lastRecoveryError: "Publication unavailable.",
    });
    const [exhaustionAudit] =
      await database.sql`select status,attempt_count from reservation_pending_persistence where reservation_id=${exhausted.id}`;
    expect(exhaustionAudit).toEqual({ status: "exhausted", attempt_count: 2 });
    expect(await service.runOnce()).toMatchObject({ discovered: 0 });
    expect(
      await service.recoverReservation({ reservation: exhausted, idempotencyKey: "exhaust" }),
    ).toBeNull();
  } finally {
    await service.close();
    await database.close();
  }
}, 10_000);
