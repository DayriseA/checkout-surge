import {
  type BuyerWallLatency,
  type ComparisonMode,
  comparisonPartnerStartGraceMs,
  type PublicRunHistoryDetailResponse,
  synchronousConfirmationDeadlineMs,
} from "@checkout-surge/contracts";
import type { CompletedBackendRead } from "../backend-read";
import { formatCount, formatDurationMs } from "./format";

export const comparisonModeLabels: Record<ComparisonMode, string> = {
  demo: "With the order queue",
  synchronous_confirmation: "Without the order queue",
};

type DetailRead = CompletedBackendRead<PublicRunHistoryDetailResponse>;

/**
 * A run of the pair: its saved report; still running (no report yet); unavailable; not started
 * yet; or never started.
 */
export type ComparisonMember =
  | { state: "available"; runId: string; detail: PublicRunHistoryDetailResponse }
  | { state: "running" | "unavailable"; runId: string | null }
  | { state: "not_started" | "never" };

/**
 * Both runs of the comparison a run belongs to, in run order. The partner comes from the run's
 * saved report, or from `firstRunId` while the run has no report yet. `ownRead` spares a read
 * the caller already made.
 */
export async function readComparison(
  runId: string,
  firstRunId: string | null,
  readDetail: (runId: string) => Promise<DetailRead>,
  ownRead?: DetailRead,
): Promise<[ComparisonMember, ComparisonMember]> {
  const member = (id: string, read: DetailRead): ComparisonMember =>
    read.status === "available"
      ? { state: "available", runId: id, detail: read.data }
      : { state: read.httpStatus === 404 ? "running" : "unavailable", runId: id };
  const own = member(runId, ownRead ?? (await readDetail(runId)));
  const comparison = own.state === "available" ? own.detail.run.comparison : undefined;
  const partnerRunId = comparison ? comparison.partnerRunId : firstRunId;
  const ownIsFirst = comparison ? comparison.mode === "demo" : firstRunId === null;
  const partner = partnerRunId
    ? member(partnerRunId, await readDetail(partnerRunId))
    : ownIsFirst
      ? missingSecondRun(own)
      : ({ state: "unavailable", runId: null } as const);
  return ownIsFirst ? [own, partner] : [partner, own];
}

/** A first run without a second one: it still may come, or it never will. */
function missingSecondRun(first: ComparisonMember): ComparisonMember {
  if (first.state !== "available") return { state: "not_started" };
  const { status, finalizedAt } = first.detail.run;
  const stillDue =
    status === "completed" &&
    finalizedAt !== undefined &&
    Date.parse(finalizedAt) + comparisonPartnerStartGraceMs > Date.now();
  return { state: stillDue ? "not_started" : "never" };
}

/** One run's facts; every number covers all winners or all buyers. Null means not recorded. */
export function comparisonRunFacts(detail: PublicRunHistoryDetailResponse) {
  const { httpSummary, businessOutcomeSummary, trafficDeliverySummary } = detail.summary;
  const accepted = httpSummary.buyerWallLatencySummary?.accepted ?? null;
  const soldOut = httpSummary.buyerWallLatencySummary?.soldOut ?? null;
  const confirmedAnswers = httpSummary.confirmedResponses ?? null;
  const pendingAnswers = httpSummary.pendingPersistenceResponses ?? null;
  const acceptedResponses = httpSummary.acceptedResponses;
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
    notYetConfirmedAnswers:
      confirmedAnswers === null || acceptedResponses === null
        ? null
        : acceptedResponses - confirmedAnswers,
    // Waits that ended unconfirmed (deadline or reset); pending-persistence answers never waited.
    deadlineAnswers:
      confirmedAnswers === null || pendingAnswers === null || acceptedResponses === null
        ? null
        : acceptedResponses - confirmedAnswers - pendingAnswers,
    withoutExpectedAnswer:
      httpSummary.transportFailures === null || httpSummary.unexpectedResponses === null
        ? null
        : httpSummary.transportFailures + httpSummary.unexpectedResponses,
    ordersAccepted: businessOutcomeSummary.acceptedReservations,
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

/** Paces this close count as the same ERP pace. */
const samePaceTolerance = 0.1;

/** A run whose every buyer got an expected answer and whose every order was confirmed. */
function settledCleanly(facts: ComparisonRunFacts): boolean {
  return (
    facts.withoutExpectedAnswer === 0 &&
    facts.ordersFailed === 0 &&
    facts.ordersConfirmed === facts.ordersAccepted
  );
}

/**
 * The honest reading of a complete pair. Null unless both runs settled cleanly, at the same ERP
 * pace, with every fact it states known: otherwise the panel shows the numbers alone.
 */
export function comparisonTakeaway(
  queued: ComparisonRunFacts,
  waiting: ComparisonRunFacts,
): string | null {
  const queuedWait = formatDurationMs(queued.everyBuyerAnsweredWithinMs);
  const waitingWait = formatDurationMs(waiting.everyBuyerAnsweredWithinMs);
  const queuedPace = queued.erpPacePerSecond;
  const waitingPace = waiting.erpPacePerSecond;
  if (
    !queuedWait ||
    !waitingWait ||
    queuedPace === null ||
    waitingPace === null ||
    waiting.deadlineAnswers === null ||
    !settledCleanly(queued) ||
    !settledCleanly(waiting) ||
    Math.abs(queuedPace - waitingPace) > samePaceTolerance * Math.max(queuedPace, waitingPace)
  )
    return null;
  return [
    `Same buyers, same stock, same ERP limit of ${waiting.erpLimitPerSecond} orders per second.`,
    `The ERP confirmed every order in both runs (${formatCount(queued.ordersConfirmed)} and ${formatCount(waiting.ordersConfirmed)}) at the same pace, ${formatPace(queuedPace)} and ${formatPace(waitingPace)}: the queue does not make the back office faster.`,
    `With the queue, every buyer had an answer within ${queuedWait}. Without it, each winner waited for their turn at the ERP, and the last answer came after ${waitingWait}.`,
    waiting.deadlineAnswers > 0
      ? `${formatCount(waiting.deadlineAnswers)} winners stopped waiting after ${synchronousConfirmationDeadlineMs / 1000} s and were told their order was still being confirmed; it was confirmed later like the others.`
      : null,
    "The queue moves the wait from the buyer to the back office.",
  ]
    .filter(Boolean)
    .join(" ");
}
