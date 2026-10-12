import {
  type BuyerWallLatency,
  type ComparisonMode,
  type PublicRunHistoryDetailResponse,
  synchronousConfirmationDeadlineMs,
} from "@checkout-surge/contracts";
import type { CompletedBackendRead } from "../backend-read";
import { formatCount, formatDurationMs } from "./format";

export const comparisonModeLabels: Record<ComparisonMode, string> = {
  demo: "With the order queue",
  synchronous_confirmation: "Without the order queue",
};

/** A run of the pair: its saved report, or none yet (`runId` null when it has not started). */
export type ComparisonMember =
  | { state: "available"; runId: string; detail: PublicRunHistoryDetailResponse }
  | { state: "pending"; runId: string | null };

/**
 * Both runs of the comparison a run belongs to, in run order. The partner comes from the run's
 * saved report, or from `firstRunId` while the run has no report yet.
 */
export async function readComparison(
  runId: string,
  firstRunId: string | null,
  readDetail: (runId: string) => Promise<CompletedBackendRead<PublicRunHistoryDetailResponse>>,
): Promise<[ComparisonMember, ComparisonMember]> {
  const member = async (id: string): Promise<ComparisonMember> => {
    const read = await readDetail(id);
    return read.status === "available"
      ? { state: "available", runId: id, detail: read.data }
      : { state: "pending", runId: id };
  };
  const own = await member(runId);
  const comparison = own.state === "available" ? own.detail.run.comparison : undefined;
  const partnerRunId = comparison ? comparison.partnerRunId : firstRunId;
  const partner = partnerRunId
    ? await member(partnerRunId)
    : { state: "pending" as const, runId: null };
  const ownIsFirst = comparison ? comparison.mode === "demo" : firstRunId === null;
  return ownIsFirst ? [own, partner] : [partner, own];
}

/** One run's facts; every number covers all winners or all buyers. Null means not recorded. */
export function comparisonRunFacts(detail: PublicRunHistoryDetailResponse) {
  const { httpSummary, businessOutcomeSummary, trafficDeliverySummary } = detail.summary;
  const accepted = httpSummary.buyerWallLatencySummary?.accepted ?? null;
  const soldOut = httpSummary.buyerWallLatencySummary?.soldOut ?? null;
  const confirmedAnswers = httpSummary.confirmedResponses ?? null;
  const convergenceSeconds =
    detail.summary.runSignalTimelineSummary?.convergenceDurationSeconds ?? null;
  const paceWindowSeconds =
    convergenceSeconds === null
      ? null
      : trafficDeliverySummary.requestArrivalSummary.dispatchDurationSeconds + convergenceSeconds;
  return {
    winnerAverageMs: accepted?.averageMs ?? null,
    winnerP95Ms: accepted?.p95Ms ?? null,
    everyBuyerAnsweredWithinMs: longestWait([
      [accepted, httpSummary.acceptedResponses],
      [soldOut, httpSummary.soldOutResponses],
    ]),
    confirmedAnswers,
    stillConfirmingAnswers:
      confirmedAnswers === null || httpSummary.acceptedResponses === null
        ? null
        : httpSummary.acceptedResponses - confirmedAnswers,
    unanswered: httpSummary.transportFailures,
    ordersConfirmed: businessOutcomeSummary.confirmedOrders,
    ordersFailed: businessOutcomeSummary.failedOrders,
    erpPacePerSecond: paceWindowSeconds
      ? businessOutcomeSummary.confirmedOrders / paceWindowSeconds
      : null,
    erpLimitPerSecond: detail.run.configSnapshot.erpConfig.maxTps,
    slowestOrderMs:
      detail.summary.runSignalTimelineSummary?.confirmationConvergence.maxLagMs ?? null,
  };
}
export type ComparisonRunFacts = ReturnType<typeof comparisonRunFacts>;

/** The longest single wait; unknown when a cohort that has replies has no statistics. */
function longestWait(cohorts: [BuyerWallLatency | null, number | null][]): number | null {
  let longest = 0;
  for (const [cohort, count] of cohorts) {
    if (count === 0) continue;
    if (!cohort) return null;
    longest = Math.max(longest, cohort.maxMs);
  }
  return longest;
}

export function formatPace(value: number | null): string | null {
  return value === null ? null : `about ${Math.round(value)} per second`;
}

/** The honest reading of a complete pair; null unless both runs have the facts it states. */
export function comparisonTakeaway(
  queued: ComparisonRunFacts,
  waiting: ComparisonRunFacts,
): string | null {
  const queuedWait = formatDurationMs(queued.everyBuyerAnsweredWithinMs);
  const waitingWait = formatDurationMs(waiting.everyBuyerAnsweredWithinMs);
  const queuedPace = formatPace(queued.erpPacePerSecond);
  const waitingPace = formatPace(waiting.erpPacePerSecond);
  if (!queuedWait || !waitingWait || !queuedPace || !waitingPace) return null;
  const stillConfirming = waiting.stillConfirmingAnswers ?? 0;
  return [
    `Same buyers, same stock, same ERP limit of ${waiting.erpLimitPerSecond} orders per second.`,
    `The ERP confirmed ${formatCount(queued.ordersConfirmed)} orders with the queue and ${formatCount(waiting.ordersConfirmed)} without it, at ${queuedPace} and ${waitingPace}: the queue does not make the back office faster.`,
    `With the queue, every buyer had an answer within ${queuedWait}. Without it, each winner waited for their turn at the ERP, and the last answer came after ${waitingWait}.`,
    stillConfirming > 0
      ? `${formatCount(stillConfirming)} winners stopped waiting after ${synchronousConfirmationDeadlineMs / 1000} s and were told their order was still being confirmed; it was confirmed later like the others.`
      : null,
    "The queue moves the wait from the buyer to the back office.",
  ]
    .filter(Boolean)
    .join(" ");
}
