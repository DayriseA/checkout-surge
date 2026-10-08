import type {
  InternalRunFailureReason,
  LoadRunDiagnosticsSummary,
  RunFailureDiagnostic,
  TransportAttemptCounts,
} from "@checkout-surge/contracts";
import { toPublicRunFailureCategory } from "@checkout-surge/contracts";
import { failureShortfallRatio } from "./traffic-delivery-classifier.js";

/** Explain the recorded failure without treating stderr warnings as a new verdict. */
export function deriveRunFailureDiagnostic(
  reason: InternalRunFailureReason | null,
  diagnostics: Pick<LoadRunDiagnosticsSummary, "executionPlan" | "stderrLines"> | null,
  counts: Pick<TransportAttemptCounts, "plannedRequests" | "interruptedRequests">,
): RunFailureDiagnostic | null {
  if (!reason || toPublicRunFailureCategory(reason) !== "traffic") return null;
  if (reason !== "traffic_delivery_major_shortfall") return { cause: "unidentified" };
  const plan = diagnostics?.executionPlan;
  if (plan?.trafficMode === "constant-arrival-rate") {
    const reachedLimit = diagnostics?.stderrLines.some((line) => {
      const match =
        /\bInsufficient VUs, reached (\d+) active VUs and cannot initialize more\b/.exec(line);
      return match !== null && Number(match[1]) === plan.maxVus;
    });
    if (reachedLimit) return { cause: "virtual_user_limit", maxVus: plan.maxVus };
  }
  // Requests left unanswered when the generator stopped fail the run on their own.
  if (
    counts.interruptedRequests !== null &&
    counts.interruptedRequests / counts.plannedRequests > failureShortfallRatio
  ) {
    return { cause: "interrupted_requests" };
  }
  return { cause: "unidentified" };
}
