import {
  normalizeLegacyTrafficDeliverySummaryJson,
  normalizeLegacyTrafficHttpSummaryJson,
  type TrafficDeliveryEvidence,
  type TrafficDeliverySummary,
  type TrafficHttpSummary,
  trafficDeliveryEvidenceSchema,
  trafficDeliverySummarySchema,
  trafficHttpSummarySchema,
} from "@checkout-surge/contracts";

export const warningShortfallRatio = 0.01;
export const failureShortfallRatio = 0.05;

/**
 * Delivery quality describes whether planned attempts started, not whether
 * started attempts received responses. A run whose attempts all started but
 * some were interrupted has complete attempt delivery.
 */
export function classifyTrafficDelivery(
  summary: Pick<TrafficDeliveryEvidence, "plannedRequests" | "unstartedRequests">,
): TrafficDeliverySummary["trafficDeliveryStatus"] | null {
  if (summary.plannedRequests <= 0) return null;

  const unstartedRatio = summary.unstartedRequests / summary.plannedRequests;

  if (unstartedRatio === 0) return "complete";
  if (unstartedRatio <= warningShortfallRatio) return "warning";
  if (unstartedRatio <= failureShortfallRatio) return "degraded";
  return "failed";
}

/**
 * Read-boundary normalization for persisted delivery summaries. Legacy rows
 * (old `emittedRequests`/`unstartedIterations`/`requestShortfall` names) are
 * mapped to canonical transport counts first; the API then derives the
 * delivery status itself instead of trusting any producer-supplied status.
 */
export function normalizeTrafficDeliverySummary(input: unknown): TrafficDeliverySummary {
  const evidence = trafficDeliveryEvidenceSchema.parse(
    normalizeLegacyTrafficDeliverySummaryJson(input),
  );
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
    trafficDeliveryStatus,
  });
}

/**
 * Read-boundary normalization for persisted HTTP summaries. Legacy rows whose
 * `emittedRequests` carried completed-response semantics are mapped to
 * canonical transport counts before strict parsing.
 */
export function normalizePersistedTrafficHttpSummary(input: unknown): TrafficHttpSummary {
  return trafficHttpSummarySchema.parse(normalizeLegacyTrafficHttpSummaryJson(input));
}
