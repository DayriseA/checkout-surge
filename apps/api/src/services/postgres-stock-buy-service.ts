import { randomUUID } from "node:crypto";
import type { BuyRequest, BuyResponse } from "@checkout-surge/contracts";
import type { BatchedInventoryCounts } from "./batched-inventory-counts.js";
import type {
  DashboardSourceDirtySchedulerPort,
  SoldOutObservationPort,
} from "./dashboard-source-dirty-scheduler.js";
import type { PostgresStockPersistence } from "./postgres-stock-persistence.js";
import type { ReservationTimingObservationPort } from "./reservation-timing-observation.js";
import {
  acceptedBuyResponse,
  createReservationHold,
  rejectedBuyResponse,
} from "./reserve-order-service.js";

/**
 * The buy path of a run whose stock PostgreSQL decides (the Redis comparison's second run): the
 * same answers and live signals as the normal path, without Redis on the decision.
 */
export class PostgresStockBuyService {
  constructor(
    private readonly options: {
      stock: Pick<PostgresStockPersistence, "reserve">;
      counts: Pick<BatchedInventoryCounts, "recordSoldOut" | "recordReserved">;
      reservationHoldMinutes: number;
      dashboardSourceDirtyScheduler: Pick<DashboardSourceDirtySchedulerPort, "scheduleInventory">;
      soldOutObservations: SoldOutObservationPort;
      businessOutcomeUpdates: {
        markDirty(scope: { saleOfferId: string; runId: string; correlationId: string }): void;
      };
      reservationTimingObservations: ReservationTimingObservationPort;
      generateId?: () => string;
    },
  ) {}

  async buy(input: { request: BuyRequest; correlationId: string }): Promise<BuyResponse> {
    const startedAt = performance.now();
    try {
      return await this.reserve(input);
    } finally {
      advisory(() =>
        this.options.reservationTimingObservations.observe({
          runId: input.request.runId,
          reserveOrderServiceMs: Math.max(performance.now() - startedAt, 0),
        }),
      );
    }
  }

  private async reserve({
    request,
    correlationId,
  }: {
    request: BuyRequest;
    correlationId: string;
  }): Promise<BuyResponse> {
    const now = new Date();
    const hold = createReservationHold({
      request,
      correlationId,
      securedAt: now,
      holdMinutes: this.options.reservationHoldMinutes,
      generateId: this.options.generateId ?? randomUUID,
    });
    const result = await this.options.stock.reserve({
      hold,
      idempotencyKey: request.idempotencyKey,
    });
    const scope = { saleOfferId: request.saleOfferId, runId: request.runId, correlationId };
    if (result.outcome === "reservation_secured") {
      if (result.fresh) {
        advisory(() =>
          this.options.counts.recordReserved({
            ...scope,
            quantity: hold.quantity,
            reservedAt: now,
          }),
        );
        advisory(() => this.options.dashboardSourceDirtyScheduler.scheduleInventory(scope));
        advisory(() => this.options.businessOutcomeUpdates.markDirty(scope));
      }
      return acceptedBuyResponse(result.persisted, correlationId);
    }
    if (result.outcome === "sold_out") {
      advisory(() => this.options.counts.recordSoldOut({ ...scope, observedAt: now }));
      advisory(() => this.options.soldOutObservations.observeSoldOut(scope));
    }
    return rejectedBuyResponse(result.outcome, correlationId, now);
  }
}

/** Live counters and signals are advisory: they never change the buyer's answer. */
function advisory(operation: () => void): void {
  try {
    operation();
  } catch {
    // Ignored, as on the normal buy path.
  }
}
