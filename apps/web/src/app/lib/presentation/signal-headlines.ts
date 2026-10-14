import {
  type ConsistencyLagSummary,
  type DemoRunStatus,
  hasObservedRequestArrivals,
  type RequestArrivalSummary,
  type RunSignalTimelineHeadline,
} from "@checkout-surge/contracts";
import type { RunSignalLiveSample } from "../dashboard-projection-state";
import { getTranslation, type Locale } from "../i18n/translate";
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

export function deriveSignalHeadlines(
  {
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
  },
  locale: Locale = "en",
): SignalHeadlines {
  const t = getTranslation(locale);
  const trafficAbsence = runEvidenceAbsence(
    runStatus,
    {
      source: "load-generator",
      pending: t("Not yet available"),
      settled: t("Not recorded for this run"),
    },
    locale,
  );
  const durableAbsence = runEvidenceAbsence(
    runStatus,
    {
      source: "durable-processing",
      pending: t("Not yet available"),
      settled: t("Not recorded for this run"),
    },
    locale,
  );
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
        ? t("Convergence incomplete · {v0} pending", {
            v0: String(
              formatNumber(terminal.confirmationConvergence.pendingAtCaptureCount, locale),
            ),
          })
        : t("Convergence duration unavailable")
      : t("Converged in {v0}", {
          v0: String(formatDuration(terminal.convergenceDurationSeconds, locale)),
        })
    : runStatus !== null && isRunEvidenceSettled(runStatus, "durable-processing")
      ? t("Final convergence evidence unavailable")
      : null;
  const confirmationCounts =
    confirmed === null && pending === null
      ? durableAbsence
      : t("{v0}/{v1} confirmed · {v2} pending", {
          v0: String(formatOptionalNumber(confirmed, durableAbsence, locale)),
          v1: String(formatOptionalNumber(acceptedReservations, durableAbsence, locale)),
          v2: String(formatOptionalNumber(pending, durableAbsence, locale)),
        });
  const confirmationUnavailable = confirmed === null && pending === null;
  const confirmationP95 =
    lag?.p95LagMs === null || lag?.p95LagMs === undefined
      ? null
      : formatMilliseconds(lag.p95LagMs, durableAbsence, locale);
  const arrivalValue =
    arrivalPeak === null
      ? trafficAbsence
      : t("Peak {v0}", { v0: String(formatRate(arrivalPeak, locale)) });
  const inventoryValue =
    remainingStock === null && initialStock === null
      ? durableAbsence
      : t("{v0} of {v1} left · {v2}", {
          v0: String(formatOptionalNumber(remainingStock, durableAbsence, locale)),
          v1: String(formatOptionalNumber(initialStock, durableAbsence, locale)),
          v2: String(
            oversoldUnits === null
              ? t("oversell unknown")
              : t("{v0} oversold", { v0: String(formatNumber(oversoldUnits, locale)) }),
          ),
        });
  const backlogValue =
    peakBacklog === null
      ? durableAbsence
      : terminal
        ? t("Peak {v0} · {v1}", {
            v0: String(formatNumber(peakBacklog, locale)),
            v1: String(
              terminal.queueBacklog.drainDurationSeconds === null
                ? t("drain duration unavailable")
                : t("drained in {v0}", {
                    v0: String(formatDuration(terminal.queueBacklog.drainDurationSeconds, locale)),
                  }),
            ),
          })
        : t("{v0} waiting · peak {v1}", {
            v0: String(formatOptionalNumber(currentBacklog, durableAbsence, locale)),
            v1: String(formatNumber(peakBacklog, locale)),
          });

  return {
    arrival: {
      value: arrivalValue,
      summaryValue: arrivalValue,
      detail: arrival
        ? t("Dispatched in {v0}", {
            v0: String(formatDuration(arrival.dispatchDurationSeconds, locale)),
          })
        : null,
    },
    inventory: {
      value: inventoryValue,
      summaryValue: inventoryValue,
      detail: terminal
        ? terminal.inventoryDrain.timeToDepletionSeconds === null
          ? t("not depleted")
          : t("depleted in {v0}", {
              v0: String(formatDuration(terminal.inventoryDrain.timeToDepletionSeconds, locale)),
            })
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
            confirmationP95
              ? t(" · 95% of confirmed orders within {v0}", { v0: String(confirmationP95) })
              : ""
          }${convergenceStatus ? ` · ${convergenceStatus}` : ""}`,
      detail:
        confirmed === null && pending === null
          ? null
          : t("{v0} failed · lag avg {v1}, max {v2}", {
              v0: String(formatOptionalNumber(failed, durableAbsence, locale)),
              v1: String(formatMilliseconds(lag?.averageLagMs ?? null, durableAbsence, locale)),
              v2: String(formatMilliseconds(lag?.maxLagMs ?? null, durableAbsence, locale)),
            }),
    },
  };
}

function formatOptionalNumber(value: number | null, absent: string, locale: Locale = "en"): string {
  return value === null ? absent : formatNumber(value, locale);
}

function formatRate(value: number, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return t("{v0} attempts/s", { v0: String(formatNumber(value, locale)) });
}

function formatDuration(value: number, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return formatDurationMs(value * 1_000, locale) ?? t("not yet available");
}

function formatMilliseconds(value: number | null, absent: string, locale: Locale = "en"): string {
  return formatDurationMs(value, locale) ?? absent;
}

function formatNumber(value: number, locale: Locale = "en"): string {
  return new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US", {
    maximumFractionDigits: 2,
  }).format(value);
}
