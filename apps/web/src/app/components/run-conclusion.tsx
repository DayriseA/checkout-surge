import type { DemoRunStatus, RunResult } from "@checkout-surge/contracts";
import { invariantLabel, runConclusionSentence } from "../lib/presentation/run-result-presentation";

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
      <p className="m-0 text-xs font-bold uppercase text-muted">Conclusion</p>
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
          {result.reconciliations.map((item) => (
            <p className="m-0 text-muted" key={item.code}>
              <span className="font-semibold text-muted-strong">{item.leftPopulation}</span> (
              {item.leftValue ?? "unavailable"}) vs {item.rightPopulation} (
              {item.rightValue ?? "unavailable"}): {item.classification.replaceAll("_", " ")}
              {item.reason ? ` — ${item.reason}` : ""}.
            </p>
          ))}
          {result.reconciliations.length === 0 ? (
            <p className="m-0 text-muted">No differences require reconciliation.</p>
          ) : null}
        </div>
      </details>
    </section>
  );
}
