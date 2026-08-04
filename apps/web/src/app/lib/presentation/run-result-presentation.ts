import {
  type DashboardProjection,
  isReplayPossible,
  type PublicRunHistoryDetailResponse,
  type PublicRunHistorySummary,
  type RunHistorySummary,
  type RunResult,
  type RunResultEvidence,
  runResultEvidenceSchema,
} from "@checkout-surge/contracts";
import { formatCount } from "./format";

type SummaryLike = RunHistorySummary | PublicRunHistorySummary;

export function evidenceFromDashboard(projection: DashboardProjection): RunResultEvidence {
  const run = projection.currentRun;
  const business = projection.businessOutcome;
  const inventory = projection.inventory;
  return runResultEvidenceSchema.parse({
    runStatus: run?.status ?? "starting",
    failureCategory: run?.status === "failed" ? (run.failureCategory ?? null) : null,
    startingStock: inventory?.allocatedStock ?? null,
    remainingStock: inventory?.remainingStock ?? null,
    durable: business
      ? {
          reservedUnits: business.reservedUnits,
          uniqueReservations: business.acceptedReservations,
          soldOutDecisions: business.soldOutRejections,
          confirmedOrders: business.confirmedOrders,
          failedOrders: business.failedOrders,
          queuedOrders: business.queuedOrders,
          processingOrders: business.processingOrders,
          durablePendingPersistenceRecords: business.pendingPersistenceCount,
          notificationsRecorded: business.notificationsRecorded,
        }
      : null,
    heldReservationsAwaitingPersistence: inventory?.pendingPersistenceCount ?? null,
    replayPossible: run ? isReplayPossible(run.configSnapshot) : null,
    generator:
      projection.transportAttemptCounts && projection.httpSummary
        ? {
            transportAttemptCounts: projection.transportAttemptCounts,
            httpSummary: projection.httpSummary,
          }
        : null,
  });
}

export function evidenceFromRunHistorySummary(summary: SummaryLike): RunResultEvidence {
  const inventory = summary.terminalInventorySnapshot;
  const business = summary.businessOutcomeSummary;
  return runResultEvidenceSchema.parse({
    runStatus: summary.status,
    failureCategory: summary.failureCategory ?? null,
    startingStock: inventory?.startingStock ?? null,
    remainingStock: inventory?.remainingStock ?? null,
    durable: {
      reservedUnits: business.reservedUnits,
      uniqueReservations: business.acceptedReservations,
      soldOutDecisions: business.soldOutRejections,
      confirmedOrders: business.confirmedOrders,
      failedOrders: business.failedOrders,
      queuedOrders: business.queuedOrders,
      processingOrders: business.processingOrders,
      durablePendingPersistenceRecords: business.pendingPersistenceCount,
      notificationsRecorded: business.notificationsRecorded,
    },
    heldReservationsAwaitingPersistence: inventory?.pendingPersistenceCount ?? null,
    replayPossible: summary.replayPossible,
    generator: {
      transportAttemptCounts: summary.transportAttemptCounts,
      httpSummary: summary.httpSummary,
    },
  });
}

export function evidenceFromRunHistoryDetail(
  detail: PublicRunHistoryDetailResponse | { summary: SummaryLike },
): RunResultEvidence {
  return evidenceFromRunHistorySummary(detail.summary);
}

export function runConclusionSentence(result: RunResult): string {
  if (result.outcome === "failed") {
    const category = result.failureCategory
      ? ` due to a ${result.failureCategory} failure`
      : "; the failure category is unavailable";
    return `The run failed${category}${result.failedOrders ? ` with ${formatNarrativeCount(result.failedOrders)} failed orders` : ""}.`;
  }
  if (result.outcome === "outcome-indeterminate") {
    return result.maximumClassification === "correctness_failure"
      ? "The completed run has contradictory authoritative evidence: one or more invariants are broken."
      : "The run outcome is indeterminate because authoritative evidence is incomplete.";
  }

  if (result.outcome === "completed-with-oversell") {
    const stock =
      result.reservedUnits === null ||
      result.startingStock === null ||
      result.oversoldUnits === null
        ? "Stock evidence is unavailable."
        : `Durable records show ${formatNarrativeCount(result.reservedUnits)} units reserved against ${formatNarrativeCount(result.startingStock)} starting units, so ${formatNarrativeCount(result.oversoldUnits)} units were oversold.`;
    return [stock, soldOutSentence(result), neutralOrderSentence(result)].filter(Boolean).join(" ");
  }

  const stock =
    result.startingStock === null || result.remainingStock === null || result.reservedUnits === null
      ? "Stock evidence is unavailable."
      : result.remainingStock === 0
        ? `All ${formatNarrativeCount(result.startingStock)} available units were reserved without overselling.`
        : `${formatNarrativeCount(result.reservedUnits)} units were reserved from ${formatNarrativeCount(result.startingStock)}, and ${formatNarrativeCount(result.remainingStock)} units remain. No units were oversold.`;
  return [stock, soldOutSentence(result), orderSentence(result)].filter(Boolean).join(" ");
}

function soldOutSentence(result: RunResult): string {
  return result.soldOutDecisions && result.soldOutDecisions > 0
    ? `${formatNarrativeCount(result.soldOutDecisions)} sold-out decisions were recorded.`
    : "";
}

function orderSentence(result: RunResult): string {
  if (result.confirmedOrders === null) return "Order evidence is unavailable.";
  const failed = result.failedOrders ?? 0;
  const pending = result.pendingOrders ?? 0;
  if (failed > 0 || pending > 0) {
    return `${formatNarrativeCount(result.confirmedOrders)} orders were confirmed, ${formatNarrativeCount(failed)} failed, and ${formatNarrativeCount(pending)} remain pending.`;
  }
  return result.uniqueReservations === result.confirmedOrders
    ? `All ${formatNarrativeCount(result.confirmedOrders)} reservations were confirmed, with no failed orders.`
    : `${formatNarrativeCount(result.confirmedOrders)} orders were confirmed, with no failed orders.`;
}

function neutralOrderSentence(result: RunResult): string {
  return result.confirmedOrders === null
    ? "Order evidence is unavailable."
    : `Order outcomes: ${formatNarrativeCount(result.confirmedOrders)} confirmed, ${formatNarrativeCount(result.failedOrders ?? 0)} failed, and ${formatNarrativeCount(result.pendingOrders ?? 0)} pending.`;
}

/**
 * Narrative counts group like every other count on the product: order, decision, and stock
 * totals here are bounded by `maxTotalRequests` and `maxStartingStock`, which reach six figures.
 *
 * Every call site has already ruled out a missing value with its own field-specific copy
 * ("Stock evidence is unavailable.", "Order evidence is unavailable."), so the sentinel below is
 * a last resort that still refuses to pass off an absent count as zero.
 */
function formatNarrativeCount(value: number | null | undefined): string {
  return formatCount(value) ?? "an unreported number of";
}

export function invariantLabel(status: RunResult["invariants"][number]["status"]): string {
  return status === "holds" ? "holds" : status === "broken" ? "broken" : "not evaluable";
}
