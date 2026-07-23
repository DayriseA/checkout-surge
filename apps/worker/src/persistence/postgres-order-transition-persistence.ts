import type { OrderProcessJob } from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type OrderStatus,
  orderEvents,
  orders,
} from "@checkout-surge/db";
import { eq } from "drizzle-orm";
import type {
  ConfirmedTransitionResult,
  FailedTransitionResult,
  OrderFailure,
  OrderProcessDeliveryMetadata,
  OrderTransitionPersistence,
  ProcessingTransitionResult,
} from "../application/order-process-job-handler.js";

type DurableOrder = typeof orders.$inferSelect;
type Transaction = Parameters<Parameters<CheckoutSurgeDatabase["transaction"]>[0]>[0];

export class OrderNotFoundError extends Error {
  override readonly name = "OrderNotFoundError";

  constructor(readonly orderId: string) {
    super(`Order ${orderId} was not found for the delivered order-processing job.`);
  }
}

export class OrderJobIdentityMismatchError extends Error {
  override readonly name = "OrderJobIdentityMismatchError";

  constructor(
    readonly orderId: string,
    readonly mismatchedFields: readonly string[],
  ) {
    super(
      `Order-processing job identity does not match durable order ${orderId}: ${mismatchedFields.join(", ")}.`,
    );
  }
}

export class InvalidOrderTransitionError extends Error {
  override readonly name = "InvalidOrderTransitionError";

  constructor(orderId: string, from: OrderStatus, to: OrderStatus) {
    super(`Order ${orderId} cannot transition from ${from} to ${to}.`);
  }
}

export class PostgresOrderTransitionPersistence implements OrderTransitionPersistence {
  constructor(
    private readonly db: CheckoutSurgeDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  transitionToProcessing(
    job: OrderProcessJob,
    delivery: OrderProcessDeliveryMetadata,
  ): Promise<ProcessingTransitionResult> {
    return this.db.transaction(async (tx) => {
      const order = await lockAndValidateOrder(tx, job);

      if (order.status === "confirmed" || order.status === "failed") {
        return { changed: false, status: order.status };
      }

      if (order.status === "processing") {
        return { changed: false, status: "processing" };
      }

      const occurredAt = this.now();
      await tx
        .update(orders)
        .set({ status: "processing", processingAt: occurredAt, updatedAt: occurredAt })
        .where(eq(orders.id, order.id));
      await appendTransitionEvent(tx, order, "order.processing", occurredAt, delivery);

      return {
        changed: true,
        status: "processing",
      };
    });
  }

  transitionToConfirmed(
    job: OrderProcessJob,
    delivery: OrderProcessDeliveryMetadata,
  ): Promise<ConfirmedTransitionResult> {
    return this.db.transaction(async (tx) => {
      const order = await lockAndValidateOrder(tx, job);

      if (order.status === "confirmed") {
        return { changed: false, status: "confirmed" };
      }
      if (order.status !== "processing") {
        throw new InvalidOrderTransitionError(order.id, order.status, "confirmed");
      }

      const occurredAt = this.now();
      await tx
        .update(orders)
        .set({ status: "confirmed", confirmedAt: occurredAt, updatedAt: occurredAt })
        .where(eq(orders.id, order.id));
      await appendTransitionEvent(tx, order, "order.confirmed", occurredAt, delivery);
      return {
        changed: true,
        status: "confirmed",
        confirmedAt: occurredAt,
      };
    });
  }

  transitionToFailed(
    job: OrderProcessJob,
    failure: OrderFailure,
    delivery: OrderProcessDeliveryMetadata,
  ): Promise<FailedTransitionResult> {
    return this.db.transaction(async (tx) => {
      const order = await lockAndValidateOrder(tx, job);

      if (order.status === "failed") {
        return { changed: false, status: "failed" };
      }
      if (order.status !== "processing") {
        throw new InvalidOrderTransitionError(order.id, order.status, "failed");
      }

      const occurredAt = this.now();
      await tx
        .update(orders)
        .set({
          status: "failed",
          failureCode: failure.code,
          failureMessage: failure.message,
          failedAt: occurredAt,
          updatedAt: occurredAt,
        })
        .where(eq(orders.id, order.id));
      await appendTransitionEvent(tx, order, "order.failed", occurredAt, delivery, failure);
      return {
        changed: true,
        status: "failed",
      };
    });
  }
}

async function lockAndValidateOrder(tx: Transaction, job: OrderProcessJob): Promise<DurableOrder> {
  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, job.orderId))
    .limit(1)
    .for("update");

  if (!order) {
    throw new OrderNotFoundError(job.orderId);
  }

  const mismatchedFields = findMismatchedIdentityFields(order, job);
  if (mismatchedFields.length > 0) {
    throw new OrderJobIdentityMismatchError(order.id, mismatchedFields);
  }

  return order;
}

function findMismatchedIdentityFields(order: DurableOrder, job: OrderProcessJob): string[] {
  const mismatches: string[] = [];
  const compare = (field: string, durable: unknown, delivered: unknown) => {
    if (durable !== delivered) {
      mismatches.push(field);
    }
  };

  compare("publicOrderId", order.publicOrderId, job.publicOrderId);
  compare("reservationId", order.reservationId, job.reservationId);
  compare("saleOfferId", order.saleOfferId, job.saleOfferId);
  compare("correlationId", order.correlationId, job.correlationId);
  compare("runId", order.runId ?? undefined, job.runId);
  compare("quantity", order.quantity, job.quantity);
  compare("queuedAt", order.queuedAt.toISOString(), new Date(job.queuedAt).toISOString());
  return mismatches;
}

async function appendTransitionEvent(
  tx: Transaction,
  order: DurableOrder,
  eventName: "order.processing" | "order.confirmed" | "order.failed",
  occurredAt: Date,
  delivery: OrderProcessDeliveryMetadata,
  failure?: OrderFailure,
): Promise<void> {
  const [inserted] = await tx
    .insert(orderEvents)
    .values({
      orderId: order.id,
      reservationId: order.reservationId,
      saleOfferId: order.saleOfferId,
      ...(order.runId ? { runId: order.runId } : {}),
      correlationId: order.correlationId,
      eventName,
      payload: {
        attemptNumber: delivery.attemptNumber,
        attemptsMade: delivery.attemptsMade,
        ...(failure ? { failureCode: failure.code, failureMessage: failure.message } : {}),
      },
      source: "worker",
      occurredAt,
    })
    .returning({ id: orderEvents.id });
  if (!inserted) throw new Error("Order transition event insert returned no durable identity.");
}
