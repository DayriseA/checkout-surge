import type {
  DemoRunStatus,
  FastReservationTargetEvaluation,
  RunResult,
  TrafficDeliveryStatus,
} from "@checkout-surge/contracts";
import {
  derivePublicRunSummary,
  type PublicRunCaveat,
  type PublicRunSummary,
} from "../lib/presentation/public-run-summary";
import { publicVocabulary } from "../lib/presentation/public-vocabulary";
import { invariantLabel, runConclusionSentence } from "../lib/presentation/run-result-presentation";
import { AdvancedOnly, RevealAdvancedLink } from "./page-view";
import type { TransportObservation } from "./transport-observation";

type Reconciliation = RunResult["reconciliations"][number];

function publicPopulationLabel(item: Reconciliation, side: "left" | "right"): string {
  switch (item.code) {
    case "pending_persistence":
    case "pending_persistence_evidence_mismatch":
      return side === "left"
        ? "reservations awaiting durable storage"
        : "durable pending reservations";
    case "accepted_responses_vs_unique_reservations":
    case "generator_evidence_unavailable":
      return side === "left"
        ? `${publicVocabulary.acceptedResponses} observed by the load generator`
        : publicVocabulary.uniqueReservationsSecured;
    case "sold_out_decisions_vs_responses":
      return side === "left"
        ? publicVocabulary.soldOutRejectionsSeen
        : publicVocabulary.soldOutRejectionsRecorded;
    case "partial_generator_coverage":
      return side === "left"
        ? "planned checkout attempts"
        : "checkout responses completed by the load generator";
    case "sold_out_with_stock_remaining":
      return side === "left" ? publicVocabulary.soldOutRejectionsRecorded : "remaining stock";
    case "notifications_below_confirmations":
      return side === "left" ? publicVocabulary.notifications : "confirmed orders";
    default:
      return side === "left" ? "first observed population" : "second observed population";
  }
}

function publicReconciliationReason(item: Reconciliation): string | null {
  const reason = item.reason;
  if (!reason) return null;
  switch (item.code) {
    case "pending_persistence":
      return "Inventory reservations can precede durable checkout records.";
    case "pending_persistence_evidence_mismatch":
      return "Live reservations and durable pending records differ.";
    case "accepted_responses_vs_unique_reservations":
      if (reason === "Idempotent replay responses are included.") {
        return "Some accepted responses may repeat an existing reservation.";
      }
      if (reason === "The populations represent different observations.") {
        return "Accepted checkout responses and unique reservations measure different stages of the run.";
      }
      if (reason === "Durable reservation evidence is unavailable.") {
        return "The durable reservation count is not available for comparison.";
      }
      return null;
    case "sold_out_decisions_vs_responses":
      if (reason === "Observed replies and durable decisions are separate populations.") {
        return "Load-generator reply observations and durable rejection records are separate populations.";
      }
      if (reason === "Observed sold-out replies exceed recorded server decisions.") {
        return "Sold-out rejections seen by the load generator exceed durable sold-out rejections.";
      }
      if (reason === "Durable sold-out decision evidence is unavailable.") {
        return "Durable sold-out rejection evidence is unavailable.";
      }
      return null;
    case "partial_generator_coverage":
      return "Only attempts that reached a response are included in the load-generator evidence.";
    case "generator_evidence_unavailable":
      return "Load-generator evidence is unavailable.";
    case "sold_out_with_stock_remaining":
      return "Sold-out rejections while stock remained need investigation.";
    case "notifications_below_confirmations":
      return "Not every confirmed order has a recorded simulated email.";
    default:
      return null;
  }
}

export function RunConclusion({
  result,
  runStatus,
  showCanonicalCodes = false,
  showReconciliationStatus = false,
}: {
  result: RunResult;
  runStatus: DemoRunStatus;
  showCanonicalCodes?: boolean;
  showReconciliationStatus?: boolean;
}) {
  if (runStatus !== "completed" && runStatus !== "failed") return null;
  const hasCorrectnessFailure = result.maximumClassification === "correctness_failure";
  return (
    <section
      className={`col-span-full rounded-lg border p-4 ${hasCorrectnessFailure ? "border-danger bg-danger-soft" : "border-border bg-surface"}`}
      aria-label="Run conclusion"
    >
      <p className="m-0 text-xs font-bold uppercase text-muted">Final result</p>
      <p className="m-0 mt-1 text-lg font-bold leading-7 text-ink">
        {runConclusionSentence(result)}
      </p>
      {showReconciliationStatus ? <ReconciliationStatus result={result} /> : null}
      <ConclusionEvidence result={result} showCanonicalCodes={showCanonicalCodes} />
    </section>
  );
}

/**
 * The public composition of the same canonical result: the shared concise summary and its
 * material caveats stay visible in both view modes, while the full narration, reconciliation
 * status, invariant expressions and proof stay available inside the Advanced boundary.
 */
export function PublicRunConclusion({
  result,
  runStatus,
  trafficDeliveryStatus = null,
  fastReservationTargetEvaluation = null,
  transportObservation = null,
  consistencyTargetId,
  measurementsTargetId,
}: {
  result: RunResult;
  runStatus: DemoRunStatus;
  trafficDeliveryStatus?: TrafficDeliveryStatus | null;
  fastReservationTargetEvaluation?: FastReservationTargetEvaluation | null;
  transportObservation?: TransportObservation | null;
  consistencyTargetId?: string;
  measurementsTargetId?: string;
}) {
  if (runStatus !== "completed" && runStatus !== "failed") return null;
  const summary = derivePublicRunSummary({
    result,
    trafficDeliveryStatus,
    fastReservationTargetEvaluation,
    transportObservation,
  });
  return (
    <section
      className={`col-span-full rounded-lg border p-4 ${publicConclusionClassName(result, summary)}`}
      aria-label="Run conclusion"
    >
      <p className="m-0 text-xs font-bold uppercase text-muted">Final result</p>
      <p className="m-0 mt-1 text-lg font-bold leading-7 text-ink">{summary.title}</p>
      <p className="m-0 mt-1 leading-6 text-muted-strong">{summary.sentence}</p>
      {summary.failure ? (
        <div className="mt-3 text-sm text-muted-strong">
          <p className="m-0">{summary.failure.explanation}</p>
          <p className="m-0 mt-1 font-semibold">{summary.failure.action}</p>
        </div>
      ) : null}
      <PublicRunCaveatList caveats={summary.caveats} />
      {measurementsTargetId && summary.hasMeasurementCaveat ? (
        <RevealAdvancedLink targetId={measurementsTargetId}>
          View technical measurements
        </RevealAdvancedLink>
      ) : null}
      <PublicRunConclusionProof
        result={result}
        {...(consistencyTargetId ? { targetId: consistencyTargetId } : {})}
      />
    </section>
  );
}

/** Every material qualification, outside the Advanced boundary. */
export function PublicRunCaveatList({ caveats }: { caveats: PublicRunCaveat[] }) {
  return (
    <>
      {caveats.map((caveat) => (
        <p
          className={`m-0 mt-3 rounded border px-3 py-2 text-sm font-semibold ${
            caveat.tone === "danger"
              ? "border-danger bg-danger-soft text-danger"
              : "border-warning bg-warning-soft text-warning"
          }`}
          key={caveat.message}
          role="status"
        >
          {caveat.message}
        </p>
      ))}
    </>
  );
}

/**
 * The Advanced-only proof of the same canonical result: the full narration, reconciliation
 * status, invariant expressions with actual/expected values and the reconciliation proof. It is
 * the Advanced content of `PublicRunConclusion`, shared with the Watch composition so both
 * surfaces present exactly the same evidence.
 */
export function PublicRunConclusionProof({
  result,
  targetId,
}: {
  result: RunResult;
  targetId?: string;
}) {
  return (
    <AdvancedOnly className="mt-4" {...(targetId ? { id: targetId } : {})}>
      {targetId ? <h2 className="m-0 text-base font-bold text-ink">Consistency</h2> : null}
      <p className="m-0 text-sm leading-6 text-muted-strong">{runConclusionSentence(result)}</p>
      <ReconciliationStatus result={result} />
      <ConclusionEvidence result={result} showCanonicalCodes={false} />
    </AdvancedOnly>
  );
}

/** Danger tracks oversell, run failure and contradictory evidence; warnings never escalate. */
function publicConclusionClassName(result: RunResult, summary: PublicRunSummary): string {
  const danger =
    result.maximumClassification === "correctness_failure" ||
    summary.outcome === "failed" ||
    summary.outcome === "completed-with-oversell" ||
    summary.caveats.some((caveat) => caveat.tone === "danger");
  const warning =
    summary.outcome === "completed-with-order-failures" ||
    summary.outcome === "completed-with-unsettled-orders" ||
    summary.caveats.length > 0;
  return danger
    ? "border-danger bg-danger-soft"
    : warning
      ? "border-warning bg-warning-soft"
      : "border-border bg-surface";
}

function ConclusionEvidence({
  result,
  showCanonicalCodes,
}: {
  result: RunResult;
  showCanonicalCodes: boolean;
}) {
  return (
    <>
      <div className="mt-4 grid gap-2">
        {result.invariants.map((invariant) => (
          <div
            className="grid gap-1 rounded border border-border px-3 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto]"
            key={invariant.name}
          >
            <span className="text-muted-strong">
              {invariant.expression}
              <span className="mt-1 block text-xs text-muted">
                actual: {invariant.actual ?? "unavailable"} · expected:{" "}
                {invariant.expected ?? "unavailable"}
              </span>
            </span>
            <span
              className={
                invariant.status === "broken"
                  ? "font-semibold text-danger"
                  : "font-semibold text-muted-strong"
              }
            >
              {invariantLabel(invariant.status)}
            </span>
          </div>
        ))}
      </div>
      <details className="mt-4 rounded border border-border px-3 py-2 text-sm">
        <summary className="cursor-pointer font-semibold text-muted-strong">
          Evidence and reconciliation proof
        </summary>
        <div className="mt-3 grid gap-2">
          {result.reconciliations.map((item) => {
            const reason = publicReconciliationReason(item);
            return (
              <p className="m-0 text-muted" key={item.code}>
                <span className="font-semibold text-muted-strong">
                  {publicPopulationLabel(item, "left")}
                </span>{" "}
                ({item.leftValue ?? "unavailable"}) vs {publicPopulationLabel(item, "right")} (
                {item.rightValue ?? "unavailable"}):{" "}
                {showCanonicalCodes ? (
                  <>
                    {classificationExplanation(item.classification)} <code>{item.code}</code>
                  </>
                ) : (
                  item.classification.replaceAll("_", " ")
                )}
                {reason ? ` — ${reason}` : "."}
              </p>
            );
          })}
          {result.reconciliations.length === 0 ? (
            <p className="m-0 text-muted">No differences require reconciliation.</p>
          ) : null}
        </div>
      </details>
    </>
  );
}

function classificationExplanation(classification: Reconciliation["classification"]): string {
  switch (classification) {
    case "expected_population_difference":
      return "Expected population difference.";
    case "evidence_incomplete":
      return "Evidence is incomplete.";
    case "warning":
      return "Evidence needs investigation.";
    case "correctness_failure":
      return "Authoritative evidence is contradictory.";
  }
}

function ReconciliationStatus({ result }: { result: RunResult }) {
  if (
    result.maximumClassification !== "evidence_incomplete" &&
    result.maximumClassification !== "warning"
  ) {
    return null;
  }

  const matchingReconciliations = result.reconciliations.filter(
    (item) => item.classification === result.maximumClassification,
  );
  const reconciliation =
    matchingReconciliations.find((item) => publicReconciliationReason(item) !== null) ??
    matchingReconciliations[0];
  const reason = reconciliation ? publicReconciliationReason(reconciliation) : null;
  const explanation = reconciliation
    ? `${publicPopulationLabel(reconciliation, "left")} and ${publicPopulationLabel(reconciliation, "right")} require reconciliation.${reason ? ` ${reason}` : ""}`
    : "Some final evidence was unavailable.";
  const incomplete = result.maximumClassification === "evidence_incomplete";

  return (
    <p
      className="m-0 mt-3 rounded border border-warning bg-warning-soft px-3 py-2 text-sm font-semibold text-muted-strong"
      role="status"
    >
      {incomplete ? "Evidence incomplete" : "Reconciliation warning"}: {explanation}
    </p>
  );
}
