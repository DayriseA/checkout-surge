import type { DemoRunStatus, RunResult } from "@checkout-surge/contracts";
import { publicVocabulary } from "../lib/presentation/public-vocabulary";
import { invariantLabel, runConclusionSentence } from "../lib/presentation/run-result-presentation";

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
}: {
  result: RunResult;
  runStatus: DemoRunStatus;
}) {
  if (runStatus !== "completed" && runStatus !== "failed") return null;
  const hasCorrectnessFailure = result.maximumClassification === "correctness_failure";
  return (
    <section
      className={`col-span-12 rounded-lg border p-4 ${hasCorrectnessFailure ? "border-danger bg-danger-soft" : "border-border bg-surface"}`}
      aria-label="Run conclusion"
    >
      <p className="m-0 text-xs font-bold uppercase text-muted">Final result</p>
      <p className="m-0 mt-1 text-lg font-bold leading-7 text-ink">
        {runConclusionSentence(result)}
      </p>
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
                {item.rightValue ?? "unavailable"}): {item.classification.replaceAll("_", " ")}
                {reason ? ` — ${reason}` : "."}
              </p>
            );
          })}
          {result.reconciliations.length === 0 ? (
            <p className="m-0 text-muted">No differences require reconciliation.</p>
          ) : null}
        </div>
      </details>
    </section>
  );
}
