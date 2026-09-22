import type {
  InternalRunFailureReason,
  LoadRunDiagnosticsSummary,
  RunFailureDiagnostic,
} from "@checkout-surge/contracts";
import { toPublicRunFailureCategory } from "@checkout-surge/contracts";

/** Explain the recorded failure without treating stderr warnings as a new verdict. */
export function deriveRunFailureDiagnostic(
  reason: InternalRunFailureReason | null,
  diagnostics: Pick<LoadRunDiagnosticsSummary, "executionPlan" | "stderrLines"> | null,
): RunFailureDiagnostic | null {
  if (!reason || toPublicRunFailureCategory(reason) !== "traffic") return null;
  const plan = diagnostics?.executionPlan;
  if (
    reason === "traffic_delivery_major_shortfall" &&
    plan?.trafficMode === "constant-arrival-rate"
  ) {
    const reachedLimit = diagnostics?.stderrLines.some((line) => {
      const match =
        /\bInsufficient VUs, reached (\d+) active VUs and cannot initialize more\b/.exec(line);
      return match !== null && Number(match[1]) === plan.maxVus;
    });
    if (reachedLimit) return { cause: "virtual_user_limit", maxVus: plan.maxVus };
  }
  return { cause: "unidentified" };
}
