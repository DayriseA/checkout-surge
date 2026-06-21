import type {
  BuyRequest,
  OrderSummary,
  ReservationSummary,
  SecuredReservationHold,
} from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type BuyPersistence,
  type ReservationPartialFailureReport,
  ReserveOrderService,
  type StockReservationGateway,
} from "../src/services/reserve-order-service.js";

const request: BuyRequest = {
  saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  runId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  idempotencyKey: "partial-failure-key",
  quantity: 1,
};
const correlationId = "partial-failure-correlation";
const now = new Date("2026-06-20T12:00:00.000Z");

function buildService(options: {
  persistence: BuyPersistence;
  stockReservations: StockReservationGateway;
  reportPersistenceFailure?: (report: ReservationPartialFailureReport) => void;
  reportPendingPersistenceEnsureFailure?: (report: ReservationPartialFailureReport) => void;
  reportPromotionFailure?: (report: ReservationPartialFailureReport) => void;
}) {
  return new ReserveOrderService({
    ...options,
    reservationHoldMinutes: 15,
    idempotencyTtlSeconds: 1800,
    pendingPersistenceRetryAfterSeconds: 30,
    generateId: (() => {
      const ids = ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"];
      let index = 0;
      return () => ids[index++] ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    })(),
  });
}

function acceptingGateway(
  overrides: Partial<StockReservationGateway> = {},
): StockReservationGateway {
  return {
    reserve: async (input) => ({
      outcome: "reservation_secured",
      reservation: input.reservation,
    }),
    markPendingPersistence: async () => undefined,
    promoteAccepted: async () => undefined,
    ...overrides,
  };
}

function persistedBuy(hold: SecuredReservationHold): {
  reservation: ReservationSummary;
  order: OrderSummary;
} {
  return {
    reservation: hold,
    order: {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      publicOrderId: "ord_partial_failure",
      saleOfferId: hold.saleOfferId,
      reservationId: hold.id,
      correlationId: hold.correlationId,
      ...(hold.runId ? { runId: hold.runId } : {}),
      quantity: hold.quantity,
      status: "queued",
      queuedAt: hold.securedAt,
    },
  };
}

describe("ReserveOrderService partial failures", () => {
  it("returns explicit pending when PostgreSQL and the marker ensure both fail", async () => {
    const persistenceError = new Error("database unavailable");
    const markerError = new Error("marker ensure unavailable");
    const reportPersistenceFailure = vi.fn();
    const reportPendingPersistenceEnsureFailure = vi.fn();
    const service = buildService({
      persistence: {
        persistSecuredReservation: async () => {
          throw persistenceError;
        },
        getPersistedBuyByReservationId: async () => null,
      },
      stockReservations: acceptingGateway({
        markPendingPersistence: async () => {
          throw markerError;
        },
      }),
      reportPersistenceFailure,
      reportPendingPersistenceEnsureFailure,
    });

    const response = await service.reserve({ request, correlationId, now });

    expect(response).toMatchObject({
      outcome: "reservation_pending_persistence",
      correlationId,
      order: null,
      retryAfterSeconds: 30,
    });
    expect(reportPersistenceFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: persistenceError,
        reservationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        saleOfferId: request.saleOfferId,
        runId: request.runId,
        correlationId,
        idempotencyKey: request.idempotencyKey,
      }),
    );
    expect(reportPendingPersistenceEnsureFailure).toHaveBeenCalledWith(
      expect.objectContaining({ error: markerError, correlationId }),
    );
  });

  it("returns explicit pending when PostgreSQL, the marker ensure, and both reporters fail", async () => {
    const reportPersistenceFailure = vi.fn(() => {
      throw new Error("persistence reporter unavailable");
    });
    const reportPendingPersistenceEnsureFailure = vi.fn(() => {
      throw new Error("marker reporter unavailable");
    });
    const service = buildService({
      persistence: {
        persistSecuredReservation: async () => {
          throw new Error("database unavailable");
        },
        getPersistedBuyByReservationId: async () => null,
      },
      stockReservations: acceptingGateway({
        markPendingPersistence: async () => {
          throw new Error("marker ensure unavailable");
        },
      }),
      reportPersistenceFailure,
      reportPendingPersistenceEnsureFailure,
    });

    const response = await service.reserve({ request, correlationId, now });

    expect(response).toMatchObject({
      outcome: "reservation_pending_persistence",
      correlationId,
      order: null,
      retryAfterSeconds: 30,
    });
    expect(reportPersistenceFailure).toHaveBeenCalledOnce();
    expect(reportPendingPersistenceEnsureFailure).toHaveBeenCalledOnce();
  });

  it("returns truthful secured and reports context when accepted promotion fails", async () => {
    const promotionError = new Error("promotion unavailable");
    const reportPromotionFailure = vi.fn();
    const service = buildService({
      persistence: {
        persistSecuredReservation: async ({ reservation }) => persistedBuy(reservation),
        getPersistedBuyByReservationId: async () => null,
      },
      stockReservations: acceptingGateway({
        promoteAccepted: async () => {
          throw promotionError;
        },
      }),
      reportPromotionFailure,
    });

    const response = await service.reserve({ request, correlationId, now });

    expect(response).toMatchObject({
      outcome: "reservation_secured",
      correlationId,
    });
    expect(reportPromotionFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: promotionError,
        reservationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        correlationId,
      }),
    );
  });

  it("returns truthful secured when accepted promotion and its reporter fail", async () => {
    const reportPromotionFailure = vi.fn(() => {
      throw new Error("promotion reporter unavailable");
    });
    const service = buildService({
      persistence: {
        persistSecuredReservation: async ({ reservation }) => persistedBuy(reservation),
        getPersistedBuyByReservationId: async () => null,
      },
      stockReservations: acceptingGateway({
        promoteAccepted: async () => {
          throw new Error("promotion unavailable");
        },
      }),
      reportPromotionFailure,
    });

    const response = await service.reserve({ request, correlationId, now });

    expect(response).toMatchObject({
      outcome: "reservation_secured",
      correlationId,
    });
    expect(reportPromotionFailure).toHaveBeenCalledOnce();
  });
});
