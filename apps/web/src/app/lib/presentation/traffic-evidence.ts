import type { TransportAttemptCounts } from "@checkout-surge/contracts";

/**
 * Shown wherever a run's traffic counters are unknown: no completion report was recorded, or the
 * report carries no k6 traffic evidence. The run data does not say which, so one text covers both.
 */
export const trafficEvidenceUnavailableText =
  "Traffic evidence unavailable: no usable completion report was recorded. Traffic counters, HTTP outcomes and latency are unknown.";

/** Observed counts are all known or all unknown together, so one field decides. */
export function hasUnknownTrafficCounts(counts: Pick<TransportAttemptCounts, "startedRequests">) {
  return counts.startedRequests === null;
}
