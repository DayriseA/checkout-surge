"use client";

import {
  type Comparison,
  comparisonModes,
  type PublicRunHistoryDetailResponse,
  publicRunHistoryDetailResponseSchema,
} from "@checkout-surge/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { readProxyJson } from "../lib/client/proxy-json";
import { publicRunHistoryDetailProxyPath } from "../lib/control-paths";
import { useLocale, useTranslation } from "../lib/i18n/locale-context";
import { getTranslation, type Locale } from "../lib/i18n/translate";
import {
  type ComparisonMember,
  comparisonRunFacts,
  comparisonRunLabel,
  formatMultiples,
  formatPace,
  readComparison,
  redisComparisonRunFacts,
} from "../lib/presentation/comparison";
import { formatCount, formatDurationMs } from "../lib/presentation/format";
import { comparisonExplanationLinks, comparisonLimitsLink } from "../lib/site-links";
import { textLinkClassName } from "./control-styles";

const notRecorded = "Not recorded";

/** One figure of a run. Run 2's `amounts` are also shown as multiples of run 1's. */
interface ComparisonRow {
  label: string;
  value: string;
  amounts?: (number | null)[];
}

interface ComparisonSpec {
  name: string;
  title: string;
  rows(detail: PublicRunHistoryDetailResponse, locale: Locale): ComparisonRow[];
}

type Format = (amount: number | null, locale: Locale) => string | null;

/** Figures shown "a / b" and compared across the two runs. */
function measured(
  label: string,
  format: Format,
  locale: Locale,
  ...amounts: (number | null)[]
): ComparisonRow {
  return {
    label,
    value: amounts
      .map((amount) => format(amount, locale) ?? getTranslation(locale)(notRecorded))
      .join(" / "),
    amounts,
  };
}

/** Answer counts shown "a / b", not compared: a multiple of them says nothing. */
function counted(label: string, locale: Locale, ...amounts: (number | null)[]): ComparisonRow {
  const t = getTranslation(locale);
  return {
    label,
    value: amounts.map((amount) => formatCount(amount, locale) ?? t(notRecorded)).join(" / "),
  };
}

const comparisonSpecs: Record<Comparison, ComparisonSpec> = {
  order_queue: {
    name: "Queue comparison",
    title: "With and without the order queue, on the same workload",
    rows: (detail, locale) => {
      const t = getTranslation(locale);
      const facts = comparisonRunFacts(detail);
      return [
        measured(
          "Winners' time to an answer, average / 95th percentile (all winners)",
          formatDurationMs,
          locale,
          facts.winnerAverageMs,
          facts.winnerP95Ms,
        ),
        measured(
          "Every buyer had an answer within",
          formatDurationMs,
          locale,
          facts.everyBuyerAnsweredWithinMs,
        ),
        counted(
          "Winners told “confirmed” / “secured, not yet confirmed”",
          locale,
          facts.confirmedAnswers,
          facts.notYetConfirmedAnswers,
        ),
        counted("Buyers without an expected answer", locale, facts.withoutExpectedAnswer),
        {
          label: "Orders confirmed by the ERP (failed)",
          value: `${formatCount(facts.ordersConfirmed, locale)} (${formatCount(facts.ordersFailed, locale)})`,
        },
        measured(
          t("ERP pace, from the first buyer to the last confirmation (limit {v0} per second)", {
            v0: facts.erpLimitPerSecond,
          }),
          formatPace,
          locale,
          facts.erpPacePerSecond,
        ),
        measured(
          "Slowest order, from secured to confirmed",
          formatDurationMs,
          locale,
          facts.slowestOrderMs,
        ),
      ];
    },
  },
  redis: {
    name: "Redis comparison",
    title: "Stock decided in Redis, then in PostgreSQL, on the same workload",
    rows: (detail, locale) => {
      const t = getTranslation(locale);
      const facts = redisComparisonRunFacts(detail);
      return [
        counted(
          "Buyers secured / turned away / without an expected answer",
          locale,
          facts.secured,
          facts.turnedAway,
          facts.withoutExpectedAnswer,
        ),
        {
          label: "Units sold, of the stock",
          value: t("{v0} of {v1}", {
            v0: formatCount(facts.unitsSold, locale) ?? "—",
            v1: formatCount(facts.stock, locale) ?? "—",
          }),
        },
        measured("PostgreSQL transactions", formatCount, locale, facts.postgresTransactions),
        measured("PostgreSQL CPU time", formatDurationMs, locale, facts.postgresCpuMs),
        measured(
          "Time spent in PostgreSQL queries, waits for the stock row included",
          formatDurationMs,
          locale,
          facts.postgresBusyMs,
        ),
        measured(
          "Winners' time to an answer, average / 95th percentile",
          formatDurationMs,
          locale,
          facts.winnerAverageMs,
          facts.winnerP95Ms,
        ),
        measured(
          "Turned-away buyers' time to an answer, average / 95th percentile",
          formatDurationMs,
          locale,
          facts.turnedAwayAverageMs,
          facts.turnedAwayP95Ms,
        ),
        measured(
          "Every buyer had an answer within",
          formatDurationMs,
          locale,
          facts.everyBuyerAnsweredWithinMs,
        ),
      ];
    },
  },
};

/**
 * One comparison of two runs on the same workload, in run order. Missing evidence reads "Not
 * recorded"; run 2's figures are also given as multiples of run 1's, and no winner is declared.
 */
export function ComparisonReport({
  className = "",
  comparison,
  first,
  second,
}: {
  className?: string;
  comparison: Comparison;
  first: ComparisonMember;
  second: ComparisonMember;
}) {
  const t = useTranslation();
  const locale = useLocale();
  const spec = comparisonSpecs[comparison];
  const [firstMode, secondMode] = comparisonModes[comparison];
  const firstDetail = completedDetail(first);
  return (
    <section aria-label={t(spec.name)} className={`grid gap-3 ${className}`}>
      <h2 className="type-title m-0 text-base leading-tight text-ink">{t(spec.title)}</h2>
      <p className="m-0 -mt-1 text-sm text-muted">
        <Link className={textLinkClassName} href={comparisonExplanationLinks[comparison]}>
          {t("How to read these figures")}
        </Link>
        {" · "}
        <Link className={textLinkClassName} href={comparisonLimitsLink}>
          {t("What this comparison does not show")}
        </Link>
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <ComparisonColumn
          label={comparisonRunLabel(firstMode, locale)}
          member={first}
          rows={spec.rows}
        />
        <ComparisonColumn
          baseRows={firstDetail ? spec.rows(firstDetail, locale) : null}
          label={comparisonRunLabel(secondMode, locale)}
          member={second}
          rows={spec.rows}
        />
      </div>
    </section>
  );
}

function completedDetail(member: ComparisonMember) {
  return member.state === "available" &&
    member.detail.run.status === "completed" &&
    !member.detail.summary.dataDiscarded
    ? member.detail
    : null;
}

const memberStatus = {
  running: "In progress: results appear when the run ends.",
  unavailable: "Report not available.",
  not_started: "Starts after run 1.",
  never: "No second run was started.",
} as const;

function ComparisonColumn({
  baseRows = null,
  label,
  member,
  rows,
}: {
  baseRows?: ComparisonRow[] | null;
  label: string;
  member: ComparisonMember;
  rows: ComparisonSpec["rows"];
}) {
  const t = useTranslation();
  const locale = useLocale();
  const detail = completedDetail(member);
  const shownRows = detail ? rows(detail, locale) : [];
  return (
    <article className="rounded-xl bg-surface-muted p-4">
      <h3 className="type-title m-0 text-base">{t(label)}</h3>
      {member.state !== "available" ? (
        <p className="mb-0 mt-1 text-sm text-muted">{t(memberStatus[member.state])}</p>
      ) : (
        <>
          {detail ? null : (
            <p className="mb-0 mt-1 text-sm text-muted">
              {t("This run did not complete; see its report.")}
            </p>
          )}
          <dl className="mt-3 grid gap-3">
            {shownRows.map((row, index) => {
              const base = baseRows?.[index]?.amounts;
              const multiples =
                base && row.amounts ? formatMultiples(base, row.amounts, locale) : null;
              return (
                <div key={row.label}>
                  <dt className="text-xs text-muted">{t(row.label)}</dt>
                  <dd className="m-0 mt-1 font-semibold text-ink">
                    {typeof row.value === "string" ? t(row.value) : row.value}
                    {multiples ? (
                      <span className="ml-2 text-xs font-medium text-muted">
                        {t("{v0} vs run 1", { v0: String(multiples) })}
                      </span>
                    ) : null}
                  </dd>
                </div>
              );
            })}
          </dl>
          <Link className={`${textLinkClassName} text-sm`} href={`/run-history/${member.runId}`}>
            {t("View this run's report")}
          </Link>
        </>
      )}
    </article>
  );
}

/** A watched comparison run: its comparison, its ID, and its first run's ID when it is run 2. */
export interface WatchedComparison {
  comparison: Comparison;
  runId: string;
  firstRunId: string | null;
  refreshKey: string;
}

/**
 * The comparison of a run being watched. It reads the saved reports of the run and of its partner
 * again each time `refreshKey` changes (the live run's identity or status).
 */
export function WatchComparisonPanel({
  className,
  comparison,
  runId,
  firstRunId,
  refreshKey,
}: WatchedComparison & { className?: string }) {
  const [members, setMembers] = useState<[ComparisonMember, ComparisonMember] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey triggers the re-read.
  useEffect(() => {
    let current = true;
    void readComparison(runId, firstRunId, (id) =>
      readProxyJson(publicRunHistoryDetailProxyPath(id), publicRunHistoryDetailResponseSchema),
    ).then((next) => {
      if (current) setMembers(next);
    });
    return () => {
      current = false;
    };
  }, [runId, firstRunId, refreshKey]);
  return members ? (
    <ComparisonReport
      {...(className ? { className } : {})}
      comparison={comparison}
      first={members[0]}
      second={members[1]}
    />
  ) : null;
}
