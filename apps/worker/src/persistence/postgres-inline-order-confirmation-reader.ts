import {
  type InlineConfirmationRequest,
  inlineConfirmationResultSchema,
  type OrderProcessJob,
} from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, demoRuns, orders, reservations } from "@checkout-surge/db";
import { eq } from "drizzle-orm";
import type {
  InlineOrderReader,
  InlineOrderSnapshot,
} from "../application/inline-order-confirmation.js";
import { OrderJobIdentityMismatchError } from "./postgres-order-transition-persistence.js";

export class PostgresInlineOrderConfirmationReader implements InlineOrderReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async read(request: InlineConfirmationRequest): Promise<InlineOrderSnapshot | null> {
    const [row] = await this.db
      .select({
        order: orders,
        reservation: reservations,
        mode: demoRuns.executionMode,
        runStatus: demoRuns.status,
      })
      .from(orders)
      .innerJoin(reservations, eq(reservations.id, orders.reservationId))
      .innerJoin(demoRuns, eq(demoRuns.id, orders.runId))
      .where(eq(orders.id, request.orderId))
      .limit(1);
    if (!row) return null;
    const { order, reservation } = row;
    const mismatches = (["reservationId", "saleOfferId", "runId"] as const).filter(
      (key) => order[key] !== request[key],
    );
    if (
      reservation.runId !== order.runId ||
      reservation.saleOfferId !== order.saleOfferId ||
      reservation.quantity !== order.quantity
    )
      mismatches.push("reservationId");
    if (mismatches.length) throw new OrderJobIdentityMismatchError(order.id, mismatches);
    if (row.mode !== "without_order_queue")
      throw new Error("Inline confirmation requires without_order_queue run mode.");
    const job: OrderProcessJob = {
      orderId: order.id,
      publicOrderId: order.publicOrderId,
      reservationId: order.reservationId,
      saleOfferId: order.saleOfferId,
      runId: order.runId,
      correlationId: order.correlationId,
      quantity: order.quantity,
      queuedAt: order.queuedAt.toISOString(),
      processingGeneration: 0,
    };
    const summary = {
      id: order.id,
      publicOrderId: order.publicOrderId,
      reservationId: order.reservationId,
      saleOfferId: order.saleOfferId,
      runId: order.runId,
      correlationId: order.correlationId,
      quantity: order.quantity,
      queuedAt: order.queuedAt.toISOString(),
      status: order.status,
      ...(order.processingAt ? { processingAt: order.processingAt.toISOString() } : {}),
      ...(order.confirmedAt ? { confirmedAt: order.confirmedAt.toISOString() } : {}),
      ...(order.failedAt ? { failedAt: order.failedAt.toISOString() } : {}),
      ...(order.failureCode ? { failureCode: order.failureCode } : {}),
      ...(order.failureMessage ? { failureMessage: order.failureMessage } : {}),
    };
    const outcome =
      order.status === "confirmed"
        ? "order_confirmed"
        : order.status === "failed"
          ? "order_confirmation_failed"
          : "order_confirmation_pending";
    return {
      job,
      securedAt: reservation.securedAt,
      runActive: ["starting", "active", "draining"].includes(row.runStatus),
      result: inlineConfirmationResultSchema.parse({ outcome, order: summary }),
    };
  }
}
