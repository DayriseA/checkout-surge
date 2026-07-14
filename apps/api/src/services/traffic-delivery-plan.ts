import type { AcceptedRunConfigSnapshot, TrafficDeliverySummary } from "@checkout-surge/contracts";
import { calculatePlannedRequests } from "@checkout-surge/contracts";

export function syntheticTrafficDeliverySummary(
  config: AcceptedRunConfigSnapshot,
  notes: string[],
): TrafficDeliverySummary {
  const traffic = config.trafficConfig;
  const plannedRequests = calculatePlannedRequests(traffic);

  return {
    plannedRequests,
    emittedRequests: 0,
    trafficMode: traffic.mode,
    plannedBuyers: traffic.mode === "buyer-spike" ? traffic.buyerCount : null,
    scheduledRatePerSecond: traffic.mode === "steady-arrival-rate" ? traffic.ratePerSecond : null,
    configuredDurationSeconds:
      traffic.mode === "steady-arrival-rate" ? traffic.durationSeconds : null,
    preAllocatedVUs:
      traffic.mode === "steady-arrival-rate"
        ? (traffic.k6Vus?.preAllocatedVus ?? Math.max(1, Math.ceil(traffic.ratePerSecond / 2)))
        : null,
    maxVUs:
      traffic.mode === "steady-arrival-rate"
        ? (traffic.k6Vus?.maxVus ?? Math.max(1, traffic.ratePerSecond * 2))
        : null,
    droppedIterations: 0,
    completedIterations: 0,
    unstartedIterations: plannedRequests,
    requestShortfall: plannedRequests,
    trafficDeliveryStatus: "failed",
    notes,
  };
}
