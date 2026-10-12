import type { OrderProcessJob } from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, orders, postgresOrderQueue } from "@checkout-surge/db";
import { asc, eq, gt, isNull, lte, min, or, sql } from "drizzle-orm";

/** A claimed job, or, when none is claimable, when the earliest lease expires (null: no job). */
export type OrderQueueClaim = { job: OrderProcessJob } | { nextAt: Date | null };

/** The PostgreSQL order queue's rows: claimed under a lease, deleted once delivered. */
export class PostgresOrderQueuePersistence {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  /**
   * Claims the oldest unleased job. Concurrent claims skip each other's rows, and the lease lets a
   * job whose delivery never settled (a stopped worker, a failed handoff) be delivered again.
   */
  async claim(leaseMs: number): Promise<OrderQueueClaim> {
    return this.db.transaction(async (tx) => {
      const [next] = await tx
        .select({
          orderId: orders.id,
          publicOrderId: orders.publicOrderId,
          reservationId: orders.reservationId,
          saleOfferId: orders.saleOfferId,
          correlationId: orders.correlationId,
          runId: orders.runId,
          quantity: orders.quantity,
          queuedAt: orders.queuedAt,
        })
        .from(postgresOrderQueue)
        .innerJoin(orders, eq(orders.id, postgresOrderQueue.orderId))
        .where(
          or(
            isNull(postgresOrderQueue.lockedUntil),
            lte(postgresOrderQueue.lockedUntil, sql`now()`),
          ),
        )
        .orderBy(asc(postgresOrderQueue.queuedAt))
        .limit(1)
        .for("update", { of: postgresOrderQueue, skipLocked: true });
      if (!next) {
        const [lease] = await tx
          .select({ nextAt: min(postgresOrderQueue.lockedUntil) })
          .from(postgresOrderQueue)
          .where(gt(postgresOrderQueue.lockedUntil, sql`now()`));
        return { nextAt: lease?.nextAt ?? null };
      }
      await tx
        .update(postgresOrderQueue)
        .set({ lockedUntil: sql`now() + ${leaseMs} * interval '1 millisecond'` })
        .where(eq(postgresOrderQueue.orderId, next.orderId));
      return {
        job: {
          ...next,
          queuedAt: next.queuedAt.toISOString(),
          processingGeneration: 0,
        },
      };
    });
  }

  async settle(orderId: string): Promise<void> {
    await this.db.delete(postgresOrderQueue).where(eq(postgresOrderQueue.orderId, orderId));
  }
}
