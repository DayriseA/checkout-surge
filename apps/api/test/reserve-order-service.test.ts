import type {
  BuyRequest,
  OrderSummary,
  ReservationSummary,
  SecuredReservationHold,
} from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import type { OrderProcessJobPublisher } from "../src/services/order-process-job-publisher.js";
import {
  type BuyPersistence,
  type OrderEnqueueFailureReport,
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
  orderProcessJobPublisher?: OrderProcessJobPublisher;
  reportPersistenceFailure?: (report: ReservationPartialFailureReport) => void;
  reportPendingPersistenceEnsureFailure?: (report: ReservationPartialFailureReport) => void;
  reportPromotionFailure?: (report: ReservationPartialFailureReport) => void;
  reportOrderEnqueueFailure?: (report: OrderEnqueueFailureReport) => void;
}) {
  return new ReserveOrderService({
    ...options,
    orderProcessJobPublisher: options.orderProcessJobPublisher ?? {
      enqueue: async () => undefined,
    },
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

describe("ReserveOrderService queue handoff", () => {
  it("enqueues the persisted summaries before Redis promotion and returns immediately after acceptance", async () => {
    const callOrder: string[] = [];
    const enqueue = vi.fn(async () => {
      callOrder.push("enqueue");
    });
    const service = buildService({
      persistence: {
        persistSecuredReservation: async ({ reservation }) => {
          callOrder.push("persist");
          return persistedBuy(reservation);
        },
        getPersistedBuyByReservationId: async () => null,
      },
      stockReservations: acceptingGateway({
        promoteAccepted: async () => {
          callOrder.push("promote");
        },
      }),
      orderProcessJobPublisher: { enqueue },
    });

    const response = await service.reserve({ request, correlationId, now });

    expect(response.outcome).toBe("reservation_secured");
    expect(callOrder).toEqual(["persist", "enqueue", "promote"]);
    expect(enqueue).toHaveBeenCalledWith({
      orderId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      publicOrderId: "ord_partial_failure",
      reservationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      saleOfferId: request.saleOfferId,
      correlationId,
      runId: request.runId,
      quantity: request.quantity,
      queuedAt: now.toISOString(),
    });
  });

  it("reports enqueue failure, rejects the request, and does not promote Redis", async () => {
    const enqueueError = new Error("queue unavailable");
    const promoteAccepted = vi.fn();
    const reportOrderEnqueueFailure = vi.fn();
    const service = buildService({
      persistence: {
        persistSecuredReservation: async ({ reservation }) => persistedBuy(reservation),
        getPersistedBuyByReservationId: async () => null,
      },
      stockReservations: acceptingGateway({ promoteAccepted }),
      orderProcessJobPublisher: {
        enqueue: async () => {
          throw enqueueError;
        },
      },
      reportOrderEnqueueFailure,
    });

    await expect(service.reserve({ request, correlationId, now })).rejects.toBe(enqueueError);
    expect(reportOrderEnqueueFailure).toHaveBeenCalledWith({
      error: enqueueError,
      orderId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      reservationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      saleOfferId: request.saleOfferId,
      runId: request.runId,
      correlationId,
      idempotencyKey: request.idempotencyKey,
    });
    expect(promoteAccepted).not.toHaveBeenCalled();
  });

  it("does not let a throwing enqueue-failure reporter hide the original enqueue error", async () => {
    const enqueueError = new Error("original queue failure");
    const reportOrderEnqueueFailure = vi.fn(() => {
      throw new Error("enqueue reporter failure");
    });
    const service = buildService({
      persistence: {
        persistSecuredReservation: async ({ reservation }) => persistedBuy(reservation),
        getPersistedBuyByReservationId: async () => null,
      },
      stockReservations: acceptingGateway(),
      orderProcessJobPublisher: {
        enqueue: async () => {
          throw enqueueError;
        },
      },
      reportOrderEnqueueFailure,
    });

    await expect(service.reserve({ request, correlationId, now })).rejects.toBe(enqueueError);
    expect(reportOrderEnqueueFailure).toHaveBeenCalledOnce();
  });

  it("uses the persisted order reservation link as the job reservation ID", async () => {
    const durableReservationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const enqueue = vi.fn();
    const service = buildService({
      persistence: {
        persistSecuredReservation: async ({ reservation }) => {
          const persisted = persistedBuy(reservation);
          return {
            ...persisted,
            order: { ...persisted.order, reservationId: durableReservationId },
          };
        },
        getPersistedBuyByReservationId: async () => null,
      },
      stockReservations: acceptingGateway(),
      orderProcessJobPublisher: { enqueue },
    });

    await service.reserve({ request, correlationId, now });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: durableReservationId }),
    );
  });

  it("heals an interrupted durable handoff on a pending idempotent retry", async () => {
    let originalHold: SecuredReservationHold | null = null;
    let durableBuy: ReturnType<typeof persistedBuy> | null = null;
    let enqueueAttempts = 0;
    const persistSecuredReservation = vi.fn(async ({ reservation }) => {
      originalHold = reservation;
      durableBuy = persistedBuy(reservation);
      return durableBuy;
    });
    const promoteAccepted = vi.fn();
    const service = buildService({
      persistence: {
        persistSecuredReservation,
        getPersistedBuyByReservationId: async () => durableBuy,
      },
      stockReservations: {
        ...acceptingGateway({ promoteAccepted }),
        reserve: async (input) => {
          if (!originalHold) {
            return { outcome: "reservation_secured", reservation: input.reservation };
          }
          return { outcome: "reservation_pending_persistence", reservation: originalHold };
        },
      },
      orderProcessJobPublisher: {
        enqueue: async () => {
          enqueueAttempts += 1;
          if (enqueueAttempts === 1) {
            throw new Error("queue temporarily unavailable");
          }
        },
      },
    });

    await expect(service.reserve({ request, correlationId, now })).rejects.toThrow(
      "queue temporarily unavailable",
    );
    const replay = await service.reserve({ request, correlationId, now });

    expect(replay.outcome).toBe("idempotent_replay");
    expect(persistSecuredReservation).toHaveBeenCalledOnce();
    expect(enqueueAttempts).toBe(2);
    expect(promoteAccepted).toHaveBeenCalledOnce();
  });

  it("re-enqueues an accepted historical replay before returning it", async () => {
    const hold: SecuredReservationHold = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      saleOfferId: request.saleOfferId,
      runId: request.runId,
      correlationId,
      quantity: 1,
      status: "secured",
      reservationToken: "res_historical",
      securedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 900_000).toISOString(),
    };
    const enqueue = vi.fn();
    const promoteAccepted = vi.fn();
    const service = buildService({
      persistence: {
        persistSecuredReservation: async () => {
          throw new Error("Historical replay must not persist again.");
        },
        getPersistedBuyByReservationId: async () => persistedBuy(hold),
      },
      stockReservations: acceptingGateway({
        reserve: async () => ({ outcome: "idempotent_replay", reservation: hold }),
        promoteAccepted,
      }),
      orderProcessJobPublisher: { enqueue },
    });

    const response = await service.reserve({ request, correlationId, now });

    expect(response.outcome).toBe("idempotent_replay");
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      promoteAccepted.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});

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
