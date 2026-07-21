import type {
  AcceptedRunConfigSnapshot,
  TrafficDeliverySummary,
  TrafficHttpSummary,
} from "@checkout-surge/contracts";
import { calculatePlannedRequests, resolveSteadyArrivalVus } from "@checkout-surge/contracts";

export function syntheticTrafficDeliverySummary(
  config: AcceptedRunConfigSnapshot,
  notes: string[],
): TrafficDeliverySummary {
  const traffic = config.trafficConfig;
  const plannedRequests = calculatePlannedRequests(traffic);
  const resolvedK6Vus =
    traffic.mode === "steady-arrival-rate" ? resolveSteadyArrivalVus(traffic) : null;

  return {
    plannedRequests,
    startedRequests: 0,
    completedRequests: 0,
    interruptedRequests: 0,
    unstartedRequests: plannedRequests,
    trafficMode: traffic.mode,
    plannedBuyers: traffic.mode === "buyer-spike" ? traffic.buyerCount : null,
    scheduledRatePerSecond: traffic.mode === "steady-arrival-rate" ? traffic.ratePerSecond : null,
    configuredDurationSeconds:
      traffic.mode === "steady-arrival-rate" ? traffic.durationSeconds : null,
    preAllocatedVUs: resolvedK6Vus?.preAllocatedVus ?? null,
    maxVUs: resolvedK6Vus?.maxVus ?? null,
    droppedIterations: 0,
    completedIterations: 0,
    trafficDeliveryStatus: "failed",
    notes,
  };
}

export function syntheticFailedTrafficSummary(
  config: AcceptedRunConfigSnapshot,
  notes: string[],
): {
  httpSummary: TrafficHttpSummary;
  trafficDeliverySummary: TrafficDeliverySummary;
} {
  const plannedRequests = calculatePlannedRequests(config.trafficConfig);

  return {
    httpSummary: {
      plannedRequests,
      startedRequests: 0,
      completedRequests: 0,
      interruptedRequests: 0,
      unstartedRequests: plannedRequests,
      failedRequests: 0,
      acceptedResponses: 0,
      soldOutResponses: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    trafficDeliverySummary: syntheticTrafficDeliverySummary(config, notes),
  };
}
