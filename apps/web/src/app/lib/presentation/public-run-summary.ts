import type { RunResult, TrafficDeliveryStatus } from "@checkout-surge/contracts";
import type { TransportObservation } from "../../components/transport-observation";
import { getTranslation, type Locale } from "../i18n/translate";
import { formatCount } from "./format";
import { publicFailureExplanation, runResultOutcomeLabel } from "./public-vocabulary";
import { runConclusionSentence } from "./run-result-presentation";
import { hasUnknownTrafficCounts, trafficEvidenceUnavailableText } from "./traffic-evidence";

/**
 * The small public summary shared by Watch and the public report. It is a presentation adapter
 * around the canonical `RunResult` from `deriveRunResult`, never a second derivation: the verdict
 * wording comes from `runConclusionSentence` and `runResultOutcomeLabel`, and the caveats select
 * and reword what the canonical invariants and reconciliations already classify.
 *
 * Unknown values stay `null` here so callers can render "unavailable" instead of a false zero.
 */
export interface PublicRunSummaryInput {
  result: RunResult;
  /**
   * Saved-report evidence only. `DashboardProjection` never carries the delivery summary, so
   * live Watch passes null and the summary never invents a delivery qualification. The public
   * report supplies it.
   */
  trafficDeliveryStatus: TrafficDeliveryStatus | null;
  /**
   * Live load-generator reply evidence, derived by the caller with
   * `deriveTransportObservation` where the transport counts exist; this caveat does NOT require
   * saved-report evidence. Null when no transport counts are available.
   */
  transportObservation: TransportObservation | null;
  /** A visible explanation already accounts for delivery and response coverage. */
  hasFailureExplanation?: boolean;
}

export type PublicRunCaveatTone = "warning" | "danger";

export interface PublicRunCaveat {
  message: string;
  tone: PublicRunCaveatTone;
}

export interface PublicRunSummaryCounts {
  startingStock: number | null;
  remainingStock: number | null;
  reservedUnits: number | null;
  uniqueReservations: number | null;
  soldOutDecisions: number | null;
  confirmedOrders: number | null;
  failedOrders: number | null;
  pendingOrders: number | null;
  oversoldUnits: number | null;
}

export interface PublicRunSummary {
  outcome: RunResult["outcome"];
  title: string;
  sentence: string;
  counts: PublicRunSummaryCounts;
  /**
   * Every material qualification, not only the highest-priority one: contradictory, incomplete
   * and investigation-worthy evidence stay visible next to each other, expected
   * duplicate-population differences never become a caveat, and partial reply observation is
   * qualified from live transport evidence. Saved-report evidence is only needed for the
   * delivery caveats.
   */
  caveats: PublicRunCaveat[];
  /** Whether at least one caveat is explained by the detailed delivery/measurement evidence. */
  hasMeasurementCaveat: boolean;
  /**
   * The next step after a failed run. Its explanation is already the verdict `sentence`, so a
   * surface states the failure once.
   */
  failureAction: string | null;
}

export function derivePublicRunSummary(
  input: PublicRunSummaryInput,
  locale: Locale = "en",
): PublicRunSummary {
  const { result } = input;
  const caveatSummary = publicRunCaveats(result, input, locale);
  return {
    outcome: result.outcome,
    title: runResultOutcomeLabel(result.outcome, locale),
    sentence: runConclusionSentence(result, { concise: true }, locale),
    counts: {
      startingStock: result.startingStock,
      remainingStock: result.remainingStock,
      reservedUnits: result.reservedUnits,
      uniqueReservations: result.uniqueReservations,
      soldOutDecisions: result.soldOutDecisions,
      confirmedOrders: result.confirmedOrders,
      failedOrders: result.failedOrders,
      pendingOrders: result.pendingOrders,
      oversoldUnits: result.oversoldUnits,
    },
    ...caveatSummary,
    failureAction: result.failureCategory
      ? publicFailureExplanation(result.failureCategory, locale).action
      : null,
  };
}

function publicRunCaveats(
  result: RunResult,
  input: PublicRunSummaryInput,
  locale: Locale = "en",
): Pick<PublicRunSummary, "caveats" | "hasMeasurementCaveat"> {
  const t = getTranslation(locale);
  const caveats: PublicRunCaveat[] = [];
  const classifications = new Set(result.reconciliations.map((item) => item.classification));
  // Broken and not-evaluable invariants carry the same material meanings as their reconciliation
  // counterparts but never appear as reconciliations, so they must be inspected directly.
  for (const invariant of result.invariants) {
    if (invariant.status === "broken") classifications.add("correctness_failure");
    if (invariant.status === "not_evaluable") classifications.add("evidence_incomplete");
  }

  // An indeterminate sentence names its own headline classification, so that one caveat would
  // only repeat it; every other outcome keeps each qualification visible.
  const sentenceSaysIncomplete =
    result.outcome === "outcome-indeterminate" &&
    result.maximumClassification === "evidence_incomplete";
  const sentenceSaysContradictory =
    result.outcome === "outcome-indeterminate" &&
    result.maximumClassification === "correctness_failure";
  if (classifications.has("correctness_failure") && !sentenceSaysContradictory) {
    caveats.push({
      message: t(
        "Contradictory evidence: the final stock and order records disagree, so this result needs investigation.",
      ),
      tone: "danger",
    });
  }
  if (classifications.has("warning")) {
    caveats.push({
      message: t(
        "Reconciliation warning: some final evidence populations disagree and need investigation.",
      ),
      tone: "warning",
    });
  }
  const hasOtherMissingEvidence =
    result.invariants.some((item) => item.status === "not_evaluable") ||
    result.reconciliations.some(
      (item) =>
        item.classification === "evidence_incomplete" &&
        !(
          item.incompleteReason === "partial" &&
          [
            "partial_generator_coverage",
            "accepted_responses_vs_unique_reservations",
            "sold_out_decisions_vs_responses",
          ].includes(item.code)
        ),
    );
  if (
    classifications.has("evidence_incomplete") &&
    !sentenceSaysIncomplete &&
    (!input.hasFailureExplanation || hasOtherMissingEvidence)
  ) {
    caveats.push({
      message: t(
        "Evidence incomplete: some final evidence was unavailable, so the result could not be fully verified.",
      ),
      tone: "warning",
    });
  }

  const measurementCaveats = input.hasFailureExplanation
    ? []
    : measurementCaveatsFor(input.transportObservation, input.trafficDeliveryStatus, locale);
  return {
    caveats: [...caveats, ...measurementCaveats],
    hasMeasurementCaveat: measurementCaveats.length > 0,
  };
}

function measurementCaveatsFor(
  observation: TransportObservation | null,
  deliveryStatus: TrafficDeliveryStatus | null,
  locale: Locale = "en",
): PublicRunCaveat[] {
  const t = getTranslation(locale);
  // Unknown counts cannot support a delivery verdict; the unavailable-evidence caveat says it all.
  if (observation && hasUnknownTrafficCounts(observation.counts))
    return [{ message: t(trafficEvidenceUnavailableText), tone: "warning" }];
  return [...transportCaveats(observation, locale), ...deliveryCaveats(deliveryStatus, locale)];
}

function transportCaveats(
  observation: TransportObservation | null,
  locale: Locale = "en",
): PublicRunCaveat[] {
  const t = getTranslation(locale);
  if (!observation || (!observation.hasUnrecordedReplies && !observation.hasUndispatchedAttempts)) {
    return [];
  }
  return [
    {
      message: observation.hasUndispatchedAttempts
        ? t(
            "{v0} planned requests were never sent. {v1} Outcomes and latency cover recorded responses only.",
            {
              v0: String(formatCount(observation.counts.unstartedRequests, locale)),
              v1: String(
                observation.hasUnrecordedReplies
                  ? t(
                      "{v0} answers arrived too late to be recorded; {v1} attempts ended in transport failure.",
                      {
                        v0: String(formatCount(observation.counts.interruptedRequests, locale)),
                        v1: String(formatCount(observation.transportFailures, locale)),
                      },
                    )
                  : t("All sent requests completed."),
              ),
            },
          )
        : t("Reply observation incomplete: outcomes and latency cover {v0} of {v1} attempts.", {
            v0: String(formatCount(observation.repliesRecorded, locale) ?? "unavailable"),
            v1: String(formatCount(observation.counts.plannedRequests, locale) ?? "unavailable"),
          }),
      tone: "warning",
    },
  ];
}

function deliveryCaveats(
  status: TrafficDeliveryStatus | null,
  locale: Locale = "en",
): PublicRunCaveat[] {
  const t = getTranslation(locale);
  if (status === null || status === "complete") return [];
  return [
    status === "failed"
      ? {
          message: t("Delivery failed: the load generator could not deliver the planned traffic."),
          tone: "danger" as const,
        }
      : {
          message: t("Partial delivery: not all planned checkout attempts completed."),
          tone: "warning" as const,
        },
  ];
}
