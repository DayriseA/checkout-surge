import { randomUUID } from "node:crypto";
import type { SecuredReservationHold } from "@checkout-surge/contracts";
import {
  createAbortableDatabaseConnection,
  createDatabaseConnection,
  createRedisClient,
  PostgresOrderDelivery,
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
import { expect, it, vi } from "vitest";
import { createPendingPersistenceRecoveryOperations } from "../src/runtime/pending-persistence-operation-factory.js";
import { createPostgresPendingPersistenceAttempt } from "../src/runtime/postgres-pending-persistence-attempt.js";
import { PendingPersistenceRecoveryService } from "../src/services/pending-persistence-recovery-service.js";
import { terminalDemoRunTransitionLockKey } from "../src/services/terminal-demo-run-transition.js";

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

it("routes scheduled and authenticated direct recovery through durable PG ownership and cleans owned max-one connections", async () => {
  await resetTestDatabase();
  const database = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
  const runId = randomUUID();
  const saleOfferId = randomUUID();
  const productId = randomUUID();
  let now = new Date();
  const closes: ReturnType<typeof vi.spyOn>[] = [];
  const createPublisher = vi.fn(() => {
    throw new Error("PG recovery must not create an ORDER BullMQ publisher");
  });
  const operations = createPendingPersistenceRecoveryOperations(
    {
      databaseUrl: requireTestDatabaseUrl(),
      redisUrl: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379",
      discoveryTimeoutMs: 2000,
    },
    {
      createDatabase: (url, signal, options) => {
        expect(options.max).toBe(1);
        const connection = createAbortableDatabaseConnection(url, signal, options);
        closes.push(vi.spyOn(connection, "close"));
        return connection;
      },
      createRedis: createRedisClient,
      createPublisher,
    },
  );
  const base = createPostgresPendingPersistenceAttempt({
    database,
    signal: new AbortController().signal,
    close: async () => {},
  });
  const service = new PendingPersistenceRecoveryService({
    ...base,
    storage: operations.storage,
    listRunScopes: (signal) => operations.listRunScopes(signal),
    resolveRunScope: (reservation) => operations.resolveRunScope(reservation),
    openDiscoveryScope: (signal) => operations.openDiscoveryScope(signal),
    openAttemptScope: (input) => operations.openAttemptScope(input),
    closeDiscovery: () => operations.close(),
    idempotencyTtlSeconds: 60,
    initialBackoffMs: 100,
    maxBackoffMs: 100,
    logger: createSilentLogger("api"),
    now: () => now,
  });
  try {
    await database.db
      .insert(products)
      .values({ id: productId, sku: productId, slug: productId, name: "PG runtime recovery" });
    await database.db.insert(saleOffers).values({
      id: saleOfferId,
      productId,
      name: "PG runtime recovery",
      allocatedStock: 3,
      saleStartsAt: now,
      saleEndsAt: new Date(now.getTime() + 60_000),
    });
    await createPurchaseRunFixture(database.db, { runId, saleOfferId });
    await database.sql`update demo_runs set execution_mode='without_redis' where id=${runId}`;
    const stock = new PostgresStockReservations(database.sql);
    await stock.initialize({ runId, saleOfferId, allocatedStock: 3 });
    const reservation: SecuredReservationHold = {
      id: randomUUID(),
      runId,
      saleOfferId,
      quantity: 1,
      correlationId: "runtime-direct",
      reservationToken: randomUUID(),
      securedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    };
    await stock.reserve({
      reservation,
      idempotencyKey: "runtime-direct",
      idempotencyTtlSeconds: 60,
    });
    expect(await operations.resolveRunScope(reservation)).toEqual({
      runId,
      saleOfferId,
      executionMode: "without_redis",
    });
    expect(
      await service.recoverReservation({
        reservation: { ...reservation, runId: randomUUID() },
        idempotencyKey: "runtime-direct",
      }),
    ).toBeNull();
    expect(
      await service.recoverReservation({ reservation, idempotencyKey: "runtime-direct" }),
    ).not.toBeNull();
    expect(
      (
        await new PostgresPendingPersistence(database.sql).readRecord({
          saleOfferId,
          reservationId: reservation.id,
        })
      ).record,
    ).toBeNull();
    const scheduled = {
      ...reservation,
      id: randomUUID(),
      correlationId: "runtime-scheduled",
      reservationToken: randomUUID(),
    };
    await stock.reserve({
      reservation: scheduled,
      idempotencyKey: "runtime-scheduled",
      idempotencyTtlSeconds: 60,
    });
    const actualPublish = PostgresOrderDelivery.prototype.publish;
    const publish = vi
      .spyOn(PostgresOrderDelivery.prototype, "publish")
      .mockImplementationOnce(async function (this: PostgresOrderDelivery, session, job, options) {
        await actualPublish.call(this, session, job, options);
        throw new Error("Actual publication response lost");
      });
    expect(await service.runOnce()).toMatchObject({ discovered: 1, deferred: 1 });
    expect(
      (
        await new PostgresPendingPersistence(database.sql).readRecord({
          saleOfferId,
          reservationId: scheduled.id,
        })
      ).record,
    ).toMatchObject({
      recoveryAttemptCount: 1,
      nextRecoveryAt: new Date(now.getTime() + 100).toISOString(),
    });
    now = new Date(now.getTime() + 100);
    expect(
      await service.recoverReservation({
        reservation: scheduled,
        idempotencyKey: "runtime-scheduled",
      }),
    ).not.toBeNull();
    publish.mockRestore();
    expect(
      (await database.sql`select count(*)::int as count from postgres_order_deliveries`)[0]?.count,
    ).toBe(2);
    expect(createPublisher).not.toHaveBeenCalled();
    const cancelled = {
      ...reservation,
      id: randomUUID(),
      correlationId: "runtime-abort",
      reservationToken: randomUUID(),
    };
    await stock.reserve({
      reservation: cancelled,
      idempotencyKey: "runtime-abort",
      idempotencyTtlSeconds: 60,
    });
    const blocker = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    let unlock!: () => void;
    let locked!: () => void;
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocking = blocker.sql.begin(async (session) => {
      await session`select pg_advisory_xact_lock(hashtext(${terminalDemoRunTransitionLockKey(runId)}))`;
      locked();
      await release;
    });
    try {
      await acquired;
      const direct = service.recoverReservation({
        reservation: cancelled,
        idempotencyKey: "runtime-abort",
      });
      await vi.waitFor(
        async () => {
          const [waiting] =
            await database.sql`select count(*)::int as count from pg_stat_activity where wait_event_type='Lock' and query like '%pg_advisory_lock_shared%' and pid<>pg_backend_pid()`;
          expect(waiting?.count).toBe(1);
        },
        { timeout: 3000, interval: 10 },
      );
      expect(await Promise.all([direct, service.close()])).toEqual([null, undefined]);
    } finally {
      unlock();
      await blocking;
      await blocker.close();
    }
    await service.close();
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
  } finally {
    vi.restoreAllMocks();
    await service.close();
    await database.close();
  }
});
