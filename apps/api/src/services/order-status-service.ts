import { type OrderStatusResponse, orderStatusResponseSchema } from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, orderEvents, orders, reservations } from "@checkout-surge/db";
import { asc, eq, sql } from "drizzle-orm";

export interface OrderStatusController {
  getStatus(input: {
    publicOrderId: string;
    correlationId: string;
  }): Promise<OrderStatusResponse | null>;
}

export class OrderStatusService implements OrderStatusController {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async getStatus(input: {
    publicOrderId: string;
    correlationId: string;
  }): Promise<OrderStatusResponse | null> {
    const [readModel] = await this.db
      .select({ order: orders, reservation: reservations })
      .from(orders)
      .innerJoin(reservations, eq(orders.reservationId, reservations.id))
      .where(eq(orders.publicOrderId, input.publicOrderId))
      .limit(1);

    if (!readModel) {
      return null;
    }

    const events = await this.db
      .select({
        id: orderEvents.id,
        eventName: orderEvents.eventName,
        occurredAt: orderEvents.occurredAt,
        createdAt: orderEvents.createdAt,
      })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, readModel.order.id))
      .orderBy(
        asc(orderEvents.occurredAt),
        sql`CASE ${orderEvents.eventName}
          WHEN 'reservation.secured' THEN 0
          WHEN 'order.queued' THEN 1
          ELSE 2
        END`,
        asc(orderEvents.createdAt),
        asc(orderEvents.id),
      );

    const consistencyLagMs =
      readModel.order.status === "confirmed"
        ? requireConfirmedAt(readModel.order.confirmedAt).getTime() -
          readModel.order.queuedAt.getTime()
        : null;

    return orderStatusResponseSchema.parse({
      correlationId: input.correlationId,
      publicOrderId: readModel.order.publicOrderId,
      saleOfferId: readModel.order.saleOfferId,
      reservation: {
        id: readModel.reservation.id,
        status: readModel.reservation.status,
        expiresAt: readModel.reservation.expiresAt.toISOString(),
      },
      order: {
        status: readModel.order.status,
        queuedAt: readModel.order.queuedAt.toISOString(),
        processingAt: readModel.order.processingAt?.toISOString() ?? null,
        confirmedAt: readModel.order.confirmedAt?.toISOString() ?? null,
        failedAt: readModel.order.failedAt?.toISOString() ?? null,
        failureCode: readModel.order.failureCode,
        failureMessage: readModel.order.failureMessage,
      },
      customerStatus:
        readModel.order.status === "queued" ? "reservation_secured" : readModel.order.status,
      consistencyLagMs,
      timeline: events.map((event) => ({
        eventName: event.eventName,
        label: timelineLabel(event.eventName),
        occurredAt: event.occurredAt.toISOString(),
      })),
    });
  }
}

function requireConfirmedAt(confirmedAt: Date | null): Date {
  if (!confirmedAt) {
    throw new Error("A confirmed order is missing confirmedAt.");
  }

  return confirmedAt;
}

function timelineLabel(eventName: string): string {
  switch (eventName) {
    case "reservation.secured":
      return "Reservation secured";
    case "order.queued":
      return "Order queued";
    default:
      return eventName;
  }
}
