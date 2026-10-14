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
import { getTranslation, type Locale } from "../i18n/translate";
import { formatCount, pluralize } from "./format";
import { publicFailureExplanation } from "./public-vocabulary";

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
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  if (options.concise) {
    return `${headlineSentence(result, locale)}${orderQuantitiesSuffix(result, locale)}`;
  }

  if (result.outcome === "failed") return failedSentence(result, locale);
  if (result.outcome === "outcome-indeterminate") return indeterminateSentence(result, locale);

  if (result.outcome === "completed-with-oversell") {
    return [
      oversellStockSentence(result, locale),
      soldOutSentence(result, locale),
      neutralOrderSentence(result, locale),
    ]
      .filter(Boolean)
      .join(" ");
  }

  const stock =
    stockSentence(result, locale) +
    (result.remainingStock !== null && result.remainingStock !== 0
      ? t(" No units were oversold.")
      : "");
  return [stock, soldOutSentence(result, locale), orderSentence(result, locale)]
    .filter(Boolean)
    .join(" ");
}

function headlineSentence(result: RunResult, locale: Locale = "en"): string {
  switch (result.outcome) {
    case "failed":
      return failedSentence(result, locale);
    case "outcome-indeterminate":
      return indeterminateSentence(result, locale);
    case "completed-with-oversell":
      return oversellStockSentence(result, locale);
    case "completed-with-order-failures":
    case "completed-with-unsettled-orders":
      return orderSentence(result, locale);
    case "completed-successfully":
      return stockSentence(result, locale);
  }
}

/**
 * Failed and pending quantities stay readable beside every headline that does not already state
 * them. The suffix reuses the existing order wording and never duplicates a quantity the
 * headline carries; unknown counts add nothing rather than implying zero.
 */
function orderQuantitiesSuffix(result: RunResult, locale: Locale = "en"): string {
  switch (result.outcome) {
    case "failed":
      // The failed headline already carries a known failed count; only pending is unstated.
      return hasKnownNonZeroPendingOrders(result)
        ? ` ${pendingOrdersSentence(result, locale)}`
        : "";
    case "completed-with-oversell":
    case "outcome-indeterminate":
      return hasKnownNonZeroFailedOrPendingOrders(result)
        ? ` ${orderSentence(result, locale)}`
        : "";
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

function pendingOrdersSentence(result: RunResult, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return t("{v0} {v1} pending.", {
    v0: String(countOf(result.pendingOrders, "order", locale)),
    v1: String(t(pluralize(result.pendingOrders, "remains", "remain"))),
  });
}

/** The shared failure explanation is the verdict; known failed orders are added to it. */
function failedSentence(result: RunResult, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  const failure = result.failureCategory
    ? publicFailureExplanation(result.failureCategory, locale).explanation
    : t("The run failed; its cause was not recorded.");
  return result.failedOrders
    ? t("{v0} {v1} failed.", {
        v0: String(failure),
        v1: String(countOf(result.failedOrders, "order", locale)),
      })
    : failure;
}

function indeterminateSentence(result: RunResult, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return result.maximumClassification === "correctness_failure"
    ? t(
        "The completed run has contradictory authoritative evidence: one or more invariants are broken.",
      )
    : t("The run outcome is indeterminate because authoritative evidence is incomplete.");
}

function oversellStockSentence(result: RunResult, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return result.reservedUnits === null ||
    result.startingStock === null ||
    result.oversoldUnits === null
    ? t("Stock evidence is unavailable.")
    : t("Durable records show {v0} reserved against {v1}, so {v2} {v3} oversold.", {
        v0: String(countOf(result.reservedUnits, "unit", locale)),
        v1: String(countOf(result.startingStock, "starting unit", locale)),
        v2: String(countOf(result.oversoldUnits, "unit", locale)),
        v3: String(t(pluralize(result.oversoldUnits, "was", "were"))),
      });
}

function stockSentence(result: RunResult, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return result.startingStock === null ||
    result.remainingStock === null ||
    result.reservedUnits === null
    ? t("Stock evidence is unavailable.")
    : // Zero starting stock is a real reading, never a vacuous success ("All 0 units…").
      result.startingStock === 0
      ? t("The sale started with no stock available to reserve.")
      : result.remainingStock === 0
        ? result.startingStock === 1
          ? t("The only available unit was reserved without overselling.")
          : t("All {v0} available units were reserved without overselling.", {
              v0: String(formatNarrativeCount(result.startingStock, locale)),
            })
        : t("{v0} {v1} reserved from {v2}, and {v3} {v4}.", {
            v0: String(countOf(result.reservedUnits, "unit", locale)),
            v1: String(t(pluralize(result.reservedUnits, "was", "were"))),
            v2: String(formatNarrativeCount(result.startingStock, locale)),
            v3: String(countOf(result.remainingStock, "unit", locale)),
            v4: String(t(pluralize(result.remainingStock, "remains", "remain"))),
          });
}

function soldOutSentence(result: RunResult, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return result.soldOutDecisions && result.soldOutDecisions > 0
    ? t("Checkout-Surge recorded {v0}.", {
        v0: String(countOf(result.soldOutDecisions, "sold-out rejection", locale)),
      })
    : "";
}

function orderSentence(result: RunResult, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  if (result.confirmedOrders === null) return t("Order evidence is unavailable.");
  const pending = result.pendingOrders ?? 0;
  if ((result.failedOrders ?? 0) > 0 || pending > 0) {
    return t("{v0} {v1} confirmed, {v2} failed, and {v3} {v4} pending.", {
      v0: String(countOf(result.confirmedOrders, "order", locale)),
      v1: String(t(pluralize(result.confirmedOrders, "was", "were"))),
      v2: String(formatNarrativeCount(result.failedOrders, locale)),
      v3: String(formatNarrativeCount(pending, locale)),
      v4: String(t(pluralize(pending, "remains", "remain"))),
    });
  }
  return result.uniqueReservations === result.confirmedOrders
    ? result.confirmedOrders === 1
      ? t("The order for the only reservation was confirmed, with no failed orders.")
      : t("The orders for all {v0} reservations were confirmed, with no failed orders.", {
          v0: String(formatNarrativeCount(result.confirmedOrders, locale)),
        })
    : t("{v0} {v1} confirmed, with no failed orders.", {
        v0: String(countOf(result.confirmedOrders, "order", locale)),
        v1: String(t(pluralize(result.confirmedOrders, "was", "were"))),
      });
}

function neutralOrderSentence(result: RunResult, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  if (result.confirmedOrders === null) return t("Order evidence is unavailable.");
  return t("Order outcomes: {v0} confirmed, {v1} failed, and {v2} pending.", {
    v0: String(formatNarrativeCount(result.confirmedOrders, locale)),
    v1: String(formatNarrativeCount(result.failedOrders, locale)),
    v2: String(formatNarrativeCount(result.pendingOrders, locale)),
  });
}

/**
 * Narrative counts group like every other count on the product: order, decision, and stock
 * totals here are bounded by `maxTotalRequests` and `maxStartingStock`, which reach six figures.
 *
 * Every call site has already ruled out a missing value with its own field-specific copy
 * ("Stock evidence is unavailable.", "Order evidence is unavailable."), so the sentinel below is
 * a last resort that still refuses to pass off an absent count as zero.
 */
function formatNarrativeCount(value: number | null | undefined, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return formatCount(value, locale) ?? t("an unreported number of");
}

function countOf(value: number | null | undefined, noun: string, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return `${formatNarrativeCount(value, locale)} ${t(pluralize(value, noun))}`;
}

export function invariantLabel(
  status: RunResult["invariants"][number]["status"],
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  return t(status === "holds" ? "holds" : status === "broken" ? "broken" : "not evaluable");
}
