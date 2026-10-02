import type { BuyRequest, SecuredReservationHold } from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import type { OrderProcessJobPublisher } from "../../src/services/order-process-job-publisher.js";
import {
  type BusinessOutcomeUpdateFailureReport,
  type BuyPersistence,
  type OrderEnqueueFailureReport,
  type PendingPersistenceRecovery,
  type PersistedBuyAcceptance,
  type ReservationPartialFailureReport,
  ReserveOrderService,
  type StockReservationGateway,
} from "../../src/services/reserve-order-service.js";

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
  pendingPersistenceRecovery?: PendingPersistenceRecovery;
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
  dashboardSourceDirtyScheduler?: ConstructorParameters<
    typeof ReserveOrderService
  >[0]["dashboardSourceDirtyScheduler"];
  soldOutObservations?: ConstructorParameters<typeof ReserveOrderService>[0]["soldOutObservations"];
  reservationTimingObservations?: ConstructorParameters<
    typeof ReserveOrderService
  >[0]["reservationTimingObservations"];
  monotonicNow?: () => number;
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
    pendingPersistenceRecovery: options.pendingPersistenceRecovery ?? {
      recoverReservation: async () => null,
    },
    generateId: (() => {
      const ids = ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"];
      let index = 0;
      return () => ids[index++] ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    })(),
    ...(options.reportPersistenceFailure
      ? { reportPersistenceFailure: options.reportPersistenceFailure }
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
    ...(options.dashboardSourceDirtyScheduler
      ? { dashboardSourceDirtyScheduler: options.dashboardSourceDirtyScheduler }
      : {}),
    ...(options.soldOutObservations ? { soldOutObservations: options.soldOutObservations } : {}),
    ...(options.reservationTimingObservations
      ? { reservationTimingObservations: options.reservationTimingObservations }
      : {}),
    ...(options.monotonicNow ? { monotonicNow: options.monotonicNow } : {}),
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

function persistedBuy(hold: SecuredReservationHold): PersistedBuyAcceptance {
  return {
    reservation: hold,
    order: {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      publicOrderId: "ord_partial_failure",
      saleOfferId: hold.saleOfferId,
      reservationId: hold.id,
      correlationId: hold.correlationId,
      runId: hold.runId,
      quantity: hold.quantity,
      status: "queued",
      queuedAt: hold.securedAt,
    },
  };
}

describe("ReserveOrderService queue handoff", () => {
  it("observes the Redis and whole-service boundaries without changing the outcome", async () => {
    const observations: unknown[] = [];
    const observe = vi.fn((input) => {
      observations.push(input);
      throw new Error("timing sink unavailable");
    });
    const monotonicTimes = [100, 102, 107, 115];
    const service = buildService({
      persistence: {
        persistSecuredReservation: vi.fn(),
        getPersistedBuyByReservationId: vi.fn(),
      },
      stockReservations: acceptingGateway({
        reserve: async () => ({ outcome: "sold_out", reservation: null }),
      }),
      reservationTimingObservations: { observe },
      monotonicNow: () => monotonicTimes.shift() ?? 115,
    });

    await expect(service.reserve({ request, correlationId, now })).resolves.toMatchObject({
      outcome: "sold_out",
    });
    expect(observations).toEqual([
      {
        runId: request.runId,
        redisAtomicReservationMs: 5,
        reserveOrderServiceMs: 15,
      },
    ]);
  });

  it("observes only a fresh sold-out decision synchronously and isolates observer failure", async () => {
    const observeSoldOut = vi.fn(() => {
      throw new Error("observer unavailable");
    });
    const service = buildService({
      persistence: {
        persistSecuredReservation: vi.fn(),
        getPersistedBuyByReservationId: vi.fn(),
      },
      stockReservations: acceptingGateway({
        reserve: async () => ({ outcome: "sold_out", reservation: null }),
      }),
      soldOutObservations: { observeSoldOut },
    });

    await expect(service.reserve({ request, correlationId, now })).resolves.toMatchObject({
      outcome: "sold_out",
    });
    expect(observeSoldOut).toHaveBeenCalledWith({
      saleOfferId: request.saleOfferId,
      runId: request.runId,
      correlationId,
    });
  });
  it("schedules aggregate source dirtiness only for a fresh hold and successful enqueue", async () => {
    const scheduleInventory = vi.fn();
    const scheduleQueue = vi.fn();
    const observeSoldOut = vi.fn();
    const service = buildService({
      persistence: {
        persistSecuredReservation: async ({ reservation }) => persistedBuy(reservation),
        getPersistedBuyByReservationId: async () => null,
      },
      stockReservations: acceptingGateway(),
      dashboardSourceDirtyScheduler: { scheduleInventory, scheduleQueue },
      soldOutObservations: { observeSoldOut },
    });

    await expect(service.reserve({ request, correlationId, now })).resolves.toMatchObject({
      outcome: "reservation_secured",
    });

    expect(scheduleInventory).toHaveBeenCalledOnce();
    expect(scheduleInventory).toHaveBeenCalledWith({
      saleOfferId: request.saleOfferId,
      runId: request.runId,
      correlationId,
    });
    expect(scheduleQueue).toHaveBeenCalledOnce();
    expect(scheduleQueue).toHaveBeenCalledWith({ runId: request.runId, correlationId });
    expect(observeSoldOut).not.toHaveBeenCalled();
  });

  it("contains snapshot scheduling failures without changing reservation correctness", async () => {
    const service = buildService({
      persistence: {
        persistSecuredReservation: async ({ reservation }) => persistedBuy(reservation),
        getPersistedBuyByReservationId: async () => null,
      },
      stockReservations: acceptingGateway(),
      dashboardSourceDirtyScheduler: {
        scheduleInventory: () => {
          throw new Error("inventory scheduling failed");
        },
        scheduleQueue: () => {
          throw new Error("queue scheduling failed");
        },
      },
    });

    await expect(service.reserve({ request, correlationId, now })).resolves.toMatchObject({
      outcome: "reservation_secured",
    });
  });

  it.each([
    "sold_out",
    "run_not_accepting_traffic",
    "inventory_not_initialized",
    "idempotency_conflict",
  ] as const)("maps the Redis $decision rejection without persistence, lookups, or snapshots", async (decision) => {
    const persistSecuredReservation = vi.fn();
    const getPersistedBuyByReservationId = vi.fn();
    const scheduleInventory = vi.fn();
    const scheduleQueue = vi.fn();
    const enqueue = vi.fn();
    const observeSoldOut = vi.fn();
    const service = buildService({
      persistence: { persistSecuredReservation, getPersistedBuyByReservationId },
      stockReservations: acceptingGateway({
        reserve: async () => ({ outcome: decision, reservation: null }),
      }),
      dashboardSourceDirtyScheduler: { scheduleInventory, scheduleQueue },
      orderProcessJobPublisher: { enqueue },
      soldOutObservations: { observeSoldOut },
    });

    const response = await service.reserve({ request, correlationId, now });

    expect(response).toEqual(
      expect.objectContaining({
        outcome: decision,
        reservation: null,
        order: null,
      }),
    );
    expect(persistSecuredReservation).not.toHaveBeenCalled();
    expect(getPersistedBuyByReservationId).not.toHaveBeenCalled();
    expect(scheduleInventory).not.toHaveBeenCalled();
    expect(scheduleQueue).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    if (decision === "sold_out") {
      expect(observeSoldOut).toHaveBeenCalledOnce();
    } else {
      expect(observeSoldOut).not.toHaveBeenCalled();
    }
  });

  it("enqueues the persisted summaries before Redis promotion and returns immediately after acceptance", async () => {
    const callOrder: string[] = [];
    const enqueue = vi.fn(async () => {
      callOrder.push("enqueue");
    });
    const promoteAccepted = vi.fn(async () => {
      callOrder.push("promote");
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
        promoteAccepted,
      }),
      orderProcessJobPublisher: { enqueue },
    });

    const response = await service.reserve({ request, correlationId, now });

    expect(response.outcome).toBe("reservation_secured");
    expect(callOrder).toEqual(["persist", "enqueue", "promote"]);
    if (response.outcome !== "reservation_secured") {
      throw new Error("Expected a secured reservation response.");
    }
    expect(promoteAccepted).toHaveBeenCalledWith({
      idempotencyKey: request.idempotencyKey,
      idempotencyTtlSeconds: 1800,
      reservation: response.reservation,
    });
    expect(enqueue).toHaveBeenCalledWith({
      orderId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      publicOrderId: "ord_partial_failure",
      reservationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      saleOfferId: request.saleOfferId,
      correlationId,
      runId: request.runId,
      quantity: request.quantity,
      queuedAt: now.toISOString(),
      processingGeneration: 0,
    });
  });

  it("enqueues without publication options", async () => {
    const callOrder: string[] = [];
    const service = buildService({
      persistence: {
        withRunAdmissionLock: async ({ reservation, operation }) => {
          callOrder.push("admission");
          return operation({
            persistSecuredReservation: async () => {
              callOrder.push("persist");
              return persistedBuy(reservation);
            },
            getPersistedBuyByReservationId: async () => null,
          });
        },
        persistSecuredReservation: async () => {
          throw new Error("Expected admission-scoped persistence.");
        },
        getPersistedBuyByReservationId: async () => null,
      },
      stockReservations: acceptingGateway({
        promoteAccepted: async () => {
          callOrder.push("promote");
        },
      }),
      orderProcessJobPublisher: {
        enqueue: async () => {
          callOrder.push("enqueue");
        },
      },
    });

    await expect(service.reserve({ request, correlationId, now })).resolves.toMatchObject({
      outcome: "reservation_secured",
    });
    expect(callOrder).toEqual(["admission", "persist", "enqueue", "promote"]);
  });

  it("preserves and re-enqueues matching durable evidence after a terminal admission race", async () => {
    let securedHold: SecuredReservationHold | null = null;
    const reverse = vi.fn(async () => "reversed" as const);
    const enqueue = vi.fn(async () => undefined);
    const promoteAccepted = vi.fn(async () => undefined);
    const service = buildService({
      persistence: {
        persistSecuredReservation: vi.fn(),
        getPersistedBuyByReservationId: vi.fn(async () => {
          if (!securedHold) throw new Error("Expected Redis hold before durable lookup.");
          return persistedBuy(securedHold);
        }),
        withRunAdmissionLock: async () => {
          throw Object.assign(new Error("terminal"), { code: "run_terminal" });
        },
      },
      stockReservations: acceptingGateway({
        reserve: async ({ reservation }) => {
          securedHold = reservation;
          return { outcome: "reservation_secured", reservation };
        },
        reverse,
        promoteAccepted,
      }),
      orderProcessJobPublisher: { enqueue },
    });

    await expect(service.reserve({ request, correlationId, now })).resolves.toMatchObject({
      outcome: "reservation_secured",
      reservation: { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
      order: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
    });
    expect(reverse).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(promoteAccepted).toHaveBeenCalledOnce();
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
    });
  });

  it("does not await a slow business outcome refresh before returning accepted reservations", async () => {
    let resolveRefresh!: () => void;
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
    resolveRefresh();
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
      reservationToken: "res_historical",
      securedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 900_000).toISOString(),
    };
    const publishBusinessOutcomeUpdate = vi.fn();
    const scheduleInventory = vi.fn();
    const scheduleQueue = vi.fn();
    const observeSoldOut = vi.fn();
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
      dashboardSourceDirtyScheduler: { scheduleInventory, scheduleQueue },
      soldOutObservations: { observeSoldOut },
    });

    await service.reserve({ request, correlationId, now });
    await flushScheduledDashboardUpdate();

    expect(publishBusinessOutcomeUpdate).not.toHaveBeenCalled();
    expect(scheduleInventory).not.toHaveBeenCalled();
    expect(scheduleQueue).toHaveBeenCalledOnce();
    expect(observeSoldOut).not.toHaveBeenCalled();
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
    const scheduleInventory = vi.fn();
    const scheduleQueue = vi.fn();
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
      dashboardSourceDirtyScheduler: { scheduleInventory, scheduleQueue },
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
    expect(scheduleInventory).toHaveBeenCalledOnce();
    expect(scheduleQueue).not.toHaveBeenCalled();
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
      pendingPersistenceRecovery: {
        recoverReservation: async () => {
          enqueueAttempts += 1;
          await promoteAccepted();
          return durableBuy;
        },
      },
    });

    await expect(service.reserve({ request, correlationId, now })).rejects.toThrow(
      "queue temporarily unavailable",
    );
    const replay = await service.reserve({ request, correlationId, now });

    expect(replay.outcome).toBe("reservation_secured");
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
    const markPendingPersistence = vi.fn(async () => undefined);
    const promoteAccepted = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => undefined);
    const publishBusinessOutcomeUpdate = vi.fn(async () => undefined);
    const observeSoldOut = vi.fn();
    const recoverReservation = vi.fn(
      async ({ reservation }: { reservation: SecuredReservationHold }) => {
        durableBuy = await persistSecuredReservation({ reservation });
        return durableBuy;
      },
    );
    const service = buildService({
      persistence: {
        persistSecuredReservation,
        getPersistedBuyByReservationId: async () => durableBuy,
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
      soldOutObservations: { observeSoldOut },
      pendingPersistenceRecovery: { recoverReservation },
    });

    const first = await service.reserve({ request, correlationId, now });
    const replay = await service.reserve({ request, correlationId, now });
    await flushScheduledDashboardUpdate();

    expect(first.outcome).toBe("reservation_pending_persistence");
    expect(replay.outcome).toBe("reservation_secured");
    if (
      first.outcome !== "reservation_pending_persistence" ||
      replay.outcome !== "reservation_secured"
    ) {
      throw new Error("Expected pending response followed by durable idempotent replay.");
    }
    const reconciledHold = persistSecuredReservation.mock.calls[1]?.[0].reservation;
    if (!reconciledHold) {
      throw new Error("Expected the original hold to be reconciled.");
    }
    const reconciledWinner = persistedBuy(reconciledHold);
    expect(replay.reservation.id).toBe(first.reservation.id);
    expect(replay.order.reservationId).toBe(first.reservation.id);
    expect(replay.timestamp).toBe(reconciledHold.securedAt);
    expect(replay.order.id).toBe(reconciledWinner.order.id);
    expect(replay.order.publicOrderId).toBe(reconciledWinner.order.publicOrderId);
    expect(persistSecuredReservation).toHaveBeenCalledTimes(2);
    expect(persistSecuredReservation.mock.calls[1]?.[0].reservation).toEqual(originalHold);
    expect(markPendingPersistence).toHaveBeenCalledOnce();
    expect(recoverReservation).toHaveBeenCalledWith({
      idempotencyKey: request.idempotencyKey,
      reservation: originalHold,
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(promoteAccepted).not.toHaveBeenCalled();
    expect(publishBusinessOutcomeUpdate).not.toHaveBeenCalled();
    expect(observeSoldOut).not.toHaveBeenCalled();
  });

  it("keeps an overloaded direct recovery publicly pending and retryable", async () => {
    const originalHold: SecuredReservationHold = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      saleOfferId: request.saleOfferId,
      runId: request.runId,
      correlationId,
      quantity: request.quantity,
      reservationToken: "direct-recovery-overload",
      securedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 900_000).toISOString(),
    };
    const winner = persistedBuy(originalHold);
    const recoverReservation = vi
      .fn<PendingPersistenceRecovery["recoverReservation"]>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    const markPendingPersistence = vi.fn(async () => undefined);
    const service = buildService({
      persistence: {
        persistSecuredReservation: vi.fn(async () => winner),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      stockReservations: acceptingGateway({
        reserve: async () => ({
          outcome: "reservation_pending_persistence",
          reservation: originalHold,
        }),
        markPendingPersistence,
      }),
      pendingPersistenceRecovery: { recoverReservation },
    });

    await expect(service.reserve({ request, correlationId, now })).resolves.toMatchObject({
      outcome: "reservation_pending_persistence",
      reservation: { id: originalHold.id },
      order: null,
    });
    await expect(service.reserve({ request, correlationId, now })).resolves.toMatchObject({
      outcome: "reservation_secured",
      reservation: { id: originalHold.id },
      order: { id: winner.order.id },
    });
    expect(markPendingPersistence).toHaveBeenCalledOnce();
    expect(recoverReservation).toHaveBeenCalledTimes(2);
  });

  it("uses a persistence-race recovery as durable replay without pending side effects", async () => {
    const originalHold: SecuredReservationHold = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      saleOfferId: request.saleOfferId,
      runId: request.runId,
      correlationId: "winner-correlation",
      quantity: request.quantity,
      reservationToken: "shared-race-token",
      securedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 900_000).toISOString(),
    };
    const winner = persistedBuy(originalHold);
    const markPendingPersistence = vi.fn();
    const reportPersistenceFailure = vi.fn();
    const enqueue = vi.fn();
    const promoteAccepted = vi.fn();
    const service = buildService({
      persistence: {
        getPersistedBuyByReservationId: async () => null,
        persistSecuredReservation: async () => winner,
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
      pendingPersistenceRecovery: { recoverReservation: async () => winner },
    });

    const response = await service.reserve({ request, correlationId, now });

    expect(response).toMatchObject({
      outcome: "reservation_secured",
      correlationId,
      reservation: { id: originalHold.id },
      order: { id: winner.order.id, publicOrderId: winner.order.publicOrderId },
    });
    expect(reportPersistenceFailure).not.toHaveBeenCalled();
    expect(markPendingPersistence).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(promoteAccepted).not.toHaveBeenCalled();
  });

  it("re-enqueues an accepted historical replay before returning it", async () => {
    const hold: SecuredReservationHold = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      saleOfferId: request.saleOfferId,
      runId: request.runId,
      correlationId: "original-workflow-correlation",
      quantity: 1,
      reservationToken: "res_historical",
      securedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 900_000).toISOString(),
    };
    const callOrder: string[] = [];
    const enqueue = vi.fn(async () => {
      callOrder.push("enqueue");
    });
    const promoteAccepted = vi.fn(async () => {
      callOrder.push("promote");
    });
    const service = buildService({
      persistence: {
        persistSecuredReservation: async () => {
          throw new Error("Historical replay must not persist again.");
        },
        getPersistedBuyByReservationId: async () => {
          callOrder.push("read durable");
          return persistedBuy(hold);
        },
      },
      stockReservations: acceptingGateway({
        reserve: async () => ({ outcome: "idempotent_replay", reservation: hold }),
        promoteAccepted,
      }),
      orderProcessJobPublisher: { enqueue },
    });

    const retryCorrelationId = "current-retry-correlation";
    const retryNow = new Date(now.getTime() + 60_000);
    const response = await service.reserve({
      request,
      correlationId: retryCorrelationId,
      now: retryNow,
    });

    expect(response.outcome).toBe("reservation_secured");
    if (response.outcome !== "reservation_secured") {
      throw new Error("Expected a durable acceptance replay.");
    }
    expect(response).toEqual({
      outcome: "reservation_secured",
      correlationId: retryCorrelationId,
      timestamp: hold.securedAt,
      reservation: hold,
      order: persistedBuy(hold).order,
    });
    expect(response.timestamp).not.toBe(retryNow.toISOString());
    expect(response.reservation.correlationId).toBe("original-workflow-correlation");
    expect(response.order.correlationId).toBe("original-workflow-correlation");
    expect(response.order.status).toBe("queued");
    expect(enqueue).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(["read durable", "enqueue", "promote"]);
    expect(promoteAccepted).toHaveBeenCalledWith({
      idempotencyKey: request.idempotencyKey,
      idempotencyTtlSeconds: 1800,
      reservation: hold,
    });
  });
});

describe("ReserveOrderService partial failures", () => {
  it("ensures the Redis pending marker only after admission is released", async () => {
    const callOrder: string[] = [];
    const admissionOperations = {
      persistSecuredReservation: async () => {
        callOrder.push("persist failure");
        throw new Error("database unavailable");
      },
      getPersistedBuyByReservationId: async () => null,
    };
    const service = buildService({
      persistence: {
        ...admissionOperations,
        withRunAdmissionLock: async ({ operation }) => {
          callOrder.push("admission start");
          const result = await operation(admissionOperations);
          callOrder.push("admission end");
          return result;
        },
      },
      stockReservations: acceptingGateway({
        markPendingPersistence: async () => {
          callOrder.push("ensure Redis pending");
        },
      }),
    });

    await expect(service.reserve({ request, correlationId, now })).resolves.toMatchObject({
      outcome: "reservation_pending_persistence",
    });
    expect(callOrder).toEqual([
      "admission start",
      "persist failure",
      "admission end",
      "ensure Redis pending",
    ]);
  });

  it("returns explicit pending when PostgreSQL, the marker ensure, and both reporters fail", async () => {
    const persistenceError = new Error("database unavailable");
    const markerError = new Error("marker ensure unavailable");
    const reportPersistenceFailure = vi.fn(() => {
      throw new Error("persistence reporter unavailable");
    });
    const reportPendingPersistenceEnsureFailure = vi.fn(() => {
      throw new Error("marker reporter unavailable");
    });
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
    const service = buildService({
      persistence: {
        persistSecuredReservation: async () => {
          throw persistenceError;
        },
        getPersistedBuyByReservationId: async () => null,
      },
      stockReservations: acceptingGateway({ reverse, markPendingPersistence }),
    });

    await expect(service.reserve({ request, correlationId, now })).rejects.toBe(persistenceError);
    expect(reverse).toHaveBeenCalledWith({
      idempotencyKey: request.idempotencyKey,
      reservation: expect.objectContaining({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }),
    });
    expect(markPendingPersistence).not.toHaveBeenCalled();
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
