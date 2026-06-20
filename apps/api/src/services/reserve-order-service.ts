import {
  type BuyRequest,
  type BuyResponse,
  buyResponseSchema,
  type OrderSummary,
  type ReservationSummary,
} from "@checkout-surge/contracts";

export interface SaleOfferEligibility {
  saleOfferId: string;
  isAccepting: boolean;
  rejectReason?: "inventory_not_initialized" | "run_not_accepting_traffic";
}

export interface PersistedBuy {
  reservation: ReservationSummary;
  order: OrderSummary;
}

export interface BuyPersistence {
  getSaleOfferEligibility(input: {
    saleOfferId: string;
    runId?: string;
    now: Date;
  }): Promise<SaleOfferEligibility>;
  persistSecuredReservation(input: {
    saleOfferId: string;
    runId?: string;
    quantity: number;
    correlationId: string;
    securedAt: Date;
    expiresAt: Date;
  }): Promise<PersistedBuy>;
}

export class ReserveOrderService {
  private readonly persistence: BuyPersistence;
  private readonly reservationHoldMinutes: number;

  constructor(options: { persistence: BuyPersistence; reservationHoldMinutes: number }) {
    this.persistence = options.persistence;
    this.reservationHoldMinutes = options.reservationHoldMinutes;
  }

  async reserve(input: {
    request: BuyRequest;
    correlationId: string;
    now?: Date;
  }): Promise<BuyResponse> {
    const now = input.now ?? new Date();
    const eligibility = await this.persistence.getSaleOfferEligibility({
      saleOfferId: input.request.saleOfferId,
      ...(input.request.runId ? { runId: input.request.runId } : {}),
      now,
    });

    if (!eligibility.isAccepting) {
      return buyResponseSchema.parse({
        outcome: "inventory_not_initialized",
        reason: eligibility.rejectReason ?? "inventory_not_initialized",
        correlationId: input.correlationId,
        timestamp: now.toISOString(),
        reservation: null,
        order: null,
        simulatedStatus: "sold_out",
      });
    }

    const persisted = await this.persistence.persistSecuredReservation({
      saleOfferId: input.request.saleOfferId,
      ...(input.request.runId ? { runId: input.request.runId } : {}),
      quantity: input.request.quantity,
      correlationId: input.correlationId,
      securedAt: now,
      expiresAt: new Date(now.getTime() + this.reservationHoldMinutes * 60_000),
    });

    return buyResponseSchema.parse({
      outcome: "reservation_secured",
      correlationId: input.correlationId,
      timestamp: now.toISOString(),
      reservation: persisted.reservation,
      order: persisted.order,
      simulatedStatus: "reservation_secured",
    });
  }
}
