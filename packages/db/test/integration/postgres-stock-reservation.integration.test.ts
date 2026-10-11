import { randomUUID } from "node:crypto";
import type { SecuredReservationHold } from "@checkout-surge/contracts";
import type postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabaseConnection,
  PostgresPendingPersistence,
  PostgresStockReservations,
  products,
  saleOffers,
} from "../../src/index.js";
import {
  createPurchaseRunFixture,
  requireTestDatabaseUrl,
  resetTestDatabase,
} from "../../src/testing.js";

let connection: ReturnType<typeof createDatabaseConnection>;
let runId: string;
let saleOfferId: string;
let stock: PostgresStockReservations;
const connections: ReturnType<typeof createDatabaseConnection>[] = [];
function open(max = 1) {
  const value = createDatabaseConnection(requireTestDatabaseUrl(), { max });
  connections.push(value);
  return value;
}
function attempt(key: string = randomUUID(), quantity = 1) {
  const securedAt = new Date().toISOString();
  const reservation: SecuredReservationHold = {
    id: randomUUID(),
    runId,
    saleOfferId,
    quantity,
    correlationId: `stock-${key}`,
    reservationToken: `token-${key}`,
    securedAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return { idempotencyKey: key, idempotencyTtlSeconds: 60, reservation };
}
beforeEach(async () => {
  await resetTestDatabase();
  connection = open(2);
  runId = randomUUID();
  saleOfferId = randomUUID();
  const productId = randomUUID();
  await connection.db
    .insert(products)
    .values({ id: productId, sku: productId, slug: productId, name: "PG stock test" });
  await connection.db.insert(saleOffers).values({
    id: saleOfferId,
    productId,
    name: "PG stock test",
    allocatedStock: 3,
    saleStartsAt: new Date(),
    saleEndsAt: new Date(Date.now() + 60_000),
  });
  await createPurchaseRunFixture(connection.db, { runId, saleOfferId });
  stock = new PostgresStockReservations(connection.sql);
  await stock.initialize({ runId, saleOfferId, allocatedStock: 3 });
});
afterEach(async () => {
  await Promise.all(connections.splice(0).map((value) => value.close()));
});

async function waitForLock(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] =
      await connection.sql`select wait_event_type from pg_stat_activity where pid=${pid}`;
    if (row?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${pid} did not reach its actual PostgreSQL lock wait.`);
}

describe("unwired PostgreSQL stock adapter", () => {
  it("does not oversell across independent clients", async () => {
    const other = new PostgresStockReservations(open(2).sql);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => (index % 2 ? stock : other).reserve(attempt())),
    );
    expect(results.filter((result) => result.outcome === "reservation_secured")).toHaveLength(3);
    expect(results.filter((result) => result.outcome === "sold_out")).toHaveLength(9);
    const [row] = await connection.sql`select remaining_stock,reserved_stock,
      (select count(*)::int from postgres_reservation_holds) as holds from postgres_run_inventory`;
    expect(row).toEqual({ remaining_stock: 0, reserved_stock: 3, holds: 3 });
  });

  it.each([
    [1, "reservation_pending_persistence"],
    [2, "idempotency_conflict"],
  ] as const)("refreshes a same-key waiter's snapshot for quantity %s", async (quantity, outcome) => {
    const first = open();
    const second = open();
    const [firstIdentity] = await first.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    const [secondIdentity] = await second.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    const firstPid = firstIdentity?.pid;
    const secondPid = secondIdentity?.pid;
    if (!firstPid || !secondPid) throw new Error("Missing PostgreSQL backend identity.");
    const input = attempt("same-key");
    let winner!: ReturnType<PostgresStockReservations["reserve"]>;
    let waiter!: ReturnType<PostgresStockReservations["reserve"]>;
    await connection.sql.begin(async (tx) => {
      await tx`select run_id from postgres_run_inventory where run_id=${runId} for update`;
      winner = new PostgresStockReservations(first.sql).reserve(input);
      await waitForLock(firstPid);
      waiter = new PostgresStockReservations(second.sql).reserve({
        ...attempt("same-key", quantity),
      });
      await waitForLock(secondPid);
    });
    expect(await winner).toEqual({
      outcome: "reservation_secured",
      reservation: input.reservation,
    });
    expect(await waiter).toEqual({
      outcome,
      reservation: quantity === 1 ? input.reservation : null,
    });
    const [count] =
      await connection.sql`select count(*)::int as count from postgres_reservation_holds`;
    expect(count?.count).toBe(1);
  });

  it("uses one read-only statement for obvious sold-out inventory", async () => {
    await stock.reserve(attempt("winner", 3));
    const queries: string[] = [];
    const instrumented = createDatabaseConnection(requireTestDatabaseUrl(), {
      max: 1,
      debug: (_connection, query) => {
        queries.push(query);
      },
    });
    connections.push(instrumented);
    await instrumented.sql`select 1`;
    queries.length = 0;
    const adapter = new PostgresStockReservations(instrumented.sql);
    expect(await adapter.reserve(attempt("turned-away"))).toEqual({
      outcome: "sold_out",
      reservation: null,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.trimStart()).toMatch(/^select /i);
    expect(await adapter.reserve(attempt("winner", 3))).toMatchObject({
      outcome: "reservation_pending_persistence",
    });
    await adapter.close({ runId, saleOfferId });
    expect(await adapter.reserve(attempt("winner", 3))).toEqual({
      outcome: "run_not_accepting_traffic",
      reservation: null,
    });
  });

  it("retains full pending holds, promotes replay, and never reverses accepted stock", async () => {
    const input = attempt("promote");
    await stock.reserve(input);
    await stock.markPendingPersistence(input);
    const [pending] =
      await connection.sql`select hold,pending_record from postgres_reservation_holds`;
    expect(pending?.hold).toEqual(input.reservation);
    expect(pending?.pending_record).toEqual({
      ...input.reservation,
      idempotencyKey: input.idempotencyKey,
      recoveryAttemptCount: 0,
      recoveryStatus: "pending",
      nextRecoveryAt: input.reservation.securedAt,
    });
    await stock.promoteAccepted(input);
    await stock.promoteAccepted(input);
    expect(await stock.reserve(attempt("promote"))).toEqual({
      outcome: "idempotent_replay",
      reservation: input.reservation,
    });
    await expect(stock.reverse(input)).rejects.toThrow("identity does not match");
    const [held] =
      await connection.sql`select pending_record,reversed_at from postgres_reservation_holds`;
    expect(held).toEqual({ pending_record: null, reversed_at: null });
  });

  it("compensates once and retains the secured observation independently of stock", async () => {
    const input = attempt("compensate");
    await stock.reserve(input);
    expect(await stock.reverse(input)).toBe("reversed");
    expect(await stock.reverse(input)).toBe("not_held");
    const [row] =
      await connection.sql`select remaining_stock,reserved_stock from postgres_run_inventory`;
    expect(row).toEqual({ remaining_stock: 3, reserved_stock: 0 });
    const [held] =
      await connection.sql`select hold,pending_record,reversed_at from postgres_reservation_holds`;
    expect(held?.hold).toEqual(input.reservation);
    expect(held?.pending_record).toBeNull();
    expect(held?.reversed_at).not.toBeNull();
    expect(await stock.reserve(attempt("compensate"))).toMatchObject({
      outcome: "reservation_secured",
    });
  });

  it("retains expired holds and reconstructs expired idempotency during promotion", async () => {
    const input = attempt("expired");
    input.idempotencyTtlSeconds = 1;
    input.reservation.securedAt = new Date(Date.now() - 2000).toISOString();
    input.reservation.expiresAt = new Date(Date.now() - 1000).toISOString();
    await stock.reserve(input);
    await connection.sql`select pg_sleep(1.1)`;
    await stock.promoteAccepted({ ...input, idempotencyTtlSeconds: 60 });
    expect(await stock.reserve(attempt("expired"))).toEqual({
      outcome: "idempotent_replay",
      reservation: input.reservation,
    });
    const [row] =
      await connection.sql`select remaining_stock,reserved_stock from postgres_run_inventory`;
    expect(row).toEqual({ remaining_stock: 2, reserved_stock: 1 });
  });
});

describe("PostgreSQL retained pending recovery", () => {
  it("filters backend, run, status and due eligibility before a bounded page and retains full metadata", async () => {
    const pending = new PostgresPendingPersistence(connection.sql);
    const exhausted = attempt("exhausted");
    const future = attempt("future");
    const eligible = attempt("eligible");
    const inputs = [exhausted, future, eligible];
    for (const input of inputs) await stock.reserve(input);
    const now = new Date();
    const deadline = new Date(now.getTime() + 60_000);
    expect(await pending.readPage({ runId, saleOfferId, limit: 1, dueAt: now })).toEqual({
      records: [],
      issues: [],
    });
    await connection.sql`update demo_runs set execution_mode='without_redis' where id=${runId}`;
    await pending.defer({
      saleOfferId,
      reservationId: exhausted.reservation.id,
      attemptCount: 2,
      status: "exhausted",
      nextRecoveryAt: now,
      recoveryDeadlineAt: deadline,
      lastError: "stopped",
    });
    await pending.defer({
      saleOfferId,
      reservationId: future.reservation.id,
      attemptCount: 1,
      status: "pending",
      nextRecoveryAt: deadline,
      recoveryDeadlineAt: deadline,
      lastError: "retry",
    });
    const page = await pending.readPage({ runId, saleOfferId, limit: 1, dueAt: now });
    expect(page.records).toEqual([
      {
        ...eligible.reservation,
        idempotencyKey: eligible.idempotencyKey,
        recoveryAttemptCount: 0,
        recoveryStatus: "pending",
        nextRecoveryAt: eligible.reservation.securedAt,
      },
    ]);
    await connection.sql`update demo_runs set status='completed' where id=${runId}`;
    expect((await pending.readPage({ runId, saleOfferId, limit: 1, dueAt: now })).records).toEqual(
      page.records,
    );
    expect(
      await pending.readPage({ runId: randomUUID(), saleOfferId, limit: 1, dueAt: now }),
    ).toEqual({ records: [], issues: [] });
    expect(
      (await pending.readRecord({ saleOfferId, reservationId: exhausted.reservation.id })).record,
    ).toEqual({
      ...exhausted.reservation,
      idempotencyKey: exhausted.idempotencyKey,
      recoveryAttemptCount: 2,
      recoveryStatus: "exhausted",
      nextRecoveryAt: now.toISOString(),
      recoveryDeadlineAt: deadline.toISOString(),
      lastRecoveryError: "stopped",
    });
    expect(
      await pending.defer({
        saleOfferId,
        reservationId: exhausted.reservation.id,
        attemptCount: 0,
        status: "pending",
        nextRecoveryAt: now,
        recoveryDeadlineAt: deadline,
        lastError: "older",
      }),
    ).toBe("exhausted");
    expect(
      await pending.defer({
        saleOfferId,
        reservationId: future.reservation.id,
        attemptCount: 0,
        status: "pending",
        nextRecoveryAt: now,
        recoveryDeadlineAt: deadline,
        lastError: "older",
      }),
    ).toBe("deferred");
    expect(
      (await pending.readRecord({ saleOfferId, reservationId: future.reservation.id })).record
        ?.lastRecoveryError,
    ).toBe("retry");
  });

  it("does not resurrect cleared promotion or compensation metadata", async () => {
    await connection.sql`update demo_runs set execution_mode='without_redis' where id=${runId}`;
    const pending = new PostgresPendingPersistence(connection.sql);
    for (const action of ["promote", "reverse"]) {
      const input = attempt(action);
      await stock.reserve(input);
      if (action === "promote") await stock.promoteAccepted(input);
      else await stock.reverse(input);
      expect(
        await pending.defer({
          saleOfferId,
          reservationId: input.reservation.id,
          attemptCount: 1,
          status: "pending",
          nextRecoveryAt: new Date(),
          recoveryDeadlineAt: new Date(Date.now() + 60_000),
          lastError: "late",
        }),
      ).toBe("removed");
      expect(
        (await pending.readRecord({ saleOfferId, reservationId: input.reservation.id })).record,
      ).toBeNull();
    }
  });
});

it("does not resurrect pending metadata when deferral waits for actual promotion", async () => {
  await connection.sql`update demo_runs set execution_mode='without_redis' where id=${runId}`;
  const input = attempt("promotion-wait");
  await stock.reserve(input);
  let holdCommit: (() => void) | undefined;
  const commitGate = new Promise<void>((resolve) => {
    holdCommit = resolve;
  });
  let updated: (() => void) | undefined;
  const promotionUpdated = new Promise<void>((resolve) => {
    updated = resolve;
  });
  const promotionSql = new Proxy(connection.sql, {
    get(target, property, receiver) {
      if (property === "begin")
        return (operation: (tx: postgres.TransactionSql) => Promise<unknown>) =>
          target.begin(async (tx) => {
            const result = await operation(tx);
            updated?.();
            await commitGate;
            return result;
          });
      return Reflect.get(target, property, receiver);
    },
  });
  const promotion = new PostgresStockReservations(promotionSql).promoteAccepted(input);
  const other = open();
  const pending = new PostgresPendingPersistence(other.sql);
  const [identity] = await other.sql`select pg_backend_pid() as pid`;
  let deferral: ReturnType<PostgresPendingPersistence["defer"]> | undefined;
  try {
    await promotionUpdated;
    deferral = pending.defer({
      saleOfferId,
      reservationId: input.reservation.id,
      attemptCount: 1,
      status: "pending",
      nextRecoveryAt: new Date(),
      recoveryDeadlineAt: new Date(Date.now() + 60_000),
      lastError: "late",
    });
    await waitForLock(identity?.pid);
    holdCommit?.();
    await promotion;
    expect(await deferral).toBe("removed");
    expect(
      (await pending.readRecord({ saleOfferId, reservationId: input.reservation.id })).record,
    ).toBeNull();
  } finally {
    holdCommit?.();
    await promotion;
    await deferral;
  }
});
