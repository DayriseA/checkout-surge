import type { OrderProcessJob } from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, orders, postgresOrderQueue } from "@checkout-surge/db";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";

export interface QueuedOrderDelivery {
  job: OrderProcessJob;
  /** How many times the job has been delivered, this delivery included. */
  deliveries: number;
}

/** The PostgreSQL order queue's rows: claimed under a lease, deleted once delivered. */
export class PostgresOrderQueuePersistence {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  /**
   * Claims the oldest available job. Concurrent claims skip each other's rows, and the lease lets
   * a job claimed by a worker that stopped be delivered again.
   */
  async claim(leaseMs: number): Promise<QueuedOrderDelivery | null> {
    return this.db.transaction(async (tx) => {
      const [next] = await tx
        .select({
          deliveries: postgresOrderQueue.deliveries,
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
          and(
            lte(postgresOrderQueue.availableAt, sql`now()`),
            or(
              isNull(postgresOrderQueue.lockedUntil),
              lte(postgresOrderQueue.lockedUntil, sql`now()`),
            ),
          ),
        )
        .orderBy(asc(postgresOrderQueue.availableAt))
        .limit(1)
        .for("update", { of: postgresOrderQueue, skipLocked: true });
      if (!next) return null;
      const deliveries = next.deliveries + 1;
      await tx
        .update(postgresOrderQueue)
        .set({ deliveries, lockedUntil: sql`now() + ${leaseMs} * interval '1 millisecond'` })
        .where(eq(postgresOrderQueue.orderId, next.orderId));
      return {
        deliveries,
        job: {
          orderId: next.orderId,
          publicOrderId: next.publicOrderId,
          reservationId: next.reservationId,
          saleOfferId: next.saleOfferId,
          correlationId: next.correlationId,
          runId: next.runId,
          quantity: next.quantity,
          queuedAt: next.queuedAt.toISOString(),
          processingGeneration: 0,
        },
      };
    });
  }

  async settle(orderId: string): Promise<void> {
    await this.db.delete(postgresOrderQueue).where(eq(postgresOrderQueue.orderId, orderId));
  }

  async retryLater(orderId: string, delayMs: number): Promise<void> {
    await this.db
      .update(postgresOrderQueue)
      .set({
        lockedUntil: null,
        availableAt: sql`now() + ${delayMs} * interval '1 millisecond'`,
      })
      .where(eq(postgresOrderQueue.orderId, orderId));
  }
}
