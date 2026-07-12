import type {
  BuyRequest,
  OrderSummary,
  ReservationSummary,
  SecuredReservationHold,
} from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import type { OrderProcessJobPublisher } from "../src/services/order-process-job-publisher.js";
import {
  type BusinessOutcomeUpdateFailureReport,
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
  reportPendingPersistenceRecordFailure?: (report: ReservationPartialFailureReport) => void;
  reportPendingPersistenceEnsureFailure?: (report: ReservationPartialFailureReport) => void;
  reportPromotionFailure?: (report: ReservationPartialFailureReport) => void;
  reportOrderEnqueueFailure?: (report: OrderEnqueueFailureReport) => void;
  publishBusinessOutcomeUpdate?: ConstructorParameters<
    typeof ReserveOrderService
  >[0]["publishBusinessOutcomeUpdate"];
  scheduleBusinessOutcomeUpdate?: ConstructorParameters<
    typeof ReserveOrderService
  >[0]["scheduleBusinessOutcomeUpdate"];
  reportBusinessOutcomeUpdateFailure?: (report: BusinessOutcomeUpdateFailureReport) => void;
}) {
  return new ReserveOrderService({
    persistence: options.persistence,
    stockReservations: options.stockReservations,
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
    ...(options.reportPersistenceFailure
      ? { reportPersistenceFailure: options.reportPersistenceFailure }
      : {}),
    ...(options.reportPendingPersistenceRecordFailure
      ? { reportPendingPersistenceRecordFailure: options.reportPendingPersistenceRecordFailure }
      : {}),
    ...(options.reportPendingPersistenceEnsureFailure
      ? { reportPendingPersistenceEnsureFailure: options.reportPendingPersistenceEnsureFailure }
      : {}),
    ...(options.reportPromotionFailure
      ? { reportPromotionFailure: options.reportPromotionFailure }
      : {}),
    ...(options.reportOrderEnqueueFailure
      ? { reportOrderEnqueueFailure: options.reportOrderEnqueueFailure }
      : {}),
    ...(options.publishBusinessOutcomeUpdate
      ? { publishBusinessOutcomeUpdate: options.publishBusinessOutcomeUpdate }
      : {}),
    ...(options.scheduleBusinessOutcomeUpdate
      ? { scheduleBusinessOutcomeUpdate: options.scheduleBusinessOutcomeUpdate }
      : {}),
    ...(options.reportBusinessOutcomeUpdateFailure
      ? { reportBusinessOutcomeUpdateFailure: options.reportBusinessOutcomeUpdateFailure }
      : {}),
  });
}

async function flushScheduledDashboardUpdate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
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
  it("rejects non-accepting generated runs from Redis without touching persistence", async () => {
    const persistSecuredReservation = vi.fn();
    const getPersistedBuyByReservationId = vi.fn();
    const service = buildService({
      persistence: {
        persistSecuredReservation,
        getPersistedBuyByReservationId,
      },
      stockReservations: acceptingGateway({
        reserve: async () => ({ outcome: "run_not_accepting_traffic", reservation: null }),
      }),
    });

    const response = await service.reserve({ request, correlationId, now });

    expect(response).toMatchObject({
      outcome: "inventory_not_initialized",
      reason: "run_not_accepting_traffic",
      reservation: null,
      order: null,
    });
    expect(persistSecuredReservation).not.toHaveBeenCalled();
    expect(getPersistedBuyByReservationId).not.toHaveBeenCalled();
  });

  it.each([
    "inventory_not_initialized",
    "sold_out",
    "idempotency_conflict",
    "quantity_invalid",
  ] as const)("does no persistence or lookup work for Redis %s", async (outcome) => {
    const persistSecuredReservation = vi.fn();
    const getPersistedBuyByReservationId = vi.fn();
    const service = buildService({
      persistence: { persistSecuredReservation, getPersistedBuyByReservationId },
      stockReservations: acceptingGateway({
        reserve: async () => ({ outcome, reservation: null }),
      }),
    });

    await expect(service.reserve({ request, correlationId, now })).resolves.toMatchObject({
      outcome,
      reason: outcome,
      reservation: null,
      order: null,
    });
    expect(persistSecuredReservation).not.toHaveBeenCalled();
    expect(getPersistedBuyByReservationId).not.toHaveBeenCalled();
  });

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

  it("schedules a best-effort business outcome update after durable reservation acceptance", async () => {
    const scheduledDashboardUpdates: Array<() => void> = [];
    const publishBusinessOutcomeUpdate = vi.fn().mockResolvedValue(undefined);
    const service = buildService({
      persistence: {
        persistSecuredReservation: async ({ reservation }) => persistedBuy(reservation),
        getPersistedBuyByReservationId: async () => null,
      },
      stockReservations: acceptingGateway(),
      publishBusinessOutcomeUpdate,
      scheduleBusinessOutcomeUpdate: (task) => {
        scheduledDashboardUpdates.push(task);
      },
    });

    const response = await service.reserve({ request, correlationId, now });

    expect(response.outcome).toBe("reservation_secured");
    expect(publishBusinessOutcomeUpdate).not.toHaveBeenCalled();
    expect(scheduledDashboardUpdates).toHaveLength(1);

    scheduledDashboardUpdates[0]?.();
    await Promise.resolve();

    expect(publishBusinessOutcomeUpdate).toHaveBeenCalledWith({
      saleOfferId: request.saleOfferId,
      runId: request.runId,
      correlationId,
      occurredAt: now,
    });
  });

  it("does not await a slow business outcome refresh before returning accepted reservations", async () => {
    let resolveRefresh: (() => void) | null = null;
    const publishBusinessOutcomeUpdate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const service = buildService({
      persistence: {
        persistSecuredReservation: async ({ reservation }) => persistedBuy(reservation),
        getPersistedBuyByReservationId: async () => null,
      },
      stockReservations: acceptingGateway(),
      publishBusinessOutcomeUpdate,
      scheduleBusinessOutcomeUpdate: (task) => {
        task();
      },
    });

    const responsePromise = service.reserve({ request, correlationId, now });
    let responseSettled = false;
    responsePromise.then(() => {
      responseSettled = true;
    });

    await flushScheduledDashboardUpdate();
    const settledBeforeRefreshCompleted = responseSettled;
    resolveRefresh?.();
    const response = await responsePromise;

    expect(response.outcome).toBe("reservation_secured");
    expect(publishBusinessOutcomeUpdate).toHaveBeenCalledOnce();
    expect(settledBeforeRefreshCompleted).toBe(true);
  });

  it("does not publish a business outcome update for idempotent accepted replays", async () => {
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
    const publishBusinessOutcomeUpdate = vi.fn();
    const service = buildService({
      persistence: {
        persistSecuredReservation: async () => {
          throw new Error("Historical replay must not persist again.");
        },
        getPersistedBuyByReservationId: async () => persistedBuy(hold),
      },
      stockReservations: acceptingGateway({
        reserve: async () => ({ outcome: "idempotent_replay", reservation: hold }),
      }),
      publishBusinessOutcomeUpdate,
    });

    await service.reserve({ request, correlationId, now });

    expect(publishBusinessOutcomeUpdate).not.toHaveBeenCalled();
  });

  it("does not hide durable acceptance when business outcome publication fails", async () => {
    const publishError = new Error("redis publish unavailable");
    const reportBusinessOutcomeUpdateFailure = vi.fn();
    const service = buildService({
      persistence: {
        persistSecuredReservation: async ({ reservation }) => persistedBuy(reservation),
        getPersistedBuyByReservationId: async () => null,
      },
      stockReservations: acceptingGateway(),
      publishBusinessOutcomeUpdate: async () => {
        throw publishError;
      },
      reportBusinessOutcomeUpdateFailure,
    });

    const response = await service.reserve({ request, correlationId, now });
    await flushScheduledDashboardUpdate();

    expect(response.outcome).toBe("reservation_secured");
    expect(reportBusinessOutcomeUpdateFailure).toHaveBeenCalledWith({
      error: publishError,
      saleOfferId: request.saleOfferId,
      runId: request.runId,
      correlationId,
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

  it("reconciles a Redis-secured pending hold on an idempotent retry", async () => {
    let originalHold: SecuredReservationHold | null = null;
    let durableBuy: ReturnType<typeof persistedBuy> | null = null;
    const persistSecuredReservation = vi.fn(async ({ reservation }) => {
      if (!originalHold) {
        originalHold = reservation;
      }
      if (persistSecuredReservation.mock.calls.length === 1) {
        throw new Error("database temporarily unavailable");
      }

      durableBuy = persistedBuy(reservation);
      return durableBuy;
    });
    const recordPendingPersistence = vi.fn(async () => undefined);
    const markPendingPersistence = vi.fn(async () => undefined);
    const promoteAccepted = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => undefined);
    const publishBusinessOutcomeUpdate = vi.fn(async () => undefined);
    const service = buildService({
      persistence: {
        persistSecuredReservation,
        getPersistedBuyByReservationId: async () => durableBuy,
        recordPendingPersistence,
      },
      stockReservations: acceptingGateway({
        reserve: async (input) => {
          if (!originalHold) {
            return { outcome: "reservation_secured", reservation: input.reservation };
          }
          return { outcome: "reservation_pending_persistence", reservation: originalHold };
        },
        markPendingPersistence,
        promoteAccepted,
      }),
      orderProcessJobPublisher: { enqueue },
      publishBusinessOutcomeUpdate,
    });

    const first = await service.reserve({ request, correlationId, now });
    const replay = await service.reserve({ request, correlationId, now });
    await flushScheduledDashboardUpdate();

    expect(first.outcome).toBe("reservation_pending_persistence");
    expect(replay.outcome).toBe("idempotent_replay");
    if (
      first.outcome !== "reservation_pending_persistence" ||
      replay.outcome !== "idempotent_replay"
    ) {
      throw new Error("Expected pending response followed by durable idempotent replay.");
    }
    expect(replay.reservation.id).toBe(first.reservation.id);
    expect(replay.order.reservationId).toBe(first.reservation.id);
    expect(persistSecuredReservation).toHaveBeenCalledTimes(2);
    expect(persistSecuredReservation.mock.calls[1]?.[0].reservation).toEqual(originalHold);
    expect(recordPendingPersistence).toHaveBeenCalledOnce();
    expect(markPendingPersistence).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(promoteAccepted).toHaveBeenCalledWith({
      idempotencyKey: request.idempotencyKey,
      reservation: originalHold,
    });
    expect(publishBusinessOutcomeUpdate).toHaveBeenCalledOnce();
  });

  it("uses a persistence-race recovery as durable replay without pending side effects", async () => {
    const originalHold: SecuredReservationHold = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      saleOfferId: request.saleOfferId,
      runId: request.runId,
      correlationId: "winner-correlation",
      quantity: request.quantity,
      status: "secured",
      reservationToken: "shared-race-token",
      securedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 900_000).toISOString(),
    };
    const winner = persistedBuy(originalHold);
    const recordPendingPersistence = vi.fn();
    const markPendingPersistence = vi.fn();
    const reportPersistenceFailure = vi.fn();
    const enqueue = vi.fn();
    const promoteAccepted = vi.fn();
    const service = buildService({
      persistence: {
        getPersistedBuyByReservationId: async () => null,
        persistSecuredReservation: async () => winner,
        recordPendingPersistence,
      },
      stockReservations: acceptingGateway({
        reserve: async () => ({
          outcome: "reservation_pending_persistence",
          reservation: originalHold,
        }),
        markPendingPersistence,
        promoteAccepted,
      }),
      orderProcessJobPublisher: { enqueue },
      reportPersistenceFailure,
    });

    const response = await service.reserve({ request, correlationId, now });

    expect(response).toMatchObject({
      outcome: "idempotent_replay",
      correlationId,
      reservation: { id: originalHold.id },
      order: { id: winner.order.id, publicOrderId: winner.order.publicOrderId },
    });
    expect(reportPersistenceFailure).not.toHaveBeenCalled();
    expect(recordPendingPersistence).not.toHaveBeenCalled();
    expect(markPendingPersistence).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
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
  it("records pending-persistence context when PostgreSQL order creation fails", async () => {
    const persistenceError = new Error("database unavailable");
    const recordPendingPersistence = vi.fn(async () => undefined);
    const service = buildService({
      persistence: {
        persistSecuredReservation: async () => {
          throw persistenceError;
        },
        getPersistedBuyByReservationId: async () => null,
        recordPendingPersistence,
      },
      stockReservations: acceptingGateway(),
    });

    const response = await service.reserve({ request, correlationId, now });

    expect(response.outcome).toBe("reservation_pending_persistence");
    expect(recordPendingPersistence).toHaveBeenCalledWith({
      idempotencyKey: request.idempotencyKey,
      reservation: expect.objectContaining({
        saleOfferId: request.saleOfferId,
        runId: request.runId,
        correlationId,
      }),
    });
  });

  it("does not hide the pending response when pending-persistence recording fails", async () => {
    const recordError = new Error("pending record unavailable");
    const reportPendingPersistenceRecordFailure = vi.fn();
    const service = buildService({
      persistence: {
        persistSecuredReservation: async () => {
          throw new Error("database unavailable");
        },
        getPersistedBuyByReservationId: async () => null,
        recordPendingPersistence: async () => {
          throw recordError;
        },
      },
      stockReservations: acceptingGateway(),
      reportPendingPersistenceRecordFailure,
    });

    const response = await service.reserve({ request, correlationId, now });

    expect(response.outcome).toBe("reservation_pending_persistence");
    expect(reportPendingPersistenceRecordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: recordError,
        saleOfferId: request.saleOfferId,
        runId: request.runId,
        correlationId,
        idempotencyKey: request.idempotencyKey,
      }),
    );
  });

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

  it("reverses a hold once for a definitive sale-offer persistence rejection", async () => {
    const persistenceError = Object.assign(new Error("run_sale_offer_mismatch"), {
      code: "run_sale_offer_mismatch",
    });
    const reverse = vi.fn(async () => "reversed" as const);
    const markPendingPersistence = vi.fn();
    const recordPendingPersistence = vi.fn();
    const service = buildService({
      persistence: {
        persistSecuredReservation: async () => {
          throw persistenceError;
        },
        getPersistedBuyByReservationId: async () => null,
        recordPendingPersistence,
      },
      stockReservations: acceptingGateway({ reverse, markPendingPersistence }),
    });

    await expect(service.reserve({ request, correlationId, now })).rejects.toBe(persistenceError);
    expect(reverse).toHaveBeenCalledWith({
      idempotencyKey: request.idempotencyKey,
      reservation: expect.objectContaining({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }),
    });
    expect(markPendingPersistence).not.toHaveBeenCalled();
    expect(recordPendingPersistence).not.toHaveBeenCalled();
  });

  it("keeps incidental persistence messages retryable", async () => {
    const reverse = vi.fn(async () => "reversed" as const);
    const service = buildService({
      persistence: {
        persistSecuredReservation: async () => {
          throw new Error("run_sale_offer_mismatch was mentioned by a downstream diagnostic");
        },
        getPersistedBuyByReservationId: async () => null,
      },
      stockReservations: acceptingGateway({ reverse }),
    });

    const response = await service.reserve({ request, correlationId, now });

    expect(response.outcome).toBe("reservation_pending_persistence");
    expect(reverse).not.toHaveBeenCalled();
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
