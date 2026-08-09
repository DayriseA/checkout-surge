import type { OrderProcessJob } from "@checkout-surge/contracts";
import { type CheckoutSurgeLogger, childLoggerWithCorrelationId } from "@checkout-surge/logger";

export interface OrderProcessDeliveryMetadata {
  attemptNumber: number;
  attemptsMade: number;
  maxAttempts: number;
  recoveryKey?: string;
  /** Stable BullMQ/durable publication identity for this delivery. */
  deliveryId?: string;
}

export interface OrderProcessJobHandler {
  handle(job: OrderProcessJob, delivery: OrderProcessDeliveryMetadata): Promise<void>;
}

export type ProcessingTransitionResult =
  | { changed: false; status: "processing" | "confirmed" | "failed" }
  | { changed: true; status: "processing" };
export type FailedTransitionResult =
  | { changed: false; status: "failed" }
  | { changed: true; status: "failed" };
export type ConfirmedTransitionResult =
  | { changed: false; status: "confirmed" }
  | {
      changed: true;
      status: "confirmed";
      confirmedAt: Date;
    };
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
  resolve(input: { recoveryKey: string }): Promise<void>;
}

export interface NotificationRecordPublisher {
  publishForConfirmedOrder(job: OrderProcessJob, confirmedAt: string): Promise<void>;
}

type BusinessOutcomeTransition = "processing" | "retrying" | "confirmed" | "failed";

type BusinessOutcomeUpdatePublisher = (
  job: OrderProcessJob,
  transition: BusinessOutcomeTransition,
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

export function createOrderProcessJobHandler(dependencies: {
  confirmation: OrderConfirmation;
  persistence: OrderTransitionPersistence;
  logger: CheckoutSurgeLogger;
  isTemporaryConfirmationFailure?: (error: unknown) => boolean;
  shouldRetryWithoutFailingOrder?: (error: unknown) => boolean;
  publishBusinessOutcomeUpdate: BusinessOutcomeUpdatePublisher;
  notificationRecordPublisher: NotificationRecordPublisher;
  recovery: OrderRecoveryHandoff;
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
        if (!hasRemainingAttempts(delivery)) {
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
        if (isPersistenceLikeError(confirmationError) && !remainingAttempts) {
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
          const failedTransition = await dependencies.persistence.transitionToFailed(
            job,
            failure,
            delivery,
          );
          if (failedTransition.changed) {
            await publishBusinessOutcomeUpdateWithoutFailingJob(
              dependencies,
              job,
              "failed",
              logger,
            );
          }
        } catch (persistenceError) {
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
          await publishBusinessOutcomeUpdateWithoutFailingJob(
            dependencies,
            job,
            "confirmed",
            logger,
          );
        }
      } catch (persistenceError) {
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
        throw persistenceError;
      }
      if (delivery.recoveryKey) {
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

async function publishNotificationRecordJobWithoutFailingOrder(
  dependencies: {
    notificationRecordPublisher: NotificationRecordPublisher;
  },
  job: OrderProcessJob,
  confirmedAt: string,
  logger: CheckoutSurgeLogger,
): Promise<void> {
  try {
    await dependencies.notificationRecordPublisher.publishForConfirmedOrder(job, confirmedAt);
  } catch (error) {
    try {
      logger.error(
        {
          err: error,
          orderId: job.orderId,
          saleOfferId: job.saleOfferId,
          ...(job.runId ? { runId: job.runId } : {}),
          correlationId: job.correlationId,
        },
        "Order confirmed but notification-recording job publication failed.",
      );
    } catch {
      // Logging must not fail the durable confirmed transition.
    }
  }
}

async function publishBusinessOutcomeUpdateWithoutFailingJob(
  dependencies: {
    publishBusinessOutcomeUpdate: BusinessOutcomeUpdatePublisher;
  },
  job: OrderProcessJob,
  transition: BusinessOutcomeTransition,
  logger: CheckoutSurgeLogger,
): Promise<void> {
  try {
    await dependencies.publishBusinessOutcomeUpdate(job, transition);
  } catch (error) {
    try {
      logger.error(
        {
          err: error,
          orderId: job.orderId,
          saleOfferId: job.saleOfferId,
          ...(job.runId ? { runId: job.runId } : {}),
          correlationId: job.correlationId,
          transition,
        },
        "Order transition succeeded but dashboard business outcome publication failed.",
      );
    } catch {
      // Logging must not fail the durable order transition.
    }
  }
}

export function hasRemainingAttempts(delivery: OrderProcessDeliveryMetadata): boolean {
  return delivery.attemptNumber < delivery.maxAttempts;
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
  recovery: OrderRecoveryHandoff,
  job: OrderProcessJob,
  delivery: OrderProcessDeliveryMetadata,
  error: unknown,
): Promise<void> {
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
