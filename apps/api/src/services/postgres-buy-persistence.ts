import { randomUUID } from "node:crypto";
import type {
  OrderSummary,
  ReservationSummary,
  SecuredReservationHold,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  orderEvents,
  orders,
  reservationPendingPersistence,
  reservations,
} from "@checkout-surge/db";
import { eq } from "drizzle-orm";
import type { BuyPersistence, PersistedBuy } from "./reserve-order-service.js";

export class PostgresBuyPersistence implements BuyPersistence {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async persistSecuredReservation(input: {
    reservation: SecuredReservationHold;
  }): Promise<PersistedBuy> {
    const hold = input.reservation;
    return this.db.transaction(async (tx) => {
      const [reservation] = await tx
        .insert(reservations)
        .values({
          id: hold.id,
          saleOfferId: hold.saleOfferId,
          ...(hold.runId ? { runId: hold.runId } : {}),
          quantity: hold.quantity,
          correlationId: hold.correlationId,
          status: "secured",
          reservationToken: hold.reservationToken,
          securedAt: new Date(hold.securedAt),
          expiresAt: new Date(hold.expiresAt),
        })
        .returning({
          id: reservations.id,
          saleOfferId: reservations.saleOfferId,
          correlationId: reservations.correlationId,
          runId: reservations.runId,
          quantity: reservations.quantity,
          status: reservations.status,
          reservationToken: reservations.reservationToken,
          expiresAt: reservations.expiresAt,
          securedAt: reservations.securedAt,
        });

      if (!reservation) {
        throw new Error("Failed to persist reservation.");
      }

      const [order] = await tx
        .insert(orders)
        .values({
          publicOrderId: `ord_${randomUUID()}`,
          saleOfferId: hold.saleOfferId,
          reservationId: reservation.id,
          ...(hold.runId ? { runId: hold.runId } : {}),
          quantity: hold.quantity,
          correlationId: hold.correlationId,
          status: "queued",
          queuedAt: new Date(hold.securedAt),
        })
        .returning({
          id: orders.id,
          publicOrderId: orders.publicOrderId,
          saleOfferId: orders.saleOfferId,
          reservationId: orders.reservationId,
          correlationId: orders.correlationId,
          runId: orders.runId,
          quantity: orders.quantity,
          status: orders.status,
          failureCode: orders.failureCode,
          failureMessage: orders.failureMessage,
          queuedAt: orders.queuedAt,
          processingAt: orders.processingAt,
          confirmedAt: orders.confirmedAt,
          failedAt: orders.failedAt,
        });

      if (!order) {
        throw new Error("Failed to persist order.");
      }

      await tx.insert(orderEvents).values([
        {
          orderId: order.id,
          reservationId: reservation.id,
          saleOfferId: hold.saleOfferId,
          ...(hold.runId ? { runId: hold.runId } : {}),
          correlationId: hold.correlationId,
          eventName: "reservation.secured",
          payload: {
            quantity: hold.quantity,
            reservationStatus: "secured",
          },
          source: "api",
          occurredAt: new Date(hold.securedAt),
        },
        {
          orderId: order.id,
          reservationId: reservation.id,
          saleOfferId: hold.saleOfferId,
          ...(hold.runId ? { runId: hold.runId } : {}),
          correlationId: hold.correlationId,
          eventName: "order.queued",
          payload: {
            quantity: hold.quantity,
            orderStatus: "queued",
          },
          source: "api",
          occurredAt: new Date(hold.securedAt),
        },
      ]);

      await tx
        .update(reservationPendingPersistence)
        .set({
          status: "reconciled",
          updatedAt: new Date(),
        })
        .where(eq(reservationPendingPersistence.reservationId, reservation.id));

      return {
        reservation: toReservationSummary(reservation),
        order: toOrderSummary(order),
      };
    });
  }

  async getPersistedBuyByReservationId(reservationId: string): Promise<PersistedBuy | null> {
    const [row] = await this.db
      .select({ reservation: reservations, order: orders })
      .from(reservations)
      .innerJoin(orders, eq(orders.reservationId, reservations.id))
      .where(eq(reservations.id, reservationId))
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      reservation: toReservationSummary(row.reservation),
      order: toOrderSummary(row.order),
    };
  }

  async recordPendingPersistence(input: {
    reservation: SecuredReservationHold;
    idempotencyKey: string;
  }): Promise<void> {
    const hold = input.reservation;
    const now = new Date();

    await this.db
      .insert(reservationPendingPersistence)
      .values({
        reservationId: hold.id,
        saleOfferId: hold.saleOfferId,
        correlationId: hold.correlationId,
        ...(hold.runId ? { runId: hold.runId } : {}),
        idempotencyKey: input.idempotencyKey,
        quantity: hold.quantity,
        reservationToken: hold.reservationToken,
        status: "pending_reconciliation",
        securedAt: new Date(hold.securedAt),
        expiresAt: new Date(hold.expiresAt),
      })
      .onConflictDoUpdate({
        target: reservationPendingPersistence.reservationId,
        set: {
          saleOfferId: hold.saleOfferId,
          correlationId: hold.correlationId,
          runId: hold.runId ?? null,
          idempotencyKey: input.idempotencyKey,
          quantity: hold.quantity,
          reservationToken: hold.reservationToken,
          status: "pending_reconciliation",
          securedAt: new Date(hold.securedAt),
          expiresAt: new Date(hold.expiresAt),
          updatedAt: now,
        },
      });
  }
}

function toReservationSummary(row: {
  id: string;
  saleOfferId: string;
  correlationId: string;
  runId: string | null;
  quantity: number;
  status: ReservationSummary["status"];
  reservationToken: string;
  expiresAt: Date;
  securedAt: Date;
}): ReservationSummary {
  return {
    id: row.id,
    saleOfferId: row.saleOfferId,
    correlationId: row.correlationId,
    ...(row.runId ? { runId: row.runId } : {}),
    quantity: row.quantity,
    status: row.status,
    reservationToken: row.reservationToken,
    expiresAt: row.expiresAt.toISOString(),
    securedAt: row.securedAt.toISOString(),
  };
}

function toOrderSummary(row: {
  id: string;
  publicOrderId: string;
  saleOfferId: string;
  reservationId: string;
  correlationId: string;
  runId: string | null;
  quantity: number;
  status: OrderSummary["status"];
  failureCode: string | null;
  failureMessage: string | null;
  queuedAt: Date;
  processingAt: Date | null;
  confirmedAt: Date | null;
  failedAt: Date | null;
}): OrderSummary {
  return {
    id: row.id,
    publicOrderId: row.publicOrderId,
    saleOfferId: row.saleOfferId,
    reservationId: row.reservationId,
    correlationId: row.correlationId,
    ...(row.runId ? { runId: row.runId } : {}),
    quantity: row.quantity,
    status: row.status,
    ...(row.failureCode ? { failureCode: row.failureCode } : {}),
    ...(row.failureMessage ? { failureMessage: row.failureMessage } : {}),
    queuedAt: row.queuedAt.toISOString(),
    ...(row.processingAt ? { processingAt: row.processingAt.toISOString() } : {}),
    ...(row.confirmedAt ? { confirmedAt: row.confirmedAt.toISOString() } : {}),
    ...(row.failedAt ? { failedAt: row.failedAt.toISOString() } : {}),
  };
}
