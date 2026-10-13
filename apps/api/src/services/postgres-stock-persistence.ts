import type { SecuredReservationHold } from "@checkout-surge/contracts";
import {
  createDatabase,
  demoRuns,
  postgresOrderQueue,
  postgresOrderQueueChannel,
  postgresRunStock,
  type SqlClient,
} from "@checkout-surge/db";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  insertSecuredReservationRows,
  type PostgresTransaction,
} from "./postgres-buy-persistence.js";
import type { BuyPersistenceOperations, PersistedBuyAcceptance } from "./reserve-order-service.js";
import { terminalDemoRunTransitionLockKey } from "./terminal-demo-run-transition.js";

/** Before its traffic completes, a run sells; draining, reset and failed runs do not. */
const acceptingRunStatuses = new Set(["starting", "active"]);
const idempotencyKeyConstraint = "reservations_sale_offer_id_idempotency_key_unique";

export type PostgresStockOutcome =
  | { outcome: "reservation_secured"; persisted: PersistedBuyAcceptance; fresh: boolean }
  | {
      outcome:
        | "sold_out"
        | "run_not_accepting_traffic"
        | "inventory_not_initialized"
        | "idempotency_conflict";
    };

class StockTakenError extends Error {}

interface DecisionRow {
  remainingStock: number | null;
  runStatus: string;
  replayId: string | null;
  replayQuantity: number | null;
}

/**
 * The stock decision when PostgreSQL holds the stock, with the protections of the Redis path:
 * the run fence, idempotency, and the durable record (with its queue job) before "yes".
 * Once the stock is gone, a buyer turned away costs one read-only statement. The few buyers who
 * read the last units before the winner committed run the winner's transaction, wait on the
 * stock row and roll back: bounded, and inherent to a read-then-conditional-update.
 */
export class PostgresStockPersistence {
  constructor(
    private readonly sql: SqlClient,
    private readonly persistedBuys: Pick<
      BuyPersistenceOperations,
      "getPersistedBuyByReservationId"
    >,
  ) {}

  async reserve(input: {
    hold: SecuredReservationHold;
    idempotencyKey: string;
  }): Promise<PostgresStockOutcome> {
    try {
      return await this.attempt(input);
    } catch (error) {
      // A concurrent request with the same key committed first: this one is its replay.
      if (!isUniqueViolation(error, idempotencyKeyConstraint)) throw error;
      return this.attempt(input);
    }
  }

  private async attempt({
    hold,
    idempotencyKey,
  }: {
    hold: SecuredReservationHold;
    idempotencyKey: string;
  }): Promise<PostgresStockOutcome> {
    // The same order of checks as the Redis script: stock, run, idempotency, then units. A
    // prepared statement on each connection, like the script Redis caches: parsed and planned once.
    const [decision] = await this.sql<DecisionRow[]>`
      select s.remaining_stock as "remainingStock", r.status as "runStatus",
        res.id as "replayId", res.quantity as "replayQuantity"
      from demo_runs r
      left join postgres_run_stock s on s.run_id = r.id and s.sale_offer_id = ${hold.saleOfferId}
      left join reservations res
        on res.sale_offer_id = ${hold.saleOfferId} and res.idempotency_key = ${idempotencyKey}
      where r.id = ${hold.runId}`;
    if (!decision || decision.remainingStock === null) {
      return { outcome: "inventory_not_initialized" };
    }
    if (!acceptingRunStatuses.has(decision.runStatus)) {
      return { outcome: "run_not_accepting_traffic" };
    }
    if (decision.replayId !== null) {
      if (decision.replayQuantity !== hold.quantity) return { outcome: "idempotency_conflict" };
      const persisted = await this.persistedBuys.getPersistedBuyByReservationId(decision.replayId);
      if (!persisted) throw new Error("A reservation with this idempotency key has no order.");
      return { outcome: "reservation_secured", persisted, fresh: false };
    }
    if (decision.remainingStock < hold.quantity) return { outcome: "sold_out" };
    return this.reserveUnits(hold, idempotencyKey);
  }

  /**
   * The winner's transaction runs on a reserved connection, as the Redis mode's persistence does:
   * postgres.js reserves a pooled connection for `sql.begin` only when its pipeline has room, and
   * the decision reads fill the pipelines, so a transaction could start unreserved and fail.
   */
  private async reserveUnits(
    hold: SecuredReservationHold,
    idempotencyKey: string,
  ): Promise<PostgresStockOutcome> {
    const client = await this.sql.reserve();
    // Drizzle reads the parser and serializer maps from the pool's options (see PostgresBuyPersistence).
    Object.defineProperty(client, "options", { value: this.sql.options });
    const tx = createDatabase(client as SqlClient) as unknown as PostgresTransaction;
    try {
      await client`begin`;
      try {
        const outcome = await this.reserveUnitsIn(tx, hold, idempotencyKey);
        await client`commit`;
        return outcome;
      } catch (error) {
        await client`rollback`;
        // Another buyer took the last units first; this transaction rolled back whole.
        if (error instanceof StockTakenError) return { outcome: "sold_out" };
        throw error;
      }
    } finally {
      client.release();
    }
  }

  private async reserveUnitsIn(
    tx: PostgresTransaction,
    hold: SecuredReservationHold,
    idempotencyKey: string,
  ): Promise<PostgresStockOutcome> {
    // Shared with every other buyer, exclusive with the run's terminal transition.
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtext(${terminalDemoRunTransitionLockKey(hold.runId)}))`,
    );
    const [run] = await tx
      .select({ status: demoRuns.status })
      .from(demoRuns)
      .where(eq(demoRuns.id, hold.runId));
    if (!run || !acceptingRunStatuses.has(run.status)) {
      return { outcome: "run_not_accepting_traffic" };
    }
    const persisted = await insertSecuredReservationRows(tx, hold, idempotencyKey);
    await tx.insert(postgresOrderQueue).values({ orderId: persisted.order.id });
    // Delivered at commit, like the rest of the transaction.
    await tx.execute(sql`select pg_notify(${postgresOrderQueueChannel}, '')`);
    // The stock row is locked last: the next buyer waits for it only until this commit.
    const decremented = await tx
      .update(postgresRunStock)
      .set({ remainingStock: sql`${postgresRunStock.remainingStock} - ${hold.quantity}` })
      .where(
        and(
          eq(postgresRunStock.runId, hold.runId),
          gte(postgresRunStock.remainingStock, hold.quantity),
        ),
      )
      .returning({ runId: postgresRunStock.runId });
    if (decremented.length === 0) throw new StockTakenError();
    return { outcome: "reservation_secured", persisted, fresh: true };
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  let candidate = error;
  for (let depth = 0; depth < 5 && typeof candidate === "object" && candidate !== null; depth++) {
    const postgresError = candidate as {
      code?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (postgresError.code === "23505" && postgresError.constraint_name === constraint) return true;
    candidate = postgresError.cause;
  }
  return false;
}
