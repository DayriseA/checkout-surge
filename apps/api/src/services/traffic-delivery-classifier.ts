import {
  type TrafficCompletionDeliverySummary,
  type TrafficDeliverySummary,
  type TrafficHttpSummary,
  type TransportAttemptCounts,
  trafficCompletionDeliverySummarySchema,
  trafficDeliverySummarySchema,
  trafficHttpSummarySchema,
  transportAttemptCountsSchema,
} from "@checkout-surge/contracts";
import type { ZodError } from "zod";

export const warningShortfallRatio = 0.01;
export const failureShortfallRatio = 0.05;

/**
 * Delivery quality describes whether planned attempts started, not whether
 * started attempts received responses. A run whose attempts all started but
 * some were interrupted has complete attempt delivery.
 */
export function classifyTrafficDelivery(
  summary: Pick<TransportAttemptCounts, "plannedRequests" | "unstartedRequests">,
): TrafficDeliverySummary["trafficDeliveryStatus"] | null {
  if (summary.plannedRequests <= 0) return null;

  const unstartedRatio = summary.unstartedRequests / summary.plannedRequests;

  if (unstartedRatio === 0) return "complete";
  if (unstartedRatio <= warningShortfallRatio) return "warning";
  if (unstartedRatio <= failureShortfallRatio) return "degraded";
  return "failed";
}

/** Adds the API-owned delivery classification to a validated current completion. */
export function classifyTrafficDeliverySummary(
  input: TrafficCompletionDeliverySummary,
  transportAttemptCounts: TransportAttemptCounts,
): TrafficDeliverySummary {
  const evidence = trafficCompletionDeliverySummarySchema.parse(input);
  const canonicalTransportAttemptCounts =
    transportAttemptCountsSchema.parse(transportAttemptCounts);
  const trafficDeliveryStatus = classifyTrafficDelivery(canonicalTransportAttemptCounts);
  if (!trafficDeliveryStatus) {
    throw new Error("Traffic delivery cannot be classified with zero planned requests.");
  }

  return trafficDeliverySummarySchema.parse({
    ...evidence,
    completedIterations: evidence.completedIterations ?? null,
    trafficDeliveryStatus,
  });
}

/** Strictly validates the current persisted delivery shape and its API-owned status. */
export function parsePersistedTrafficDeliverySummary(
  input: unknown,
  transportAttemptCounts: TransportAttemptCounts,
  context: string,
): TrafficDeliverySummary {
  const parsed = trafficDeliverySummarySchema.safeParse(input);
  if (!parsed.success) {
    throw persistedTrafficSummaryError(context, "trafficDeliverySummary", parsed.error);
  }
  const expectedStatus = classifyTrafficDelivery(transportAttemptCounts);
  if (parsed.data.trafficDeliveryStatus !== expectedStatus) {
    throw new Error(
      `Invalid persisted trafficDeliverySummary for ${context}: trafficDeliveryStatus must be ${expectedStatus ?? "classifiable from a positive plannedRequests count"}.`,
    );
  }
  return parsed.data;
}

/** Strictly validates the current persisted HTTP-summary shape. */
export function parsePersistedTrafficHttpSummary(
  input: unknown,
  context: string,
): TrafficHttpSummary {
  const parsed = trafficHttpSummarySchema.safeParse(input);
  if (!parsed.success) {
    throw persistedTrafficSummaryError(context, "httpSummary", parsed.error);
  }
  return parsed.data;
}

/** Strictly validates canonical persisted transport-attempt counts. */
export function parsePersistedTransportAttemptCounts(
  input: unknown,
  context: string,
): TransportAttemptCounts {
  const parsed = transportAttemptCountsSchema.safeParse(input);
  if (!parsed.success) {
    throw persistedTrafficSummaryError(context, "transportAttemptCounts", parsed.error);
  }
  return parsed.data;
}

function persistedTrafficSummaryError(context: string, field: string, error: ZodError): Error {
  const issues = error.issues
    .map((issue) => `${[field, ...issue.path].join(".")}: ${issue.message}`)
    .join("; ");
  return new Error(`Invalid persisted ${field} for ${context}: ${issues}`, { cause: error });
}
