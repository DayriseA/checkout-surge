import type { OrderProcessJob } from "@checkout-surge/contracts";
import { type CheckoutSurgeLogger, childLoggerWithCorrelationId } from "@checkout-surge/logger";

export interface OrderProcessDeliveryMetadata {
  attemptNumber: number;
  attemptsMade: number;
  maxAttempts?: number;
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
  confirm(job: OrderProcessJob, delivery: OrderProcessDeliveryMetadata): Promise<void>;
}

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
      const transition = await dependencies.persistence.transitionToProcessing(job, delivery);

      if (transition.status !== "processing") {
        logger.info(
          { ...logContext, orderStatus: transition.status },
          "Terminal order delivery acknowledged without reprocessing.",
        );
        return;
      }

      logger.info(
        { ...logContext, resumed: transition.resumed },
        transition.resumed
          ? "Resuming order confirmation from processing state."
          : "Order transitioned to processing.",
      );

      try {
        await dependencies.confirmation.confirm(job, delivery);
      } catch (confirmationError) {
        if (
          dependencies.isTemporaryConfirmationFailure?.(confirmationError) &&
          hasRemainingAttempts(delivery)
        ) {
          logger.warn(
            { ...logContext, err: confirmationError },
            "Temporary order confirmation failure will be retried.",
          );
          throw confirmationError;
        }

        const failure = toOrderFailure(confirmationError);

        try {
          await dependencies.persistence.transitionToFailed(job, failure, delivery);
        } catch (persistenceError) {
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

      await dependencies.persistence.transitionToConfirmed(job, delivery);
      logger.info(logContext, "Order transitioned to confirmed.");
    },
  };
}

function hasRemainingAttempts(delivery: OrderProcessDeliveryMetadata): boolean {
  return delivery.maxAttempts !== undefined && delivery.attemptNumber < delivery.maxAttempts;
}

function toOrderFailure(error: unknown): OrderFailure {
  return {
    code: "order_confirmation_failed",
    message: error instanceof Error ? error.message : "Order confirmation failed.",
  };
}
