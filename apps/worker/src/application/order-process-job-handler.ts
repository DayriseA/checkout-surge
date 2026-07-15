import type {
  OrderConsistencyLagDashboardEvent,
  OrderProcessJob,
  OrderStatusDashboardEvent,
} from "@checkout-surge/contracts";
import { createHash } from "node:crypto";
import { type CheckoutSurgeLogger, childLoggerWithCorrelationId } from "@checkout-surge/logger";

export interface OrderProcessDeliveryMetadata {
  attemptNumber: number;
  attemptsMade: number;
  maxAttempts?: number;
  recoveryKey?: string;
  /** Stable BullMQ/durable publication identity for this delivery. */
  deliveryId?: string;
}

export interface OrderProcessJobHandler {
  handle(job: OrderProcessJob, delivery: OrderProcessDeliveryMetadata): Promise<void>;
}

export type ProcessingTransitionResult =
  | { changed: false; status: "processing" | "confirmed" | "failed" }
  | {
      changed: true;
      eventId: string;
      previousStatus: "queued";
      status: "processing";
      occurredAt: Date;
      queuedAt: Date;
    };
export type FailedTransitionResult =
  | { changed: false; status: "failed" }
  | {
      changed: true;
      eventId: string;
      previousStatus: "processing";
      status: "failed";
      occurredAt: Date;
      queuedAt: Date;
    };
export type ConfirmedTransitionResult =
  | { changed: false; status: "confirmed" }
  | {
      changed: true;
      eventId: string;
      previousStatus: "processing";
      status: "confirmed";
      occurredAt: Date;
      queuedAt: Date;
      confirmedAt: Date;
    };
export type FreshOrderTransition = Extract<
  ProcessingTransitionResult | FailedTransitionResult | ConfirmedTransitionResult,
  { changed: true }
>;

export interface OrderFailure {
  code: string;
  message: string;
}

export interface OrderTransitionPersistence {
  transitionToProcessing(
    job: OrderProcessJob,
    delivery: OrderProcessDeliveryMetadata,
  ): Promise<ProcessingTransitionResult>;
  transitionToConfirmed(
    job: OrderProcessJob,
    delivery: OrderProcessDeliveryMetadata,
  ): Promise<ConfirmedTransitionResult>;
  transitionToFailed(
    job: OrderProcessJob,
    failure: OrderFailure,
    delivery: OrderProcessDeliveryMetadata,
  ): Promise<FailedTransitionResult>;
}

export interface OrderRealtimePublisher {
  enqueue(events: readonly [OrderStatusDashboardEvent] | readonly [OrderStatusDashboardEvent, OrderConsistencyLagDashboardEvent]): void;
}

export interface OrderConfirmation {
  confirm(job: OrderProcessJob, delivery: OrderProcessDeliveryMetadata): Promise<unknown>;
}

export interface RecoverableOrderHandoff {
  job: OrderProcessJob;
  delivery: OrderProcessDeliveryMetadata;
  reason: string;
  error: unknown;
  accepted?: boolean;
  attempt?: unknown;
  /** Identity of the failed source delivery/disposition, when known. */
  sourceJobId?: string;
  sourceDisposition?: string;
}

export interface OrderRecoveryHandoff {
  handoff(input: RecoverableOrderHandoff): Promise<void>;
  resolve?(input: { recoveryKey: string }): Promise<void>;
}

export interface NotificationRecordPublisher {
  publishForConfirmedOrder(job: OrderProcessJob, confirmedAt: string): Promise<void>;
}

export interface BusinessOutcomeUpdateFailureReport {
  error: unknown;
  orderId: string;
  saleOfferId: string;
  runId?: string;
  correlationId: string;
  transition: "processing" | "retrying" | "confirmed" | "failed";
}

type BusinessOutcomeUpdatePublisher = (
  job: OrderProcessJob,
  transition: BusinessOutcomeUpdateFailureReport["transition"],
) => Promise<void>;

export class OrderFailurePersistenceError extends AggregateError {
  override readonly name = "OrderFailurePersistenceError";

  constructor(
    readonly confirmationError: unknown,
    readonly persistenceError: unknown,
  ) {
    super(
      [confirmationError, persistenceError],
      "Order confirmation failed and the terminal failure could not be persisted.",
      { cause: confirmationError },
    );
  }
}

export class OrderRecoveryHandoffError extends AggregateError {
  override readonly name = "OrderRecoveryHandoffError";

  constructor(
    readonly sourceError: unknown,
    readonly handoffError: unknown,
  ) {
    super([sourceError, handoffError], "Durable order recovery handoff failed.", {
      cause: sourceError,
    });
  }
}

export class OrderProcessingPersistenceError extends Error {
  override readonly name = "OrderProcessingPersistenceError";

  constructor(readonly causeError: unknown) {
    super("Order processing state could not be persisted.", { cause: causeError });
  }
}

export function createLocalOrderConfirmation(): OrderConfirmation {
  return {
    confirm: async () => undefined,
  };
}

export function createOrderProcessJobHandler(dependencies: {
  confirmation: OrderConfirmation;
  persistence: OrderTransitionPersistence;
  logger: CheckoutSurgeLogger;
  isTemporaryConfirmationFailure?: (error: unknown) => boolean;
  shouldRetryWithoutFailingOrder?: (error: unknown) => boolean;
  publishBusinessOutcomeUpdate?: BusinessOutcomeUpdatePublisher;
  reportBusinessOutcomeUpdateFailure?: (report: BusinessOutcomeUpdateFailureReport) => void;
  notificationRecordPublisher?: NotificationRecordPublisher;
  reportNotificationRecordPublishFailure?: (report: {
    error: unknown;
    orderId: string;
    saleOfferId: string;
    runId?: string;
    correlationId: string;
  }) => void;
  recovery?: OrderRecoveryHandoff;
  realtimePublisher?: OrderRealtimePublisher;
  reportConsistencyLagClockAnomaly?: (report: {
    orderId: string;
    publicOrderId: string;
    saleOfferId: string;
    runId?: string;
    correlationId: string;
    startedAt: string;
    confirmedAt: string;
    rawLagMs: number;
    clampedLagMs: number;
  }) => void;
}): OrderProcessJobHandler {
  return {
    handle: async (job, delivery) => {
      const logger = childLoggerWithCorrelationId(dependencies.logger, job.correlationId);
      const logContext = {
        orderId: job.orderId,
        reservationId: job.reservationId,
        saleOfferId: job.saleOfferId,
        ...(job.runId ? { runId: job.runId } : {}),
        attemptNumber: delivery.attemptNumber,
        attemptsMade: delivery.attemptsMade,
      };
      let transition: ProcessingTransitionResult;
      try {
        transition = await dependencies.persistence.transitionToProcessing(job, delivery);
      } catch (error) {
        // Missing/mismatched orders remain poison jobs and are handled by the
        // consumer's DLQ path. Other failures happen before ERP is called and
        // must retain recovery ownership on the last delivery.
        if (isOrderPoisonError(error)) throw error;
        const persistenceError = new OrderProcessingPersistenceError(error);
        if (dependencies.recovery && !hasRemainingAttempts(delivery)) {
          await handoffOrThrow(
            dependencies.recovery,
            {
              job,
              delivery,
              reason: "order_processing_persistence_unavailable",
              error: persistenceError,
            },
            persistenceError,
          );
        }
        throw persistenceError;
      }

      if (transition.status !== "processing") {
        logger.info(
          { ...logContext, orderStatus: transition.status },
          "Terminal order delivery acknowledged without reprocessing.",
        );
        return;
      }

      if (transition.changed) {
        enqueueRealtimeEvents(dependencies, job, delivery, transition, logger);
        await publishBusinessOutcomeUpdateWithoutFailingJob(
          dependencies,
          job,
          "processing",
          logger,
        );
      }

      logger.info(
        { ...logContext, resumed: !transition.changed },
        !transition.changed
          ? "Resuming order confirmation from processing state."
          : "Order transitioned to processing.",
      );

      let confirmationResult: unknown;
      try {
        confirmationResult = await dependencies.confirmation.confirm(job, delivery);
      } catch (confirmationError) {
        if (isAcceptedConfirmationPersistenceError(confirmationError)) {
          await handoffAcceptedResult(dependencies.recovery, job, delivery, confirmationError);
          throw confirmationError;
        }

        const shouldRetryWithoutFailingOrder =
          dependencies.shouldRetryWithoutFailingOrder?.(confirmationError) ?? false;
        const temporary = dependencies.isTemporaryConfirmationFailure?.(confirmationError) ?? false;
        const remainingAttempts = hasRemainingAttempts(delivery);
        if (
          dependencies.recovery &&
          isPersistenceLikeError(confirmationError) &&
          !remainingAttempts
        ) {
          await handoffOrThrow(
            dependencies.recovery,
            {
              job,
              delivery,
              reason: "erp_local_persistence_unavailable",
              error: confirmationError,
            },
            confirmationError,
          );
          throw confirmationError;
        }
        if (shouldRetryWithoutFailingOrder || (temporary && remainingAttempts)) {
          logger.warn(
            { ...logContext, err: confirmationError },
            shouldRetryWithoutFailingOrder
              ? "Order confirmation failure will be retried without marking the order failed."
              : "Temporary order confirmation failure will be retried.",
          );
          if (freshErpAttemptWasRecorded(confirmationError)) {
            await publishBusinessOutcomeUpdateWithoutFailingJob(
              dependencies,
              job,
              "retrying",
              logger,
            );
          }
          throw confirmationError;
        }

        const failure = toOrderFailure(
          confirmationError,
          temporary && !remainingAttempts ? "erp_retries_exhausted" : undefined,
        );

        try {
          const failedTransition = await dependencies.persistence.transitionToFailed(job, failure, delivery);
          if (failedTransition.changed) {
            enqueueRealtimeEvents(dependencies, job, delivery, failedTransition, logger);
            await publishBusinessOutcomeUpdateWithoutFailingJob(dependencies, job, "failed", logger);
          }
        } catch (persistenceError) {
          if (dependencies.recovery) {
            await handoffOrThrow(
              dependencies.recovery,
              {
                job,
                delivery,
                reason: "terminal_failure_persistence_unavailable",
                error: persistenceError,
              },
              persistenceError,
            );
          }
          logger.error(
            { ...logContext, err: confirmationError, persistenceError },
            "Order confirmation and failure persistence both failed.",
          );
          throw new OrderFailurePersistenceError(confirmationError, persistenceError);
        }

        logger.error(
          { ...logContext, err: confirmationError, failureCode: failure.code },
          "Order confirmation failed and the order transitioned to failed.",
        );
        throw confirmationError;
      }

      let confirmedTransition: ConfirmedTransitionResult;
      try {
        confirmedTransition = await dependencies.persistence.transitionToConfirmed(job, delivery);
        if (confirmedTransition.changed) {
          enqueueRealtimeEvents(dependencies, job, delivery, confirmedTransition, logger);
          await publishBusinessOutcomeUpdateWithoutFailingJob(
            dependencies,
            job,
            "confirmed",
            logger,
          );
        }
      } catch (persistenceError) {
        if (dependencies.recovery) {
          await handoffOrThrow(
            dependencies.recovery,
            {
              job,
              delivery,
              reason: "confirmed_transition_persistence_unavailable",
              error: persistenceError,
              accepted: true,
              attempt: confirmationResult,
            },
            persistenceError,
          );
        }
        throw persistenceError;
      }
      if (dependencies.recovery?.resolve && delivery.recoveryKey) {
        try {
          await dependencies.recovery.resolve({ recoveryKey: delivery.recoveryKey });
        } catch (resolveError) {
          logger.warn(
            { ...logContext, err: resolveError, recoveryKey: delivery.recoveryKey },
            "Confirmed order could not close its recovery record; scanner will reconcile it.",
          );
        }
      }
      if (confirmedTransition.changed && confirmedTransition.status === "confirmed") {
        await publishNotificationRecordJobWithoutFailingOrder(
          dependencies,
          job,
          confirmedTransition.confirmedAt.toISOString(),
          logger,
        );
      }
      logger.info(logContext, "Order transitioned to confirmed.");
    },
  };
}

function enqueueRealtimeEvents(
  dependencies: Pick<Parameters<typeof createOrderProcessJobHandler>[0], "realtimePublisher" | "reportConsistencyLagClockAnomaly">,
  job: OrderProcessJob,
  delivery: OrderProcessDeliveryMetadata,
  transition: FreshOrderTransition,
  logger: CheckoutSurgeLogger,
): void {
  if (!dependencies.realtimePublisher) return;
  const occurredAt = transition.occurredAt.toISOString();
  const eventName = `order.${transition.status}` as OrderStatusDashboardEvent["eventName"];
  const statusEvent: OrderStatusDashboardEvent = {
    type: "order.status.updated",
    eventId: transition.eventId,
    ...(job.runId ? { runId: job.runId } : {}),
    correlationId: job.correlationId,
    occurredAt,
    orderId: job.orderId,
    publicOrderId: job.publicOrderId,
    saleOfferId: job.saleOfferId,
    eventName,
    previousStatus: transition.previousStatus,
    status: transition.status,
    attemptNumber: delivery.attemptNumber,
    attemptsMade: delivery.attemptsMade,
  };
  try {
    if (transition.status !== "confirmed") {
      dependencies.realtimePublisher.enqueue([statusEvent]);
      return;
    }
    const startedAt = transition.queuedAt.toISOString();
    const confirmedAt = transition.confirmedAt.toISOString();
    const rawLagMs = transition.confirmedAt.getTime() - transition.queuedAt.getTime();
    if (rawLagMs < 0) {
      const report = {
        orderId: job.orderId,
        publicOrderId: job.publicOrderId,
        saleOfferId: job.saleOfferId,
        ...(job.runId ? { runId: job.runId } : {}),
        correlationId: job.correlationId,
        startedAt,
        confirmedAt,
        rawLagMs,
        clampedLagMs: 0,
      };
      try {
        dependencies.reportConsistencyLagClockAnomaly?.(report);
      } catch {
        // Reporting must not affect the durable transition.
      }
      logger.warn(report, "Confirmed order consistency lag clock anomaly was clamped to zero.");
    }
    dependencies.realtimePublisher.enqueue([
      statusEvent,
      {
        type: "order.consistency_lag.observed",
        eventId: deriveLagEventId(transition.eventId),
        confirmedTransitionEventId: transition.eventId,
        ...(job.runId ? { runId: job.runId } : {}),
        correlationId: job.correlationId,
        occurredAt: confirmedAt,
        metricName: "order.consistency_lag",
        value: Math.max(0, rawLagMs),
        unit: "ms",
        observedAt: confirmedAt,
        orderId: job.orderId,
        publicOrderId: job.publicOrderId,
        saleOfferId: job.saleOfferId,
        startedAt,
        confirmedAt,
      },
    ]);
  } catch (error) {
    logger.error({ err: error, orderId: job.orderId, eventId: transition.eventId }, "Order realtime enqueue failed.");
  }
}

function deriveLagEventId(transitionEventId: string): string {
  const hex = createHash("sha256").update(`order.consistency_lag:${transitionEventId}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

async function publishNotificationRecordJobWithoutFailingOrder(
  dependencies: {
    notificationRecordPublisher?: NotificationRecordPublisher;
    reportNotificationRecordPublishFailure?: (report: {
      error: unknown;
      orderId: string;
      saleOfferId: string;
      runId?: string;
      correlationId: string;
    }) => void;
  },
  job: OrderProcessJob,
  confirmedAt: string,
  logger: CheckoutSurgeLogger,
): Promise<void> {
  if (!dependencies.notificationRecordPublisher) {
    return;
  }

  try {
    await dependencies.notificationRecordPublisher.publishForConfirmedOrder(job, confirmedAt);
  } catch (error) {
    const report = {
      error,
      orderId: job.orderId,
      saleOfferId: job.saleOfferId,
      ...(job.runId ? { runId: job.runId } : {}),
      correlationId: job.correlationId,
    };

    if (dependencies.reportNotificationRecordPublishFailure) {
      try {
        dependencies.reportNotificationRecordPublishFailure(report);
      } catch {
        // Reporting is non-critical; the confirmed order remains authoritative.
      }
      return;
    }

    logger.error(report, "Confirmed order notification job publication failed.");
  }
}

async function publishBusinessOutcomeUpdateWithoutFailingJob(
  dependencies: {
    publishBusinessOutcomeUpdate?: BusinessOutcomeUpdatePublisher;
    reportBusinessOutcomeUpdateFailure?: (report: BusinessOutcomeUpdateFailureReport) => void;
  },
  job: OrderProcessJob,
  transition: BusinessOutcomeUpdateFailureReport["transition"],
  logger: CheckoutSurgeLogger,
): Promise<void> {
  if (!dependencies.publishBusinessOutcomeUpdate) {
    return;
  }

  try {
    await dependencies.publishBusinessOutcomeUpdate(job, transition);
  } catch (error) {
    const report: BusinessOutcomeUpdateFailureReport = {
      error,
      orderId: job.orderId,
      saleOfferId: job.saleOfferId,
      ...(job.runId ? { runId: job.runId } : {}),
      correlationId: job.correlationId,
      transition,
    };

    if (dependencies.reportBusinessOutcomeUpdateFailure) {
      try {
        dependencies.reportBusinessOutcomeUpdateFailure(report);
      } catch {
        // Reporting is non-critical; the durable order transition remains authoritative.
      }
      return;
    }

    logger.error(report, "Dashboard business outcome publication failed.");
  }
}

function hasRemainingAttempts(delivery: OrderProcessDeliveryMetadata): boolean {
  return delivery.maxAttempts !== undefined && delivery.attemptNumber < delivery.maxAttempts;
}

function isAcceptedConfirmationPersistenceError(error: unknown): error is {
  record?: unknown;
} {
  return (
    error instanceof Error &&
    (error.name === "ErpAcceptedConfirmationPersistenceError" || "record" in error)
  );
}

function isPersistenceLikeError(error: unknown): boolean {
  return error instanceof Error && error.name.includes("PersistenceError");
}

function freshErpAttemptWasRecorded(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "attemptRecorded" in error &&
    (error as { attemptRecorded?: unknown }).attemptRecorded === true
  );
}

function isOrderPoisonError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "OrderNotFoundError" || error.name === "OrderJobIdentityMismatchError")
  );
}

async function handoffAcceptedResult(
  recovery: OrderRecoveryHandoff | undefined,
  job: OrderProcessJob,
  delivery: OrderProcessDeliveryMetadata,
  error: unknown,
): Promise<void> {
  if (!recovery) return;
  const record =
    error instanceof Error && "record" in error
      ? (error as { record?: unknown }).record
      : undefined;
  await handoffOrThrow(
    recovery,
    {
      job,
      delivery,
      reason: "erp_accepted_local_persistence_incomplete",
      error,
      accepted: true,
      attempt: record,
    },
    error,
  );
}

async function handoffOrThrow(
  recovery: OrderRecoveryHandoff,
  input: RecoverableOrderHandoff,
  sourceError: unknown,
): Promise<void> {
  try {
    await recovery.handoff(input);
  } catch (handoffError) {
    throw new OrderRecoveryHandoffError(sourceError, handoffError);
  }
}

function toOrderFailure(error: unknown, code = "order_confirmation_failed"): OrderFailure {
  return {
    code,
    message: error instanceof Error ? error.message : "Order confirmation failed.",
  };
}
