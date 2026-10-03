import type { TransportAttemptCounts } from "@checkout-surge/contracts";

/** Shown wherever a run's traffic counters are unknown because no completion report exists. */
export const trafficEvidenceUnavailableText =
  "Traffic evidence unavailable: no completion report was recorded. Traffic counters, HTTP outcomes and latency are unknown.";

/** Observed counts are all known or all unknown together, so one field decides. */
export function hasUnknownTrafficCounts(counts: Pick<TransportAttemptCounts, "startedRequests">) {
  return counts.startedRequests === null;
}
