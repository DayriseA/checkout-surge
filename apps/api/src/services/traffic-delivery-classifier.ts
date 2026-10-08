import {
  type TrafficCompletionDeliverySummary,
  type TrafficDeliverySummary,
  type TrafficHttpSummary,
  type TransportAttemptCounts,
  trafficDeliverySummarySchema,
  trafficHttpSummarySchema,
  transportAttemptCountsSchema,
} from "@checkout-surge/contracts";
import { parsePersistedState } from "./persisted-demo-run-state.js";

export const warningShortfallRatio = 0.01;
export const failureShortfallRatio = 0.05;

/**
 * Delivery quality describes whether every planned attempt was started and completed. The
 * shortfall is planned minus completed attempts, that is unstarted plus interrupted ones: an
 * attempt the server did not answer before the generator stopped counts like one never started.
 * A transport failure still completes its attempt; transport loss is graded separately.
 */
export function classifyTrafficDelivery(
  summary: Pick<TransportAttemptCounts, "plannedRequests" | "completedRequests">,
): TrafficDeliverySummary["trafficDeliveryStatus"] | null {
  if (summary.completedRequests === null) return "failed";
  if (summary.plannedRequests <= 0) return null;

  const shortfallRatio =
    (summary.plannedRequests - summary.completedRequests) / summary.plannedRequests;

  if (shortfallRatio === 0) return "complete";
  if (shortfallRatio <= warningShortfallRatio) return "warning";
  if (shortfallRatio <= failureShortfallRatio) return "degraded";
  return "failed";
}

export function classifyTrafficTransport(input: {
  startedRequests: number | null;
  transportFailures: number | null;
}): TrafficDeliverySummary["trafficDeliveryStatus"] | null {
  if (input.startedRequests === null || input.transportFailures === null) return null;
  if (input.startedRequests <= 0) return null;

  const lossRatio = input.transportFailures / input.startedRequests;
  if (lossRatio === 0) return "complete";
  if (lossRatio <= warningShortfallRatio) return "warning";
  if (lossRatio <= failureShortfallRatio) return "degraded";
  return "failed";
}

/** Adds the API-owned delivery classification to a route-validated current completion. */
export function classifyTrafficDeliverySummary(
  input: TrafficCompletionDeliverySummary,
  transportAttemptCounts: TransportAttemptCounts,
): TrafficDeliverySummary {
  const trafficDeliveryStatus = classifyTrafficDelivery(
    transportAttemptCounts,
  ) as TrafficDeliverySummary["trafficDeliveryStatus"];
  return {
    ...input,
    completedIterations: input.completedIterations ?? null,
    trafficDeliveryStatus,
  };
}

/** Strictly validates the current persisted delivery shape and its API-owned status. */
export function parsePersistedTrafficDeliverySummary(
  input: unknown,
  transportAttemptCounts: TransportAttemptCounts,
  context: string,
): TrafficDeliverySummary {
  const parsed = parsePersistedState(
    trafficDeliverySummarySchema,
    input,
    context,
    "trafficDeliverySummary",
  );
  const expectedStatus = classifyTrafficDelivery(transportAttemptCounts);
  if (parsed.trafficDeliveryStatus !== expectedStatus) {
    throw new Error(
      `Invalid persisted trafficDeliverySummary for ${context}: trafficDeliveryStatus must be ${expectedStatus ?? "classifiable from a positive plannedRequests count"}.`,
    );
  }
  return parsed;
}

/** Strictly validates the current persisted HTTP-summary shape. */
export function parsePersistedTrafficHttpSummary(
  input: unknown,
  context: string,
): TrafficHttpSummary {
  return parsePersistedState(trafficHttpSummarySchema, input, context, "httpSummary");
}

/** Strictly validates canonical persisted transport-attempt counts. */
export function parsePersistedTransportAttemptCounts(
  input: unknown,
  context: string,
): TransportAttemptCounts {
  return parsePersistedState(
    transportAttemptCountsSchema,
    input,
    context,
    "transportAttemptCounts",
  );
}
