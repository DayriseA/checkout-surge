import { randomUUID } from "node:crypto";
import {
  type BuyRequest,
  type BuyResponse,
  buyResponseSchema,
  type OrderSummary,
  type ReservationSummary,
  type SecuredReservationHold,
  type StockReservationDecision,
} from "@checkout-surge/contracts";

export interface PersistedBuy {
  reservation: ReservationSummary;
  order: OrderSummary;
}

export interface BuyPersistence {
  persistSecuredReservation(input: { reservation: SecuredReservationHold }): Promise<PersistedBuy>;
  getPersistedBuyByReservationId(reservationId: string): Promise<PersistedBuy | null>;
}

export interface StockReservationGateway {
  isRunSaleEligible(input: { runId: string; saleOfferId: string }): Promise<boolean>;
  reserve(input: {
    idempotencyKey: string;
    idempotencyTtlSeconds: number;
    reservation: SecuredReservationHold;
  }): Promise<StockReservationDecision>;
  markPendingPersistence(input: {
    idempotencyKey: string;
    reservation: SecuredReservationHold;
  }): Promise<void>;
  promoteAccepted(input: {
    idempotencyKey: string;
    reservation: SecuredReservationHold;
  }): Promise<void>;
}

export class ReserveOrderService {
  private readonly persistence: BuyPersistence;
  private readonly stockReservations: StockReservationGateway;
  private readonly reservationHoldMinutes: number;
  private readonly idempotencyTtlSeconds: number;
  private readonly pendingPersistenceRetryAfterSeconds: number;
  private readonly generateId: () => string;
  private readonly reportPromotionFailure: (error: unknown, reservationId: string) => void;

  constructor(options: {
    persistence: BuyPersistence;
    stockReservations: StockReservationGateway;
    reservationHoldMinutes: number;
    idempotencyTtlSeconds: number;
    pendingPersistenceRetryAfterSeconds: number;
    generateId?: () => string;
    reportPromotionFailure?: (error: unknown, reservationId: string) => void;
  }) {
    this.persistence = options.persistence;
    this.stockReservations = options.stockReservations;
    this.reservationHoldMinutes = options.reservationHoldMinutes;
    this.idempotencyTtlSeconds = options.idempotencyTtlSeconds;
    this.pendingPersistenceRetryAfterSeconds = options.pendingPersistenceRetryAfterSeconds;
    this.generateId = options.generateId ?? randomUUID;
    this.reportPromotionFailure = options.reportPromotionFailure ?? (() => undefined);
  }

  async reserve(input: {
    request: BuyRequest;
    correlationId: string;
    now?: Date;
  }): Promise<BuyResponse> {
    const now = input.now ?? new Date();

    if (
      input.request.runId &&
      !(await this.stockReservations.isRunSaleEligible({
        runId: input.request.runId,
        saleOfferId: input.request.saleOfferId,
      }))
    ) {
      return this.rejectedResponse(
        "inventory_not_initialized",
        "run_not_accepting_traffic",
        input.correlationId,
        now,
      );
    }

    const reservation = this.createReservationHold(input.request, input.correlationId, now);
    const decision = await this.stockReservations.reserve({
      idempotencyKey: input.request.idempotencyKey,
      idempotencyTtlSeconds: this.idempotencyTtlSeconds,
      reservation,
    });

    if (
      decision.outcome === "sold_out" ||
      decision.outcome === "inventory_not_initialized" ||
      decision.outcome === "idempotency_conflict" ||
      decision.outcome === "quantity_invalid"
    ) {
      return this.rejectedResponse(decision.outcome, decision.outcome, input.correlationId, now);
    }

    if (!decision.reservation) {
      throw new Error("Redis returned an accepted decision without a reservation hold.");
    }

    if (decision.outcome === "reservation_secured") {
      return this.persistNewReservation({
        reservation: decision.reservation,
        idempotencyKey: input.request.idempotencyKey,
        correlationId: input.correlationId,
        now,
      });
    }

    const persisted = await this.persistence.getPersistedBuyByReservationId(
      decision.reservation.id,
    );

    if (persisted) {
      await this.promoteWithoutHidingDurableSuccess(
        input.request.idempotencyKey,
        decision.reservation,
      );
      return this.acceptedResponse("idempotent_replay", persisted, input.correlationId, now);
    }

    if (decision.outcome === "idempotent_replay") {
      throw new Error("Accepted Redis idempotency record has no durable reservation and order.");
    }

    await this.stockReservations.markPendingPersistence({
      idempotencyKey: input.request.idempotencyKey,
      reservation: decision.reservation,
    });
    return this.pendingResponse(decision.reservation, input.correlationId, now);
  }

  private async persistNewReservation(input: {
    reservation: SecuredReservationHold;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<BuyResponse> {
    let persisted: PersistedBuy;

    try {
      persisted = await this.persistence.persistSecuredReservation({
        reservation: input.reservation,
      });
    } catch {
      await this.stockReservations.markPendingPersistence({
        idempotencyKey: input.idempotencyKey,
        reservation: input.reservation,
      });
      return this.pendingResponse(input.reservation, input.correlationId, input.now);
    }

    await this.promoteWithoutHidingDurableSuccess(input.idempotencyKey, input.reservation);
    return this.acceptedResponse("reservation_secured", persisted, input.correlationId, input.now);
  }

  private async promoteWithoutHidingDurableSuccess(
    idempotencyKey: string,
    reservation: SecuredReservationHold,
  ): Promise<void> {
    try {
      await this.stockReservations.promoteAccepted({ idempotencyKey, reservation });
    } catch (error) {
      this.reportPromotionFailure(error, reservation.id);
    }
  }

  private createReservationHold(
    request: BuyRequest,
    correlationId: string,
    securedAt: Date,
  ): SecuredReservationHold {
    const tokenId = this.generateId();
    return {
      id: this.generateId(),
      saleOfferId: request.saleOfferId,
      correlationId,
      ...(request.runId ? { runId: request.runId } : {}),
      quantity: request.quantity,
      status: "secured",
      reservationToken: `res_${tokenId}`,
      securedAt: securedAt.toISOString(),
      expiresAt: new Date(securedAt.getTime() + this.reservationHoldMinutes * 60_000).toISOString(),
    };
  }

  private acceptedResponse(
    outcome: "reservation_secured" | "idempotent_replay",
    persisted: PersistedBuy,
    correlationId: string,
    now: Date,
  ): BuyResponse {
    return buyResponseSchema.parse({
      outcome,
      correlationId,
      timestamp: now.toISOString(),
      reservation: persisted.reservation,
      order: persisted.order,
      simulatedStatus: "reservation_secured",
    });
  }

  private pendingResponse(
    reservation: SecuredReservationHold,
    correlationId: string,
    now: Date,
  ): BuyResponse {
    return buyResponseSchema.parse({
      outcome: "reservation_pending_persistence",
      correlationId,
      timestamp: now.toISOString(),
      reservation,
      order: null,
      simulatedStatus: "reservation_secured",
      retryAfterSeconds: this.pendingPersistenceRetryAfterSeconds,
    });
  }

  private rejectedResponse(
    outcome: "sold_out" | "inventory_not_initialized" | "idempotency_conflict" | "quantity_invalid",
    reason:
      | "sold_out"
      | "inventory_not_initialized"
      | "idempotency_conflict"
      | "quantity_invalid"
      | "run_not_accepting_traffic",
    correlationId: string,
    now: Date,
  ): BuyResponse {
    return buyResponseSchema.parse({
      outcome,
      reason,
      correlationId,
      timestamp: now.toISOString(),
      reservation: null,
      order: null,
      simulatedStatus: "sold_out",
    });
  }
}
