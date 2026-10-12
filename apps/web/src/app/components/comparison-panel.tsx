"use client";

import {
  publicRunHistoryDetailResponseSchema,
  synchronousConfirmationDeadlineMs,
} from "@checkout-surge/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { readProxyJson } from "../lib/client/proxy-json";
import { publicRunHistoryDetailProxyPath } from "../lib/control-paths";
import {
  type ComparisonMember,
  comparisonModeLabels,
  comparisonRunFacts,
  comparisonTakeaway,
  formatPace,
  readComparison,
} from "../lib/presentation/comparison";
import { formatCount, formatDurationMs } from "../lib/presentation/format";
import { textLinkClassName } from "./control-styles";

const notRecorded = "Not recorded";

/**
 * One comparison of two runs on the same workload: run 1 with the order queue, run 2 with each
 * winner waiting for the ERP's confirmation. Missing evidence reads "Not recorded"; no winner is
 * declared.
 */
export function ComparisonReport({
  first,
  second,
}: {
  first: ComparisonMember;
  second: ComparisonMember;
}) {
  const firstFacts = completedFacts(first);
  const secondFacts = completedFacts(second);
  const takeaway = firstFacts && secondFacts ? comparisonTakeaway(firstFacts, secondFacts) : null;
  return (
    <section
      aria-label="Queue comparison"
      className="col-span-12 rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4"
    >
      <p className="m-0 text-xs font-medium text-muted">One comparison, two runs</p>
      <h2 className="type-title m-0 mt-1 text-xl text-ink">
        What the order queue buys: the same workload with and without it
      </h2>
      <p className="mb-0 mt-2 max-w-[80ch] text-sm leading-6 text-muted-strong">
        Both runs use the same buyers, stock and ERP limit, one after the other. Without the order
        queue, each winner&apos;s purchase request stays open until the same worker has the order
        confirmed by the ERP, at the ERP&apos;s pace; after{" "}
        {synchronousConfirmationDeadlineMs / 1000} s the buyer is told the order is still being
        confirmed, and it is confirmed later. Run 1 is always the one with the queue.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <ComparisonColumn label={`Run 1 of 2 · ${comparisonModeLabels.demo}`} member={first} />
        <ComparisonColumn
          label={`Run 2 of 2 · ${comparisonModeLabels.synchronous_confirmation}`}
          member={second}
        />
      </div>
      {takeaway ? <p className="mb-0 mt-4 max-w-[80ch] leading-6 text-ink">{takeaway}</p> : null}
    </section>
  );
}

function completedFacts(member: ComparisonMember) {
  return member.state === "available" &&
    member.detail.run.status === "completed" &&
    !member.detail.summary.dataDiscarded
    ? comparisonRunFacts(member.detail)
    : null;
}

function ComparisonColumn({ label, member }: { label: string; member: ComparisonMember }) {
  const facts = completedFacts(member);
  const value = (text: string | null) => text ?? notRecorded;
  const rows: [string, string][] = facts
    ? [
        [
          "Winners' time to an answer, average / 95th percentile (all winners)",
          `${value(formatDurationMs(facts.winnerAverageMs))} / ${value(formatDurationMs(facts.winnerP95Ms))}`,
        ],
        [
          "Every buyer had an answer within",
          value(formatDurationMs(facts.everyBuyerAnsweredWithinMs)),
        ],
        [
          "Winners told “confirmed” / “secured, still being confirmed” / no answer",
          `${value(formatCount(facts.confirmedAnswers))} / ${value(formatCount(facts.stillConfirmingAnswers))} / ${value(formatCount(facts.unanswered))}`,
        ],
        [
          "Orders confirmed by the ERP (failed)",
          `${formatCount(facts.ordersConfirmed)} (${formatCount(facts.ordersFailed)})`,
        ],
        [
          `ERP pace, from the first buyer to the last confirmation (limit ${facts.erpLimitPerSecond} per second)`,
          value(formatPace(facts.erpPacePerSecond)),
        ],
        ["Slowest order, from secured to confirmed", value(formatDurationMs(facts.slowestOrderMs))],
      ]
    : [];
  return (
    <article className="rounded-xl bg-surface-muted p-4">
      <h3 className="type-title m-0 text-base">{label}</h3>
      {member.state === "pending" ? (
        <p className="mb-0 mt-1 text-sm text-muted">
          {member.runId ? "In progress: results appear when the run ends." : "Not started yet."}
        </p>
      ) : (
        <>
          {facts ? null : (
            <p className="mb-0 mt-1 text-sm text-muted">
              This run did not complete; see its report.
            </p>
          )}
          <dl className="mt-3 grid gap-3">
            {rows.map(([rowLabel, rowValue]) => (
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
  runId,
  firstRunId,
  refreshKey,
}: {
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
  return members ? <ComparisonReport first={members[0]} second={members[1]} /> : null;
}
