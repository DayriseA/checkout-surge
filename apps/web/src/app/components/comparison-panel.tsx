"use client";

import {
  type Comparison,
  comparisonModes,
  type PublicRunHistoryDetailResponse,
  publicRunHistoryDetailResponseSchema,
  synchronousConfirmationDeadlineMs,
} from "@checkout-surge/contracts";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { readProxyJson } from "../lib/client/proxy-json";
import { publicRunHistoryDetailProxyPath } from "../lib/control-paths";
import {
  type ComparisonMember,
  comparisonModeLabels,
  comparisonRunFacts,
  comparisonTakeaway,
  formatPace,
  formatRatio,
  readComparison,
  redisComparisonRunFacts,
  redisComparisonTakeaway,
} from "../lib/presentation/comparison";
import { formatCount, formatDurationMs } from "../lib/presentation/format";
import { textLinkClassName } from "./control-styles";

const notRecorded = "Not recorded";

interface ComparisonSpec {
  name: string;
  title: string;
  intro: ReactNode;
  rows(detail: PublicRunHistoryDetailResponse): [string, string][];
  takeaway(
    first: PublicRunHistoryDetailResponse,
    second: PublicRunHistoryDetailResponse,
  ): string | null;
}

const value = (text: string | null) => text ?? notRecorded;

const comparisonSpecs: Record<Comparison, ComparisonSpec> = {
  order_queue: {
    name: "Queue comparison",
    title: "What the order queue buys: the same workload with and without it",
    intro: (
      <>
        Both runs use the same buyers, stock and ERP limit, one after the other. Without the order
        queue, each winner&apos;s purchase request stays open until the same worker has the order
        confirmed by the ERP, at the ERP&apos;s pace; after{" "}
        {synchronousConfirmationDeadlineMs / 1000} s the buyer is told the order is still being
        confirmed, and it is confirmed later. Run 1 is always the one with the queue.
      </>
    ),
    rows: (detail) => {
      const facts = comparisonRunFacts(detail);
      return [
        [
          "Winners' time to an answer, average / 95th percentile (all winners)",
          `${value(formatDurationMs(facts.winnerAverageMs))} / ${value(formatDurationMs(facts.winnerP95Ms))}`,
        ],
        [
          "Every buyer had an answer within",
          value(formatDurationMs(facts.everyBuyerAnsweredWithinMs)),
        ],
        [
          "Winners told “confirmed” / “secured, not yet confirmed”",
          `${value(formatCount(facts.confirmedAnswers))} / ${value(formatCount(facts.notYetConfirmedAnswers))}`,
        ],
        ["Buyers without an expected answer", value(formatCount(facts.withoutExpectedAnswer))],
        [
          "Orders confirmed by the ERP (failed)",
          `${formatCount(facts.ordersConfirmed)} (${formatCount(facts.ordersFailed)})`,
        ],
        [
          `ERP pace, from the first buyer to the last confirmation (limit ${facts.erpLimitPerSecond} per second)`,
          value(formatPace(facts.erpPacePerSecond)),
        ],
        ["Slowest order, from secured to confirmed", value(formatDurationMs(facts.slowestOrderMs))],
      ];
    },
    takeaway: (first, second) =>
      comparisonTakeaway(comparisonRunFacts(first), comparisonRunFacts(second)),
  },
  redis: {
    name: "Redis comparison",
    title: "What Redis buys: the same workload with the stock decided in Redis, then in PostgreSQL",
    intro: (
      <>
        Both runs use the same buyers, stock and ERP, one after the other. In run 2, PostgreSQL
        decides the stock and holds the order queue, with the same protections: idempotency, the
        run&apos;s fence, and the order recorded before the buyer hears &ldquo;yes&rdquo;. Redis
        still carries the live dashboard&apos;s counters and the notifications. The database figures
        are PostgreSQL&apos;s own statistics for the whole database during each run, background work
        included. Run 1 is always the one with Redis.
      </>
    ),
    rows: (detail) => {
      const facts = redisComparisonRunFacts(detail);
      const busyPerBuyer = formatRatio(facts.postgresBusyMsPerBuyer);
      return [
        [
          "Buyers secured / turned away / without an expected answer",
          `${value(formatCount(facts.secured))} / ${value(formatCount(facts.turnedAway))} / ${value(formatCount(facts.withoutExpectedAnswer))}`,
        ],
        [
          "Units sold, of the stock",
          `${formatCount(facts.unitsSold)} of ${formatCount(facts.stock)}`,
        ],
        ["PostgreSQL transactions", value(formatCount(facts.postgresTransactions))],
        [
          "PostgreSQL busy time, executing statements",
          value(formatDurationMs(facts.postgresBusyMs)),
        ],
        [
          "PostgreSQL work per buyer: transactions / busy time",
          `${value(formatRatio(facts.postgresTransactionsPerBuyer))} / ${value(busyPerBuyer && `${busyPerBuyer} ms`)}`,
        ],
        ["Redis CPU time", value(formatDurationMs(facts.redisCpuMs))],
        [
          "Turned-away buyers' time to an answer, 95th percentile / longest",
          `${value(formatDurationMs(facts.turnedAwayP95Ms))} / ${value(formatDurationMs(facts.turnedAwayLongestMs))}`,
        ],
      ];
    },
    takeaway: (first, second) =>
      redisComparisonTakeaway(redisComparisonRunFacts(first), redisComparisonRunFacts(second)),
  },
};

/**
 * One comparison of two runs on the same workload, in run order. Missing evidence reads "Not
 * recorded"; no winner is declared.
 */
export function ComparisonReport({
  comparison,
  first,
  second,
}: {
  comparison: Comparison;
  first: ComparisonMember;
  second: ComparisonMember;
}) {
  const spec = comparisonSpecs[comparison];
  const [firstMode, secondMode] = comparisonModes[comparison];
  const firstDetail = completedDetail(first);
  const secondDetail = completedDetail(second);
  const takeaway = firstDetail && secondDetail ? spec.takeaway(firstDetail, secondDetail) : null;
  return (
    <section
      aria-label={spec.name}
      className="col-span-12 rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4"
    >
      <p className="m-0 text-xs font-medium text-muted">One comparison, two runs</p>
      <h2 className="type-title m-0 mt-1 text-xl text-ink">{spec.title}</h2>
      <p className="mb-0 mt-2 max-w-[80ch] text-sm leading-6 text-muted-strong">{spec.intro}</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <ComparisonColumn
          label={`Run 1 of 2 · ${comparisonModeLabels[firstMode]}`}
          member={first}
          rows={spec.rows}
        />
        <ComparisonColumn
          label={`Run 2 of 2 · ${comparisonModeLabels[secondMode]}`}
          member={second}
          rows={spec.rows}
        />
      </div>
      {takeaway ? <p className="mb-0 mt-4 max-w-[80ch] leading-6 text-ink">{takeaway}</p> : null}
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
  not_started: "Starts when run 1 completes.",
  never: "No second run was started.",
} as const;

function ComparisonColumn({
  label,
  member,
  rows,
}: {
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
            {shownRows.map(([rowLabel, rowValue]) => (
              <div key={rowLabel}>
                <dt className="text-xs text-muted">{rowLabel}</dt>
                <dd className="m-0 mt-1 font-semibold text-ink">{rowValue}</dd>
              </div>
            ))}
          </dl>
          <Link className={`${textLinkClassName} text-sm`} href={`/run-history/${member.runId}`}>
            View this run&apos;s report
          </Link>
        </>
      )}
    </article>
  );
}

/**
 * The comparison of a run being watched. It reads the saved reports of the run and of its partner
 * again each time `refreshKey` changes (the live run's identity or status).
 */
export function WatchComparisonPanel({
  comparison,
  runId,
  firstRunId,
  refreshKey,
}: {
  comparison: Comparison;
  runId: string;
  firstRunId: string | null;
  refreshKey: string;
}) {
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
    <ComparisonReport comparison={comparison} first={members[0]} second={members[1]} />
  ) : null;
}
