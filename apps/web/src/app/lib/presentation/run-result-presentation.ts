import {
  type DashboardProjection,
  deriveOversoldUnits,
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

/**
 * Oversell compares durable reserved units with the authoritative terminal inventory snapshot.
 * The derived signal timeline is a reservation-row visualization rather than an invariant input,
 * so a run without that snapshot has unknown oversell instead of an implied zero.
 */
export function oversoldUnitsFromTerminalInventory(summary: SummaryLike): number | null {
  const inventory = summary.terminalInventorySnapshot;
  return inventory
    ? deriveOversoldUnits({
        reservedUnits: summary.businessOutcomeSummary.reservedUnits,
        startingStock: inventory.startingStock,
      })
    : null;
}

export function evidenceFromRunHistoryDetail(
  detail: PublicRunHistoryDetailResponse | { summary: SummaryLike },
): RunResultEvidence {
  return evidenceFromRunHistorySummary(detail.summary);
}

/**
 * The plain-language verdict for a run. The default form narrates stock, sold-out rejections and
 * order outcomes; the `concise` form is the verdict that public summaries show while the full
 * narration stays available in the run's full detail. The concise form keeps known failed
 * and pending order quantities readable beside every headline that does not already state them.
 */
export function runConclusionSentence(
  result: RunResult,
  options: { concise?: boolean } = {},
): string {
  if (options.concise) {
    return `${headlineSentence(result)}${orderQuantitiesSuffix(result)}`;
  }

  if (result.outcome === "failed") return failedSentence(result);
  if (result.outcome === "outcome-indeterminate") return indeterminateSentence(result);

  if (result.outcome === "completed-with-oversell") {
    return [oversellStockSentence(result), soldOutSentence(result), neutralOrderSentence(result)]
      .filter(Boolean)
      .join(" ");
  }

  const stock =
    stockSentence(result) +
    (result.remainingStock !== null && result.remainingStock !== 0
      ? " No units were oversold."
      : "");
  return [stock, soldOutSentence(result), orderSentence(result)].filter(Boolean).join(" ");
}

function headlineSentence(result: RunResult): string {
  switch (result.outcome) {
    case "failed":
      return failedSentence(result);
    case "outcome-indeterminate":
      return indeterminateSentence(result);
    case "completed-with-oversell":
      return oversellStockSentence(result);
    case "completed-with-order-failures":
    case "completed-with-unsettled-orders":
      return orderSentence(result);
    case "completed-successfully":
      return stockSentence(result);
  }
}

/**
 * Failed and pending quantities stay readable beside every headline that does not already state
 * them. The suffix reuses the existing order wording and never duplicates a quantity the
 * headline carries; unknown counts add nothing rather than implying zero.
 */
function orderQuantitiesSuffix(result: RunResult): string {
  switch (result.outcome) {
    case "failed":
      // The failed headline already carries a known failed count; only pending is unstated.
      return hasKnownNonZeroPendingOrders(result) ? ` ${pendingOrdersSentence(result)}` : "";
    case "completed-with-oversell":
    case "outcome-indeterminate":
      return hasKnownNonZeroFailedOrPendingOrders(result) ? ` ${orderSentence(result)}` : "";
    default:
      // The order-failures/unsettled headlines are the order sentence; success has no failures.
      return "";
  }
}

function hasKnownNonZeroPendingOrders(result: RunResult): boolean {
  return result.pendingOrders !== null && result.pendingOrders > 0;
}

function hasKnownNonZeroFailedOrPendingOrders(result: RunResult): boolean {
  return (
    (result.failedOrders !== null && result.failedOrders > 0) ||
    hasKnownNonZeroPendingOrders(result)
  );
}

function pendingOrdersSentence(result: RunResult): string {
  return `${formatNarrativeCount(result.pendingOrders)} orders remain pending.`;
}

function failedSentence(result: RunResult): string {
  const category =
    result.failureCategory === "not_started"
      ? " because the load generator could not be started; no traffic was sent"
      : result.failureCategory === "provider_capacity"
        ? " because the hosting provider had no capacity for the load generator; no traffic was sent"
        : result.failureCategory
          ? ` due to a ${result.failureCategory} failure`
          : "; the failure category is unavailable";
  return `The run failed${category}${result.failedOrders ? ` with ${formatNarrativeCount(result.failedOrders)} failed orders` : ""}.`;
}

function indeterminateSentence(result: RunResult): string {
  return result.maximumClassification === "correctness_failure"
    ? "The completed run has contradictory authoritative evidence: one or more invariants are broken."
    : "The run outcome is indeterminate because authoritative evidence is incomplete.";
}

function oversellStockSentence(result: RunResult): string {
  return result.reservedUnits === null ||
    result.startingStock === null ||
    result.oversoldUnits === null
    ? "Stock evidence is unavailable."
    : `Durable records show ${formatNarrativeCount(result.reservedUnits)} units reserved against ${formatNarrativeCount(result.startingStock)} starting units, so ${formatNarrativeCount(result.oversoldUnits)} units were oversold.`;
}

function stockSentence(result: RunResult): string {
  return result.startingStock === null ||
    result.remainingStock === null ||
    result.reservedUnits === null
    ? "Stock evidence is unavailable."
    : // Zero starting stock is a real reading, never a vacuous success ("All 0 units…").
      result.startingStock === 0
      ? "The sale started with no stock available to reserve."
      : result.remainingStock === 0
        ? `All ${formatNarrativeCount(result.startingStock)} available units were reserved without overselling.`
        : `${formatNarrativeCount(result.reservedUnits)} units were reserved from ${formatNarrativeCount(result.startingStock)}, and ${formatNarrativeCount(result.remainingStock)} units remain.`;
}

function soldOutSentence(result: RunResult): string {
  return result.soldOutDecisions && result.soldOutDecisions > 0
    ? `Checkout-Surge recorded ${formatNarrativeCount(result.soldOutDecisions)} sold-out rejections.`
    : "";
}

function orderSentence(result: RunResult): string {
  if (result.confirmedOrders === null) return "Order evidence is unavailable.";
  const pending = result.pendingOrders ?? 0;
  if ((result.failedOrders ?? 0) > 0 || pending > 0) {
    return `${formatNarrativeCount(result.confirmedOrders)} orders were confirmed, ${formatNarrativeCount(result.failedOrders)} failed, and ${formatNarrativeCount(pending)} remain pending.`;
  }
  return result.uniqueReservations === result.confirmedOrders
    ? `All ${formatNarrativeCount(result.confirmedOrders)} reservations were confirmed, with no failed orders.`
    : `${formatNarrativeCount(result.confirmedOrders)} orders were confirmed, with no failed orders.`;
}

function neutralOrderSentence(result: RunResult): string {
  if (result.confirmedOrders === null) return "Order evidence is unavailable.";
  return `Order outcomes: ${formatNarrativeCount(result.confirmedOrders)} confirmed, ${formatNarrativeCount(result.failedOrders)} failed, and ${formatNarrativeCount(result.pendingOrders)} pending.`;
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
