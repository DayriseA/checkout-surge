import { randomUUID } from "node:crypto";
import type { OrderSummary, ReservationSummary } from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  demoRunSaleContexts,
  demoRuns,
  orderEvents,
  orders,
  reservations,
  saleOffers,
} from "@checkout-surge/db";
import { and, eq } from "drizzle-orm";
import type {
  BuyPersistence,
  PersistedBuy,
  SaleOfferEligibility,
} from "./reserve-order-service.js";

export class PostgresBuyPersistence implements BuyPersistence {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async getSaleOfferEligibility(input: {
    saleOfferId: string;
    runId?: string;
    now: Date;
  }): Promise<SaleOfferEligibility> {
    const [offer] = await this.db
      .select({
        id: saleOffers.id,
        isActive: saleOffers.isActive,
        saleStartsAt: saleOffers.saleStartsAt,
        saleEndsAt: saleOffers.saleEndsAt,
        purpose: saleOffers.purpose,
      })
      .from(saleOffers)
      .where(eq(saleOffers.id, input.saleOfferId))
      .limit(1);

    if (!offer) {
      return {
        saleOfferId: input.saleOfferId,
        isAccepting: false,
        rejectReason: "inventory_not_initialized",
      };
    }

    if (!offer.isActive || input.now < offer.saleStartsAt || input.now >= offer.saleEndsAt) {
      return {
        saleOfferId: input.saleOfferId,
        isAccepting: false,
        rejectReason: "run_not_accepting_traffic",
      };
    }

    if (offer.purpose === "catalog") {
      return {
        saleOfferId: input.saleOfferId,
        isAccepting: !input.runId,
        ...(input.runId ? { rejectReason: "run_not_accepting_traffic" } : {}),
      };
    }

    if (!input.runId) {
      return {
        saleOfferId: input.saleOfferId,
        isAccepting: false,
        rejectReason: "run_not_accepting_traffic",
      };
    }

    const [runContext] = await this.db
      .select({
        runId: demoRunSaleContexts.runId,
        runStatus: demoRuns.status,
      })
      .from(demoRunSaleContexts)
      .innerJoin(demoRuns, eq(demoRuns.id, demoRunSaleContexts.runId))
      .where(
        and(
          eq(demoRunSaleContexts.saleOfferId, input.saleOfferId),
          eq(demoRunSaleContexts.runId, input.runId),
        ),
      )
      .limit(1);

    return {
      saleOfferId: input.saleOfferId,
      isAccepting: runContext?.runStatus === "starting" || runContext?.runStatus === "active",
      ...(runContext?.runStatus === "starting" || runContext?.runStatus === "active"
        ? {}
        : { rejectReason: "run_not_accepting_traffic" }),
    };
  }

  async persistSecuredReservation(input: {
    saleOfferId: string;
    runId?: string;
    quantity: number;
    correlationId: string;
    securedAt: Date;
    expiresAt: Date;
  }): Promise<PersistedBuy> {
    return this.db.transaction(async (tx) => {
      const [reservation] = await tx
        .insert(reservations)
        .values({
          saleOfferId: input.saleOfferId,
          ...(input.runId ? { runId: input.runId } : {}),
          quantity: input.quantity,
          correlationId: input.correlationId,
          status: "secured",
          reservationToken: `res_${randomUUID()}`,
          securedAt: input.securedAt,
          expiresAt: input.expiresAt,
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
          saleOfferId: input.saleOfferId,
          reservationId: reservation.id,
          ...(input.runId ? { runId: input.runId } : {}),
          quantity: input.quantity,
          correlationId: input.correlationId,
          status: "queued",
          queuedAt: input.securedAt,
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
          saleOfferId: input.saleOfferId,
          ...(input.runId ? { runId: input.runId } : {}),
          correlationId: input.correlationId,
          eventName: "reservation.secured",
          payload: {
            quantity: input.quantity,
            reservationStatus: "secured",
          },
          source: "api",
          occurredAt: input.securedAt,
        },
        {
          orderId: order.id,
          reservationId: reservation.id,
          saleOfferId: input.saleOfferId,
          ...(input.runId ? { runId: input.runId } : {}),
          correlationId: input.correlationId,
          eventName: "order.queued",
          payload: {
            quantity: input.quantity,
            orderStatus: "queued",
          },
          source: "api",
          occurredAt: input.securedAt,
        },
      ]);

      return {
        reservation: toReservationSummary(reservation),
        order: toOrderSummary(order),
      };
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
