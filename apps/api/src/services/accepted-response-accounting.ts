import type {
  AcceptedRunConfigSnapshot,
  BusinessOutcomeSummary,
  TrafficDeliverySummary,
  TrafficHttpSummary,
} from "@checkout-surge/contracts";

export interface AcceptedResponseAccounting {
  rawAcceptedResponses: number;
  normalizedExpectedCount: number;
  reservationCount: number;
  orderCount: number;
  duplicateNormalizationApplied: boolean;
  accounted: boolean;
  counterUnderreported: boolean;
}

export function reconcileAcceptedResponses(input: {
  config: AcceptedRunConfigSnapshot;
  delivery: TrafficDeliverySummary;
  http: TrafficHttpSummary;
  business: BusinessOutcomeSummary;
}): AcceptedResponseAccounting {
  const duplicateNormalizationApplied = isCompleteDuplicateBuyerDelivery(
    input.config,
    input.delivery,
  );
  const normalizedExpectedCount = duplicateNormalizationApplied
    ? Math.ceil(input.http.acceptedResponses / 2)
    : input.http.acceptedResponses;
  const orderCount =
    input.business.queuedOrders +
    input.business.processingOrders +
    input.business.confirmedOrders +
    input.business.failedOrders;
  const reservationCount = input.business.acceptedReservations;

  return {
    rawAcceptedResponses: input.http.acceptedResponses,
    normalizedExpectedCount,
    reservationCount,
    orderCount,
    duplicateNormalizationApplied,
    accounted:
      input.business.pendingPersistenceCount === 0 &&
      reservationCount === orderCount &&
      reservationCount >= normalizedExpectedCount,
    counterUnderreported:
      input.business.pendingPersistenceCount === 0 &&
      reservationCount === orderCount &&
      reservationCount > normalizedExpectedCount,
  };
}

function isCompleteDuplicateBuyerDelivery(
  config: AcceptedRunConfigSnapshot,
  delivery: TrafficDeliverySummary,
): boolean {
  const traffic = config.trafficConfig;
  if (traffic.mode !== "buyer-spike" || !traffic.duplicateEachBuyerAttempt) return false;
  const expectedAttempts = traffic.buyerCount * 2;

  return (
    delivery.trafficMode === "buyer-spike" &&
    delivery.plannedRequests === expectedAttempts &&
    delivery.completedIterations === expectedAttempts &&
    delivery.requestShortfall === 0 &&
    (delivery.unstartedIterations === null || delivery.unstartedIterations === 0)
  );
}

export function acceptedResponseAccountingWarning(
  accounting: AcceptedResponseAccounting,
): Record<string, unknown> | null {
  if (!accounting.counterUnderreported) return null;

  return {
    code: "traffic_outcome_counter_underreported",
    rawAcceptedResponses: accounting.rawAcceptedResponses,
    normalizedExpectedCount: accounting.normalizedExpectedCount,
    reservationCount: accounting.reservationCount,
    orderCount: accounting.orderCount,
    duplicateNormalizationApplied: accounting.duplicateNormalizationApplied,
  };
}
