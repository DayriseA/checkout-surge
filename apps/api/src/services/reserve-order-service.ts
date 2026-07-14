import { randomUUID } from "node:crypto";
import {
  type AcceptedOrderSummary,
  type AcceptedReservationSummary,
  type BuyRequest,
  type BuyResponse,
  buyResponseSchema,
  type OrderProcessJob,
  type ReservationRejectedResponse,
  type SecuredReservationHold,
  type StockReservationDecision,
} from "@checkout-surge/contracts";
import type { DashboardSnapshotPublicationSchedulerPort } from "./dashboard-snapshot-publication-scheduler.js";
import type { OrderProcessJobPublisher } from "./order-process-job-publisher.js";

export const definitivePersistenceRejectionCode = "run_sale_offer_mismatch" as const;
export const terminalPersistenceRejectionCode = "run_terminal" as const;

export class DefinitivePersistenceRejectionError extends Error {
  readonly code:
    | typeof definitivePersistenceRejectionCode
    | typeof terminalPersistenceRejectionCode = definitivePersistenceRejectionCode;

  constructor(message = "Reservation run and sale offer do not match.") {
    super(message);
    this.name = "DefinitivePersistenceRejectionError";
  }
}

export class TerminalRunPersistenceRejectionError extends DefinitivePersistenceRejectionError {
  readonly code = terminalPersistenceRejectionCode;
  readonly reason = "run_terminal" as const;

  constructor() {
    super("Generated run is terminal and no longer accepts reservations.");
    this.name = "TerminalRunPersistenceRejectionError";
  }
}

export function isDefinitivePersistenceRejection(error: unknown): boolean {
  return (
    error instanceof DefinitivePersistenceRejectionError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ((error as { code?: unknown }).code === definitivePersistenceRejectionCode ||
        (error as { code?: unknown }).code === terminalPersistenceRejectionCode))
  );
}

export interface PersistedBuyAcceptance {
  reservation: AcceptedReservationSummary;
  order: AcceptedOrderSummary;
}

export interface BuyPersistenceOperations {
  persistSecuredReservation(input: {
    reservation: SecuredReservationHold;
  }): Promise<PersistedBuyAcceptance>;
  getPersistedBuyByReservationId(reservationId: string): Promise<PersistedBuyAcceptance | null>;
  recordPendingPersistence?(input: {
    reservation: SecuredReservationHold;
    idempotencyKey: string;
  }): Promise<void>;
  markPendingPersistenceReconciled?(input: { reservationId: string }): Promise<void>;
}

export interface BuyPersistence extends BuyPersistenceOperations {
  withRunAdmissionLock?<T>(input: {
    reservation: SecuredReservationHold;
    operation: (persistence: BuyPersistenceOperations) => Promise<T>;
  }): Promise<T>;
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
  reverse?(input: {
    idempotencyKey: string;
    reservation: SecuredReservationHold;
    occurredAt?: Date;
  }): Promise<"reversed" | "not_held">;
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
type BusinessOutcomeUpdateScheduler = (task: () => void) => void;

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

type RejectedReservationOutcome = ReservationRejectedResponse["outcome"];

function simulatedStatusForRejectedOutcome(
  outcome: RejectedReservationOutcome,
): "sold_out" | "sale_not_active" | null {
  switch (outcome) {
    case "sold_out":
      return "sold_out";
    case "run_not_accepting_traffic":
      return "sale_not_active";
    case "inventory_not_initialized":
    case "idempotency_conflict":
    case "quantity_invalid":
      return null;
    default: {
      const exhaustive: never = outcome;
      throw new Error(`Unhandled rejected reservation outcome: ${String(exhaustive)}`);
    }
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
  private readonly reportReservationReversalFailure: ReservationPartialFailureReporter;
  private readonly publishBusinessOutcomeUpdate: BusinessOutcomeUpdatePublisher;
  private readonly scheduleBusinessOutcomeUpdate: BusinessOutcomeUpdateScheduler;
  private readonly reportBusinessOutcomeUpdateFailure: (
    report: BusinessOutcomeUpdateFailureReport,
  ) => void;
  private readonly dashboardSnapshotPublications: DashboardSnapshotPublicationSchedulerPort;

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
    reportReservationReversalFailure?: ReservationPartialFailureReporter;
    publishBusinessOutcomeUpdate?: BusinessOutcomeUpdatePublisher;
    scheduleBusinessOutcomeUpdate?: BusinessOutcomeUpdateScheduler;
    reportBusinessOutcomeUpdateFailure?: (report: BusinessOutcomeUpdateFailureReport) => void;
    dashboardSnapshotPublications?: DashboardSnapshotPublicationSchedulerPort;
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
    this.reportReservationReversalFailure =
      options.reportReservationReversalFailure ?? (() => undefined);
    this.publishBusinessOutcomeUpdate =
      options.publishBusinessOutcomeUpdate ?? (async () => undefined);
    this.scheduleBusinessOutcomeUpdate =
      options.scheduleBusinessOutcomeUpdate ??
      ((task) => {
        setImmediate(task);
      });
    this.reportBusinessOutcomeUpdateFailure =
      options.reportBusinessOutcomeUpdateFailure ?? (() => undefined);
    this.dashboardSnapshotPublications = options.dashboardSnapshotPublications ?? {
      scheduleInventory: () => undefined,
      scheduleQueue: () => undefined,
    };
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

    if (
      decision.outcome === "sold_out" ||
      decision.outcome === "run_not_accepting_traffic" ||
      decision.outcome === "inventory_not_initialized" ||
      decision.outcome === "idempotency_conflict" ||
      decision.outcome === "quantity_invalid"
    ) {
      return this.rejectedResponse(decision.outcome, input.correlationId, now);
    }

    if (!decision.reservation) {
      throw new Error("Redis returned an accepted decision without a reservation hold.");
    }

    if (decision.outcome === "reservation_secured") {
      this.scheduleInventorySnapshot(decision.reservation);
      return this.persistNewReservation({
        reservation: decision.reservation,
        idempotencyKey: input.request.idempotencyKey,
        correlationId: input.correlationId,
        now,
      });
    }

    return this.replayOrReconcilePendingReservation({
      reservation: decision.reservation,
      idempotencyKey: input.request.idempotencyKey,
      correlationId: input.correlationId,
      now,
      outcome: decision.outcome,
    });
  }

  private async persistNewReservation(input: {
    reservation: SecuredReservationHold;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<BuyResponse> {
    let persisted: PersistedBuyAcceptance | null;
    try {
      persisted = await this.withPersistenceAdmissionLock(
        input.reservation,
        async (persistence) => {
          let persisted: PersistedBuyAcceptance;

          try {
            persisted = await persistence.persistSecuredReservation({
              reservation: input.reservation,
            });
          } catch (error) {
            safelyReportPartialFailure(
              this.reportPersistenceFailure,
              this.partialFailureReport(error, input.idempotencyKey, input.reservation),
            );
            if (isDefinitivePersistenceRejection(error)) {
              throw error;
            }
            await this.recordPendingPersistenceWithoutHidingPending(
              input.idempotencyKey,
              input.reservation,
              persistence,
            );
            await this.ensurePendingPersistence(input.idempotencyKey, input.reservation);
            return null;
          }

          await this.enqueuePersistedBuy(persisted, input.idempotencyKey, input.reservation);
          return persisted;
        },
      );
    } catch (error) {
      if (isDefinitivePersistenceRejection(error) && this.stockReservations.reverse) {
        await this.compensateHold(input.idempotencyKey, input.reservation, error);
      }
      throw error;
    }

    if (!persisted) {
      return this.pendingResponse(input.reservation, input.correlationId, input.now);
    }

    await this.promoteWithoutHidingDurableSuccess(input.idempotencyKey, input.reservation);
    this.scheduleBusinessOutcomeUpdateWithoutHidingDurableSuccess(input.reservation, input.now);
    return this.acceptedResponse(persisted, input.correlationId);
  }

  private async compensateHold(
    idempotencyKey: string,
    reservation: SecuredReservationHold,
    originalError: unknown,
  ): Promise<void> {
    try {
      await this.stockReservations.reverse?.({ idempotencyKey, reservation });
    } catch (error) {
      safelyReportPartialFailure(
        this.reportReservationReversalFailure,
        this.partialFailureReport(error, idempotencyKey, reservation),
      );
      // Preserve the original persistence rejection for the request caller.
      void originalError;
    }
  }

  private async replayOrReconcilePendingReservation(input: {
    reservation: SecuredReservationHold;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
    outcome: "reservation_pending_persistence" | "idempotent_replay";
  }): Promise<BuyResponse> {
    let persisted: PersistedBuyAcceptance | null;
    try {
      persisted = await this.withPersistenceAdmissionLock(
        input.reservation,
        async (persistence) => {
          const existing = await persistence.getPersistedBuyByReservationId(input.reservation.id);
          if (existing) {
            await this.enqueuePersistedBuy(existing, input.idempotencyKey, input.reservation);
            return existing;
          }

          if (input.outcome === "idempotent_replay") {
            throw new Error(
              "Accepted Redis idempotency record has no durable reservation and order.",
            );
          }

          let materialized: PersistedBuyAcceptance;
          try {
            materialized = await persistence.persistSecuredReservation({
              reservation: input.reservation,
            });
          } catch (error) {
            safelyReportPartialFailure(
              this.reportPersistenceFailure,
              this.partialFailureReport(error, input.idempotencyKey, input.reservation),
            );
            if (isDefinitivePersistenceRejection(error)) {
              throw error;
            }
            await this.recordPendingPersistenceWithoutHidingPending(
              input.idempotencyKey,
              input.reservation,
              persistence,
            );
            await this.ensurePendingPersistence(input.idempotencyKey, input.reservation);
            return null;
          }

          await this.enqueuePersistedBuy(materialized, input.idempotencyKey, input.reservation);
          return materialized;
        },
      );
    } catch (error) {
      if (isDefinitivePersistenceRejection(error) && this.stockReservations.reverse) {
        await this.compensateHold(input.idempotencyKey, input.reservation, error);
      }
      throw error;
    }

    if (!persisted) {
      return this.pendingResponse(input.reservation, input.correlationId, input.now);
    }

    await this.promoteWithoutHidingDurableSuccess(input.idempotencyKey, input.reservation);
    this.scheduleBusinessOutcomeUpdateWithoutHidingDurableSuccess(input.reservation, input.now);
    return this.acceptedResponse(persisted, input.correlationId);
  }

  private scheduleBusinessOutcomeUpdateWithoutHidingDurableSuccess(
    reservation: SecuredReservationHold,
    occurredAt: Date,
  ): void {
    try {
      this.scheduleBusinessOutcomeUpdate(() => {
        void this.publishBusinessOutcomeUpdateWithoutHidingDurableSuccess(reservation, occurredAt);
      });
    } catch (error) {
      this.reportBusinessOutcomeUpdateFailureSafely(error, reservation);
    }
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
      this.reportBusinessOutcomeUpdateFailureSafely(error, reservation);
    }
  }

  private reportBusinessOutcomeUpdateFailureSafely(
    error: unknown,
    reservation: SecuredReservationHold,
  ): void {
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

  private async withPersistenceAdmissionLock<T>(
    reservation: SecuredReservationHold,
    operation: (persistence: BuyPersistenceOperations) => Promise<T>,
  ): Promise<T> {
    if (reservation.runId && this.persistence.withRunAdmissionLock) {
      return this.persistence.withRunAdmissionLock({ reservation, operation });
    }

    return operation(this.persistence);
  }

  private async enqueuePersistedBuy(
    persisted: PersistedBuyAcceptance,
    idempotencyKey: string,
    reservation: SecuredReservationHold,
  ): Promise<void> {
    const enqueue = async (): Promise<void> => {
      try {
        // PostgreSQL and BullMQ are not atomic. Every durable replay re-asserts this
        // deterministic job before Redis can be promoted to an accepted response.
        await this.orderProcessJobPublisher.enqueue(this.toOrderProcessJob(persisted));
        this.scheduleQueueSnapshot(reservation);
      } catch (error) {
        safelyReportPartialFailure(this.reportOrderEnqueueFailure, {
          ...this.partialFailureReport(error, idempotencyKey, reservation),
          orderId: persisted.order.id,
        });
        throw error;
      }
    };

    await enqueue();
  }

  private scheduleInventorySnapshot(reservation: SecuredReservationHold): void {
    try {
      this.dashboardSnapshotPublications.scheduleInventory({
        saleOfferId: reservation.saleOfferId,
        ...(reservation.runId ? { runId: reservation.runId } : {}),
        correlationId: reservation.correlationId,
      });
    } catch {
      // Advisory dashboard scheduling cannot change a fresh Redis reservation decision.
    }
  }

  private scheduleQueueSnapshot(reservation: SecuredReservationHold): void {
    try {
      this.dashboardSnapshotPublications.scheduleQueue({
        ...(reservation.runId ? { runId: reservation.runId } : {}),
        correlationId: reservation.correlationId,
      });
    } catch {
      // Advisory dashboard scheduling cannot hide a successful durable enqueue.
    }
  }

  private toOrderProcessJob(persisted: PersistedBuyAcceptance): OrderProcessJob {
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
    persistence: BuyPersistenceOperations,
  ): Promise<void> {
    if (!persistence.recordPendingPersistence) {
      return;
    }

    try {
      await persistence.recordPendingPersistence({ idempotencyKey, reservation });
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

  private acceptedResponse(persisted: PersistedBuyAcceptance, correlationId: string): BuyResponse {
    return buyResponseSchema.parse({
      outcome: "reservation_secured",
      correlationId,
      timestamp: persisted.reservation.securedAt,
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
    outcome: RejectedReservationOutcome,
    correlationId: string,
    now: Date,
  ): BuyResponse {
    return buyResponseSchema.parse({
      outcome,
      reason: outcome,
      correlationId,
      timestamp: now.toISOString(),
      reservation: null,
      order: null,
      simulatedStatus: simulatedStatusForRejectedOutcome(outcome),
    });
  }
}
