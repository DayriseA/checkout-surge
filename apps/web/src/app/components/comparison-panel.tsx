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
  rows(detail: PublicRunHistoryDetailResponse): ComparisonRow[];
}

type Format = (amount: number | null) => string | null;

/** Figures shown "a / b" and compared across the two runs. */
function measured(label: string, format: Format, ...amounts: (number | null)[]): ComparisonRow {
  return {
    label,
    value: amounts.map((amount) => format(amount) ?? notRecorded).join(" / "),
    amounts,
  };
}

/** Answer counts shown "a / b", not compared: a multiple of them says nothing. */
function counted(label: string, ...amounts: (number | null)[]): ComparisonRow {
  return { label, value: amounts.map((amount) => formatCount(amount) ?? notRecorded).join(" / ") };
}

const comparisonSpecs: Record<Comparison, ComparisonSpec> = {
  order_queue: {
    name: "Queue comparison",
    title: "With and without the order queue, on the same workload",
    rows: (detail) => {
      const facts = comparisonRunFacts(detail);
      return [
        measured(
          "Winners' time to an answer, average / 95th percentile (all winners)",
          formatDurationMs,
          facts.winnerAverageMs,
          facts.winnerP95Ms,
        ),
        measured(
          "Every buyer had an answer within",
          formatDurationMs,
          facts.everyBuyerAnsweredWithinMs,
        ),
        counted(
          "Winners told “confirmed” / “secured, not yet confirmed”",
          facts.confirmedAnswers,
          facts.notYetConfirmedAnswers,
        ),
        counted("Buyers without an expected answer", facts.withoutExpectedAnswer),
        {
          label: "Orders confirmed by the ERP (failed)",
          value: `${formatCount(facts.ordersConfirmed)} (${formatCount(facts.ordersFailed)})`,
        },
        measured(
          `ERP pace, from the first buyer to the last confirmation (limit ${facts.erpLimitPerSecond} per second)`,
          formatPace,
          facts.erpPacePerSecond,
        ),
        measured(
          "Slowest order, from secured to confirmed",
          formatDurationMs,
          facts.slowestOrderMs,
        ),
      ];
    },
  },
  redis: {
    name: "Redis comparison",
    title: "Stock decided in Redis, then in PostgreSQL, on the same workload",
    rows: (detail) => {
      const facts = redisComparisonRunFacts(detail);
      return [
        counted(
          "Buyers secured / turned away / without an expected answer",
          facts.secured,
          facts.turnedAway,
          facts.withoutExpectedAnswer,
        ),
        {
          label: "Units sold, of the stock",
          value: `${formatCount(facts.unitsSold)} of ${formatCount(facts.stock)}`,
        },
        measured("PostgreSQL transactions", formatCount, facts.postgresTransactions),
        measured("PostgreSQL CPU time", formatDurationMs, facts.postgresCpuMs),
        measured(
          "Time spent in PostgreSQL queries, waits for the stock row included",
          formatDurationMs,
          facts.postgresBusyMs,
        ),
        measured(
          "Winners' time to an answer, average / 95th percentile",
          formatDurationMs,
          facts.winnerAverageMs,
          facts.winnerP95Ms,
        ),
        measured(
          "Turned-away buyers' time to an answer, average / 95th percentile",
          formatDurationMs,
          facts.turnedAwayAverageMs,
          facts.turnedAwayP95Ms,
        ),
        measured(
          "Every buyer had an answer within",
          formatDurationMs,
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
  const spec = comparisonSpecs[comparison];
  const [firstMode, secondMode] = comparisonModes[comparison];
  const firstDetail = completedDetail(first);
  return (
    <section aria-label={spec.name} className={`grid gap-3 ${className}`}>
      <h2 className="type-title m-0 text-base leading-tight text-ink">{spec.title}</h2>
      <p className="m-0 -mt-1 text-sm text-muted">
        <Link className={textLinkClassName} href={comparisonExplanationLinks[comparison]}>
          How to read these figures
        </Link>
        {" · "}
        <Link className={textLinkClassName} href={comparisonLimitsLink}>
          What this comparison does not show
        </Link>
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <ComparisonColumn label={comparisonRunLabel(firstMode)} member={first} rows={spec.rows} />
        <ComparisonColumn
          baseRows={firstDetail ? spec.rows(firstDetail) : null}
          label={comparisonRunLabel(secondMode)}
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
  const detail = completedDetail(member);
  const shownRows = detail ? rows(detail) : [];
  return (
    <article className="rounded-xl bg-surface-muted p-4">
      <h3 className="type-title m-0 text-base">{label}</h3>
      {member.state !== "available" ? (
        <p className="mb-0 mt-1 text-sm text-muted">{memberStatus[member.state]}</p>
      ) : (
        <>
          {detail ? null : (
            <p className="mb-0 mt-1 text-sm text-muted">
              This run did not complete; see its report.
            </p>
          )}
          <dl className="mt-3 grid gap-3">
            {shownRows.map((row, index) => {
              const base = baseRows?.[index]?.amounts;
              const multiples = base && row.amounts ? formatMultiples(base, row.amounts) : null;
              return (
                <div key={row.label}>
                  <dt className="text-xs text-muted">{row.label}</dt>
                  <dd className="m-0 mt-1 font-semibold text-ink">
                    {row.value}
                    {multiples ? (
                      <span className="ml-2 text-xs font-medium text-muted">
                        {`${multiples} vs run 1`}
                      </span>
                    ) : null}
                  </dd>
                </div>
              );
            })}
          </dl>
          <Link className={`${textLinkClassName} text-sm`} href={`/run-history/${member.runId}`}>
            View this run&apos;s report
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
