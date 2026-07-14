import {
  type TrafficDeliveryEvidence,
  type TrafficDeliverySummary,
  trafficDeliveryEvidenceSchema,
  trafficDeliverySummarySchema,
} from "@checkout-surge/contracts";

export const warningShortfallRatio = 0.01;
export const failureShortfallRatio = 0.05;

export function classifyTrafficDelivery(
  summary: Pick<TrafficDeliveryEvidence, "plannedRequests" | "emittedRequests">,
): TrafficDeliverySummary["trafficDeliveryStatus"] | null {
  if (summary.plannedRequests <= 0) return null;

  const requestShortfall = Math.max(0, summary.plannedRequests - summary.emittedRequests);
  const shortfallRatio = requestShortfall / summary.plannedRequests;

  if (shortfallRatio === 0) return "complete";
  if (shortfallRatio <= warningShortfallRatio) return "warning";
  if (shortfallRatio <= failureShortfallRatio) return "degraded";
  return "failed";
}

export function normalizeTrafficDeliverySummary(input: unknown): TrafficDeliverySummary {
  const evidence = trafficDeliveryEvidenceSchema.parse(input);
  const trafficDeliveryStatus = classifyTrafficDelivery(evidence);
  if (!trafficDeliveryStatus) {
    throw new Error("Traffic delivery cannot be classified with zero planned requests.");
  }

  return trafficDeliverySummarySchema.parse({
    ...evidence,
    trafficMode: evidence.trafficMode ?? null,
    plannedBuyers: evidence.plannedBuyers ?? null,
    scheduledRatePerSecond: evidence.scheduledRatePerSecond ?? null,
    configuredDurationSeconds: evidence.configuredDurationSeconds ?? null,
    preAllocatedVUs: evidence.preAllocatedVUs ?? null,
    maxVUs: evidence.maxVUs ?? null,
    completedIterations: evidence.completedIterations ?? null,
    unstartedIterations: evidence.unstartedIterations ?? null,
    requestShortfall: Math.max(0, evidence.plannedRequests - evidence.emittedRequests),
    trafficDeliveryStatus,
  });
}
