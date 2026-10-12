import { describe, expect, it, vi } from "vitest";
import { PostgresStockBuyService } from "../../src/services/postgres-stock-buy-service.js";
import type { PostgresStockOutcome } from "../../src/services/postgres-stock-persistence.js";

const runId = "40000000-0000-4000-8000-000000000001";
const saleOfferId = "40000000-0000-4000-8000-000000000002";
const request = { runId, saleOfferId, quantity: 1, idempotencyKey: "buyer-1" };

function serviceAnswering(outcome: (hold: { id: string }) => PostgresStockOutcome) {
  const counts = { recordSoldOut: vi.fn(), recordReserved: vi.fn() };
  const signals = {
    scheduleInventory: vi.fn(),
    observeSoldOut: vi.fn(),
    markDirty: vi.fn(),
    observe: vi.fn(),
  };
  const service = new PostgresStockBuyService({
    stock: { reserve: async ({ hold }) => outcome(hold) },
    counts,
    reservationHoldMinutes: 15,
    dashboardSourceDirtyScheduler: signals,
    soldOutObservations: signals,
    businessOutcomeUpdates: signals,
    reservationTimingObservations: signals,
  });
  return { service, counts, signals };
}

function persisted(reservationId: string) {
  const at = "2026-10-12T10:00:00.000Z";
  const scope = { saleOfferId, runId, correlationId: "corr-1", quantity: 1 };
  return {
    reservation: {
      ...scope,
      id: reservationId,
      reservationToken: "res_token",
      securedAt: at,
      expiresAt: "2026-10-12T10:15:00.000Z",
    },
    order: {
      ...scope,
      id: "40000000-0000-4000-8000-000000000003",
      publicOrderId: "ord_1",
      reservationId,
      status: "queued" as const,
      queuedAt: at,
    },
  };
}

describe("PostgreSQL stock buy service", () => {
  it("counts a turned-away buyer in the batched counters and answers sold out", async () => {
    const { service, counts, signals } = serviceAnswering(() => ({ outcome: "sold_out" }));

    const response = await service.buy({ request, correlationId: "corr-1" });

    expect(response.outcome).toBe("sold_out");
    expect(counts.recordSoldOut).toHaveBeenCalledWith(
      expect.objectContaining({ runId, saleOfferId }),
    );
    expect(signals.observeSoldOut).toHaveBeenCalledOnce();
    expect(signals.observe).toHaveBeenCalledWith(expect.objectContaining({ runId }));
  });

  it("counts a new winner once and answers a replay without counting it again", async () => {
    let fresh = true;
    const { service, counts, signals } = serviceAnswering((hold) => {
      const outcome = { outcome: "reservation_secured", persisted: persisted(hold.id), fresh };
      fresh = false;
      return outcome as PostgresStockOutcome;
    });

    const first = await service.buy({ request, correlationId: "corr-1" });
    const replay = await service.buy({ request, correlationId: "corr-1" });

    expect([first.outcome, replay.outcome]).toEqual(["reservation_secured", "reservation_secured"]);
    expect(counts.recordReserved).toHaveBeenCalledOnce();
    expect(signals.scheduleInventory).toHaveBeenCalledOnce();
    expect(signals.markDirty).toHaveBeenCalledOnce();
    expect(counts.recordSoldOut).not.toHaveBeenCalled();
  });
});
