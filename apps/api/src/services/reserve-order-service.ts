import { randomUUID } from "node:crypto";
import {
  type AcceptedOrderSummary,
  type AcceptedReservationSummary,
  type BackpressureConfig,
  type BuyRequest,
  type BuyResponse,
  buyResponseSchema,
  type OrderProcessJob,
  type ReservationRejectedResponse,
  type SecuredReservationHold,
  type StockReservationDecision,
} from "@checkout-surge/contracts";
import type {
  DashboardSourceDirtySchedulerPort,
  SoldOutObservationPort,
} from "./dashboard-source-dirty-scheduler.js";
import type { OrderProcessJobPublisher } from "./order-process-job-publisher.js";
import type { ReservationTimingObservationPort } from "./reservation-timing-observation.js";
import type { RunRetryPolicyResolver } from "./run-retry-policy-resolver.js";

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
}

export interface PendingPersistenceRecovery {
  recoverReservation(input: {
    reservation: SecuredReservationHold;
    idempotencyKey: string;
  }): Promise<PersistedBuyAcceptance | null>;
}

export interface BuyPersistence extends BuyPersistenceOperations {
  withRunAdmissionLock?<T>(input: {
    reservation: SecuredReservationHold;
    operation: (persistence: BuyPersistenceOperations) => Promise<T>;
  }): Promise<T>;
  withRunPendingPersistenceLock?<T>(input: {
    reservation: SecuredReservationHold;
    operation: (
      persistence: BuyPersistenceOperations,
      runDisposition: "admissible" | "terminal" | "invalid",
    ) => Promise<T>;
  }): Promise<T>;
}

export function isPersistedBuyForReservation(
  persisted: PersistedBuyAcceptance,
  reservation: SecuredReservationHold,
): boolean {
  return (
    persisted.reservation.id === reservation.id &&
    persisted.reservation.saleOfferId === reservation.saleOfferId &&
    persisted.reservation.correlationId === reservation.correlationId &&
    persisted.reservation.reservationToken === reservation.reservationToken &&
    persisted.reservation.quantity === reservation.quantity &&
    persisted.reservation.runId === reservation.runId &&
    persisted.reservation.securedAt === reservation.securedAt &&
    persisted.reservation.expiresAt === reservation.expiresAt &&
    persisted.order.reservationId === reservation.id &&
    persisted.order.saleOfferId === reservation.saleOfferId &&
    persisted.order.correlationId === reservation.correlationId &&
    persisted.order.quantity === reservation.quantity &&
    persisted.order.runId === reservation.runId &&
    persisted.order.queuedAt === reservation.securedAt
  );
}

function elapsedMilliseconds(startedAt: number, endedAt: number): number {
  return Math.max(endedAt - startedAt, 0);
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
    idempotencyTtlSeconds: number;
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

export class ReserveOrderService {
  private readonly persistence: BuyPersistence;
  private readonly stockReservations: StockReservationGateway;
  private readonly orderProcessJobPublisher: OrderProcessJobPublisher;
  private readonly runRetryPolicyResolver: RunRetryPolicyResolver | undefined;
  private readonly reservationHoldMinutes: number;
  private readonly idempotencyTtlSeconds: number;
  private readonly pendingPersistenceRetryAfterSeconds: number;
  private readonly pendingPersistenceRecovery: PendingPersistenceRecovery;
  private readonly generateId: () => string;
  private readonly reportPersistenceFailure: ReservationPartialFailureReporter;
  private readonly reportPendingPersistenceEnsureFailure: ReservationPartialFailureReporter;
  private readonly reportPromotionFailure: ReservationPartialFailureReporter;
  private readonly reportOrderEnqueueFailure: (report: OrderEnqueueFailureReport) => void;
  private readonly reportReservationReversalFailure: ReservationPartialFailureReporter;
  private readonly publishBusinessOutcomeUpdate: BusinessOutcomeUpdatePublisher;
  private readonly scheduleBusinessOutcomeUpdate: BusinessOutcomeUpdateScheduler;
  private readonly reportBusinessOutcomeUpdateFailure: (
    report: BusinessOutcomeUpdateFailureReport,
  ) => void;
  private readonly dashboardSourceDirtyScheduler: DashboardSourceDirtySchedulerPort;
  private readonly soldOutObservations: SoldOutObservationPort;
  private readonly reservationTimingObservations: ReservationTimingObservationPort;
  private readonly monotonicNow: () => number;

  constructor(options: {
    persistence: BuyPersistence;
    stockReservations: StockReservationGateway;
    orderProcessJobPublisher: OrderProcessJobPublisher;
    runRetryPolicyResolver?: RunRetryPolicyResolver;
    reservationHoldMinutes: number;
    idempotencyTtlSeconds: number;
    pendingPersistenceRetryAfterSeconds: number;
    pendingPersistenceRecovery: PendingPersistenceRecovery;
    generateId?: () => string;
    reportPersistenceFailure?: ReservationPartialFailureReporter;
    reportPendingPersistenceEnsureFailure?: ReservationPartialFailureReporter;
    reportPromotionFailure?: ReservationPartialFailureReporter;
    reportOrderEnqueueFailure?: (report: OrderEnqueueFailureReport) => void;
    reportReservationReversalFailure?: ReservationPartialFailureReporter;
    publishBusinessOutcomeUpdate?: BusinessOutcomeUpdatePublisher;
    scheduleBusinessOutcomeUpdate?: BusinessOutcomeUpdateScheduler;
    reportBusinessOutcomeUpdateFailure?: (report: BusinessOutcomeUpdateFailureReport) => void;
    dashboardSourceDirtyScheduler?: DashboardSourceDirtySchedulerPort;
    soldOutObservations?: SoldOutObservationPort;
    reservationTimingObservations?: ReservationTimingObservationPort;
    monotonicNow?: () => number;
  }) {
    this.persistence = options.persistence;
    this.stockReservations = options.stockReservations;
    this.orderProcessJobPublisher = options.orderProcessJobPublisher;
    this.runRetryPolicyResolver = options.runRetryPolicyResolver;
    this.reservationHoldMinutes = options.reservationHoldMinutes;
    this.idempotencyTtlSeconds = options.idempotencyTtlSeconds;
    this.pendingPersistenceRetryAfterSeconds = options.pendingPersistenceRetryAfterSeconds;
    this.pendingPersistenceRecovery = options.pendingPersistenceRecovery;
    this.generateId = options.generateId ?? randomUUID;
    this.reportPersistenceFailure = options.reportPersistenceFailure ?? (() => undefined);
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
    this.dashboardSourceDirtyScheduler = options.dashboardSourceDirtyScheduler ?? {
      scheduleInventory: () => undefined,
      scheduleQueue: () => undefined,
    };
    this.soldOutObservations = options.soldOutObservations ?? { observeSoldOut: () => undefined };
    this.reservationTimingObservations = options.reservationTimingObservations ?? {
      observe: () => undefined,
    };
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  async reserve(input: {
    request: BuyRequest;
    correlationId: string;
    now?: Date;
  }): Promise<BuyResponse> {
    const serviceStartedAt = this.monotonicNow();
    let redisAtomicReservationMs: number | undefined;
    try {
      return await this.performReservation(input, (durationMs) => {
        redisAtomicReservationMs = durationMs;
      });
    } finally {
      if (input.request.runId) {
        try {
          this.reservationTimingObservations.observe({
            runId: input.request.runId,
            reserveOrderServiceMs: elapsedMilliseconds(serviceStartedAt, this.monotonicNow()),
            ...(redisAtomicReservationMs === undefined ? {} : { redisAtomicReservationMs }),
          });
        } catch {
          // Timing observability is advisory and cannot alter the reservation outcome.
        }
      }
    }
  }

  private async performReservation(
    input: {
      request: BuyRequest;
      correlationId: string;
      now?: Date;
    },
    recordRedisDuration: (durationMs: number) => void,
  ): Promise<BuyResponse> {
    const now = input.now ?? new Date();

    const reservation = this.createReservationHold(input.request, input.correlationId, now);
    const redisStartedAt = this.monotonicNow();
    let decision: StockReservationDecision;
    try {
      decision = await this.stockReservations.reserve({
        idempotencyKey: input.request.idempotencyKey,
        idempotencyTtlSeconds: this.idempotencyTtlSeconds,
        reservation,
      });
    } finally {
      recordRedisDuration(elapsedMilliseconds(redisStartedAt, this.monotonicNow()));
    }

    if (decision.outcome === "sold_out") {
      try {
        this.soldOutObservations.observeSoldOut({
          saleOfferId: input.request.saleOfferId,
          ...(input.request.runId ? { runId: input.request.runId } : {}),
          correlationId: input.correlationId,
        });
      } catch {
        // Sold-out observability is advisory and cannot alter the rejection.
      }
      return this.rejectedResponse(decision.outcome, input.correlationId, now);
    }

    if (
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
    let retryPolicy: BackpressureConfig["retryPolicy"] | undefined;
    try {
      retryPolicy = await this.resolveRunRetryPolicy(input.reservation);
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
            return null;
          }

          await this.enqueuePersistedBuy(
            persisted,
            input.idempotencyKey,
            input.reservation,
            retryPolicy,
          );
          return persisted;
        },
      );
    } catch (error) {
      persisted = await this.classifyDefinitiveRejection({
        error,
        idempotencyKey: input.idempotencyKey,
        reservation: input.reservation,
        ...(retryPolicy ? { retryPolicy } : {}),
      });
    }

    if (!persisted) {
      await this.ensurePendingPersistence(input.idempotencyKey, input.reservation);
      return this.pendingResponse(input.reservation, input.correlationId, input.now);
    }

    await this.promoteWithoutHidingDurableSuccess(input.idempotencyKey, input.reservation);
    this.scheduleBusinessOutcomeUpdateWithoutHidingDurableSuccess(input.reservation);
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
    if (input.outcome === "reservation_pending_persistence") {
      let persisted: PersistedBuyAcceptance | null = null;
      try {
        persisted = await this.pendingPersistenceRecovery.recoverReservation({
          reservation: input.reservation,
          idempotencyKey: input.idempotencyKey,
        });
      } catch (error) {
        safelyReportPartialFailure(
          this.reportPersistenceFailure,
          this.partialFailureReport(error, input.idempotencyKey, input.reservation),
        );
      }
      if (!persisted) {
        await this.ensurePendingPersistence(input.idempotencyKey, input.reservation);
        return this.pendingResponse(input.reservation, input.correlationId, input.now);
      }
      return this.acceptedResponse(persisted, input.correlationId);
    }

    let persisted: PersistedBuyAcceptance | null;
    let retryPolicy: BackpressureConfig["retryPolicy"] | undefined;
    try {
      retryPolicy = await this.resolveRunRetryPolicy(input.reservation);
      persisted = await this.withPersistenceAdmissionLock(
        input.reservation,
        async (persistence) => {
          const existing = await persistence.getPersistedBuyByReservationId(input.reservation.id);
          if (existing) {
            await this.enqueuePersistedBuy(
              existing,
              input.idempotencyKey,
              input.reservation,
              retryPolicy,
            );
            return existing;
          }

          throw new Error(
            "Accepted Redis idempotency record has no durable reservation and order.",
          );
        },
      );
    } catch (error) {
      persisted = await this.classifyDefinitiveRejection({
        error,
        idempotencyKey: input.idempotencyKey,
        reservation: input.reservation,
        ...(retryPolicy ? { retryPolicy } : {}),
      });
    }

    if (!persisted) {
      await this.ensurePendingPersistence(input.idempotencyKey, input.reservation);
      return this.pendingResponse(input.reservation, input.correlationId, input.now);
    }

    await this.promoteWithoutHidingDurableSuccess(input.idempotencyKey, input.reservation);
    return this.acceptedResponse(persisted, input.correlationId);
  }

  private scheduleBusinessOutcomeUpdateWithoutHidingDurableSuccess(
    reservation: SecuredReservationHold,
  ): void {
    try {
      this.scheduleBusinessOutcomeUpdate(() => {
        void this.publishBusinessOutcomeUpdateWithoutHidingDurableSuccess(reservation);
      });
    } catch (error) {
      this.reportBusinessOutcomeUpdateFailureSafely(error, reservation);
    }
  }

  private async publishBusinessOutcomeUpdateWithoutHidingDurableSuccess(
    reservation: SecuredReservationHold,
  ): Promise<void> {
    try {
      await this.publishBusinessOutcomeUpdate({
        saleOfferId: reservation.saleOfferId,
        ...(reservation.runId ? { runId: reservation.runId } : {}),
        correlationId: reservation.correlationId,
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
    retryPolicy?: BackpressureConfig["retryPolicy"],
  ): Promise<void> {
    const enqueue = async (): Promise<void> => {
      try {
        // PostgreSQL and BullMQ are not atomic. Every durable replay re-asserts this
        // deterministic job before Redis can be promoted to an accepted response.
        const job = this.toOrderProcessJob(persisted);
        if (retryPolicy) {
          await this.orderProcessJobPublisher.enqueue(job, { retryPolicy });
        } else {
          await this.orderProcessJobPublisher.enqueue(job);
        }
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

  private async classifyDefinitiveRejection(input: {
    error: unknown;
    idempotencyKey: string;
    reservation: SecuredReservationHold;
    retryPolicy?: BackpressureConfig["retryPolicy"];
  }): Promise<PersistedBuyAcceptance> {
    if (!isDefinitivePersistenceRejection(input.error)) {
      throw input.error;
    }

    const durable = await this.persistence.getPersistedBuyByReservationId(input.reservation.id);
    if (durable) {
      if (!isPersistedBuyForReservation(durable, input.reservation)) {
        throw new Error(
          "Durable reservation/order attribution does not match the rejected Redis hold.",
          { cause: input.error },
        );
      }
      if (input.reservation.runId && !input.retryPolicy) {
        throw input.error;
      }
      await this.enqueuePersistedBuy(
        durable,
        input.idempotencyKey,
        input.reservation,
        input.retryPolicy,
      );
      return durable;
    }

    if (this.stockReservations.reverse) {
      await this.compensateHold(input.idempotencyKey, input.reservation, input.error);
    }
    throw input.error;
  }

  private async resolveRunRetryPolicy(
    reservation: SecuredReservationHold,
  ): Promise<BackpressureConfig["retryPolicy"] | undefined> {
    if (!reservation.runId || !this.runRetryPolicyResolver) return undefined;
    const retryPolicy = await this.runRetryPolicyResolver.resolve(reservation.runId);
    if (!retryPolicy) {
      throw new DefinitivePersistenceRejectionError(
        `Accepted run snapshot was not found for order job run ${reservation.runId}.`,
      );
    }
    return retryPolicy;
  }

  private scheduleInventorySnapshot(reservation: SecuredReservationHold): void {
    try {
      this.dashboardSourceDirtyScheduler.scheduleInventory({
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
      this.dashboardSourceDirtyScheduler.scheduleQueue({
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
      await this.stockReservations.promoteAccepted({
        idempotencyKey,
        idempotencyTtlSeconds: this.idempotencyTtlSeconds,
        reservation,
      });
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
      correlationId,
      timestamp: now.toISOString(),
      reservation: null,
      order: null,
    });
  }
}
