import {
  type BuyerWallLatency,
  type ComparisonMode,
  comparisonPartnerStartGraceMs,
  isFirstComparisonMode,
  type PublicRunHistoryDetailResponse,
} from "@checkout-surge/contracts";
import type { CompletedBackendRead } from "../backend-read";
import { getTranslation, type Locale } from "../i18n/translate";

export const comparisonModeLabels: Record<ComparisonMode, string> = {
  demo: "With the order queue",
  synchronous_confirmation: "Without the order queue",
  redis: "With Redis",
  postgres: "Stock and order queue in PostgreSQL",
};

/** A comparison run's place in its pair and its mode: "Run 1 of 2 · With the order queue". */
export function comparisonRunLabel(mode: ComparisonMode, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return t("Run {v0} of 2 · {v1}", {
    v0: String(isFirstComparisonMode(mode) ? 1 : 2),
    v1: t(comparisonModeLabels[mode]),
  });
}

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
  const ownIsFirst = comparison ? isFirstComparisonMode(comparison.mode) : firstRunId === null;
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
    withoutExpectedAnswer:
      httpSummary.transportFailures === null || httpSummary.unexpectedResponses === null
        ? null
        : httpSummary.transportFailures + httpSummary.unexpectedResponses,
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

export function formatPace(value: number | null, locale: Locale = "en"): string | null {
  const t = getTranslation(locale);
  return value === null ? null : t("about {v0} per second", { v0: String(Math.round(value)) });
}

/** One run of the Redis comparison; every count covers all buyers. Null means not recorded. */
export function redisComparisonRunFacts(detail: PublicRunHistoryDetailResponse) {
  const { httpSummary, businessOutcomeSummary } = detail.summary;
  const accepted = httpSummary.buyerWallLatencySummary?.accepted ?? null;
  const soldOut = httpSummary.buyerWallLatencySummary?.soldOut ?? null;
  const load = detail.run.storeLoad ?? null;
  return {
    secured: httpSummary.acceptedResponses,
    turnedAway: httpSummary.soldOutResponses,
    withoutExpectedAnswer:
      httpSummary.transportFailures === null || httpSummary.unexpectedResponses === null
        ? null
        : httpSummary.transportFailures + httpSummary.unexpectedResponses,
    unitsSold: businessOutcomeSummary.reservedUnits,
    stock: detail.run.configSnapshot.inventoryConfig.startingStock,
    postgresTransactions: load?.postgresTransactions ?? null,
    postgresCpuMs: load?.postgresCpuMs ?? null,
    postgresBusyMs: load?.postgresBusyMs ?? null,
    winnerAverageMs: accepted?.averageMs ?? null,
    winnerP95Ms: accepted?.p95Ms ?? null,
    turnedAwayAverageMs: soldOut?.averageMs ?? null,
    turnedAwayP95Ms: soldOut?.p95Ms ?? null,
    everyBuyerAnsweredWithinMs: longestWait([
      [accepted, httpSummary.acceptedResponses],
      [soldOut, httpSummary.soldOutResponses],
    ]),
  };
}

/**
 * Run 2's figures as multiples of run 1's, "×2.7 / ×3.1", whichever run is higher. Null unless
 * every figure is known in both runs and run 1's is above zero.
 */
export function formatMultiples(
  base: (number | null)[],
  amounts: (number | null)[],
  locale: Locale = "en",
): string | null {
  const multiples = amounts.map((amount, index) => {
    const baseAmount = base[index] ?? null;
    return amount === null || baseAmount === null || baseAmount <= 0
      ? null
      : `×${(amount / baseAmount).toFixed(1).replace(".", locale === "fr" ? "," : ".")}`;
  });
  return multiples.every((multiple) => multiple !== null) ? multiples.join(" / ") : null;
}
