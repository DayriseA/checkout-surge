import type { SecuredReservationHold } from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  demoRuns,
  postgresOrderQueue,
  postgresOrderQueueChannel,
  postgresRunStock,
  reservations,
} from "@checkout-surge/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { insertSecuredReservationRows } from "./postgres-buy-persistence.js";
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

/**
 * The stock decision when PostgreSQL holds the stock, with the protections of the Redis path:
 * the run fence, idempotency, and the durable record (with its queue job) before "yes".
 * A buyer turned away costs one read-only statement: no write and no lock.
 */
export class PostgresStockPersistence {
  constructor(
    private readonly db: CheckoutSurgeDatabase,
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
    // The same order of checks as the Redis script: stock, run, idempotency, then units.
    const [decision] = await this.db
      .select({
        remainingStock: postgresRunStock.remainingStock,
        runStatus: demoRuns.status,
        replayId: reservations.id,
        replayQuantity: reservations.quantity,
      })
      .from(demoRuns)
      .leftJoin(
        postgresRunStock,
        and(
          eq(postgresRunStock.runId, demoRuns.id),
          eq(postgresRunStock.saleOfferId, hold.saleOfferId),
        ),
      )
      .leftJoin(
        reservations,
        and(
          eq(reservations.saleOfferId, hold.saleOfferId),
          eq(reservations.idempotencyKey, idempotencyKey),
        ),
      )
      .where(eq(demoRuns.id, hold.runId))
      .limit(1);
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

  private async reserveUnits(
    hold: SecuredReservationHold,
    idempotencyKey: string,
  ): Promise<PostgresStockOutcome> {
    try {
      return await this.db.transaction(async (tx) => {
        // Shared with every other buyer, exclusive with the run's terminal transition.
        await tx.execute(
          sql`select pg_advisory_xact_lock_shared(hashtext(${terminalDemoRunTransitionLockKey(hold.runId)}))`,
        );
        const [run] = await tx
          .select({ status: demoRuns.status })
          .from(demoRuns)
          .where(eq(demoRuns.id, hold.runId));
        if (!run || !acceptingRunStatuses.has(run.status)) {
          return { outcome: "run_not_accepting_traffic" } as const;
        }
        const persisted = await insertSecuredReservationRows(tx, hold, idempotencyKey);
        await tx.insert(postgresOrderQueue).values({ orderId: persisted.order.id });
        // The stock row is locked last, so a concurrent buyer waits for it only until this commit.
        const decremented = await tx
          .update(postgresRunStock)
          .set({
            remainingStock: sql`${postgresRunStock.remainingStock} - ${hold.quantity}`,
            reservedStock: sql`${postgresRunStock.reservedStock} + ${hold.quantity}`,
          })
          .where(
            and(
              eq(postgresRunStock.runId, hold.runId),
              gte(postgresRunStock.remainingStock, hold.quantity),
            ),
          )
          .returning({ runId: postgresRunStock.runId });
        if (decremented.length === 0) throw new StockTakenError();
        await tx.execute(sql`select pg_notify(${postgresOrderQueueChannel}, '')`);
        return { outcome: "reservation_secured", persisted, fresh: true } as const;
      });
    } catch (error) {
      // Another buyer took the last units first; this transaction rolled back whole.
      if (error instanceof StockTakenError) return { outcome: "sold_out" };
      throw error;
    }
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
