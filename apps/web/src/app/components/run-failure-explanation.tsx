import {
  k6GracefulStopSeconds,
  type RunFailureDiagnostic,
  type TransportAttemptCounts,
} from "@checkout-surge/contracts";
import { formatCount, formatDurationMs, pluralize } from "../lib/presentation/format";
import type { RunFailureExplanationEvidence } from "../lib/presentation/run-failure-explanation";
import {
  hasUnknownTrafficCounts,
  trafficEvidenceUnavailableText,
} from "../lib/presentation/traffic-evidence";

export function RunFailureExplanation({
  evidence,
  stderrLines,
}: {
  evidence: RunFailureExplanationEvidence;
  /** Only supplied by the authenticated history surface. */
  stderrLines?: string[];
}) {
  const diagnostic = evidence.failureDiagnostic;
  if (!diagnostic) return null;
  const counts = evidence.transportAttemptCounts;
  const http = evidence.httpSummary;
  const business = evidence.businessOutcomeSummary;
  const connectionP95 = evidence.httpTimingBreakdownSummary.connecting?.p95Ms;
  const copy = causeCopy(diagnostic, counts);
  const lateAnswersCause = diagnostic.cause === "interrupted_requests";
  const countsUnknown = hasUnknownTrafficCounts(counts);
  const settled =
    business.acceptedReservations > 0 &&
    business.confirmedOrders === business.acceptedReservations &&
    business.notificationsRecorded === business.confirmedOrders &&
    business.failedOrders === 0 &&
    business.queuedOrders === 0 &&
    business.processingOrders === 0 &&
    business.pendingPersistenceCount === 0 &&
    business.retryingOrders === 0;
  const missingRequests =
    counts.completedRequests === null ? 0 : counts.plannedRequests - counts.completedRequests;
  // Server-side proof that late answers were handled: every sent request became a reservation,
  // and every reservation was confirmed and notified.
  const serverHandledLateAnswers =
    hasLateAnswers(counts) && settled && business.acceptedReservations === counts.startedRequests;
  return (
    <section className="mt-3 text-sm leading-6 text-muted-strong" aria-label="Failure explanation">
      <h2 className="type-title m-0 text-xl leading-tight text-ink">{copy.heading}</h2>
      {countsUnknown ? <p className="m-0 mt-2">{trafficEvidenceUnavailableText}</p> : null}
      <p className="m-0 mt-2">{copy.summary}</p>
      {missingRequests > 0 ? (
        <div className="my-3 border-l-2 border-danger pl-3">
          {counts.unstartedRequests !== null && counts.unstartedRequests > 0 ? (
            <p className="m-0 font-semibold text-ink">
              {unsentRequestsText(counts.unstartedRequests)}
            </p>
          ) : null}
          {lateAnswersCause ? (
            <p className="m-0">
              {formatCount(counts.interruptedRequests)} of {formatCount(counts.startedRequests)}{" "}
              {pluralize(counts.startedRequests, "answer")} arrived too late (
              {formatShortfallPercent(counts.interruptedRequests ?? 0, counts.startedRequests ?? 0)}
              %).
            </p>
          ) : (
            <p className="m-0">
              {formatCount(counts.completedRequests)} of {formatCount(counts.plannedRequests)}{" "}
              {pluralize(counts.plannedRequests, "request")} completed (
              {formatShortfallPercent(missingRequests, counts.plannedRequests)}% shortfall).
            </p>
          )}
        </div>
      ) : null}
      {lateAnswersCause ? (
        <p className="m-0 mt-2">
          {serverHandledLateAnswers
            ? `The server still handled ${pluralize(counts.interruptedRequests, "that request", "those requests")}: ${business.acceptedReservations === 1 ? "the only order was" : `all ${formatCount(business.acceptedReservations)} orders were`} reserved, confirmed and notified. Only ${pluralize(counts.interruptedRequests, "its answer", "their answers")} came too late to be recorded. `
            : null}
          {pluralize(counts.interruptedRequests, "This buyer", "These buyers")} waited at least{" "}
          {k6GracefulStopSeconds} seconds without an answer, so the run counts as failed.
        </p>
      ) : null}
      {http.unexpectedResponses !== null && http.unexpectedResponses > 0 ? (
        <p className="m-0 mt-2">
          Unexpected responses recorded: {formatCount(http.unexpectedResponses)}.
        </p>
      ) : null}
      {http.transportFailures !== null && http.transportFailures > 0 ? (
        <p className="m-0 mt-2">
          {formatCount(http.transportFailures)} {pluralize(http.transportFailures, "attempt")} ended
          in transport failure.
        </p>
      ) : null}
      {!lateAnswersCause && hasLateAnswers(counts) ? (
        <p className="m-0 mt-2">{lateAnswersClause(counts.interruptedRequests)}.</p>
      ) : null}
      {settled ? (
        <p className="m-0 mt-3 rounded-xl border border-border bg-surface-muted p-3 font-semibold text-ink">
          {business.confirmedOrders === 1
            ? "The only accepted order was"
            : `All ${formatCount(business.confirmedOrders)} accepted orders were`}{" "}
          confirmed and notified
          {serverHandledLateAnswers
            ? `, including ${pluralize(counts.interruptedRequests, "the one", "those")} whose answer arrived too late`
            : null}
          .
        </p>
      ) : (
        <p className="m-0 mt-3 rounded-xl border border-border bg-surface-muted p-3">
          Business outcomes: {formatCount(business.confirmedOrders)}{" "}
          {pluralize(business.confirmedOrders, "order")} confirmed,{" "}
          {formatCount(business.failedOrders)} failed,{" "}
          {formatCount(business.queuedOrders + business.processingOrders)} pending;{" "}
          {formatCount(business.notificationsRecorded)}{" "}
          {pluralize(business.notificationsRecorded, "notification")} recorded.
        </p>
      )}
      {counts.startedRequests !== null &&
      counts.startedRequests > 0 &&
      counts.interruptedRequests === 0 &&
      http.transportFailures === 0 &&
      http.unexpectedResponses === 0 ? (
        <p className="m-0 mt-2">
          All sent requests completed. No transport failures or unexpected responses were recorded.
        </p>
      ) : null}
      <h3 className="m-0 mt-4 text-sm font-bold text-ink">What to check next</h3>
      <p className="m-0 mt-1">{copy.next}</p>
      <details className="mt-3 border-t border-border pt-2">
        <summary className="disclosure font-semibold text-ink">Why this diagnosis?</summary>
        <p className="m-0 mt-2">{copy.why}</p>
        <dl className="my-2 grid grid-cols-2 gap-2">
          <dt>HTTP response latency, p95</dt>
          <dd className="m-0 text-right">
            {formatDurationMs(http.p95LatencyMs ?? null) ?? "Unavailable"}
          </dd>
          <dt>Connection time, p95</dt>
          <dd className="m-0 text-right">
            {connectionP95 !== undefined &&
            connectionP95 !== null &&
            connectionP95 > 0 &&
            connectionP95 < 1
              ? "< 1 ms"
              : (formatDurationMs(connectionP95) ?? "Unavailable")}
          </dd>
        </dl>
        {stderrLines ? (
          <>
            <h3 className="m-0 mt-3 text-sm font-bold text-ink">Recorded k6 output</h3>
            {stderrLines.length > 0 ? (
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-surface-muted p-3 text-xs [overflow-wrap:anywhere]">
                {stderrLines.join("\n")}
              </pre>
            ) : (
              <p className="m-0 mt-1">No retained generator stderr lines.</p>
            )}
          </>
        ) : null}
      </details>
      <details className="mt-2 border-t border-border pt-2">
        <summary className="disclosure font-semibold text-ink">Measurement coverage</summary>
        <p className="m-0 mt-2">
          {countsUnknown ? trafficEvidenceUnavailableText : measurementCoverageText(counts)}
        </p>
        {http.transportFailures !== null && http.transportFailures > 0 ? (
          <p className="m-0 mt-1">
            {formatCount(http.transportFailures)}{" "}
            {pluralize(http.transportFailures, "completed attempt")} ended in transport failure.
          </p>
        ) : null}
      </details>
    </section>
  );
}

function hasLateAnswers(counts: TransportAttemptCounts): boolean {
  return counts.interruptedRequests !== null && counts.interruptedRequests > 0;
}

function measurementCoverageText(counts: TransportAttemptCounts): string {
  const coverage = hasLateAnswers(counts)
    ? `${lateAnswersClause(counts.interruptedRequests)}; outcomes and latency cover only the recorded answers.`
    : "Outcomes and latency cover only the recorded answers.";
  return counts.unstartedRequests !== null && counts.unstartedRequests > 0
    ? `${unsentRequestsText(counts.unstartedRequests)} ${coverage}`
    : coverage;
}

function unsentRequestsText(unstartedRequests: number | null): string {
  return `${formatCount(unstartedRequests)} planned ${pluralize(unstartedRequests, "request was", "requests were")} never sent.`;
}

function lateAnswersClause(interruptedRequests: number | null): string {
  return `${formatCount(interruptedRequests)} ${pluralize(interruptedRequests, "answer")} arrived too late to be recorded`;
}

function formatShortfallPercent(missingRequests: number, plannedRequests: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
    (missingRequests / plannedRequests) * 100,
  );
}

function causeCopy(
  diagnostic: RunFailureDiagnostic,
  counts: TransportAttemptCounts,
): {
  heading: string;
  summary: string;
  next: string;
  why: string;
} {
  switch (diagnostic.cause) {
    case "virtual_user_limit":
      return {
        heading: "Virtual user limit reached",
        summary: `The load generator reached its limit of ${formatCount(diagnostic.maxVus)} concurrent ${pluralize(diagnostic.maxVus, "virtual user")} and could not maintain the requested traffic rate.`,
        next: "For the same traffic target, investigate slow responses and review virtual-user capacity. A lower request rate would test a less demanding scenario.",
        why: "The generator explicitly reported that its virtual-user limit was reached. This identifies the delivery limit, but does not establish the exact source of response delays.",
      };
    case "interrupted_requests":
      return {
        heading: "Answers arrived too late",
        summary: `The server needed more time than the load generator waits: ${formatCount(counts.interruptedRequests)} ${pluralize(counts.interruptedRequests, "buyer was", "buyers were")} still waiting for their answer when the generator stopped listening, ${k6GracefulStopSeconds} seconds after its sending window closed.`,
        next: "Accepted orders are the slow path: each one is written to the database before the buyer gets an answer. A lower request rate or less stock lets the server answer everyone in time.",
        why: "The load generator sent these requests but stopped listening before their answers arrived. The late answers alone are enough to fail the run, so they explain this failure. The report shows when answers arrived, not where the server spent its time.",
      };
    case "unidentified":
      return {
        heading: "Traffic failed — exact cause not identified",
        summary:
          "The recorded evidence does not identify a specific cause for this traffic failure.",
        next: "Review the recorded traffic measurements and generator diagnostics before retrying. The report does not establish which setting or component caused the failure.",
        why: "No recognized generator diagnostic explains this failure. Missing or truncated diagnostics cannot establish that no problem occurred.",
      };
  }
}
