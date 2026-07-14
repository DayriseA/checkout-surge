import type { SecuredReservationHold } from "@checkout-surge/contracts";
import { inventoryKeys, pendingPersistenceIndexKey } from "@checkout-surge/db";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { PendingPersistenceReconciler } from "../src/services/pending-persistence-reconciler.js";

const hold: SecuredReservationHold = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  correlationId: "reconciler-test",
  quantity: 1,
  status: "secured",
  reservationToken: "res_reconciler",
  securedAt: "2026-06-20T00:00:00.000Z",
  expiresAt: "2026-06-20T00:15:00.000Z",
};

function pendingRedis() {
  const keys = inventoryKeys(hold.saleOfferId);
  const records = new Map<string, string>();
  const redis = {
    zrange: vi.fn(async (key: string) => (key === keys.pendingPersistence ? [hold.id] : [])),
    hget: vi.fn(async (key: string, id: string) =>
      key === keys.pendingPersistenceRecords && id === hold.id
        ? JSON.stringify({
            id: hold.id,
            saleOfferId: hold.saleOfferId,
            correlationId: hold.correlationId,
            runId: hold.runId,
            idempotencyKey: "reconciler-key",
            quantity: hold.quantity,
            reservationToken: hold.reservationToken,
            securedAt: hold.securedAt,
            expiresAt: hold.expiresAt,
          })
        : key === keys.reservations && id === hold.id
          ? JSON.stringify(hold)
          : (records.get(id) ?? null),
    ),
  };
  return redis;
}

function persisted() {
  return {
    reservation: hold,
    order: {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      publicOrderId: "ord_reconciler",
      saleOfferId: hold.saleOfferId,
      reservationId: hold.id,
      correlationId: hold.correlationId,
      runId: hold.runId,
      quantity: hold.quantity,
      status: "queued" as const,
      queuedAt: hold.securedAt,
    },
  };
}

describe("PendingPersistenceReconciler", () => {
  it("materializes a missing durable buy and promotes it", async () => {
    const persistedBuy = persisted();
    const persistSecuredReservation = vi.fn(async () => persistedBuy);
    const enqueue = vi.fn(async () => undefined);
    const promoteAccepted = vi.fn(async () => undefined);
    const scheduleQueue = vi.fn();
    const markDirty = vi.fn();
    const reconciler = new PendingPersistenceReconciler({
      redis: pendingRedis() as never,
      persistence: {
        persistSecuredReservation,
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      stockReservations: { promoteAccepted },
      orderProcessJobPublisher: { enqueue },
      dashboardSnapshotPublications: { scheduleQueue },
      businessOutcomeUpdates: { markDirty },
      logger: createSilentLogger("api"),
    });

    await expect(reconciler.reconcileSaleOffer(hold.saleOfferId)).resolves.toMatchObject({
      found: 1,
      materialized: 1,
      reconciled: 1,
    });
    expect(persistSecuredReservation).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(promoteAccepted).toHaveBeenCalledOnce();
    expect(scheduleQueue).toHaveBeenCalledOnce();
    expect(scheduleQueue).toHaveBeenCalledWith({
      runId: hold.runId,
      correlationId: hold.correlationId,
    });
    expect(markDirty).toHaveBeenCalledWith({
      saleOfferId: hold.saleOfferId,
      runId: hold.runId,
      correlationId: hold.correlationId,
    });
  });

  it("reasserts queue and promotion for an already durable hold", async () => {
    const enqueue = vi.fn(async () => undefined);
    const promoteAccepted = vi.fn(async () => undefined);
    const markPendingPersistenceReconciled = vi.fn(async () => undefined);
    const markDirty = vi.fn();
    const reconciler = new PendingPersistenceReconciler({
      redis: pendingRedis() as never,
      persistence: {
        persistSecuredReservation: vi.fn(),
        getPersistedBuyByReservationId: vi.fn(async () => persisted()),
        markPendingPersistenceReconciled,
      },
      stockReservations: { promoteAccepted },
      orderProcessJobPublisher: { enqueue },
      businessOutcomeUpdates: { markDirty },
      logger: createSilentLogger("api"),
    });

    await expect(reconciler.reconcileSaleOffer(hold.saleOfferId)).resolves.toMatchObject({
      found: 1,
      materialized: 0,
      reconciled: 1,
      failed: 0,
    });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(promoteAccepted).toHaveBeenCalledWith({
      idempotencyKey: "reconciler-key",
      reservation: hold,
    });
    expect(markPendingPersistenceReconciled).toHaveBeenCalledWith({ reservationId: hold.id });
    expect(markDirty).not.toHaveBeenCalled();
  });

  it("does not materialize twice when the same pending record is redriven", async () => {
    let durable: ReturnType<typeof persisted> | null = null;
    const persistSecuredReservation = vi.fn(async () => {
      const value = persisted();
      durable = value;
      return value;
    });
    const reconciler = new PendingPersistenceReconciler({
      redis: pendingRedis() as never,
      persistence: {
        persistSecuredReservation,
        getPersistedBuyByReservationId: vi.fn(async () => durable),
      },
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      logger: createSilentLogger("api"),
    });

    await reconciler.reconcileSaleOffer(hold.saleOfferId);
    await expect(reconciler.reconcileSaleOffer(hold.saleOfferId)).resolves.toMatchObject({
      found: 1,
      materialized: 0,
      reconciled: 1,
    });
    expect(persistSecuredReservation).toHaveBeenCalledOnce();
  });

  it("leaves the marker discoverable when queue handoff fails", async () => {
    const queueError = new Error("queue unavailable");
    const scheduleQueue = vi.fn();
    const markDirty = vi.fn();
    const reconciler = new PendingPersistenceReconciler({
      redis: pendingRedis() as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => persisted()),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      stockReservations: { promoteAccepted: vi.fn() },
      orderProcessJobPublisher: {
        enqueue: vi.fn(async () => {
          throw queueError;
        }),
      },
      dashboardSnapshotPublications: { scheduleQueue },
      businessOutcomeUpdates: { markDirty },
      logger: createSilentLogger("api"),
    });

    await expect(reconciler.reconcileSaleOffer(hold.saleOfferId)).resolves.toMatchObject({
      found: 1,
      failed: 1,
      reconciled: 0,
    });
    expect(scheduleQueue).not.toHaveBeenCalled();
    expect(markDirty).not.toHaveBeenCalled();
  });

  it("contains queue snapshot scheduling failure after successful reconciliation", async () => {
    const promoteAccepted = vi.fn(async () => undefined);
    const reconciler = new PendingPersistenceReconciler({
      redis: pendingRedis() as never,
      persistence: {
        persistSecuredReservation: vi.fn(),
        getPersistedBuyByReservationId: vi.fn(async () => persisted()),
      },
      stockReservations: { promoteAccepted },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      dashboardSnapshotPublications: {
        scheduleQueue: () => {
          throw new Error("dashboard scheduling unavailable");
        },
      },
      logger: createSilentLogger("api"),
    });

    await expect(reconciler.reconcileSaleOffer(hold.saleOfferId)).resolves.toMatchObject({
      found: 1,
      reconciled: 1,
      failed: 0,
    });
    expect(promoteAccepted).toHaveBeenCalledOnce();
  });

  it("leaves the marker discoverable when accepted promotion fails", async () => {
    const promotionError = new Error("promotion unavailable");
    const markDirty = vi.fn();
    const reconciler = new PendingPersistenceReconciler({
      redis: pendingRedis() as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => persisted()),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      stockReservations: {
        promoteAccepted: vi.fn(async () => {
          throw promotionError;
        }),
      },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      businessOutcomeUpdates: { markDirty },
      logger: createSilentLogger("api"),
    });

    await expect(reconciler.reconcileSaleOffer(hold.saleOfferId)).resolves.toMatchObject({
      found: 1,
      failed: 1,
      reconciled: 0,
    });
    expect(markDirty).toHaveBeenCalledOnce();
  });

  it("contains business outcome dirty-marker failure after fresh enqueue", async () => {
    const promoteAccepted = vi.fn(async () => undefined);
    const reconciler = new PendingPersistenceReconciler({
      redis: pendingRedis() as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => persisted()),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      stockReservations: { promoteAccepted },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      businessOutcomeUpdates: {
        markDirty: () => {
          throw new Error("dashboard scheduler unavailable");
        },
      },
      logger: createSilentLogger("api"),
    });

    await expect(reconciler.reconcileSaleOffer(hold.saleOfferId)).resolves.toMatchObject({
      materialized: 1,
      reconciled: 1,
      failed: 0,
    });
    expect(promoteAccepted).toHaveBeenCalledOnce();
  });

  it("reverses only a narrowly classified definitive persistence rejection", async () => {
    const reverse = vi.fn(async () => "reversed" as const);
    const reconciler = new PendingPersistenceReconciler({
      redis: pendingRedis() as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => {
          throw Object.assign(new Error("controlled rejection"), {
            code: "run_sale_offer_mismatch",
          });
        }),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      stockReservations: { promoteAccepted: vi.fn(), reverse },
      orderProcessJobPublisher: { enqueue: vi.fn() },
      logger: createSilentLogger("api"),
    });

    await expect(reconciler.reconcileSaleOffer(hold.saleOfferId)).resolves.toMatchObject({
      found: 1,
      reversed: 1,
      failed: 0,
    });
    expect(reverse).toHaveBeenCalledOnce();
  });

  it("does nothing for an empty scan and filters records by run", async () => {
    const emptyRedis = {
      zrange: vi.fn(async () => []),
      hget: vi.fn(async () => null),
    };
    const reconciler = new PendingPersistenceReconciler({
      redis: emptyRedis as never,
      persistence: {
        persistSecuredReservation: vi.fn(),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      stockReservations: { promoteAccepted: vi.fn() },
      orderProcessJobPublisher: { enqueue: vi.fn() },
      logger: createSilentLogger("api"),
    });
    await expect(reconciler.reconcileSaleOffer(hold.saleOfferId)).resolves.toMatchObject({
      found: 0,
    });
    await expect(
      new PendingPersistenceReconciler({
        redis: pendingRedis() as never,
        persistence: {
          persistSecuredReservation: vi.fn(),
          getPersistedBuyByReservationId: vi.fn(async () => null),
        },
        stockReservations: { promoteAccepted: vi.fn() },
        orderProcessJobPublisher: { enqueue: vi.fn() },
        logger: createSilentLogger("api"),
      }).reconcileSaleOffer(hold.saleOfferId, { runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }),
    ).resolves.toMatchObject({ found: 0 });
  });

  it("defers stale earliest index members so later valid records are reachable", async () => {
    const laterHold: SecuredReservationHold = {
      ...hold,
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      saleOfferId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    };
    const staleKeys = inventoryKeys(hold.saleOfferId);
    const laterKeys = inventoryKeys(laterHold.saleOfferId);
    const evalCalls: unknown[][] = [];
    const redis = {
      zrange: vi.fn(async (key: string) => {
        if (key === pendingPersistenceIndexKey) {
          return [`${hold.saleOfferId}:${hold.id}`, `${laterHold.saleOfferId}:${laterHold.id}`];
        }
        if (key === staleKeys.pendingPersistence) {
          return [hold.id];
        }
        if (key === laterKeys.pendingPersistence) {
          return [laterHold.id];
        }
        return [];
      }),
      hget: vi.fn(async (key: string, id: string) => {
        if (key === laterKeys.pendingPersistenceRecords && id === laterHold.id) {
          return JSON.stringify({
            id: laterHold.id,
            saleOfferId: laterHold.saleOfferId,
            correlationId: laterHold.correlationId,
            runId: laterHold.runId,
            idempotencyKey: "later-key",
            quantity: laterHold.quantity,
            reservationToken: laterHold.reservationToken,
            securedAt: laterHold.securedAt,
            expiresAt: laterHold.expiresAt,
          });
        }
        if (key === laterKeys.reservations && id === laterHold.id) {
          return JSON.stringify(laterHold);
        }
        return null;
      }),
      eval: vi.fn(async (...args: unknown[]) => {
        evalCalls.push(args);
        return "deferred";
      }),
    };
    const persistSecuredReservation = vi.fn(async () => persisted());
    const reconciler = new PendingPersistenceReconciler({
      redis: redis as never,
      persistence: {
        persistSecuredReservation,
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      logger: createSilentLogger("api"),
    });

    const result = await reconciler.reconcileAll();

    expect(result.found).toBe(1);
    expect(persistSecuredReservation).toHaveBeenCalledOnce();
    expect(evalCalls).toHaveLength(1);
    expect(evalCalls[0]).toContain(`${hold.saleOfferId}:${hold.id}`);
  });
});
