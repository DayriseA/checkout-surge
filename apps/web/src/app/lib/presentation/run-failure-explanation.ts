import type { PublicRunHistoryDetailResponse } from "@checkout-surge/contracts";

/** Same saved evidence for the public report, protected report, and accepted result on Watch. */
export type RunFailureExplanationEvidence = Pick<
  PublicRunHistoryDetailResponse,
  "failureDiagnostic" | "httpTimingBreakdownSummary"
> &
  Pick<
    PublicRunHistoryDetailResponse["summary"],
    "transportAttemptCounts" | "httpSummary" | "businessOutcomeSummary"
  >;

export function runFailureExplanationEvidence(
  report: Pick<
    PublicRunHistoryDetailResponse,
    "failureDiagnostic" | "httpTimingBreakdownSummary" | "summary"
  >,
): RunFailureExplanationEvidence | null {
  if (!report.failureDiagnostic) return null;
  return {
    failureDiagnostic: report.failureDiagnostic,
    httpTimingBreakdownSummary: report.httpTimingBreakdownSummary,
    transportAttemptCounts: report.summary.transportAttemptCounts,
    httpSummary: report.summary.httpSummary,
    businessOutcomeSummary: report.summary.businessOutcomeSummary,
  };
}
