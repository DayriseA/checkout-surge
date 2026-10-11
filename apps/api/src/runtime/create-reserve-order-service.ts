import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import {
  type BusinessOutcomeUpdateFailureReport,
  type OrderEnqueueFailureReport,
  type ReservationPartialFailureReport,
  ReserveOrderService,
} from "../services/reserve-order-service.js";

export function createReserveOrderService(
  options: ConstructorParameters<typeof ReserveOrderService>[0],
  logger: CheckoutSurgeLogger,
): ReserveOrderService {
  const businessOutcomePublications = {
    markDirty: options.publishBusinessOutcomeUpdate ?? (async () => undefined),
  };
  return new ReserveOrderService({
    ...options,
    reportPersistenceFailure: (report) => {
      logger.error(
        partialFailureLogContext(report),
        "Redis secured a reservation but PostgreSQL persistence failed.",
      );
    },
    reportPendingPersistenceEnsureFailure: (report) => {
      logger.error(
        partialFailureLogContext(report),
        "Could not ensure the Redis pending-persistence marker.",
      );
    },
    reportPromotionFailure: (report) => {
      logger.error(
        partialFailureLogContext(report),
        "Durable reservation succeeded but Redis idempotency promotion failed.",
      );
    },
    reportOrderEnqueueFailure: (report) => {
      logger.error(
        orderEnqueueFailureLogContext(report),
        "Durable reservation succeeded but order-processing enqueue failed.",
      );
    },
    reportReservationReversalFailure: (report) => {
      logger.error(
        partialFailureLogContext(report),
        "Could not reverse a definitively rejected Redis reservation hold.",
      );
    },
    publishBusinessOutcomeUpdate: async (input) => businessOutcomePublications.markDirty(input),
    scheduleBusinessOutcomeUpdate: (task) => task(),
    reportBusinessOutcomeUpdateFailure: (report) => {
      logger.error(
        businessOutcomeUpdateFailureLogContext(report),
        "Durable reservation succeeded but dashboard business outcome publication failed.",
      );
    },
  });
}
function orderEnqueueFailureLogContext(report: OrderEnqueueFailureReport) {
  return { ...partialFailureLogContext(report), orderId: report.orderId };
}

function partialFailureLogContext(report: ReservationPartialFailureReport) {
  return {
    err: report.error,
    reservationId: report.reservationId,
    saleOfferId: report.saleOfferId,
    runId: report.runId,
    correlationId: report.correlationId,
    idempotencyKey: report.idempotencyKey,
  };
}

function businessOutcomeUpdateFailureLogContext(report: BusinessOutcomeUpdateFailureReport) {
  return {
    err: report.error,
    saleOfferId: report.saleOfferId,
    runId: report.runId,
    correlationId: report.correlationId,
  };
}
