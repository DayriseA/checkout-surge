import {
  type AcceptedRunConfigSnapshot,
  type BusinessOutcomeSummary,
  type TrafficDeliverySummary,
  type TrafficHttpSummary,
  type TransportAttemptCounts,
  isReplayPossible,
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
  transportAttemptCounts: TransportAttemptCounts;
  delivery: TrafficDeliverySummary;
  http: TrafficHttpSummary;
  business: BusinessOutcomeSummary;
}): AcceptedResponseAccounting {
  const duplicateNormalizationApplied = isCompleteDuplicateBuyerDelivery(
    input.config,
    input.transportAttemptCounts,
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
  transportAttemptCounts: TransportAttemptCounts,
  delivery: TrafficDeliverySummary,
): boolean {
  const traffic = config.trafficConfig;
  if (!isReplayPossible(config)) return false;
  if (traffic.mode !== "buyer-spike") return false;
  const expectedAttempts = traffic.buyerCount * 2;

  return (
    delivery.trafficMode === "buyer-spike" &&
    transportAttemptCounts.plannedRequests === expectedAttempts &&
    delivery.completedIterations === expectedAttempts &&
    transportAttemptCounts.startedRequests === expectedAttempts &&
    transportAttemptCounts.unstartedRequests === 0
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
