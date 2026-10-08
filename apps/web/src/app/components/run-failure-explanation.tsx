import type { RunFailureDiagnostic } from "@checkout-surge/contracts";
import { formatCount, formatDurationMs } from "../lib/presentation/format";
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
  const copy = causeCopy(diagnostic);
  const unanswered = diagnostic.cause === "interrupted_requests";
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
  return (
    <section className="mt-3 text-sm leading-6 text-muted-strong" aria-label="Failure explanation">
      <h2 className="type-title m-0 text-xl leading-tight text-ink">{copy.heading}</h2>
      {countsUnknown ? <p className="m-0 mt-2">{trafficEvidenceUnavailableText}</p> : null}
      <p className="m-0 mt-2">{copy.summary}</p>
      {missingRequests > 0 ? (
        <div className="my-3 border-l-2 border-danger pl-3">
          {counts.unstartedRequests !== null && counts.unstartedRequests > 0 ? (
            <p className="m-0 font-semibold text-ink">
              {formatCount(counts.unstartedRequests)} planned requests were never sent.
            </p>
          ) : null}
          {unanswered ? (
            <p className="m-0 font-semibold text-ink">
              {formatCount(counts.interruptedRequests)} launched requests were still waiting for an
              answer when the load generator stopped.
            </p>
          ) : null}
          <p className="m-0">
            {formatCount(counts.completedRequests)} of {formatCount(counts.plannedRequests)}{" "}
            requests completed ({formatShortfallPercent(missingRequests, counts.plannedRequests)}%
            shortfall).
          </p>
        </div>
      ) : null}
      {http.unexpectedResponses !== null && http.unexpectedResponses > 0 ? (
        <p className="m-0 mt-2">
          Unexpected responses recorded: {formatCount(http.unexpectedResponses)}.
        </p>
      ) : null}
      {http.transportFailures !== null && http.transportFailures > 0 ? (
        <p className="m-0 mt-2">
          {formatCount(http.transportFailures)} attempts ended in transport failure.
        </p>
      ) : null}
      {!unanswered && counts.interruptedRequests !== null && counts.interruptedRequests > 0 ? (
        <p className="m-0 mt-2">
          {formatCount(counts.interruptedRequests)} launched requests did not complete.
        </p>
      ) : null}
      {settled ? (
        <p className="m-0 mt-3 rounded-xl border border-border bg-surface-muted p-3 font-semibold text-ink">
          All {formatCount(business.confirmedOrders)} accepted orders were confirmed and notified.
        </p>
      ) : (
        <p className="m-0 mt-3 rounded-xl border border-border bg-surface-muted p-3">
          Business outcomes: {formatCount(business.confirmedOrders)} orders confirmed,{" "}
          {formatCount(business.failedOrders)} failed,{" "}
          {formatCount(business.queuedOrders + business.processingOrders)} pending;{" "}
          {formatCount(business.notificationsRecorded)} notifications recorded.
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
          {countsUnknown ? (
            trafficEvidenceUnavailableText
          ) : (
            <>
              {formatCount(counts.unstartedRequests)} planned requests were never sent;{" "}
              {formatCount(counts.interruptedRequests)} launched requests did not complete. Outcomes
              and latency cover only recorded responses.
            </>
          )}
        </p>
        {http.transportFailures !== null && http.transportFailures > 0 ? (
          <p className="m-0 mt-1">
            {formatCount(http.transportFailures)} completed attempts ended in transport failure.
          </p>
        ) : null}
      </details>
    </section>
  );
}

function formatShortfallPercent(missingRequests: number, plannedRequests: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
    (missingRequests / plannedRequests) * 100,
  );
}

function causeCopy(diagnostic: RunFailureDiagnostic): {
  heading: string;
  summary: string;
  next: string;
  why: string;
} {
  switch (diagnostic.cause) {
    case "virtual_user_limit":
      return {
        heading: "Virtual user limit reached",
        summary: `The load generator reached its limit of ${formatCount(diagnostic.maxVus)} concurrent virtual users and could not maintain the requested traffic rate.`,
        next: "For the same traffic target, investigate slow responses and review virtual-user capacity. A lower request rate would test a less demanding scenario.",
        why: "The generator explicitly reported that its virtual-user limit was reached. This identifies the delivery limit, but does not establish the exact source of response delays.",
      };
    case "interrupted_requests":
      return {
        heading: "Server did not answer in time",
        summary:
          "The server did not answer enough requests before the load generator stopped. The server may still have processed these requests; their answers came too late for the load generator.",
        next: "For the same traffic target, investigate slow responses on the server. Fewer buyers or a lower request rate would test a less demanding scenario.",
        why: "The generator recorded these requests as launched but never answered when it stopped, and they alone are enough to fail the run. This identifies why the run fell short, but does not establish the exact source of response delays.",
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
