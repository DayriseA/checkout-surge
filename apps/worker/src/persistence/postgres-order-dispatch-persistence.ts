import type { OrderProcessJob } from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, orders } from "@checkout-surge/db";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { OrderDispatchPersistence } from "../application/order-dispatch-scanner.js";

export class PostgresOrderDispatchPersistence implements OrderDispatchPersistence {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async findQueuedOrdersForDispatch(input: {
    queuedBefore: Date;
    limit: number;
  }): Promise<OrderProcessJob[]> {
    const rows = await this.db
      .select({
        id: orders.id,
        publicOrderId: orders.publicOrderId,
        reservationId: orders.reservationId,
        saleOfferId: orders.saleOfferId,
        correlationId: orders.correlationId,
        runId: orders.runId,
        quantity: orders.quantity,
        queuedAt: orders.queuedAt,
      })
      .from(orders)
      .where(
        and(
          eq(orders.status, "queued"),
          lte(orders.queuedAt, input.queuedBefore),
          sql`(
            exists (
              select 1 from demo_runs eligible_run
              where eligible_run.id = ${orders.runId}
                and eligible_run.status in ('starting', 'active', 'draining')
            )
          )`,
          sql`not exists (
            select 1 from order_recovery_jobs control
            where control.order_id = ${orders.id}
          )`,
        ),
      )
      .orderBy(asc(orders.queuedAt), asc(orders.id))
      .limit(input.limit);

    return rows.map((order) => ({
      orderId: order.id,
      publicOrderId: order.publicOrderId,
      reservationId: order.reservationId,
      saleOfferId: order.saleOfferId,
      correlationId: order.correlationId,
      runId: order.runId,
      quantity: order.quantity,
      queuedAt: order.queuedAt.toISOString(),
      processingGeneration: 0,
    }));
  }
}
