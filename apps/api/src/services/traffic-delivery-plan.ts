import type { AcceptedRunConfigSnapshot, TrafficDeliverySummary } from "@checkout-surge/contracts";
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
    emittedRequests: 0,
    trafficMode: traffic.mode,
    plannedBuyers: traffic.mode === "buyer-spike" ? traffic.buyerCount : null,
    scheduledRatePerSecond: traffic.mode === "steady-arrival-rate" ? traffic.ratePerSecond : null,
    configuredDurationSeconds:
      traffic.mode === "steady-arrival-rate" ? traffic.durationSeconds : null,
    preAllocatedVUs: resolvedK6Vus?.preAllocatedVus ?? null,
    maxVUs: resolvedK6Vus?.maxVus ?? null,
    droppedIterations: 0,
    completedIterations: 0,
    unstartedIterations: plannedRequests,
    requestShortfall: plannedRequests,
    trafficDeliveryStatus: "failed",
    notes,
  };
}
