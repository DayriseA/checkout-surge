"use client";

import {
  k6GracefulStopSeconds,
  k6RequestTimeoutSeconds,
  type RunFailureDiagnostic,
  type TrafficHttpSummary,
  type TransportAttemptCounts,
} from "@checkout-surge/contracts";
import { useLocale, useTranslation } from "../lib/i18n/locale-context";
import { getTranslation, type Locale } from "../lib/i18n/translate";
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
  const t = useTranslation();
  const locale = useLocale();
  const diagnostic = evidence.failureDiagnostic;
  if (!diagnostic) return null;
  const counts = evidence.transportAttemptCounts;
  const http = evidence.httpSummary;
  const business = evidence.businessOutcomeSummary;
  const connectionP95 = evidence.httpTimingBreakdownSummary.connecting?.p95Ms;
  const copy = causeCopy(diagnostic, counts, http, locale);
  const lateAnswersCause = diagnostic.cause === "interrupted_requests";
  const timeoutsCause = diagnostic.cause === "request_timeouts";
  const requestTimeouts = http.requestTimeouts ?? null;
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
  // Server-side proof that late or timed-out answers were handled: every sent request became a
  // reservation, and every reservation was confirmed and notified.
  const everySentRequestSettled =
    settled && business.acceptedReservations === counts.startedRequests;
  const serverHandledLateAnswers = hasLateAnswers(counts) && everySentRequestSettled;
  return (
    <section
      className="mt-3 text-sm leading-6 text-muted-strong"
      aria-label={t("Failure explanation")}
    >
      <h2 className="type-title m-0 text-xl leading-tight text-ink">{t(copy.heading)}</h2>
      {countsUnknown ? <p className="m-0 mt-2">{t(trafficEvidenceUnavailableText)}</p> : null}
      <p className="m-0 mt-2">{t(copy.summary)}</p>
      {missingRequests > 0 ? (
        <div className="my-3 border-l-2 border-danger pl-3">
          {counts.unstartedRequests !== null && counts.unstartedRequests > 0 ? (
            <p className="m-0 font-semibold text-ink">
              {unsentRequestsText(counts.unstartedRequests, locale)}
            </p>
          ) : null}
          {lateAnswersCause ? (
            <p className="m-0">
              {t("{v0} of {v1} {v2} arrived too late ({v3}%).", {
                v0: formatCount(counts.interruptedRequests, locale) ?? "",
                v1: formatCount(counts.startedRequests, locale) ?? "",
                v2: t(pluralize(counts.startedRequests, "answer")),
                v3: formatShortfallPercent(
                  counts.interruptedRequests ?? 0,
                  counts.startedRequests ?? 0,
                  locale,
                ),
              })}
            </p>
          ) : (
            <p className="m-0">
              {t("{v0} of {v1} {v2} completed ({v3}% shortfall).", {
                v0: formatCount(counts.completedRequests, locale) ?? "",
                v1: formatCount(counts.plannedRequests, locale) ?? "",
                v2: t(pluralize(counts.plannedRequests, "request")),
                v3: formatShortfallPercent(missingRequests, counts.plannedRequests, locale),
              })}
            </p>
          )}
        </div>
      ) : null}
      {timeoutsCause ? (
        <>
          <div className="my-3 border-l-2 border-danger pl-3">
            <p className="m-0">
              {t("{v0} of {v1} {v2} timed out ({v3}%).", {
                v0: formatCount(requestTimeouts, locale) ?? "",
                v1: formatCount(counts.startedRequests, locale) ?? "",
                v2: t(pluralize(counts.startedRequests, "request")),
                v3: formatShortfallPercent(
                  requestTimeouts ?? 0,
                  counts.startedRequests ?? 0,
                  locale,
                ),
              })}
            </p>
          </div>
          <p className="m-0 mt-2">
            {everySentRequestSettled
              ? t(
                  "The server still handled {v0}: {v1} secured and its order confirmed and notified. Only {v2} took too long. ",
                  {
                    v0: String(
                      t(pluralize(requestTimeouts, t("that request"), t("those requests"))),
                    ),
                    v1: String(
                      business.acceptedReservations === 1
                        ? t("the only reservation was")
                        : t("every one of the {v0} reservations was", {
                            v0: String(formatCount(business.acceptedReservations, locale)),
                          }),
                    ),
                    v2: String(t(pluralize(requestTimeouts, t("its answer"), t("their answers")))),
                  },
                )
              : t(
                  "The server may still have handled {v0}: a timeout only means that no answer arrived in time. ",
                  {
                    v0: String(
                      t(pluralize(requestTimeouts, t("that request"), t("those requests"))),
                    ),
                  },
                )}
            {t(
              "{requests} waited {seconds} seconds without an answer, so the run counts as failed.",
              {
                requests: t(pluralize(requestTimeouts, "This request", "These requests")),
                seconds: k6RequestTimeoutSeconds,
              },
            )}
          </p>
        </>
      ) : null}
      {lateAnswersCause ? (
        <p className="m-0 mt-2">
          {serverHandledLateAnswers
            ? t(
                "The server still handled {v0}: {v1} secured and its order confirmed and notified. Only {v2} came too late to be recorded. ",
                {
                  v0: String(
                    t(
                      pluralize(counts.interruptedRequests, t("that request"), t("those requests")),
                    ),
                  ),
                  v1: String(
                    business.acceptedReservations === 1
                      ? t("the only reservation was")
                      : t("every one of the {v0} reservations was", {
                          v0: String(formatCount(business.acceptedReservations, locale)),
                        }),
                  ),
                  v2: String(
                    t(pluralize(counts.interruptedRequests, t("its answer"), t("their answers"))),
                  ),
                },
              )
            : null}
          {t(
            "{buyers} waited at least {seconds} seconds without an answer, so the run counts as failed.",
            {
              buyers: t(pluralize(counts.interruptedRequests, "This buyer", "These buyers")),
              seconds: k6GracefulStopSeconds,
            },
          )}
        </p>
      ) : null}
      {http.unexpectedResponses !== null && http.unexpectedResponses > 0 ? (
        <p className="m-0 mt-2">
          {t("Unexpected responses recorded:")} {formatCount(http.unexpectedResponses, locale)}.
        </p>
      ) : null}
      {http.transportFailures !== null && http.transportFailures > 0 ? (
        <p className="m-0 mt-2">
          {formatCount(http.transportFailures, locale)}{" "}
          {t(pluralize(http.transportFailures, "attempt"))} {t("ended in transport failure.")}
        </p>
      ) : null}
      {!lateAnswersCause && hasLateAnswers(counts) ? (
        <p className="m-0 mt-2">{lateAnswersClause(counts.interruptedRequests, locale)}.</p>
      ) : null}
      {settled ? (
        <p className="m-0 mt-3 rounded-xl border border-border bg-surface-muted p-3 font-semibold text-ink">
          {business.confirmedOrders === 1
            ? t("The only accepted order was confirmed and notified")
            : t("All {v0} accepted orders were confirmed and notified", {
                v0: String(formatCount(business.confirmedOrders, locale)),
              })}
          {serverHandledLateAnswers
            ? t(", including {v0} whose answer arrived too late", {
                v0: String(t(pluralize(counts.interruptedRequests, t("the one"), "those"))),
              })
            : null}
          .
        </p>
      ) : (
        <p className="m-0 mt-3 rounded-xl border border-border bg-surface-muted p-3">
          {t("Business outcomes:")} {formatCount(business.confirmedOrders, locale)}{" "}
          {t(pluralize(business.confirmedOrders, "order confirmed,", "orders confirmed,"))}{" "}
          {formatCount(business.failedOrders, locale)} {t("failed,")}{" "}
          {formatCount(business.queuedOrders + business.processingOrders, locale)} {t("pending;")}{" "}
          {formatCount(business.notificationsRecorded, locale)}{" "}
          {t(
            pluralize(
              business.notificationsRecorded,
              "notification recorded.",
              "notifications recorded.",
            ),
          )}
        </p>
      )}
      {counts.startedRequests !== null &&
      counts.startedRequests > 0 &&
      counts.interruptedRequests === 0 &&
      http.transportFailures === 0 &&
      http.unexpectedResponses === 0 ? (
        <p className="m-0 mt-2">
          {t(
            "All sent requests completed. No transport failures or unexpected responses were recorded.",
          )}
        </p>
      ) : null}
      <h3 className="m-0 mt-4 text-sm font-bold text-ink">{t("What to check next")}</h3>
      <p className="m-0 mt-1">{t(copy.next)}</p>
      <details className="mt-3 border-t border-border pt-2">
        <summary className="disclosure font-semibold text-ink">{t("Why this diagnosis?")}</summary>
        <p className="m-0 mt-2">{t(copy.why)}</p>
        <dl className="my-2 grid grid-cols-2 gap-2">
          <dt>{t("HTTP response latency, p95")}</dt>
          <dd className="m-0 text-right">
            {formatDurationMs(http.p95LatencyMs ?? null, locale) ?? t("Unavailable")}
          </dd>
          <dt>{t("Connection time, p95")}</dt>
          <dd className="m-0 text-right">
            {connectionP95 !== undefined &&
            connectionP95 !== null &&
            connectionP95 > 0 &&
            connectionP95 < 1
              ? "< 1 ms"
              : (formatDurationMs(connectionP95, locale) ?? t("Unavailable"))}
          </dd>
        </dl>
        {stderrLines ? (
          <>
            <h3 className="m-0 mt-3 text-sm font-bold text-ink">{t("Recorded k6 output")}</h3>
            {stderrLines.length > 0 ? (
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-surface-muted p-3 text-xs [overflow-wrap:anywhere]">
                {stderrLines.join("\n")}
              </pre>
            ) : (
              <p className="m-0 mt-1">{t("No retained generator stderr lines.")}</p>
            )}
          </>
        ) : null}
      </details>
      <details className="mt-2 border-t border-border pt-2">
        <summary className="disclosure font-semibold text-ink">{t("Measurement coverage")}</summary>
        <p className="m-0 mt-2">
          {countsUnknown
            ? t(trafficEvidenceUnavailableText)
            : measurementCoverageText(counts, locale)}
        </p>
        {http.transportFailures !== null && http.transportFailures > 0 ? (
          <p className="m-0 mt-1">
            {formatCount(http.transportFailures, locale)}{" "}
            {t(pluralize(http.transportFailures, "completed attempt", "completed attempts"))}{" "}
            {t("ended in transport failure.")}
          </p>
        ) : null}
      </details>
    </section>
  );
}

function hasLateAnswers(counts: TransportAttemptCounts): boolean {
  return counts.interruptedRequests !== null && counts.interruptedRequests > 0;
}

function measurementCoverageText(counts: TransportAttemptCounts, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  const coverage = hasLateAnswers(counts)
    ? t("{v0}; outcomes and latency cover only the recorded answers.", {
        v0: String(lateAnswersClause(counts.interruptedRequests, locale)),
      })
    : t("Outcomes and latency cover only the recorded answers.");
  return counts.unstartedRequests !== null && counts.unstartedRequests > 0
    ? `${unsentRequestsText(counts.unstartedRequests, locale)} ${coverage}`
    : coverage;
}

function unsentRequestsText(unstartedRequests: number | null, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return t("{v0} planned {v1} never sent.", {
    v0: String(formatCount(unstartedRequests, locale)),
    v1: String(t(pluralize(unstartedRequests, t("request was"), t("requests were")))),
  });
}

function lateAnswersClause(interruptedRequests: number | null, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return t(
    pluralize(
      interruptedRequests,
      "{v0} answer arrived too late to be recorded",
      "{v0} answers arrived too late to be recorded",
    ),
    { v0: String(formatCount(interruptedRequests, locale)) },
  );
}

function formatShortfallPercent(
  missingRequests: number,
  plannedRequests: number,
  locale: Locale = "en",
): string {
  return new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US", {
    maximumFractionDigits: 2,
  }).format((missingRequests / plannedRequests) * 100);
}

function causeCopy(
  diagnostic: RunFailureDiagnostic,
  counts: TransportAttemptCounts,
  http: TrafficHttpSummary,
  locale: Locale = "en",
): {
  heading: string;
  summary: string;
  next: string;
  why: string;
} {
  const t = getTranslation(locale);
  switch (diagnostic.cause) {
    case "virtual_user_limit":
      return {
        heading: t("Virtual user limit reached"),
        summary: t(
          "The load generator reached its limit of {v0} concurrent {v1} and could not maintain the requested traffic rate.",
          {
            v0: String(formatCount(diagnostic.maxVus, locale)),
            v1: String(t(pluralize(diagnostic.maxVus, "virtual user"))),
          },
        ),
        next: t(
          "For the same traffic target, investigate slow responses and review virtual-user capacity. A lower request rate would test a less demanding scenario.",
        ),
        why: t(
          "The generator explicitly reported that its virtual-user limit was reached. This identifies the delivery limit, but does not establish the exact source of response delays.",
        ),
      };
    case "interrupted_requests":
      return {
        heading: t("Answers arrived too late"),
        summary: t(
          "The server needed more time than the load generator waits: {v0} {v1} still waiting for their answer when the generator stopped listening, {v2} seconds after its sending window closed.",
          {
            v0: String(formatCount(counts.interruptedRequests, locale)),
            v1: String(t(pluralize(counts.interruptedRequests, t("buyer was"), t("buyers were")))),
            v2: String(k6GracefulStopSeconds),
          },
        ),
        next: t(
          "Accepted orders are the slow path: each one is written to the database before the buyer gets an answer. A lower request rate or less stock lets the server answer everyone in time.",
        ),
        why: t(
          "The load generator sent these requests but stopped listening before their answers arrived. The late answers alone are enough to fail the run, so they explain this failure. The report shows when answers arrived, not where the server spent its time.",
        ),
      };
    case "request_timeouts":
      return {
        heading: t("Requests timed out"),
        summary: t(
          "{v0} {v1} got no answer within the load generator's {v2}-second limit, so the generator gave up on {v3}.",
          {
            v0: String(formatCount(http.requestTimeouts, locale)),
            v1: String(t(pluralize(http.requestTimeouts, "request"))),
            v2: String(k6RequestTimeoutSeconds),
            v3: String(t(pluralize(http.requestTimeouts, "it", "them"))),
          },
        ),
        next: t(
          "Fewer buyers, a smaller burst, or the same traffic spread over more time gives the server room to answer every request within {v0} seconds.",
          { v0: String(k6RequestTimeoutSeconds) },
        ),
        why: t(
          "The load generator recorded these requests as timed out: it started each one but did not receive a complete response within {v0} seconds. The timeouts alone are enough to fail the run, so they explain this failure. The report does not show where the server spent that time.",
          { v0: String(k6RequestTimeoutSeconds) },
        ),
      };
    case "unidentified":
      return {
        heading: t("Traffic failed — exact cause not identified"),
        summary: t(
          "The recorded evidence does not identify a specific cause for this traffic failure.",
        ),
        next: t(
          "Review the recorded traffic measurements and generator diagnostics before retrying. The report does not establish which setting or component caused the failure.",
        ),
        why: t(
          "No recognized generator diagnostic explains this failure. Missing or truncated diagnostics cannot establish that no problem occurred.",
        ),
      };
  }
}
