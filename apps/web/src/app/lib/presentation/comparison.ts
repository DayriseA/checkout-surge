import type { ComparisonDetailResponse, ComparisonStage } from "@checkout-surge/contracts";
import type { BackendRead } from "../backend-read";

export function comparisonReportMissing(read: BackendRead<unknown>): boolean {
  return (
    read.status === "unavailable" &&
    read.httpStatus === 404 &&
    read.errorCode === "resource_not_found"
  );
}

export const comparisonStageLabels: Record<ComparisonStage["role"], string> = {
  redis_demo: "With Redis",
  redis_without: "With PostgreSQL stock checks",
  queue_demo: "Reply without waiting for processing",
  queue_without: "Reply after processing",
};

export function comparisonIsTerminal(detail: ComparisonDetailResponse): boolean {
  return detail.state === "completed" || detail.state === "failed";
}

export function comparisonProgress(detail: ComparisonDetailResponse): string {
  if (detail.state === "cleanup_pending")
    return "Finishing cleanup before the next visitor can start.";
  if (detail.state === "failed")
    return "This comparison stopped. Available results are shown below.";
  if (detail.state === "completed") return "All four simulations have finished.";
  // The shared contract bounds currentStage to this fixed four-element tuple.
  const stage = detail.stages[detail.currentStage as 0 | 1 | 2 | 3];
  const status =
    stage.availability === "available"
      ? stage.detail.run.status
      : stage.availability === "pending"
        ? stage.run.status
        : null;
  if (status === "failed") return "This simulation stopped. Checking the comparison result…";
  if (status === "completed")
    return detail.currentStage === 3
      ? "Finishing the comparison…"
      : "Preparing the next simulation…";
  const pair = detail.currentStage < 2 ? "Stock checks" : "Order processing";
  return `${pair} · ${detail.currentStage + 1} of 4 simulations · ${comparisonStageLabels[stage.role]}`;
}

export function comparisonStageEvidence(stage: ComparisonStage) {
  if (stage.availability !== "available" || stage.detail.summary.dataDiscarded) return null;
  const cohort =
    stage.role === "redis_demo" || stage.role === "redis_without" ? "soldOut" : "accepted";
  return {
    timing: stage.detail.summary.httpSummary.buyerWallLatencySummary?.[cohort] ?? null,
    result: stage.detail.result,
  };
}
