import {
  type ConsistencyLagSummary,
  type DemoRunStatus,
  hasObservedRequestArrivals,
  type RequestArrivalSummary,
  type RunSignalTimelineHeadline,
} from "@checkout-surge/contracts";
import type { RunSignalLiveSample } from "../dashboard-projection-state";
import { formatDurationMs } from "./format";
import { isRunEvidenceSettled, runEvidenceAbsence } from "./public-vocabulary";

export type SignalHeadlines = {
  arrival: { summaryValue: string; value: string; detail: string | null };
  inventory: { summaryValue: string; value: string; detail: string | null };
  backlog: { summaryValue: string; value: string; detail: string | null };
  confirmation: { summaryValue: string; value: string; detail: string | null };
};

export function selectConfirmationLiveSamples(
  liveSamples: RunSignalLiveSample[],
): RunSignalLiveSample[] {
  return liveSamples.filter((sample) => sample.hasBusinessOutcomeEvidence);
}

export function deriveSignalHeadlines({
  acceptedReservations,
  arrivalSummary,
  failedOrders,
  liveLag,
  liveSamples = [],
  oversoldUnits,
  runStatus,
  startingStock,
  terminalSummary,
}: {
  acceptedReservations: number | null;
  arrivalSummary: RequestArrivalSummary | null;
  failedOrders: number | null;
  liveLag: ConsistencyLagSummary | null;
  liveSamples?: RunSignalLiveSample[];
  oversoldUnits: number | null;
  runStatus: DemoRunStatus | null;
  startingStock: number | null;
  terminalSummary: RunSignalTimelineHeadline | null;
}): SignalHeadlines {
  const trafficAbsence = runEvidenceAbsence(runStatus, {
    source: "load-generator",
    pending: "Not yet available",
    settled: "Not recorded for this run",
  });
  const durableAbsence = runEvidenceAbsence(runStatus, {
    source: "durable-processing",
    pending: "Not yet available",
    settled: "Not recorded for this run",
  });
  const arrival =
    arrivalSummary && hasObservedRequestArrivals(arrivalSummary) ? arrivalSummary : null;
  const liveArrivalRates = liveSamples.flatMap((sample) =>
    sample.arrivalRatePerSecond === null ? [] : [sample.arrivalRatePerSecond],
  );
  const liveStock = [...liveSamples]
    .reverse()
    .find((sample) => sample.remainingStock !== null)?.remainingStock;
  const liveBacklogs = liveSamples.flatMap((sample) =>
    sample.queueBacklog === null ? [] : [sample.queueBacklog],
  );
  const terminal = terminalSummary;
  const arrivalPeak =
    arrival?.peakArrivalRatePerSecond ??
    (liveArrivalRates.length > 0 ? Math.max(...liveArrivalRates) : null);
  const remainingStock = terminal?.inventoryDrain.remainingStock ?? liveStock ?? null;
  const initialStock = terminal?.inventoryDrain.startingStock ?? startingStock;
  const currentBacklog = liveBacklogs.at(-1) ?? null;
  const peakBacklog =
    terminal?.queueBacklog.peakBacklog ??
    (liveBacklogs.length > 0 ? Math.max(...liveBacklogs) : null);
  const confirmation = terminal?.confirmationConvergence;
  const confirmed = confirmation?.confirmedOrderCount ?? liveLag?.confirmedOrderCount ?? null;
  const failed = confirmation?.failedOrderCount ?? failedOrders;
  const pending = confirmation?.pendingAtCaptureCount ?? liveLag?.pendingConfirmationCount ?? null;
  const lag = confirmation ?? liveLag;
  const convergenceStatus = terminal
    ? terminal.convergenceDurationSeconds === null
      ? terminal.confirmationConvergence.pendingAtCaptureCount > 0
        ? `Convergence incomplete · ${formatNumber(
            terminal.confirmationConvergence.pendingAtCaptureCount,
          )} pending`
        : "Convergence duration unavailable"
      : `Converged in ${formatDuration(terminal.convergenceDurationSeconds)}`
    : runStatus !== null && isRunEvidenceSettled(runStatus, "durable-processing")
      ? "Final convergence evidence unavailable"
      : null;
  const confirmationCounts =
    confirmed === null && pending === null
      ? durableAbsence
      : `${formatOptionalNumber(confirmed, durableAbsence)}/${formatOptionalNumber(
          acceptedReservations,
          durableAbsence,
        )} confirmed · ${formatOptionalNumber(pending, durableAbsence)} pending`;
  const confirmationUnavailable = confirmed === null && pending === null;
  const confirmationP95 =
    lag?.p95LagMs === null || lag?.p95LagMs === undefined
      ? null
      : formatMilliseconds(lag.p95LagMs, durableAbsence);
  const arrivalValue = arrivalPeak === null ? trafficAbsence : `Peak ${formatRate(arrivalPeak)}`;
  const inventoryValue =
    remainingStock === null && initialStock === null
      ? durableAbsence
      : `${formatOptionalNumber(remainingStock, durableAbsence)} of ${formatOptionalNumber(
          initialStock,
          durableAbsence,
        )} left · ${
          oversoldUnits === null ? "oversell unknown" : `${formatNumber(oversoldUnits)} oversold`
        }`;
  const backlogValue =
    peakBacklog === null
      ? durableAbsence
      : terminal
        ? `Peak ${formatNumber(peakBacklog)} · ${
            terminal.queueBacklog.drainDurationSeconds === null
              ? "drain duration unavailable"
              : `drained in ${formatDuration(terminal.queueBacklog.drainDurationSeconds)}`
          }`
        : `${formatOptionalNumber(currentBacklog, durableAbsence)} waiting · peak ${formatNumber(
            peakBacklog,
          )}`;

  return {
    arrival: {
      value: arrivalValue,
      summaryValue: arrivalValue,
      detail: arrival ? `Dispatched in ${formatDuration(arrival.dispatchDurationSeconds)}` : null,
    },
    inventory: {
      value: inventoryValue,
      summaryValue: inventoryValue,
      detail: terminal
        ? terminal.inventoryDrain.timeToDepletionSeconds === null
          ? "not depleted"
          : `depleted in ${formatDuration(terminal.inventoryDrain.timeToDepletionSeconds)}`
        : null,
    },
    backlog: {
      value: backlogValue,
      summaryValue: backlogValue,
      detail: null,
    },
    confirmation: {
      value: confirmationUnavailable
        ? durableAbsence
        : `${confirmationCounts}${confirmationP95 ? ` · p95 ${confirmationP95}` : ""}${
            convergenceStatus ? ` · ${convergenceStatus}` : ""
          }`,
      summaryValue: confirmationUnavailable
        ? durableAbsence
        : `${confirmationCounts}${
            confirmationP95 ? ` · 95% of confirmed orders within ${confirmationP95}` : ""
          }${convergenceStatus ? ` · ${convergenceStatus}` : ""}`,
      detail:
        confirmed === null && pending === null
          ? null
          : `${formatOptionalNumber(failed, durableAbsence)} failed · lag avg ${formatMilliseconds(
              lag?.averageLagMs ?? null,
              durableAbsence,
            )}, max ${formatMilliseconds(lag?.maxLagMs ?? null, durableAbsence)}`,
    },
  };
}

function formatOptionalNumber(value: number | null, absent: string): string {
  return value === null ? absent : formatNumber(value);
}

function formatRate(value: number): string {
  return `${formatNumber(value)} attempts/s`;
}

function formatDuration(value: number): string {
  return formatDurationMs(value * 1_000) ?? "not yet available";
}

function formatMilliseconds(value: number | null, absent: string): string {
  return formatDurationMs(value) ?? absent;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}
