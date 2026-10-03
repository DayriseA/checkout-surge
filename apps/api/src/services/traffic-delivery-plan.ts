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
  evidence: "no_traffic_started" | "unavailable",
): {
  transportAttemptCounts: TransportAttemptCounts;
  httpSummary: TrafficHttpSummary;
  trafficDeliverySummary: TrafficDeliverySummary;
} {
  const plannedRequests = calculatePlannedRequests(config.trafficConfig);

  const known = evidence === "no_traffic_started";
  return {
    transportAttemptCounts: {
      plannedRequests,
      startedRequests: known ? 0 : null,
      completedRequests: known ? 0 : null,
      interruptedRequests: known ? 0 : null,
      unstartedRequests: known ? plannedRequests : null,
    },
    httpSummary: known
      ? {
          failedRequests: 0,
          acceptedResponses: 0,
          soldOutResponses: 0,
          transportFailures: 0,
          unexpectedResponses: 0,
          failureRate: 0,
        }
      : {
          failedRequests: null,
          acceptedResponses: null,
          soldOutResponses: null,
          transportFailures: null,
          unexpectedResponses: null,
          failureRate: null,
        },
    trafficDeliverySummary: {
      ...syntheticTrafficDeliverySummary(config, notes),
      droppedIterations: known ? 0 : null,
      completedIterations: known ? 0 : null,
    },
  };
}
