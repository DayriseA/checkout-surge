import type { OrderProcessJob } from "@checkout-surge/contracts";
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

export type OrderTransitionResult =
  | { status: "processing"; resumed: boolean }
  | { status: "confirmed" | "failed"; resumed: false };

export interface OrderFailure {
  code: string;
  message: string;
}

export interface OrderTransitionPersistence {
  transitionToProcessing(
    job: OrderProcessJob,
    delivery: OrderProcessDeliveryMetadata,
  ): Promise<OrderTransitionResult>;
  transitionToConfirmed(
    job: OrderProcessJob,
    delivery: OrderProcessDeliveryMetadata,
  ): Promise<void>;
  transitionToFailed(
    job: OrderProcessJob,
    failure: OrderFailure,
    delivery: OrderProcessDeliveryMetadata,
  ): Promise<void>;
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
      let transition: OrderTransitionResult;
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

      if (!transition.resumed) {
        await publishBusinessOutcomeUpdateWithoutFailingJob(
          dependencies,
          job,
          "processing",
          logger,
        );
      }

      logger.info(
        { ...logContext, resumed: transition.resumed },
        transition.resumed
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
          await publishBusinessOutcomeUpdateWithoutFailingJob(
            dependencies,
            job,
            "retrying",
            logger,
          );
          throw confirmationError;
        }

        const failure = toOrderFailure(
          confirmationError,
          temporary && !remainingAttempts ? "erp_retries_exhausted" : undefined,
        );

        try {
          await dependencies.persistence.transitionToFailed(job, failure, delivery);
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
        await publishBusinessOutcomeUpdateWithoutFailingJob(dependencies, job, "failed", logger);
        throw confirmationError;
      }

      try {
        await dependencies.persistence.transitionToConfirmed(job, delivery);
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
      await publishNotificationRecordJobWithoutFailingOrder(
        dependencies,
        job,
        new Date().toISOString(),
        logger,
      );
      await publishBusinessOutcomeUpdateWithoutFailingJob(dependencies, job, "confirmed", logger);
      logger.info(logContext, "Order transitioned to confirmed.");
    },
  };
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
