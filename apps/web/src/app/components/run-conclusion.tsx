"use client";

import type { DemoRunStatus, RunResult, TrafficDeliveryStatus } from "@checkout-surge/contracts";
import { useLocale, useTranslation } from "../lib/i18n/locale-context";
import { getTranslation, type Locale } from "../lib/i18n/translate";
import { formatCount } from "../lib/presentation/format";
import {
  derivePublicRunSummary,
  type PublicRunCaveat,
  type PublicRunSummary,
} from "../lib/presentation/public-run-summary";
import { publicVocabulary } from "../lib/presentation/public-vocabulary";
import type { RunFailureExplanationEvidence } from "../lib/presentation/run-failure-explanation";
import { invariantLabel, runConclusionSentence } from "../lib/presentation/run-result-presentation";
import { ReportMeasurementsLink } from "./report-measurements-link";
import { RunFailureExplanation } from "./run-failure-explanation";
import type { TransportObservation } from "./transport-observation";

type Reconciliation = RunResult["reconciliations"][number];

function publicPopulationLabel(
  item: Reconciliation,
  side: "left" | "right",
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  switch (item.code) {
    case "pending_persistence":
    case "pending_persistence_evidence_mismatch":
      return side === "left"
        ? t("reservations awaiting durable storage")
        : t("durable pending reservations");
    case "accepted_responses_vs_unique_reservations":
    case "generator_evidence_unavailable":
      return side === "left"
        ? t("{value1} observed by the load generator", {
            value1: t(publicVocabulary.acceptedResponses),
          })
        : t(publicVocabulary.uniqueReservationsSecured);
    case "sold_out_decisions_vs_responses":
      return side === "left"
        ? t(publicVocabulary.soldOutRejectionsSeen)
        : t(publicVocabulary.soldOutRejectionsRecorded);
    case "partial_generator_coverage":
      return side === "left"
        ? t("planned checkout attempts")
        : t("checkout responses completed by the load generator");
    case "sold_out_with_stock_remaining":
      return side === "left" ? t(publicVocabulary.soldOutRejectionsRecorded) : t("remaining stock");
    case "notifications_below_confirmations":
      return side === "left" ? t(publicVocabulary.notifications) : t("confirmed orders");
  }
}

function publicReconciliationReason(item: Reconciliation, locale: Locale = "en"): string | null {
  const t = getTranslation(locale);
  switch (item.code) {
    case "pending_persistence":
      return t("Inventory reservations can precede durable checkout records.");
    case "pending_persistence_evidence_mismatch":
      return t("Live reservations and durable pending records differ.");
    case "accepted_responses_vs_unique_reservations":
      if (item.classification === "expected_population_difference") {
        return item.replayPossible
          ? t("Some accepted responses may repeat an existing reservation.")
          : t(
              "Accepted checkout responses and unique reservations measure different stages of the run.",
            );
      }
      if (
        item.classification === "evidence_incomplete" &&
        item.incompleteReason === "unavailable"
      ) {
        return t("The durable reservation count is not available for comparison.");
      }
      if (item.classification === "evidence_incomplete" && item.incompleteReason === "partial") {
        return t(
          "The load generator did not record an answer for every planned request, so its count cannot match the server's.",
        );
      }
      return null;
    case "sold_out_decisions_vs_responses":
      if (item.classification === "expected_population_difference") {
        return t(
          "Load-generator reply observations and durable rejection records are separate populations.",
        );
      }
      if (item.classification === "warning") {
        return t(
          "Sold-out rejections seen by the load generator exceed durable sold-out rejections.",
        );
      }
      if (
        item.classification === "evidence_incomplete" &&
        item.incompleteReason === "unavailable"
      ) {
        return t("Durable sold-out rejection evidence is unavailable.");
      }
      return null;
    case "partial_generator_coverage":
      return t(
        "Only attempts that reached a response are included in the load-generator evidence.",
      );
    case "generator_evidence_unavailable":
      return t("Load-generator evidence is unavailable.");
    case "sold_out_with_stock_remaining":
      return t("Sold-out rejections while stock remained need investigation.");
    case "notifications_below_confirmations":
      return t("Not every confirmed order has a recorded simulated email.");
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
  const t = useTranslation();
  if (runStatus !== "completed" && runStatus !== "failed") return null;
  const hasCorrectnessFailure = result.maximumClassification === "correctness_failure";
  return (
    <section
      className={`col-span-full rounded-2xl border p-5 max-[560px]:p-4 ${hasCorrectnessFailure ? "border-danger bg-danger-soft" : "border-border bg-surface"}`}
      aria-label={t("Run conclusion")}
    >
      <p className="m-0 text-xs font-medium text-muted">{t("Final result")}</p>
      <ProofNarration
        className="m-0 mt-1 max-w-[90ch] text-base font-semibold leading-6 text-ink"
        result={result}
      />
      {showReconciliationStatus ? <ReconciliationStatus result={result} /> : null}
      <ConclusionEvidence result={result} showCanonicalCodes={showCanonicalCodes} />
    </section>
  );
}

/**
 * The public composition of the same canonical result: the shared concise summary, material
 * caveats, full narration, reconciliation status, invariant expressions and proof.
 */
export function PublicRunConclusion({
  result,
  runStatus,
  trafficDeliveryStatus = null,
  transportObservation = null,
  consistencyTargetId,
  measurementsTargetId,
  showProof = true,
  failureExplanation = null,
  stderrLines,
}: {
  result: RunResult;
  runStatus: DemoRunStatus;
  trafficDeliveryStatus?: TrafficDeliveryStatus | null;
  transportObservation?: TransportObservation | null;
  consistencyTargetId?: string;
  measurementsTargetId?: string;
  showProof?: boolean;
  failureExplanation?: RunFailureExplanationEvidence | null;
  stderrLines?: string[];
}) {
  const locale = useLocale();
  const t = useTranslation();
  if (runStatus !== "completed" && runStatus !== "failed") return null;
  const summary = derivePublicRunSummary(
    {
      result,
      trafficDeliveryStatus,
      transportObservation,
      hasFailureExplanation: failureExplanation !== null,
    },
    locale,
  );
  return (
    <section
      className={`col-span-full rounded-2xl border p-5 max-[560px]:p-4 ${failureExplanation ? "border-border bg-surface" : publicConclusionClassName(result, summary)}`}
      aria-label={t("Run conclusion")}
    >
      <p className="m-0 text-xs font-medium text-muted">{t("Final result")}</p>
      {failureExplanation ? (
        <p className="m-0 mt-1 text-sm font-semibold text-danger">{t("Traffic failure")}</p>
      ) : (
        <p className="m-0 mt-1 max-w-[90ch] text-base font-semibold leading-6 text-ink">
          {summary.sentence}
        </p>
      )}
      {failureExplanation ? (
        <RunFailureExplanation
          evidence={failureExplanation}
          {...(stderrLines ? { stderrLines } : {})}
        />
      ) : summary.failureAction ? (
        <p className="m-0 mt-1 text-sm font-semibold text-muted-strong">{summary.failureAction}</p>
      ) : null}
      <PublicRunCaveatList caveats={summary.caveats} />
      {measurementsTargetId && summary.hasMeasurementCaveat ? (
        <ReportMeasurementsLink targetId={measurementsTargetId} />
      ) : null}
      {showProof ? (
        <PublicRunConclusionProof
          result={result}
          {...(consistencyTargetId ? { targetId: consistencyTargetId } : {})}
        />
      ) : null}
    </section>
  );
}

/** Every material qualification for the public result. */
export function PublicRunCaveatList({ caveats }: { caveats: PublicRunCaveat[] }) {
  const t = useTranslation();
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
          {t(caveat.message)}
        </p>
      ))}
    </>
  );
}

/**
 * The proof of the same canonical result: the full narration, reconciliation status, invariant
 * expressions with actual/expected values and the reconciliation proof, shared with the Watch
 * composition so both surfaces present exactly the same evidence.
 */
export function PublicRunConclusionProof({
  alwaysVisible = false,
  result,
  targetId,
}: {
  alwaysVisible?: boolean;
  result: RunResult;
  targetId?: string;
}) {
  const t = useTranslation();
  const content = (
    <>
      {targetId ? <h2 className="type-title m-0 text-base text-ink">{t("Consistency")}</h2> : null}
      <ProofNarration className="m-0 text-sm leading-6 text-muted-strong" result={result} />
      <ReconciliationStatus result={result} />
      <ConclusionEvidence result={result} showCanonicalCodes={false} />
    </>
  );
  if (alwaysVisible) {
    return (
      <section
        className="rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4"
        {...(targetId ? { id: targetId, tabIndex: -1 } : {})}
      >
        {content}
      </section>
    );
  }
  return (
    <div className="mt-4" {...(targetId ? { id: targetId } : {})} tabIndex={-1}>
      {content}
    </div>
  );
}

/**
 * The full narration that opens the proof. A failed run's narration is its verdict, which every
 * surface showing the proof already states, so the proof does not repeat it.
 */
function ProofNarration({ className, result }: { className: string; result: RunResult }) {
  const locale = useLocale();
  if (result.outcome === "failed") return null;
  return <p className={className}>{runConclusionSentence(result, {}, locale)}</p>;
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
  const t = useTranslation();
  const locale = useLocale();
  return (
    <>
      <div className="mt-4 grid gap-2">
        {result.invariants.map((invariant) => (
          <div
            className="grid gap-1 rounded border border-border px-3 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto]"
            key={invariant.name}
          >
            <span className="text-muted-strong">
              {t(invariant.expression)}
              <span className="mt-1 block text-xs text-muted">
                {t("actual:")} {formatCount(invariant.actual, locale) ?? t("unavailable")}{" "}
                {t("· expected:")} {formatCount(invariant.expected, locale) ?? t("unavailable")}
              </span>
            </span>
            <span
              className={
                invariant.status === "broken"
                  ? "font-semibold text-danger"
                  : "font-semibold text-muted-strong"
              }
            >
              {invariantLabel(invariant.status, locale)}
            </span>
          </div>
        ))}
      </div>
      <details className="mt-4 rounded border border-border px-3 py-2 text-sm">
        <summary className="disclosure font-semibold text-ink">
          {t("Evidence and reconciliation proof")}
        </summary>
        <div className="mt-3 grid gap-2">
          {result.reconciliations.map((item) => {
            const reason = publicReconciliationReason(item, locale);
            return (
              <p className="m-0 text-muted" key={item.code}>
                <span className="font-semibold text-muted-strong">
                  {publicPopulationLabel(item, "left", locale)}
                </span>{" "}
                ({formatCount(item.leftValue, locale) ?? t("unavailable")}
                {t(") vs")} {publicPopulationLabel(item, "right", locale)} (
                {formatCount(item.rightValue, locale) ?? t("unavailable")}):{" "}
                {showCanonicalCodes ? (
                  <>
                    {classificationExplanation(item.classification, locale)}{" "}
                    <code>{item.code}</code>
                  </>
                ) : (
                  t(item.classification.replaceAll("_", " "))
                )}
                {reason ? ` — ${reason}` : "."}
              </p>
            );
          })}
          {result.reconciliations.length === 0 ? (
            <p className="m-0 text-muted">{t("No differences require reconciliation.")}</p>
          ) : null}
        </div>
      </details>
    </>
  );
}

function classificationExplanation(
  classification: Reconciliation["classification"],
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  switch (classification) {
    case "expected_population_difference":
      return t("Expected population difference.");
    case "evidence_incomplete":
      return t("Evidence is incomplete.");
    case "warning":
      return t("Evidence needs investigation.");
    case "correctness_failure":
      return t("Authoritative evidence is contradictory.");
  }
}

// Population labels are written as headings; lowercase a capitalized word, not an acronym, mid-sentence.
function inSentence(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

function ReconciliationStatus({ result }: { result: RunResult }) {
  const t = useTranslation();
  const locale = useLocale();
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
    matchingReconciliations.find((item) => publicReconciliationReason(item, locale) !== null) ??
    matchingReconciliations[0];
  const reason = reconciliation ? publicReconciliationReason(reconciliation, locale) : null;
  const explanation = reconciliation
    ? t("{value1} and {value2} require reconciliation.{value3}", {
        value1: inSentence(publicPopulationLabel(reconciliation, "left", locale)),
        value2: inSentence(publicPopulationLabel(reconciliation, "right", locale)),
        value3: reason ? ` ${reason}` : "",
      })
    : t("Some final evidence was unavailable.");
  const incomplete = result.maximumClassification === "evidence_incomplete";

  return (
    <p
      className="m-0 mt-3 rounded border border-warning bg-warning-soft px-3 py-2 text-sm font-semibold text-muted-strong"
      role="status"
    >
      {incomplete ? t("Evidence incomplete") : t("Reconciliation warning")}
      {t(": ")}
      {explanation}
    </p>
  );
}
