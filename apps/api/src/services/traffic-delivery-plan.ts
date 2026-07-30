import type {
  AcceptedRunConfigSnapshot,
  TrafficDeliverySummary,
  TrafficHttpSummary,
  TransportAttemptCounts,
} from "@checkout-surge/contracts";
import {
  calculatePlannedRequests,
  emptyRequestArrivalSummary,
  resolveConstantArrivalVus,
} from "@checkout-surge/contracts";

export function syntheticTrafficDeliverySummary(
  config: AcceptedRunConfigSnapshot,
  notes: string[],
): TrafficDeliverySummary {
  const traffic = config.trafficConfig;
  const resolvedK6Vus =
    traffic.mode === "constant-arrival-rate" ? resolveConstantArrivalVus(traffic) : null;

  return {
    trafficMode: traffic.mode,
    plannedBuyers: traffic.mode === "buyer-spike" ? traffic.buyerCount : null,
    scheduledRatePerSecond: traffic.mode === "constant-arrival-rate" ? traffic.ratePerSecond : null,
    configuredDurationSeconds:
      traffic.mode === "constant-arrival-rate" ? traffic.durationSeconds : null,
    preAllocatedVUs: resolvedK6Vus?.preAllocatedVus ?? null,
    maxVUs: resolvedK6Vus?.maxVus ?? null,
    droppedIterations: 0,
    completedIterations: 0,
    requestArrivalSummary: emptyRequestArrivalSummary,
    trafficDeliveryStatus: "failed",
    notes,
  };
}

export function syntheticFailedTrafficSummary(
  config: AcceptedRunConfigSnapshot,
  notes: string[],
): {
  transportAttemptCounts: TransportAttemptCounts;
  httpSummary: TrafficHttpSummary;
  trafficDeliverySummary: TrafficDeliverySummary;
} {
  const plannedRequests = calculatePlannedRequests(config.trafficConfig);

  return {
    transportAttemptCounts: {
      plannedRequests,
      startedRequests: 0,
      completedRequests: 0,
      interruptedRequests: 0,
      unstartedRequests: plannedRequests,
    },
    httpSummary: {
      failedRequests: 0,
      acceptedResponses: 0,
      soldOutResponses: 0,
      transportFailures: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    trafficDeliverySummary: syntheticTrafficDeliverySummary(config, notes),
  };
}
