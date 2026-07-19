import type { SecuredReservationHold } from "@checkout-surge/contracts";
import { inventoryKeys, pendingPersistenceIndexKey } from "@checkout-surge/db";
import { describe, expect, it, vi } from "vitest";
import { PendingPersistenceRemediationService } from "../src/services/pending-persistence-remediation-service.js";

const target = {
  runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};
const hold: SecuredReservationHold = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ...target,
  correlationId: "audit-correlation",
  quantity: 1,
  status: "secured",
  reservationToken: "audit-token",
  securedAt: "2026-06-20T00:00:00.000Z",
  expiresAt: "2026-06-20T00:15:00.000Z",
};

describe("PendingPersistenceRemediationService", () => {
  it("is dry-run safe and reports only attributable non-sensitive classification fields", async () => {
    const reconcileSaleOffer = vi.fn();
    const service = new PendingPersistenceRemediationService({
      db: terminalRunDatabase() as never,
      redis: pendingRedis() as never,
      persistence: {
        persistSecuredReservation: vi.fn(),
        getPersistedBuyByReservationId: vi.fn(async () => persisted()),
      },
      reconciler: { reconcileSaleOffer },
    });

    const inspection = await service.inspect(target);

    expect(inspection).toEqual({
      target,
      runStatus: "failed",
      pendingCount: 1,
      recordCount: 1,
      globalIndexCount: 1,
      targetGlobalMemberCount: 1,
      classifications: [
        {
          reservationId: hold.id,
          disposition: "durable",
          reason: "matching_reservation_and_order",
        },
      ],
      safeToApply: true,
    });
    expect(JSON.stringify(inspection)).not.toContain(hold.correlationId);
    expect(JSON.stringify(inspection)).not.toContain(hold.reservationToken);
    expect(reconcileSaleOffer).not.toHaveBeenCalled();
  });

  it("refuses apply when Redis evidence is incomplete", async () => {
    const redis = pendingRedis();
    redis.hget = vi.fn(async () => null);
    const reconcileSaleOffer = vi.fn();
    const service = new PendingPersistenceRemediationService({
      db: terminalRunDatabase() as never,
      redis: redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      reconciler: { reconcileSaleOffer },
    });

    await expect(service.apply(target)).rejects.toThrow(
      "Remediation inspection is unsafe; no mutation was attempted.",
    );
    expect(reconcileSaleOffer).not.toHaveBeenCalled();
  });
});

function terminalRunDatabase() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ status: "failed", saleOfferId: target.saleOfferId }],
        }),
      }),
    }),
  };
}

function pendingRedis() {
  const keys = inventoryKeys(target.saleOfferId);
  return {
    zcard: vi.fn(async () => 1),
    hlen: vi.fn(async () => 1),
    zrange: vi.fn(async (key: string) => {
      if (key === keys.pendingPersistence) return [hold.id];
      if (key === pendingPersistenceIndexKey) return [`${target.saleOfferId}:${hold.id}`];
      return [];
    }),
    hget: vi.fn(async (key: string) => {
      if (key === keys.pendingPersistenceRecords) {
        return JSON.stringify({ ...hold, idempotencyKey: "audit-idempotency" });
      }
      if (key === keys.reservations) return JSON.stringify(hold);
      return null;
    }),
    get: vi.fn(async () => null),
    pttl: vi.fn(async () => -2),
  };
}

function persisted() {
  return {
    reservation: hold,
    order: {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      publicOrderId: "ord_audit",
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
