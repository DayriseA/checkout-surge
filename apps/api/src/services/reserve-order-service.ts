import { randomUUID } from "node:crypto";
import {
  type BuyRequest,
  type BuyResponse,
  buyResponseSchema,
  type OrderProcessJob,
  type OrderSummary,
  type ReservationSummary,
  type SecuredReservationHold,
  type StockReservationDecision,
} from "@checkout-surge/contracts";
import type { OrderProcessJobPublisher } from "./order-process-job-publisher.js";

export interface PersistedBuy {
  reservation: ReservationSummary;
  order: OrderSummary;
}

export interface BuyPersistence {
  persistSecuredReservation(input: { reservation: SecuredReservationHold }): Promise<PersistedBuy>;
  getPersistedBuyByReservationId(reservationId: string): Promise<PersistedBuy | null>;
  recordPendingPersistence?(input: {
    reservation: SecuredReservationHold;
    idempotencyKey: string;
  }): Promise<void>;
}

export interface StockReservationGateway {
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

export interface ReservationPartialFailureReport {
  error: unknown;
  reservationId: string;
  saleOfferId: string;
  runId?: string;
  correlationId: string;
  idempotencyKey: string;
}

export interface OrderEnqueueFailureReport extends ReservationPartialFailureReport {
  orderId: string;
}

export interface BusinessOutcomeUpdateFailureReport {
  error: unknown;
  saleOfferId: string;
  runId?: string;
  correlationId: string;
}

type ReservationPartialFailureReporter = (report: ReservationPartialFailureReport) => void;
type BusinessOutcomeUpdatePublisher = (input: {
  saleOfferId: string;
  runId?: string;
  correlationId: string;
  occurredAt: Date;
}) => Promise<void>;

function safelyReportPartialFailure<Report extends ReservationPartialFailureReport>(
  reporter: (report: Report) => void,
  report: Report,
): void {
  try {
    reporter(report);
  } catch {
    // Reporting is non-critical and must not hide the reservation outcome.
  }
}

export class ReserveOrderService {
  private readonly persistence: BuyPersistence;
  private readonly stockReservations: StockReservationGateway;
  private readonly orderProcessJobPublisher: OrderProcessJobPublisher;
  private readonly reservationHoldMinutes: number;
  private readonly idempotencyTtlSeconds: number;
  private readonly pendingPersistenceRetryAfterSeconds: number;
  private readonly generateId: () => string;
  private readonly reportPersistenceFailure: ReservationPartialFailureReporter;
  private readonly reportPendingPersistenceRecordFailure: ReservationPartialFailureReporter;
  private readonly reportPendingPersistenceEnsureFailure: ReservationPartialFailureReporter;
  private readonly reportPromotionFailure: ReservationPartialFailureReporter;
  private readonly reportOrderEnqueueFailure: (report: OrderEnqueueFailureReport) => void;
  private readonly publishBusinessOutcomeUpdate: BusinessOutcomeUpdatePublisher;
  private readonly reportBusinessOutcomeUpdateFailure: (
    report: BusinessOutcomeUpdateFailureReport,
  ) => void;

  constructor(options: {
    persistence: BuyPersistence;
    stockReservations: StockReservationGateway;
    orderProcessJobPublisher: OrderProcessJobPublisher;
    reservationHoldMinutes: number;
    idempotencyTtlSeconds: number;
    pendingPersistenceRetryAfterSeconds: number;
    generateId?: () => string;
    reportPersistenceFailure?: ReservationPartialFailureReporter;
    reportPendingPersistenceRecordFailure?: ReservationPartialFailureReporter;
    reportPendingPersistenceEnsureFailure?: ReservationPartialFailureReporter;
    reportPromotionFailure?: ReservationPartialFailureReporter;
    reportOrderEnqueueFailure?: (report: OrderEnqueueFailureReport) => void;
    publishBusinessOutcomeUpdate?: BusinessOutcomeUpdatePublisher;
    reportBusinessOutcomeUpdateFailure?: (report: BusinessOutcomeUpdateFailureReport) => void;
  }) {
    this.persistence = options.persistence;
    this.stockReservations = options.stockReservations;
    this.orderProcessJobPublisher = options.orderProcessJobPublisher;
    this.reservationHoldMinutes = options.reservationHoldMinutes;
    this.idempotencyTtlSeconds = options.idempotencyTtlSeconds;
    this.pendingPersistenceRetryAfterSeconds = options.pendingPersistenceRetryAfterSeconds;
    this.generateId = options.generateId ?? randomUUID;
    this.reportPersistenceFailure = options.reportPersistenceFailure ?? (() => undefined);
    this.reportPendingPersistenceRecordFailure =
      options.reportPendingPersistenceRecordFailure ?? (() => undefined);
    this.reportPendingPersistenceEnsureFailure =
      options.reportPendingPersistenceEnsureFailure ?? (() => undefined);
    this.reportPromotionFailure = options.reportPromotionFailure ?? (() => undefined);
    this.reportOrderEnqueueFailure = options.reportOrderEnqueueFailure ?? (() => undefined);
    this.publishBusinessOutcomeUpdate =
      options.publishBusinessOutcomeUpdate ?? (async () => undefined);
    this.reportBusinessOutcomeUpdateFailure =
      options.reportBusinessOutcomeUpdateFailure ?? (() => undefined);
  }

  async reserve(input: {
    request: BuyRequest;
    correlationId: string;
    now?: Date;
  }): Promise<BuyResponse> {
    const now = input.now ?? new Date();

    const reservation = this.createReservationHold(input.request, input.correlationId, now);
    const decision = await this.stockReservations.reserve({
      idempotencyKey: input.request.idempotencyKey,
      idempotencyTtlSeconds: this.idempotencyTtlSeconds,
      reservation,
    });

    if (decision.outcome === "run_not_accepting_traffic") {
      return this.rejectedResponse(
        "inventory_not_initialized",
        "run_not_accepting_traffic",
        input.correlationId,
        now,
      );
    }

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
      await this.enqueuePersistedBuy(persisted, input.request.idempotencyKey, decision.reservation);
      await this.promoteWithoutHidingDurableSuccess(
        input.request.idempotencyKey,
        decision.reservation,
      );
      return this.acceptedResponse("idempotent_replay", persisted, input.correlationId, now);
    }

    if (decision.outcome === "idempotent_replay") {
      throw new Error("Accepted Redis idempotency record has no durable reservation and order.");
    }

    return this.reconcilePendingReservation({
      reservation: decision.reservation,
      idempotencyKey: input.request.idempotencyKey,
      correlationId: input.correlationId,
      now,
    });
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
    } catch (error) {
      safelyReportPartialFailure(
        this.reportPersistenceFailure,
        this.partialFailureReport(error, input.idempotencyKey, input.reservation),
      );
      await this.recordPendingPersistenceWithoutHidingPending(
        input.idempotencyKey,
        input.reservation,
      );
      await this.ensurePendingPersistence(input.idempotencyKey, input.reservation);
      return this.pendingResponse(input.reservation, input.correlationId, input.now);
    }

    await this.enqueuePersistedBuy(persisted, input.idempotencyKey, input.reservation);
    await this.promoteWithoutHidingDurableSuccess(input.idempotencyKey, input.reservation);
    await this.publishBusinessOutcomeUpdateWithoutHidingDurableSuccess(
      input.reservation,
      input.now,
    );
    return this.acceptedResponse("reservation_secured", persisted, input.correlationId, input.now);
  }

  private async reconcilePendingReservation(input: {
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
    } catch (error) {
      safelyReportPartialFailure(
        this.reportPersistenceFailure,
        this.partialFailureReport(error, input.idempotencyKey, input.reservation),
      );
      await this.recordPendingPersistenceWithoutHidingPending(
        input.idempotencyKey,
        input.reservation,
      );
      await this.ensurePendingPersistence(input.idempotencyKey, input.reservation);
      return this.pendingResponse(input.reservation, input.correlationId, input.now);
    }

    await this.enqueuePersistedBuy(persisted, input.idempotencyKey, input.reservation);
    await this.promoteWithoutHidingDurableSuccess(input.idempotencyKey, input.reservation);
    await this.publishBusinessOutcomeUpdateWithoutHidingDurableSuccess(
      input.reservation,
      input.now,
    );
    return this.acceptedResponse("idempotent_replay", persisted, input.correlationId, input.now);
  }

  private async publishBusinessOutcomeUpdateWithoutHidingDurableSuccess(
    reservation: SecuredReservationHold,
    occurredAt: Date,
  ): Promise<void> {
    try {
      await this.publishBusinessOutcomeUpdate({
        saleOfferId: reservation.saleOfferId,
        ...(reservation.runId ? { runId: reservation.runId } : {}),
        correlationId: reservation.correlationId,
        occurredAt,
      });
    } catch (error) {
      try {
        this.reportBusinessOutcomeUpdateFailure({
          error,
          saleOfferId: reservation.saleOfferId,
          ...(reservation.runId ? { runId: reservation.runId } : {}),
          correlationId: reservation.correlationId,
        });
      } catch {
        // Realtime publication is best-effort and must not hide durable success.
      }
    }
  }

  private async enqueuePersistedBuy(
    persisted: PersistedBuy,
    idempotencyKey: string,
    reservation: SecuredReservationHold,
  ): Promise<void> {
    try {
      // PostgreSQL and BullMQ are not atomic. Every durable replay re-asserts this
      // deterministic job before Redis can be promoted to an accepted response.
      await this.orderProcessJobPublisher.enqueue(this.toOrderProcessJob(persisted));
    } catch (error) {
      safelyReportPartialFailure(this.reportOrderEnqueueFailure, {
        ...this.partialFailureReport(error, idempotencyKey, reservation),
        orderId: persisted.order.id,
      });
      throw error;
    }
  }

  private toOrderProcessJob(persisted: PersistedBuy): OrderProcessJob {
    return {
      orderId: persisted.order.id,
      publicOrderId: persisted.order.publicOrderId,
      reservationId: persisted.order.reservationId,
      saleOfferId: persisted.order.saleOfferId,
      correlationId: persisted.order.correlationId,
      ...(persisted.order.runId ? { runId: persisted.order.runId } : {}),
      quantity: persisted.order.quantity,
      queuedAt: persisted.order.queuedAt,
    };
  }

  private async promoteWithoutHidingDurableSuccess(
    idempotencyKey: string,
    reservation: SecuredReservationHold,
  ): Promise<void> {
    try {
      await this.stockReservations.promoteAccepted({ idempotencyKey, reservation });
    } catch (error) {
      safelyReportPartialFailure(
        this.reportPromotionFailure,
        this.partialFailureReport(error, idempotencyKey, reservation),
      );
    }
  }

  private async ensurePendingPersistence(
    idempotencyKey: string,
    reservation: SecuredReservationHold,
  ): Promise<void> {
    try {
      await this.stockReservations.markPendingPersistence({ idempotencyKey, reservation });
    } catch (error) {
      safelyReportPartialFailure(
        this.reportPendingPersistenceEnsureFailure,
        this.partialFailureReport(error, idempotencyKey, reservation),
      );
    }
  }

  private async recordPendingPersistenceWithoutHidingPending(
    idempotencyKey: string,
    reservation: SecuredReservationHold,
  ): Promise<void> {
    if (!this.persistence.recordPendingPersistence) {
      return;
    }

    try {
      await this.persistence.recordPendingPersistence({ idempotencyKey, reservation });
    } catch (error) {
      safelyReportPartialFailure(
        this.reportPendingPersistenceRecordFailure,
        this.partialFailureReport(error, idempotencyKey, reservation),
      );
    }
  }

  private partialFailureReport(
    error: unknown,
    idempotencyKey: string,
    reservation: SecuredReservationHold,
  ): ReservationPartialFailureReport {
    return {
      error,
      reservationId: reservation.id,
      saleOfferId: reservation.saleOfferId,
      ...(reservation.runId ? { runId: reservation.runId } : {}),
      correlationId: reservation.correlationId,
      idempotencyKey,
    };
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
