import { formatCount, formatDurationMs } from "../lib/presentation/format";
import type { RunFailureExplanationEvidence } from "../lib/presentation/run-failure-explanation";

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
  const known = diagnostic.cause === "virtual_user_limit";
  const settled =
    business.acceptedReservations > 0 &&
    business.confirmedOrders === business.acceptedReservations &&
    business.notificationsRecorded === business.confirmedOrders &&
    business.failedOrders === 0 &&
    business.queuedOrders === 0 &&
    business.processingOrders === 0 &&
    business.pendingPersistenceCount === 0 &&
    business.retryingOrders === 0;
  const shortfall =
    counts.plannedRequests > 0
      ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
          (counts.unstartedRequests / counts.plannedRequests) * 100,
        )
      : null;
  return (
    <section className="mt-3 text-sm leading-6 text-muted-strong" aria-label="Failure explanation">
      <h2 className="type-title m-0 text-xl leading-tight text-ink">
        {known ? "Virtual user limit reached" : "Traffic failed — exact cause not identified"}
      </h2>
      <p className="m-0 mt-2">
        {known
          ? `The load generator reached its limit of ${formatCount(diagnostic.maxVus)} concurrent virtual users and could not maintain the requested traffic rate.`
          : "The recorded evidence does not identify a specific cause for this traffic failure."}
      </p>
      {counts.unstartedRequests > 0 ? (
        <div className="my-3 border-l-2 border-danger pl-3">
          <p className="m-0 font-semibold text-ink">
            {formatCount(counts.unstartedRequests)} planned requests were never sent.
          </p>
          <p className="m-0">
            {formatCount(counts.startedRequests)} of {formatCount(counts.plannedRequests)} requests
            launched{shortfall ? ` (${shortfall}% shortfall)` : ""}.
          </p>
        </div>
      ) : null}
      {http.unexpectedResponses > 0 ? (
        <p className="m-0 mt-2">
          Unexpected responses recorded: {formatCount(http.unexpectedResponses)}.
        </p>
      ) : null}
      {http.transportFailures > 0 ? (
        <p className="m-0 mt-2">
          {formatCount(http.transportFailures)} attempts ended in transport failure.
        </p>
      ) : null}
      {counts.interruptedRequests > 0 ? (
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
      {counts.startedRequests > 0 &&
      counts.interruptedRequests === 0 &&
      http.transportFailures === 0 &&
      http.unexpectedResponses === 0 ? (
        <p className="m-0 mt-2">
          All sent requests completed. No transport failures or unexpected responses were recorded.
        </p>
      ) : null}
      <h3 className="m-0 mt-4 text-sm font-bold text-ink">What to check next</h3>
      <p className="m-0 mt-1">
        {known
          ? "For the same traffic target, investigate slow responses and review virtual-user capacity. A lower request rate would test a less demanding scenario."
          : "Review the recorded traffic measurements and generator diagnostics before retrying. The report does not establish which setting or component caused the failure."}
      </p>
      <details className="mt-3 border-t border-border pt-2">
        <summary className="disclosure font-semibold text-ink">Why this diagnosis?</summary>
        <p className="m-0 mt-2">
          {known
            ? "The generator explicitly reported that its virtual-user limit was reached. This identifies the delivery limit, but does not establish the exact source of response delays."
            : "No recognized generator diagnostic explains this failure. Missing or truncated diagnostics cannot establish that no problem occurred."}
        </p>
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
          {formatCount(counts.unstartedRequests)} planned requests were never sent;{" "}
          {formatCount(counts.interruptedRequests)} launched requests did not complete. Outcomes and
          latency cover only recorded responses.
        </p>
        {http.transportFailures > 0 ? (
          <p className="m-0 mt-1">
            {formatCount(http.transportFailures)} completed attempts ended in transport failure.
          </p>
        ) : null}
      </details>
    </section>
  );
}
