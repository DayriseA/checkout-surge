"use client";

import type { DashboardProjection } from "@checkout-surge/contracts";
import type { ReactNode } from "react";
import type { BackendRead } from "../lib/api";
import { projectRequestSurge } from "../lib/dashboard-projection-state";
import { useLocale, useTranslation } from "../lib/i18n/locale-context";
import { getTranslation, type Locale } from "../lib/i18n/translate";
import { deriveRunErpStory } from "../lib/presentation/erp-story";
import {
  formatCount,
  formatDurationMs,
  formatInstantUtc,
  formatWindowSeconds,
} from "../lib/presentation/format";
import type { Freshness, RealtimeConnectionStatus } from "../lib/presentation/freshness";
import {
  durableCheckoutLens,
  erpAttemptStatusLabel,
  liveTrafficMetricWindowSeconds,
  publicStatusLabel,
  publicVocabulary,
  queueConnectivityLabel,
  rateWindowLabel,
  runEvidenceAbsence,
  runLifecycleStatusLabel,
  trafficExecutionStatusLabel,
  trailingRateWindowLabel,
} from "../lib/presentation/public-vocabulary";
import {
  deriveFreshnessPresentationState,
  type PresentationState,
} from "../lib/presentation/run-presentation-state";
import { buttonClassName } from "./control-styles";
import { ErrorNotice } from "./error-notice";
import { StatusPill } from "./status-pill";
import {
  deriveHarnessPreparation,
  RequestArrivalRateSeries,
  TransportObservationPanelBlock,
} from "./transport-observation";

export type { RealtimeConnectionStatus } from "../lib/presentation/freshness";

const panelClassName =
  "min-w-0 rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4 max-[900px]:col-span-full";
const panelNarrowClassName = `${panelClassName} col-span-4`;
/** Two half-width panels pair into one full row instead of orphaning a third of the grid. */
const panelHalfClassName = `${panelClassName} col-span-6`;
const panelWideClassName = `${panelClassName} col-span-8`;
const panelFullClassName = `${panelClassName} col-span-12`;
const panelHeaderClassName = "mb-4 flex items-start justify-between gap-3";
const eyebrowClassName = "m-0 text-xs font-medium text-muted";
const panelTitleClassName = "m-0 mt-1 text-base font-bold leading-tight text-ink";
const emptyStateClassName = "m-0 leading-6 text-muted";
const factGridClassName = "m-0 grid grid-cols-3 gap-3 max-[560px]:grid-cols-2";
const wideFactGridClassName =
  "m-0 grid grid-cols-6 gap-3 max-[700px]:grid-cols-3 max-[480px]:grid-cols-2";
const stackedFactGridClassName = "m-0 grid gap-3";
const factItemClassName = "min-w-0";
const leadSentenceClassName = "m-0 mb-1 text-base font-bold leading-6 text-ink";
const leadDetailClassName = "m-0 mb-3 text-xs leading-5 text-muted";
const factTermClassName = "mb-0.5 text-xs font-medium text-muted";
const factValueClassName = "m-0 [overflow-wrap:anywhere] text-base font-bold text-ink";
const smallValueClassName = "m-0 [overflow-wrap:anywhere] text-sm font-semibold text-ink";
/** The unit tag carried by load-generator latency samples. */
const millisecondUnit = "ms";

/**
 * The lag producer owns this measurement; the panel only names its boundaries so a reader knows
 * which interval the distribution below describes. It is not the checkout-response boundary.
 */
const lagMeasurementBoundaryCaption =
  "Measured from the moment a reservation is secured to final simulated-ERP confirmation.";

export function formatNumber(value: number | null | undefined, locale: Locale = "en"): string {
  return formatCount(value, locale) ?? "—";
}

/** Rates are not counts or durations; they keep their own precision rule and unit label. */
export function formatRate(
  value: number | null | undefined,
  unit: string,
  absent = "—",
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  if (value === null || value === undefined) {
    return absent;
  }

  return `${new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US", {
    maximumFractionDigits: value < 10 ? 2 : 1,
  }).format(value)} ${t(unit)}`;
}

function formatExpectedTime(value: string | undefined | null, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return formatInstantUtc(value, { locale }) ?? t("not yet available");
}

export function formatDurationSeconds(
  value: number | null | undefined,
  absent = "—",
  locale: Locale = "en",
): string {
  return (
    formatDurationMs(value === null || value === undefined ? null : value * 1000, locale) ?? absent
  );
}

export function formatMilliseconds(
  value: number | null | undefined,
  absent = "—",
  locale: Locale = "en",
): string {
  return formatDurationMs(value, locale) ?? absent;
}

/**
 * A metric sample carries its own unit. A millisecond sample is an elapsed measurement, so it
 * follows the one duration policy rather than the sample's raw precision; every other unit is a
 * rate or a ratio and keeps its own precision rule and unit label.
 */
export function formatMetric(
  value: number,
  unit: string,
  absent = "—",
  locale: Locale = "en",
): string {
  if (unit === millisecondUnit) {
    return formatDurationMs(value, locale) ?? absent;
  }

  return `${new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US", {
    maximumFractionDigits: value < 10 ? 2 : 1,
  }).format(value)} ${unit}`;
}

export function formatFailureSample(value: number, unit: string, locale: Locale = "en"): string {
  return unit === "ratio"
    ? `${new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US", { maximumFractionDigits: 2 }).format(value * 100)}%`
    : formatMetric(value, unit, undefined, locale);
}

function formatObservedRequestRate(value: number, locale: Locale = "en"): string {
  return formatRate(value, "attempts/s", undefined, locale);
}

function recoveryData(recovery: BackendRead<DashboardProjection>): DashboardProjection | null {
  return recovery.status === "available" ? recovery.data : null;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className={emptyStateClassName}>{children}</p>;
}

function UnavailableState({ read }: { read: BackendRead<unknown> }) {
  if (read.status === "available") return null;
  return <ErrorNotice context="watch-read" read={read} />;
}

function Fact({ label, value, small = false }: { label: string; value: string; small?: boolean }) {
  const t = useTranslation();

  return (
    <div className={factItemClassName}>
      <dt className={factTermClassName}>{t(label)}</dt>
      <dd className={small ? smallValueClassName : factValueClassName}>
        {typeof value === "string" ? t(value) : value}
      </dd>
    </div>
  );
}

/**
 * The lead of the simulated-ERP surface: one sentence a visitor can read without technical
 * context. `caption` states a measurement window once for the facts below, so no individual count
 * has to repeat it.
 */
function ErpStoryLead({ story, caption }: { story: string; caption?: string }) {
  const t = useTranslation();

  return (
    <>
      <p className={leadSentenceClassName}>{story}</p>
      {caption ? <p className={leadDetailClassName}>{t(caption)}</p> : null}
    </>
  );
}

/**
 * The one-line observation age and delivery state, shared by every data panel and by the summary
 * Watch last-known warning: retained readings must never appear without their reading time.
 */
export function FreshnessLine({ freshness }: { freshness: Freshness }) {
  const t = useTranslation();
  const locale = useLocale();

  // Retained and stale states can show an observation from an earlier calendar day, so this
  // line always carries the full dated UTC form rather than a bare clock reading. Like both
  // history routes, it keeps the exact ISO value in `<time dateTime>`; the reading and the
  // machine value derive from the same server-supplied string under a fixed zone, so server
  // rendering and hydration cannot disagree.
  const reading = formatInstantUtc(freshness.observedAt, { locale });
  const updated: ReactNode =
    reading === null ? (
      t("an unrecorded time")
    ) : (
      <time dateTime={freshness.observedAt}>{reading}</time>
    );
  const notApplicable = freshness.final ? (
    <>
      {t("Final, as of")} {updated}
    </>
  ) : (
    <>
      {t("As of")} {updated} {t("· no active run")}
    </>
  );
  const copy: Record<Freshness["state"], ReactNode> = {
    connecting: (
      <>
        {t("Updated")} {updated} {t("· connecting to live updates")}
      </>
    ),
    disconnected: (
      <>
        {t("Updated")} {updated} {t("· disconnected, showing last known values")}
      </>
    ),
    live: (
      <>
        {t("Updated")} {updated} {t("· live")}
      </>
    ),
    "not-applicable": notApplicable,
    "retained-fresh": (
      <>
        {t("Updated")} {updated} {t("· connected, no update expected")}
      </>
    ),
    stale: (
      <>
        {t("Updated")} {updated} {t("· stale, showing last known values")}
      </>
    ),
    unsupported: (
      <>
        {t("Updated")} {updated} {t("· live updates unsupported")}
      </>
    ),
  };

  return <p className="m-0 mb-3 text-xs leading-5 text-muted">{copy[freshness.state]}</p>;
}

export function RecoveryStatusPanel({
  recovery,
  realtimeStatus,
  isRefreshing = false,
  hasSyncIssue = false,
  syncIssue = null,
  presentation,
  freshness,
  fullWidth = false,
  onRefresh,
}: {
  recovery: BackendRead<DashboardProjection>;
  realtimeStatus: RealtimeConnectionStatus;
  isRefreshing?: boolean;
  hasSyncIssue?: boolean;
  syncIssue?: Extract<BackendRead<DashboardProjection>, { status: "unavailable" }> | null;
  presentation: PresentationState;
  freshness?: Freshness;
  fullWidth?: boolean;
  onRefresh?: () => void;
}) {
  const t = useTranslation();
  const locale = useLocale();
  const data = recoveryData(recovery);
  const run = data?.currentRun ?? null;
  const noRunValue =
    presentation.state === "reset-recovery-incomplete"
      ? t("Unavailable until operator recovery completes")
      : t("No run has started");
  const hasLastKnownGoodSyncIssue = data !== null && hasSyncIssue;
  const retryWaitActive =
    (recovery.status === "unavailable" && (recovery.retryAfterMs ?? 0) > 0) ||
    (syncIssue?.retryAfterMs ?? 0) > 0;

  return (
    <section className={fullWidth ? panelFullClassName : panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>{t("Current state")}</p>
          <h2 className={panelTitleClassName}>{t("Run availability and updates")}</h2>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {onRefresh &&
          recovery.status !== "loading" &&
          !retryWaitActive &&
          !hasLastKnownGoodSyncIssue ? (
            <button
              className={`${buttonClassName} px-3 py-2 text-sm`}
              disabled={isRefreshing}
              onClick={onRefresh}
              type="button"
            >
              {isRefreshing ? t("Refreshing") : t("Refresh")}
            </button>
          ) : null}
          <StatusPill
            status={{
              ...presentation,
              label: publicStatusLabel(
                {
                  family: "run",
                  status: run?.status ?? "starting",
                  displayLabel: presentation.label,
                },
                locale,
              ),
            }}
          />
        </div>
      </div>
      {hasLastKnownGoodSyncIssue && syncIssue ? (
        <div className="mb-3">
          <ErrorNotice context="watch-read" read={syncIssue} />
        </div>
      ) : null}
      {data ? (
        <>
          {freshness ? <FreshnessLine freshness={freshness} /> : null}
          <dl className={stackedFactGridClassName}>
            <Fact label={t("Current scenario")} value={run ? run.presetName : noRunValue} />
            <Fact
              label={t("Run")}
              value={run ? runLifecycleStatusLabel(run.status, locale) : noRunValue}
            />
            <Fact
              label={t("Load generator")}
              value={run ? trafficExecutionStatusLabel(run.trafficStatus, locale) : noRunValue}
            />
          </dl>
          <p className="m-0 mt-3 text-xs leading-5 text-muted">
            {t("Updates")} {t(realtimeStatus)}
          </p>
        </>
      ) : (
        <UnavailableState read={recovery} />
      )}
    </section>
  );
}

/**
 * Realtime transport recovery guidance shared by Watch and authenticated Admin. The transport
 * status stays `disconnected` while a replacement is scheduled or in flight, so the interrupted
 * copy must not claim the stream is restored, and the reload action appears only after every
 * application-managed replacement attempt has failed.
 */
export function RealtimeRecoveryNotice({
  className = "",
  realtimeStatus,
  reconnectExhausted,
}: {
  className?: string;
  realtimeStatus: RealtimeConnectionStatus;
  reconnectExhausted: boolean;
}) {
  const t = useTranslation();

  if (realtimeStatus !== "disconnected") return null;
  return (
    <section
      className={`${className} rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4`}
    >
      {reconnectExhausted ? (
        <>
          <p className="m-0 leading-6 text-muted-strong">
            {t(
              "Unable to restore live updates. Reload the page. If the problem persists, try again later.",
            )}
          </p>
          <button className={`${buttonClassName} mt-3`} onClick={reloadPage} type="button">
            {t("Reload page")}
          </button>
        </>
      ) : (
        <p className="m-0 leading-6 text-muted-strong">
          {t("Live updates interrupted. Trying to reconnect...")}
        </p>
      )}
    </section>
  );
}

function reloadPage() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

export function RequestSurgePanel({
  recovery,
  freshness,
}: {
  recovery: BackendRead<DashboardProjection>;
  freshness: Freshness;
}) {
  const t = useTranslation();
  const locale = useLocale();
  const data = recoveryData(recovery);
  if (data && data.currentRun === null) {
    return (
      <section className={panelWideClassName}>
        <div className={panelHeaderClassName}>
          <div>
            <p className={eyebrowClassName}>{t("Request surge")}</p>
            <h2 className={panelTitleClassName}>{t("Traffic arrival and responses")}</h2>
          </div>
          <StatusPill status={deriveFreshnessPresentationState(freshness, locale)} />
        </div>
        <EmptyState>{t("No run has started.")}</EmptyState>
      </section>
    );
  }
  const inventory = data?.inventory ?? null;
  const runStatus = data?.currentRun?.status ?? null;
  // Every fact in this panel is load-generator evidence, so all of it is final once traffic ends.
  const loadGeneratorEvidenceAbsence = runEvidenceAbsence(
    runStatus,
    {
      source: "load-generator",
      pending: t("Waiting for the load generator"),
      settled: t("Not recorded for this run"),
    },
    locale,
  );
  const timingEvidenceAbsence = runEvidenceAbsence(
    runStatus,
    {
      source: "load-generator",
      pending: t("not yet available"),
      settled: t("Not recorded for this run"),
    },
    locale,
  );
  const reservationThroughput = inventory?.reservationThroughput ?? null;
  const transportAttemptCounts = data?.transportAttemptCounts ?? null;
  const httpSummary = data?.httpSummary ?? null;
  const requestSurge = data ? projectRequestSurge(data) : null;
  const preparation = data?.requestArrivalSummary
    ? deriveHarnessPreparation(
        data.requestArrivalSummary,
        data.currentRun?.trafficStartedAt,
        data.currentRun?.configSnapshot.trafficConfig.startDelaySeconds,
      )
    : null;
  const latencyMetric = data
    ? findLatestMetric(data.recentMetrics, (name) => name === "traffic.latency")
    : null;
  const failureRateMetric = data
    ? findLatestMetric(data.recentMetrics, (name) => name === "traffic.failure_rate")
    : null;

  return (
    <section className={panelWideClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>{t("Request surge")}</p>
          <h2 className={panelTitleClassName}>{t("Traffic arrival and responses")}</h2>
        </div>
        <StatusPill status={deriveFreshnessPresentationState(freshness, locale)} />
      </div>
      {data ? (
        <>
          <FreshnessLine freshness={freshness} />
          <dl className={factGridClassName}>
            <Fact
              label={
                requestSurge?.arrivalRateIsPeak
                  ? t("Peak request arrival rate ({v0})", {
                      v0: String(rateWindowLabel(requestSurge.arrivalWindowSeconds, locale)),
                    })
                  : t("Request arrival rate ({v0})", {
                      v0: String(
                        rateWindowLabel(
                          requestSurge?.arrivalWindowSeconds ?? liveTrafficMetricWindowSeconds,
                          locale,
                        ),
                      ),
                    })
              }
              value={
                requestSurge?.arrivalRatePerSecond !== null &&
                requestSurge?.arrivalRatePerSecond !== undefined
                  ? formatObservedRequestRate(requestSurge.arrivalRatePerSecond, locale)
                  : loadGeneratorEvidenceAbsence
              }
            />
            <Fact
              label={t("Attempts dispatched")}
              value={
                requestSurge?.attemptsDispatched === null ||
                requestSurge?.attemptsDispatched === undefined
                  ? loadGeneratorEvidenceAbsence
                  : formatNumber(requestSurge.attemptsDispatched, locale)
              }
            />
            <Fact
              label={t("Dispatch duration")}
              value={formatDurationSeconds(
                requestSurge?.dispatchDurationSeconds,
                timingEvidenceAbsence,
                locale,
              )}
            />
            <Fact
              label={t("Response completion rate ({v0})", {
                v0: rateWindowLabel(liveTrafficMetricWindowSeconds, locale),
              })}
              value={formatRate(
                requestSurge?.responseCompletionRatePerSecond,
                "responses/s",
                timingEvidenceAbsence,
                locale,
              )}
            />
            <Fact
              label={t("Configured start delay")}
              value={formatDurationSeconds(
                preparation?.configuredDelaySeconds,
                timingEvidenceAbsence,
                locale,
              )}
            />
            <Fact
              label={t("Startup overhead beyond configured delay")}
              value={formatDurationSeconds(
                preparation?.startupOverheadSeconds,
                timingEvidenceAbsence,
                locale,
              )}
            />
            <Fact
              label={t("Time until checkout attempts begin")}
              value={formatDurationSeconds(
                preparation?.totalPreparationSeconds,
                timingEvidenceAbsence,
                locale,
              )}
            />
            <Fact
              label={t("Response latency ({v0}; mean)", {
                v0: rateWindowLabel(liveTrafficMetricWindowSeconds, locale),
              })}
              value={
                latencyMetric
                  ? formatMetric(
                      latencyMetric.value,
                      latencyMetric.unit,
                      t("not measurable"),
                      locale,
                    )
                  : loadGeneratorEvidenceAbsence
              }
            />
            <Fact
              label={t("HTTP failure rate ({v0}; {v1})", {
                v0: rateWindowLabel(liveTrafficMetricWindowSeconds, locale),
                v1: String(t(publicVocabulary.httpFailurePopulation)),
              })}
              value={
                failureRateMetric
                  ? formatFailureSample(failureRateMetric.value, failureRateMetric.unit, locale)
                  : loadGeneratorEvidenceAbsence
              }
            />
            {reservationThroughput ? (
              <>
                <Fact
                  label={t("Peak reservation rate ({v0}; {v1})", {
                    v0: String(rateWindowLabel(reservationThroughput.peakWindowSeconds, locale)),
                    v1: String(
                      trailingRateWindowLabel(reservationThroughput.windowSeconds, locale),
                    ),
                  })}
                  value={formatRate(
                    reservationThroughput.peakRatePerSecond,
                    "reservations/s",
                    undefined,
                    locale,
                  )}
                />
                <Fact
                  label={t("Reservations in {v0}", {
                    v0: String(
                      trailingRateWindowLabel(reservationThroughput.windowSeconds, locale),
                    ),
                  })}
                  value={formatNumber(reservationThroughput.successfulReservationCount, locale)}
                />
              </>
            ) : null}
            <Fact
              label={t(publicVocabulary.soldOutRejectionsRecorded)}
              value={
                inventory
                  ? formatNumber(inventory.soldOutPressure.rejectionCount, locale)
                  : runEvidenceAbsence(
                      runStatus,
                      {
                        source: "durable-processing",
                        pending: t("Waiting for inventory evidence"),
                        settled: t("Not recorded for this run"),
                      },
                      locale,
                    )
              }
            />
          </dl>
          <p className="mb-0 mt-3 text-xs leading-5 text-muted">
            {t(
              "Arrival counts checkout attempts when the load generator starts them. Response completion and latency are separate HTTP observations aggregated per",
            )}{" "}
            {rateWindowLabel(liveTrafficMetricWindowSeconds, locale)}
            {t("; failure observations use the same window over")}{" "}
            {t(publicVocabulary.httpFailurePopulation)}.
          </p>
          {requestSurge &&
          (data.requestArrivalSummary !== null || requestSurge.arrivalRateSeries.length > 0) ? (
            <RequestArrivalRateSeries
              emptyText={runEvidenceAbsence(
                runStatus,
                {
                  source: "load-generator",
                  pending: t("No completed arrival windows yet."),
                  settled: t("No arrival windows were recorded for this run."),
                },
                locale,
              )}
              samples={requestSurge.arrivalRateSeries}
            />
          ) : null}
          {transportAttemptCounts && httpSummary ? (
            <TransportObservationPanelBlock
              counts={transportAttemptCounts}
              httpSummary={httpSummary}
            />
          ) : (
            <p className="mb-0 mt-3 text-xs leading-5 text-muted">
              {runEvidenceAbsence(
                runStatus,
                {
                  source: "load-generator",
                  pending: t(
                    "Final request totals appear here once all planned attempts have been dispatched.",
                  ),
                  settled: t("Final request totals were not recorded for this run."),
                },
                locale,
              )}
            </p>
          )}
        </>
      ) : (
        <UnavailableState read={recovery} />
      )}
    </section>
  );
}

export function findLatestMetric(
  metrics: DashboardProjection["recentMetrics"],
  predicate: (metricName: string, unit: string) => boolean,
): DashboardProjection["recentMetrics"][number] | null {
  for (let index = metrics.length - 1; index >= 0; index -= 1) {
    const metric = metrics[index];

    if (metric && predicate(metric.metricName, metric.unit)) {
      return metric;
    }
  }

  return null;
}

export function InventoryDrainPanel({
  recovery,
  presentation,
  freshness,
}: {
  recovery: BackendRead<DashboardProjection>;
  presentation: PresentationState;
  freshness: Freshness;
}) {
  const t = useTranslation();
  const locale = useLocale();
  const data = recoveryData(recovery);
  const inventory = data?.inventory ?? null;
  const percentRemaining =
    inventory && inventory.allocatedStock > 0
      ? Math.round((inventory.remainingStock / inventory.allocatedStock) * 100)
      : 0;

  return (
    <section className={panelFullClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>{t("Inventory drain")}</p>
          <h2 className={panelTitleClassName}>{t("Inventory")}</h2>
        </div>
        <StatusPill status={presentation} />
      </div>
      {inventory ? (
        <>
          <FreshnessLine freshness={freshness} />
          <meter
            aria-label={t("Remaining inventory")}
            className="meter mb-4 block h-2 w-full rounded-full border-0 bg-surface-muted"
            max={100}
            min={0}
            value={percentRemaining}
          />
          <dl className={factGridClassName}>
            <Fact
              label={t("Starting stock")}
              value={formatNumber(inventory.allocatedStock, locale)}
            />
            <Fact label={t("Remaining")} value={formatNumber(inventory.remainingStock, locale)} />
            <Fact label={t("Reserved")} value={formatNumber(inventory.reservedStock, locale)} />
            <Fact
              label={t(publicVocabulary.pendingReservations)}
              value={formatNumber(inventory.pendingPersistenceCount, locale)}
            />
            <Fact
              label={t(publicVocabulary.expiredReservations)}
              value={formatNumber(inventory.expiredReservationCount, locale)}
            />
            <Fact
              label={t("Oldest pending")}
              value={formatDurationSeconds(
                inventory.oldestPendingPersistenceAgeSeconds,
                undefined,
                locale,
              )}
            />
            <Fact
              label={t("Stock last changed")}
              value={formatExpectedTime(inventory.lastUpdatedAt, locale)}
              small
            />
            <Fact
              label={t("Stock observed")}
              value={formatExpectedTime(inventory.observedAt, locale)}
              small
            />
          </dl>
        </>
      ) : (
        <EmptyState>
          {runEvidenceAbsence(
            data?.currentRun?.status ?? null,
            {
              source: "durable-processing",
              pending: t("No inventory evidence yet."),
              settled: t("Inventory evidence is unavailable for this run."),
            },
            locale,
          )}
        </EmptyState>
      )}
    </section>
  );
}

export function RunErpOutcomesPanel({
  recovery,
  presentation,
  freshness,
}: {
  recovery: BackendRead<DashboardProjection>;
  presentation: PresentationState;
  freshness: Freshness;
}) {
  const t = useTranslation();
  const locale = useLocale();
  const data = recoveryData(recovery);
  const erp = data?.erp ?? null;
  const runStatus = data?.currentRun?.status ?? null;

  return (
    <section className={panelHalfClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>{t("This run")}</p>
          <h2 className={panelTitleClassName}>{t("Simulated ERP outcomes")}</h2>
        </div>
        <StatusPill status={presentation} />
      </div>
      {erp ? (
        <>
          <FreshnessLine freshness={freshness} />
          <ErpStoryLead
            caption={t("Attempts, failures, and timeouts over the last {v0}s.", {
              v0: String(formatWindowSeconds(erp.recentAttemptWindowSeconds, locale)),
            })}
            story={deriveRunErpStory(erp, locale)}
          />
          <dl className={factGridClassName}>
            <Fact
              label={t("Recent attempts")}
              value={formatNumber(erp.recentAttemptCount, locale)}
            />
            <Fact
              label={t("Failures")}
              value={
                erp.recentFailureCount > 0 && data?.businessOutcome?.failedOrders === 0
                  ? t("{v0} (retried; no order failed)", {
                      v0: String(formatNumber(erp.recentFailureCount, locale)),
                    })
                  : formatNumber(erp.recentFailureCount, locale)
              }
            />
            <Fact label={t("Timeouts")} value={formatNumber(erp.recentTimeoutCount, locale)} />
            <Fact
              label={t("Latest attempt")}
              value={
                erp.latestAttempt
                  ? t("{v0} at {v1}", {
                      v0: String(erpAttemptStatusLabel(erp.latestAttempt.status, locale)),
                      v1: String(formatExpectedTime(erp.latestAttempt.finishedAt, locale)),
                    })
                  : runEvidenceAbsence(
                      runStatus,
                      {
                        source: "durable-processing",
                        pending: t("not yet available"),
                        settled: t("No attempt was recorded for this run"),
                      },
                      locale,
                    )
              }
              small
            />
          </dl>
        </>
      ) : (
        <EmptyState>
          {runEvidenceAbsence(
            runStatus,
            {
              source: "durable-processing",
              pending: t("No simulated ERP evidence yet."),
              settled: t("Simulated ERP evidence is unavailable for this run."),
            },
            locale,
          )}
        </EmptyState>
      )}
    </section>
  );
}

export function SystemStatusPanel({ recovery }: { recovery: BackendRead<DashboardProjection> }) {
  const t = useTranslation();
  const locale = useLocale();
  const data = recoveryData(recovery);
  const queue = data?.systemStatus?.queue ?? null;
  // This mode queues its orders in PostgreSQL, where BullMQ's counts would show none of them.
  const postgresQueue = data?.currentRun?.comparison?.mode === "postgres";
  const progress = data?.runtimeProgress ?? null;

  return (
    <section className={panelFullClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>{t("Shared demo runtime")}</p>
          <h2 className={panelTitleClassName}>{t("Physical order queue")}</h2>
          <p className="m-0 mt-1 text-xs text-muted">
            {postgresQueue
              ? t(
                  "In this run the order queue is in PostgreSQL: each order not yet confirmed waits there, counted from the run's order records.",
                )
              : t(
                  "Live BullMQ counts for the one shared order queue; global technical context, not evidence for the selected run.",
                )}
          </p>
        </div>
      </div>
      {postgresQueue ? (
        <dl className={factGridClassName}>
          <Fact
            label={t("Orders waiting or being confirmed")}
            value={formatNumber(progress?.outstandingOrders, locale)}
          />
          <Fact
            label={t("Oldest wait")}
            value={formatDurationSeconds(progress?.oldestOutstandingAgeSeconds, undefined, locale)}
          />
          <Fact
            label={t("Last updated")}
            value={formatExpectedTime(progress?.observedAt, locale)}
            small
          />
        </dl>
      ) : queue ? (
        <>
          <h3 className="mb-3 mt-0 text-sm font-bold text-ink">
            {t("Shared order-processing backlog")}
          </h3>
          <dl className={factGridClassName}>
            <Fact
              label={t("Connectivity")}
              value={queueConnectivityLabel(queue.connectivity, locale)}
            />
            <Fact label={t("Depth (all runs)")} value={formatNumber(queue.depth, locale)} />
            <Fact
              label={t("Oldest wait")}
              value={formatDurationSeconds(queue.oldestWaitingAgeSeconds, undefined, locale)}
            />
            <Fact
              label={t("Last updated")}
              value={formatExpectedTime(queue.observedAt, locale)}
              small
            />
          </dl>
          <details className="mt-3 rounded border border-border px-3 py-2 text-sm">
            <summary className="disclosure font-semibold text-ink">{t("Backlog details")}</summary>
            <dl className={factGridClassName}>
              <Fact label={t("Waiting")} value={formatNumber(queue.counts.waiting, locale)} />
              <Fact
                label={t("Prioritized")}
                value={formatNumber(queue.counts.prioritized, locale)}
              />
              <Fact label={t("Paused")} value={formatNumber(queue.counts.paused, locale)} />
              <Fact label={t("Delayed")} value={formatNumber(queue.counts.delayed, locale)} />
              <Fact label={t("Active")} value={formatNumber(queue.counts.active, locale)} />
            </dl>
          </details>
          <p className="mb-0 mt-3 text-xs leading-5 text-muted">
            {t("Counts include work from all runs and visitors.")}
          </p>
        </>
      ) : (
        <EmptyState>{t("Shared demo-runtime status is unavailable.")}</EmptyState>
      )}
    </section>
  );
}

export function ConsistencyLagPanel({
  recovery,
  presentation,
  freshness,
}: {
  recovery: BackendRead<DashboardProjection>;
  presentation: PresentationState;
  freshness: Freshness;
}) {
  const t = useTranslation();
  const locale = useLocale();
  const data = recoveryData(recovery);
  const lag = data?.consistencyLag ?? null;
  const lagAbsence = runEvidenceAbsence(
    data?.currentRun?.status ?? null,
    {
      source: "durable-processing",
      pending: t("not yet available"),
      settled: t("Not recorded for this run"),
    },
    locale,
  );
  // A distribution over zero confirmations has no reading, so it states the absence of
  // confirmations rather than the absence of the measurement. "Yet" may only promise evidence that
  // can still arrive, so the lifecycle decides the wording; a pre-run zero is never called settled.
  const distributionAbsence =
    lag?.confirmedOrderCount === 0
      ? runEvidenceAbsence(
          data?.currentRun?.status ?? null,
          {
            source: "durable-processing",
            pending: t("No confirmations yet"),
            settled: t("No confirmations were recorded for this run"),
          },
          locale,
        )
      : lagAbsence;

  return (
    <section className={panelHalfClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>{t(publicVocabulary.consistencyLag)}</p>
          <h2 className={panelTitleClassName}>{t("Fast reservation vs final confirmation")}</h2>
          <p className="m-0 mt-1 text-xs text-muted">{t(lagMeasurementBoundaryCaption)}</p>
        </div>
        <StatusPill status={presentation} />
      </div>
      {lag ? (
        <>
          <FreshnessLine freshness={freshness} />
          <dl className={factGridClassName}>
            <Fact
              label={t("95% confirmed within")}
              value={formatMilliseconds(lag.p95LagMs, distributionAbsence, locale)}
            />
            <Fact
              label={t("Average")}
              value={formatMilliseconds(lag.averageLagMs, distributionAbsence, locale)}
            />
            <Fact
              label={t("Longest")}
              value={formatMilliseconds(lag.maxLagMs, distributionAbsence, locale)}
            />
            <Fact
              label={t("Awaiting confirmation")}
              value={formatNumber(lag.pendingConfirmationCount, locale)}
            />
            <Fact
              label={t("Oldest pending")}
              value={formatDurationSeconds(lag.oldestPendingAgeSeconds, undefined, locale)}
            />
            <Fact label={t("Confirmed")} value={formatNumber(lag.confirmedOrderCount, locale)} />
            <Fact label={t("Measured")} value={formatExpectedTime(lag.measuredAt, locale)} />
          </dl>
        </>
      ) : (
        <EmptyState>
          {runEvidenceAbsence(
            data?.currentRun?.status ?? null,
            {
              source: "durable-processing",
              pending: t("No confirmation evidence yet."),
              settled: t("Confirmation evidence is unavailable for this run."),
            },
            locale,
          )}
        </EmptyState>
      )}
    </section>
  );
}

export function RunOutcomesPanel({
  recovery,
  presentation,
  freshness,
}: {
  recovery: BackendRead<DashboardProjection>;
  presentation: PresentationState;
  freshness: Freshness;
}) {
  const t = useTranslation();
  const locale = useLocale();
  const data = recoveryData(recovery);
  const outcome = data?.businessOutcome ?? null;

  return (
    <section className={panelFullClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>{t(durableCheckoutLens.title)}</p>
          <h2 className={panelTitleClassName}>{t("Reservation and confirmation summary")}</h2>
          <p className="m-0 mt-1 text-xs text-muted">{t(durableCheckoutLens.caption)}</p>
        </div>
        <StatusPill status={presentation} />
      </div>
      {outcome ? (
        <>
          <FreshnessLine freshness={freshness} />
          <dl className={wideFactGridClassName}>
            <Fact
              label={t(publicVocabulary.uniqueReservationsSecured)}
              value={formatNumber(outcome.acceptedReservations, locale)}
            />
            <Fact
              label={t(publicVocabulary.soldOutRejectionsRecorded)}
              value={formatNumber(outcome.soldOutRejections, locale)}
            />
            <Fact
              label={t("Queued (awaiting first processing start)")}
              value={formatNumber(outcome.queuedOrders, locale)}
            />
            <Fact label={t("Processing")} value={formatNumber(outcome.processingOrders, locale)} />
            <Fact label={t("Retrying")} value={formatNumber(outcome.retryingOrders, locale)} />
            <Fact label={t("Confirmed")} value={formatNumber(outcome.confirmedOrders, locale)} />
            <Fact label={t("Failed")} value={formatNumber(outcome.failedOrders, locale)} />
            <Fact
              label={t(publicVocabulary.pendingReservations)}
              value={formatNumber(outcome.pendingPersistenceCount, locale)}
            />
            <Fact
              label={t(publicVocabulary.notifications)}
              value={formatNumber(outcome.notificationsRecorded, locale)}
            />
          </dl>
        </>
      ) : (
        <EmptyState>
          {runEvidenceAbsence(
            data?.currentRun?.status ?? null,
            {
              source: "durable-processing",
              pending: t("No checkout outcome evidence yet."),
              settled: t("Checkout outcome evidence is unavailable for this run."),
            },
            locale,
          )}
        </EmptyState>
      )}
    </section>
  );
}
