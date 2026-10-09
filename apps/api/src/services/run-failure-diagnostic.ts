import type {
  InternalRunFailureReason,
  LoadRunDiagnosticsSummary,
  RunFailureDiagnostic,
  TrafficExecutionStatus,
  TrafficHttpSummary,
  TransportAttemptCounts,
} from "@checkout-surge/contracts";
import { toPublicRunFailureCategory } from "@checkout-surge/contracts";
import { failureShortfallRatio } from "./traffic-delivery-classifier.js";

type RunDiagnostics = Pick<LoadRunDiagnosticsSummary, "executionPlan" | "stderrLines">;

/**
 * Explain the recorded failure without treating stderr warnings as a new verdict. A cause is
 * named only when its own requests exceed the failure tier, so a VU warning for a few unsent
 * requests never hides requests whose answers arrived after the generator stopped. Late answers
 * and request timeouts are named only after a normal generator exit: when k6 crashes, the counts
 * fall back to started − completed, which says nothing about the graceful stop, and a starved
 * generator can time out requests the server answered. Timeouts are graded against started
 * requests, like the transport loss they belong to; a run recorded before the timeout counter
 * existed has no count, so its transport loss stays unidentified.
 */
export function deriveRunFailureDiagnostic(
  reason: InternalRunFailureReason | null,
  diagnostics: RunDiagnostics | null,
  counts: Pick<
    TransportAttemptCounts,
    "plannedRequests" | "startedRequests" | "unstartedRequests" | "interruptedRequests"
  >,
  http: Pick<TrafficHttpSummary, "requestTimeouts">,
  trafficStatus: TrafficExecutionStatus,
): RunFailureDiagnostic | null {
  if (!reason || toPublicRunFailureCategory(reason) !== "traffic") return null;
  if (reason === "traffic_transport_major_loss") {
    return trafficStatus === "succeeded" &&
      counts.startedRequests !== null &&
      exceedsFailureTier(http.requestTimeouts ?? null, counts.startedRequests)
      ? { cause: "request_timeouts" }
      : { cause: "unidentified" };
  }
  if (reason !== "traffic_delivery_major_shortfall") return { cause: "unidentified" };
  const maxVus = recordedVirtualUserLimit(diagnostics);
  if (maxVus !== null && exceedsFailureTier(counts.unstartedRequests, counts.plannedRequests)) {
    return { cause: "virtual_user_limit", maxVus };
  }
  if (
    trafficStatus === "succeeded" &&
    exceedsFailureTier(counts.interruptedRequests, counts.plannedRequests)
  ) {
    return { cause: "interrupted_requests" };
  }
  return { cause: "unidentified" };
}

/** The constant-arrival VU maximum, when k6 reported reaching exactly that limit. */
function recordedVirtualUserLimit(diagnostics: RunDiagnostics | null): number | null {
  const plan = diagnostics?.executionPlan;
  if (plan?.trafficMode !== "constant-arrival-rate") return null;
  const reachedLimit = diagnostics?.stderrLines.some((line) => {
    const match = /\bInsufficient VUs, reached (\d+) active VUs and cannot initialize more\b/.exec(
      line,
    );
    return match !== null && Number(match[1]) === plan.maxVus;
  });
  return reachedLimit ? plan.maxVus : null;
}

function exceedsFailureTier(requests: number | null, totalRequests: number): boolean {
  return requests !== null && requests / totalRequests > failureShortfallRatio;
}
