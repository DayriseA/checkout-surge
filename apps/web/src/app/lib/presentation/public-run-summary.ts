import type {
  FastReservationTargetEvaluation,
  RunResult,
  TrafficDeliveryStatus,
} from "@checkout-surge/contracts";
import type { TransportObservation } from "../../components/transport-observation";
import { formatCount } from "./format";
import { publicFailureExplanation, runResultOutcomeLabel } from "./public-vocabulary";
import { runConclusionSentence } from "./run-result-presentation";

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
   * Saved-report evidence only. `DashboardProjection` carries neither the delivery summary nor
   * the reservation-target evaluation, so live Watch passes null and the summary never invents
   * a delivery or speed-target verdict. The public report supplies both.
   */
  trafficDeliveryStatus: TrafficDeliveryStatus | null;
  fastReservationTargetEvaluation: FastReservationTargetEvaluation | null;
  /**
   * Live load-generator reply evidence, derived by the caller with
   * `deriveTransportObservation` where the transport counts exist; this caveat does NOT require
   * saved-report evidence. Null when no transport counts are available.
   */
  transportObservation: TransportObservation | null;
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
   * delivery and speed-target caveats.
   */
  caveats: PublicRunCaveat[];
  /** Whether at least one caveat is explained by the detailed delivery/measurement evidence. */
  hasMeasurementCaveat: boolean;
  /** Public-safe failure explanation and next action for a failed run. */
  failure: { explanation: string; action: string } | null;
}

export function derivePublicRunSummary(input: PublicRunSummaryInput): PublicRunSummary {
  const { result } = input;
  const caveatSummary = publicRunCaveats(result, input);
  return {
    outcome: result.outcome,
    title: runResultOutcomeLabel(result.outcome),
    sentence: runConclusionSentence(result, { concise: true }),
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
    failure: result.failureCategory ? publicFailureExplanation(result.failureCategory) : null,
  };
}

function publicRunCaveats(
  result: RunResult,
  input: PublicRunSummaryInput,
): Pick<PublicRunSummary, "caveats" | "hasMeasurementCaveat"> {
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
      message:
        "Contradictory evidence: the final stock and order records disagree, so this result needs investigation.",
      tone: "danger",
    });
  }
  if (classifications.has("warning")) {
    caveats.push({
      message:
        "Reconciliation warning: some final evidence populations disagree and need investigation.",
      tone: "warning",
    });
  }
  if (classifications.has("evidence_incomplete") && !sentenceSaysIncomplete) {
    caveats.push({
      message:
        "Evidence incomplete: some final evidence was unavailable, so the result could not be fully verified.",
      tone: "warning",
    });
  }

  const measurementCaveats = [
    ...transportCaveats(input.transportObservation),
    ...deliveryCaveats(input.trafficDeliveryStatus),
    ...targetCaveats(input.fastReservationTargetEvaluation),
  ];
  return {
    caveats: [...caveats, ...measurementCaveats],
    hasMeasurementCaveat: measurementCaveats.length > 0,
  };
}

function transportCaveats(observation: TransportObservation | null): PublicRunCaveat[] {
  if (!observation || (!observation.hasUnrecordedReplies && !observation.hasUndispatchedAttempts)) {
    return [];
  }
  return [
    {
      message: `Reply observation incomplete: outcomes and latency cover ${formatCount(observation.repliesRecorded) ?? "unavailable"} of ${formatCount(observation.counts.plannedRequests) ?? "unavailable"} attempts.`,
      tone: "warning",
    },
  ];
}

function deliveryCaveats(status: TrafficDeliveryStatus | null): PublicRunCaveat[] {
  if (status === null || status === "complete") return [];
  return [
    status === "failed"
      ? {
          message: "Delivery failed: the load generator could not deliver the planned traffic.",
          tone: "danger" as const,
        }
      : {
          message: "Partial delivery: not all planned checkout attempts were delivered.",
          tone: "warning" as const,
        },
  ];
}

function targetCaveats(evaluation: FastReservationTargetEvaluation | null): PublicRunCaveat[] {
  if (!evaluation || evaluation.verdict === "pass") return [];
  if (evaluation.verdict === "fail") {
    // The threshold is a declared parameter, so it stays a bound ("≤ 1ms"), never a measurement.
    return [
      {
        message: `The run missed its fast-reservation speed target: the time within which 95% of measured reservations finished was above the ≤ ${evaluation.target.thresholdMs}ms target.`,
        tone: "warning",
      },
    ];
  }
  return [
    {
      message:
        evaluation.qualification === "measurement_unavailable"
          ? "The fast-reservation speed target could not be evaluated: server timing was unavailable."
          : `The fast-reservation speed target could not be fully evaluated: server timing covered ${evaluation.observedSampleCount} of ${evaluation.expectedResponseCount} recorded replies.`,
      tone: "warning",
    },
  ];
}
