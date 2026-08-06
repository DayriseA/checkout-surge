import type { DashboardProjection } from "@checkout-surge/contracts";
import type { ReactNode } from "react";
import type { BackendRead } from "../lib/api";
import { projectRequestSurge } from "../lib/dashboard-projection-state";
import {
  deriveRunErpStory,
  deriveSharedErpStory,
  type ErpStory,
} from "../lib/presentation/erp-story";
import {
  formatCount,
  formatDurationMs,
  formatInstantUtc,
  formatWindowSeconds,
} from "../lib/presentation/format";
import type { Freshness, RealtimeConnectionStatus } from "../lib/presentation/freshness";
import {
  circuitStateLabel,
  durableCheckoutLens,
  erpAttemptStatusLabel,
  liveTrafficMetricWindowSeconds,
  liveTrafficWindowLabel,
  protectionReasonLabel,
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
import { ErrorNotice } from "./error-notice";
import { StatusPill } from "./status-pill";
import {
  deriveHarnessPreparation,
  RequestArrivalRateSeries,
  TransportObservationPanelBlock,
} from "./transport-observation";

export type { RealtimeConnectionStatus } from "../lib/presentation/freshness";

const panelClassName =
  "min-w-0 rounded-lg border border-border bg-surface p-4 max-[900px]:col-span-full";
const panelNarrowClassName = `${panelClassName} col-span-4`;
/** Two half-width panels pair into one full row instead of orphaning a third of the grid. */
const panelHalfClassName = `${panelClassName} col-span-6`;
const panelWideClassName = `${panelClassName} col-span-8`;
const panelFullClassName = `${panelClassName} col-span-12`;
const panelHeaderClassName = "mb-4 flex items-start justify-between gap-3";
const eyebrowClassName = "m-0 text-xs font-bold uppercase text-muted";
const panelTitleClassName = "m-0 mt-1 text-base font-bold leading-tight text-ink";
const emptyStateClassName = "m-0 leading-6 text-muted";
const factGridClassName = "m-0 grid grid-cols-3 gap-3 max-[560px]:grid-cols-2";
const wideFactGridClassName =
  "m-0 grid grid-cols-6 gap-3 max-[700px]:grid-cols-3 max-[480px]:grid-cols-2";
const stackedFactGridClassName = "m-0 grid gap-3";
const factItemClassName = "min-w-0";
const leadSentenceClassName = "m-0 mb-1 text-base font-bold leading-6 text-ink";
const leadDetailClassName = "m-0 mb-3 text-xs leading-5 text-muted";
const factTermClassName = "mb-1 text-xs font-bold text-muted";
const factValueClassName = "m-0 [overflow-wrap:anywhere] text-base font-bold text-ink";
const smallValueClassName = "m-0 [overflow-wrap:anywhere] text-sm font-semibold text-ink";
const controlButtonClassName =
  "min-h-10 rounded-lg border border-border bg-surface px-3.5 py-2.5 font-semibold text-muted-strong disabled:cursor-not-allowed disabled:opacity-60";

/** The unit tag carried by load-generator latency samples. */
const millisecondUnit = "ms";

/**
 * The lag producer owns this measurement; the panel only names its boundaries so a reader knows
 * which interval the distribution below describes. It is not the checkout-response boundary.
 */
const lagMeasurementBoundaryCaption =
  "Measured from the moment a reservation is secured to final simulated-ERP confirmation.";

/**
 * Both simulated-ERP surfaces carry clocks from two different producers with two different update
 * meanings: the circuit breaker's edge-triggered state clocks, which move only when protection
 * changes, and the API projection's poll clock, which moves on every read. Labelling them by
 * producer keeps them from reading as one synchronized set of run timestamps.
 */
const protectionClockLabel = {
  pauseBegan: "Protection pause began (reported by circuit breaker)",
  /**
   * Not a scheduled check: the breaker books nothing, and only an incoming call can move it out of
   * the paused state. This is the earliest time such a call would be allowed through.
   */
  retryEligibleFrom: "Calls can be retried from (per circuit breaker)",
  stateChanged: "Protection state changed (reported by circuit breaker)",
  projected: "Projected by API at",
} as const;

function formatNumber(value: number): string {
  return formatCount(value) ?? "—";
}

/** Rates are not counts or durations; they keep their own precision rule and unit label. */
function formatRate(value: number | null | undefined, unit: string, absent = "—"): string {
  if (value === null || value === undefined) {
    return absent;
  }

  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value < 10 ? 2 : 1,
  }).format(value)} ${unit}`;
}

function formatExpectedTime(value: string | undefined | null): string {
  return formatInstantUtc(value) ?? "not yet available";
}

function formatScheduledTime(value: string | undefined | null): string {
  return formatInstantUtc(value) ?? "not scheduled";
}

function formatDurationSeconds(value: number | null | undefined, absent = "—"): string {
  return formatDurationMs(value === null || value === undefined ? null : value * 1000) ?? absent;
}

function formatMilliseconds(value: number | null | undefined, absent = "—"): string {
  return formatDurationMs(value) ?? absent;
}

/**
 * A metric sample carries its own unit. A millisecond sample is an elapsed measurement, so it
 * follows the one duration policy rather than the sample's raw precision; every other unit is a
 * rate or a ratio and keeps its own precision rule and unit label.
 */
function formatMetric(value: number, unit: string, absent = "—"): string {
  if (unit === millisecondUnit) {
    return formatDurationMs(value) ?? absent;
  }

  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value < 10 ? 2 : 1,
  }).format(value)} ${unit}`;
}

function formatFailureSample(value: number, unit: string): string {
  return unit === "ratio"
    ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value * 100)}%`
    : formatMetric(value, unit);
}

function formatObservedRequestRate(value: number): string {
  return formatRate(value, "attempts/s");
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
  return (
    <div className={factItemClassName}>
      <dt className={factTermClassName}>{label}</dt>
      <dd className={small ? smallValueClassName : factValueClassName}>{value}</dd>
    </div>
  );
}

/**
 * The lead of both simulated-ERP surfaces: one sentence a visitor can read without knowing what a
 * circuit breaker is, and the next action only when one exists. `caption` states a measurement
 * window once for the facts below, so no individual count has to repeat it.
 */
function ErpStoryLead({ story, caption }: { story: ErpStory; caption?: string }) {
  return (
    <>
      <p className={leadSentenceClassName}>{story.sentence}</p>
      {story.nextAction ? <p className={leadDetailClassName}>{story.nextAction}</p> : null}
      {caption ? <p className={leadDetailClassName}>{caption}</p> : null}
    </>
  );
}

function FreshnessLine({ freshness }: { freshness: Freshness }) {
  // Retained and stale states can show an observation from an earlier calendar day, so this
  // line always carries the full dated UTC form rather than a bare clock reading. Like both
  // history routes, it keeps the exact ISO value in `<time dateTime>`; the reading and the
  // machine value derive from the same server-supplied string under a fixed zone, so server
  // rendering and hydration cannot disagree.
  const reading = formatInstantUtc(freshness.observedAt);
  const updated: ReactNode =
    reading === null ? (
      "an unrecorded time"
    ) : (
      <time dateTime={freshness.observedAt}>{reading}</time>
    );
  const notApplicable = freshness.final ? (
    <>Final, as of {updated}</>
  ) : (
    <>As of {updated} · no active run</>
  );
  const copy: Record<Freshness["state"], ReactNode> = {
    connecting: <>Updated {updated} · connecting to live updates</>,
    disconnected: <>Updated {updated} · disconnected, showing last known values</>,
    live: <>Updated {updated} · live</>,
    "not-applicable": notApplicable,
    "retained-fresh": <>Updated {updated} · connected, no update expected</>,
    stale: <>Updated {updated} · stale, showing last known values</>,
    unsupported: <>Updated {updated} · live updates unsupported</>,
  };

  return <p className="m-0 mb-3 text-xs leading-5 text-muted">{copy[freshness.state]}</p>;
}

export function RecoveryStatusPanel({
  recovery,
  realtimeStatus,
  isRefreshing = false,
  isRetryScheduled = false,
  retryAttempt = 0,
  retryDelayMs = null,
  hasSyncIssue = false,
  syncIssue = null,
  presentation,
  freshness,
  onRefresh,
}: {
  recovery: BackendRead<DashboardProjection>;
  realtimeStatus: RealtimeConnectionStatus;
  isRefreshing?: boolean;
  isRetryScheduled?: boolean;
  retryAttempt?: number;
  retryDelayMs?: number | null;
  hasSyncIssue?: boolean;
  syncIssue?: Extract<BackendRead<DashboardProjection>, { status: "unavailable" }> | null;
  presentation: PresentationState;
  freshness?: Freshness;
  onRefresh?: () => void;
}) {
  const data = recoveryData(recovery);
  const run = data?.currentRun ?? null;
  const hasLastKnownGoodSyncIssue = data !== null && hasSyncIssue;
  const retryWaitActive =
    (recovery.status === "unavailable" && (recovery.retryAfterMs ?? 0) > 0) ||
    (syncIssue?.retryAfterMs ?? 0) > 0;

  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Current state</p>
          <h2 className={panelTitleClassName}>Run availability and updates</h2>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {onRefresh && recovery.status !== "loading" && !retryWaitActive ? (
            <button
              className={`${controlButtonClassName} min-h-9 px-3 py-2 text-sm`}
              disabled={isRefreshing}
              onClick={onRefresh}
              type="button"
            >
              {isRefreshing ? "Refreshing" : "Refresh"}
            </button>
          ) : null}
          <StatusPill
            status={{
              ...presentation,
              label: publicStatusLabel({
                family: "run",
                status: run?.status ?? "starting",
                displayLabel: presentation.label,
              }),
            }}
          />
        </div>
      </div>
      {hasLastKnownGoodSyncIssue ? (
        <div className="mb-3 grid gap-1 rounded-lg border border-border bg-surface-muted p-3 leading-6 text-muted-strong">
          <strong>Last-known-good data</strong>
          <div>
            {isRefreshing
              ? "Refreshing the latest run data now."
              : isRetryScheduled && retryDelayMs !== null
                ? `Retry scheduled in ${formatMilliseconds(retryDelayMs)} (attempt ${retryAttempt}).`
                : "The latest authoritative data is unavailable."}
          </div>
          {syncIssue ? <ErrorNotice context="watch-read" read={syncIssue} /> : null}
        </div>
      ) : null}
      {data ? (
        <>
          {freshness ? <FreshnessLine freshness={freshness} /> : null}
          <dl className={stackedFactGridClassName}>
            <Fact label="Current scenario" value={run ? run.presetName : "No run has started"} />
            <Fact
              label="Run"
              value={run ? runLifecycleStatusLabel(run.status) : "No run has started"}
            />
            <Fact
              label="Load generator"
              value={run ? trafficExecutionStatusLabel(run.trafficStatus) : "No run has started"}
            />
          </dl>
          <p className="m-0 mt-3 text-xs leading-5 text-muted">Updates {realtimeStatus}</p>
        </>
      ) : (
        <UnavailableState read={recovery} />
      )}
    </section>
  );
}

export function RequestSurgePanel({
  recovery,
  freshness,
}: {
  recovery: BackendRead<DashboardProjection>;
  freshness: Freshness;
}) {
  const data = recoveryData(recovery);
  if (data && data.currentRun === null) {
    return (
      <section className={panelWideClassName}>
        <div className={panelHeaderClassName}>
          <div>
            <p className={eyebrowClassName}>Request surge</p>
            <h2 className={panelTitleClassName}>Traffic arrival and responses</h2>
          </div>
          <StatusPill status={deriveFreshnessPresentationState(freshness)} />
        </div>
        <EmptyState>No run has started.</EmptyState>
      </section>
    );
  }
  const inventory = data?.inventory ?? null;
  const runStatus = data?.currentRun?.status ?? null;
  // Every fact in this panel is load-generator evidence, so all of it is final once traffic ends.
  const loadGeneratorEvidenceAbsence = runEvidenceAbsence(runStatus, {
    source: "load-generator",
    pending: "Waiting for the load generator",
    settled: "Not recorded for this run",
  });
  const timingEvidenceAbsence = runEvidenceAbsence(runStatus, {
    source: "load-generator",
    pending: "not yet available",
    settled: "Not recorded for this run",
  });
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
          <p className={eyebrowClassName}>Request surge</p>
          <h2 className={panelTitleClassName}>Traffic arrival and responses</h2>
        </div>
        <StatusPill status={deriveFreshnessPresentationState(freshness)} />
      </div>
      {data ? (
        <>
          <FreshnessLine freshness={freshness} />
          <dl className={factGridClassName}>
            <Fact
              label={
                requestSurge?.arrivalRateIsPeak
                  ? `Peak request arrival rate (${rateWindowLabel(requestSurge.arrivalWindowSeconds)})`
                  : `Request arrival rate (${rateWindowLabel(requestSurge?.arrivalWindowSeconds ?? liveTrafficMetricWindowSeconds)})`
              }
              value={
                requestSurge?.arrivalRatePerSecond !== null &&
                requestSurge?.arrivalRatePerSecond !== undefined
                  ? formatObservedRequestRate(requestSurge.arrivalRatePerSecond)
                  : loadGeneratorEvidenceAbsence
              }
            />
            <Fact
              label="Attempts dispatched"
              value={
                requestSurge?.attemptsDispatched === null ||
                requestSurge?.attemptsDispatched === undefined
                  ? loadGeneratorEvidenceAbsence
                  : formatNumber(requestSurge.attemptsDispatched)
              }
            />
            <Fact
              label="Dispatch duration"
              value={formatDurationSeconds(
                requestSurge?.dispatchDurationSeconds,
                timingEvidenceAbsence,
              )}
            />
            <Fact
              label={`Response completion rate (${liveTrafficWindowLabel})`}
              value={formatRate(
                requestSurge?.responseCompletionRatePerSecond,
                "responses/s",
                timingEvidenceAbsence,
              )}
            />
            <Fact
              label="Configured start delay"
              value={formatDurationSeconds(
                preparation?.configuredDelaySeconds,
                timingEvidenceAbsence,
              )}
            />
            <Fact
              label="Time until checkout attempts begin"
              value={formatDurationSeconds(
                preparation?.remainingPreparationSeconds,
                timingEvidenceAbsence,
              )}
            />
            <Fact
              label={`Response latency (${liveTrafficWindowLabel}; mean)`}
              value={
                latencyMetric
                  ? formatMetric(latencyMetric.value, latencyMetric.unit, "not measurable")
                  : loadGeneratorEvidenceAbsence
              }
            />
            <Fact
              label={`HTTP failure rate (${liveTrafficWindowLabel}; ${publicVocabulary.httpFailurePopulation})`}
              value={
                failureRateMetric
                  ? formatFailureSample(failureRateMetric.value, failureRateMetric.unit)
                  : loadGeneratorEvidenceAbsence
              }
            />
          </dl>
          <dl className={stackedFactGridClassName}>
            {reservationThroughput ? (
              <>
                <Fact
                  label={`Peak reservation rate (${rateWindowLabel(reservationThroughput.peakWindowSeconds)}; ${trailingRateWindowLabel(reservationThroughput.windowSeconds)})`}
                  value={formatRate(reservationThroughput.peakRatePerSecond, "reservations/s")}
                />
                <Fact
                  label={`Reservations in ${trailingRateWindowLabel(reservationThroughput.windowSeconds)}`}
                  value={formatNumber(reservationThroughput.successfulReservationCount)}
                />
              </>
            ) : null}
            <Fact
              label={publicVocabulary.soldOutRejectionsRecorded}
              value={
                inventory
                  ? formatNumber(inventory.soldOutPressure.rejectionCount)
                  : runEvidenceAbsence(runStatus, {
                      source: "durable-processing",
                      pending: "Waiting for inventory evidence",
                      settled: "Not recorded for this run",
                    })
              }
            />
          </dl>
          <p className="mb-0 mt-3 text-xs leading-5 text-muted">
            Arrival counts checkout attempts when the load generator starts them. Response
            completion and latency are separate HTTP observations aggregated per{" "}
            {liveTrafficWindowLabel}; failure observations use the same window over{" "}
            {publicVocabulary.httpFailurePopulation}.
          </p>
          {requestSurge &&
          (data.requestArrivalSummary !== null || requestSurge.arrivalRateSeries.length > 0) ? (
            <RequestArrivalRateSeries
              emptyText={runEvidenceAbsence(runStatus, {
                source: "load-generator",
                pending: "No completed arrival windows yet.",
                settled: "No arrival windows were recorded for this run.",
              })}
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
              {runEvidenceAbsence(runStatus, {
                source: "load-generator",
                pending:
                  "Final request totals appear here once all planned attempts have been dispatched.",
                settled: "Final request totals were not recorded for this run.",
              })}
            </p>
          )}
        </>
      ) : (
        <UnavailableState read={recovery} />
      )}
    </section>
  );
}

function findLatestMetric(
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
  const data = recoveryData(recovery);
  const inventory = data?.inventory ?? null;
  const percentRemaining =
    inventory && inventory.allocatedStock > 0
      ? Math.round((inventory.remainingStock / inventory.allocatedStock) * 100)
      : 0;

  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Inventory drain</p>
          <h2 className={panelTitleClassName}>Inventory</h2>
        </div>
        <StatusPill status={presentation} />
      </div>
      {inventory ? (
        <>
          <FreshnessLine freshness={freshness} />
          <meter
            aria-label="Remaining inventory"
            className="meter mb-4 block h-2 w-full rounded-full border-0 bg-surface-muted"
            max={100}
            min={0}
            value={percentRemaining}
          />
          <dl className={factGridClassName}>
            <Fact label="Starting stock" value={formatNumber(inventory.allocatedStock)} />
            <Fact label="Remaining" value={formatNumber(inventory.remainingStock)} />
            <Fact label="Reserved" value={formatNumber(inventory.reservedStock)} />
            <Fact
              label={publicVocabulary.pendingReservations}
              value={formatNumber(inventory.pendingPersistenceCount)}
            />
            <Fact
              label={publicVocabulary.expiredReservations}
              value={formatNumber(inventory.expiredReservationCount)}
            />
            <Fact
              label="Oldest pending"
              value={formatDurationSeconds(inventory.oldestPendingPersistenceAgeSeconds)}
            />
            <Fact
              label="Stock last changed"
              value={formatExpectedTime(inventory.lastUpdatedAt)}
              small
            />
            <Fact label="Stock observed" value={formatExpectedTime(inventory.observedAt)} small />
          </dl>
        </>
      ) : (
        <EmptyState>
          {runEvidenceAbsence(data?.currentRun?.status ?? null, {
            source: "durable-processing",
            pending: "No inventory evidence yet.",
            settled: "Inventory evidence is unavailable for this run.",
          })}
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
  const data = recoveryData(recovery);
  const erp = data?.erp ?? null;
  const runStatus = data?.currentRun?.status ?? null;

  return (
    <section className={panelHalfClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>This run</p>
          <h2 className={panelTitleClassName}>Simulated ERP outcomes</h2>
        </div>
        <StatusPill status={presentation} />
      </div>
      {erp ? (
        <>
          <FreshnessLine freshness={freshness} />
          <ErpStoryLead
            caption={`Attempts, failures, and timeouts over the last ${formatWindowSeconds(erp.recentAttemptWindowSeconds)}s.`}
            story={deriveRunErpStory(erp, runStatus)}
          />
          <dl className={factGridClassName}>
            <Fact label="Recent attempts" value={formatNumber(erp.recentAttemptCount)} />
            <Fact label="Failures" value={formatNumber(erp.recentFailureCount)} />
            <Fact label="Timeouts" value={formatNumber(erp.recentTimeoutCount)} />
            <Fact
              label="Latest attempt"
              value={
                erp.latestAttempt
                  ? `${erpAttemptStatusLabel(erp.latestAttempt.status)} at ${formatExpectedTime(erp.latestAttempt.finishedAt)}`
                  : runEvidenceAbsence(runStatus, {
                      source: "durable-processing",
                      pending: "not yet available",
                      settled: "No attempt was recorded for this run",
                    })
              }
              small
            />
          </dl>
          <details className="mt-3 rounded border border-border px-3 py-2 text-sm">
            <summary className="cursor-pointer font-semibold text-muted-strong">
              Protection details
            </summary>
            <dl className={factGridClassName}>
              <Fact
                label="Run protection"
                value={
                  erp.circuitReadStatus === "unavailable"
                    ? "Protection status unavailable"
                    : erp.circuit
                      ? circuitStateLabel(erp.circuit.state)
                      : // A successful read with no snapshot only proves that no protection state is
                        // retained now; run-scoped snapshots expire, so a settled run cannot claim
                        // that protection never engaged.
                        runEvidenceAbsence(runStatus, {
                          source: "durable-processing",
                          pending: "not yet exercised",
                          settled: "No protection state was retained for this run",
                        })
                }
              />
              <Fact
                label="Failures before protection pauses calls"
                value={erp.circuit ? formatNumber(erp.circuit.failureThreshold) : "—"}
              />
              <Fact
                label="Current failure streak"
                value={erp.circuit ? formatNumber(erp.circuit.consecutiveFailureCount) : "—"}
              />
              <Fact
                label="Recovery check delay"
                value={erp.circuit ? formatMilliseconds(erp.circuit.resetTimeoutMs) : "—"}
              />
              <Fact
                label={protectionClockLabel.pauseBegan}
                value={formatScheduledTime(erp.circuit?.openedAt)}
                small
              />
              <Fact
                label={protectionClockLabel.retryEligibleFrom}
                value={formatScheduledTime(erp.circuit?.nextAttemptAt)}
                small
              />
              <Fact
                label={protectionClockLabel.stateChanged}
                value={formatExpectedTime(erp.circuit?.lastChangedAt)}
                small
              />
              <Fact
                label={protectionClockLabel.projected}
                value={formatExpectedTime(erp.observedAt)}
                small
              />
            </dl>
          </details>
          <p className="mb-0 mt-3 text-xs leading-5 text-muted">
            Protection is scoped to this run. Its state changes only when calls pause, recovery is
            tested, or normal operation resumes.
          </p>
        </>
      ) : (
        <EmptyState>
          {runEvidenceAbsence(runStatus, {
            source: "durable-processing",
            pending: "No simulated ERP evidence yet.",
            settled: "Simulated ERP evidence is unavailable for this run.",
          })}
        </EmptyState>
      )}
    </section>
  );
}

export function SystemStatusPanel({
  recovery,
  presentation,
  erpPresentation,
}: {
  recovery: BackendRead<DashboardProjection>;
  presentation: PresentationState;
  erpPresentation: PresentationState;
}) {
  const systemStatus = recoveryData(recovery)?.systemStatus ?? null;
  const queue = systemStatus?.queue ?? null;
  const protection = systemStatus?.erpProtection ?? null;

  return (
    <section className={panelFullClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Shared demo runtime</p>
          <h2 className={panelTitleClassName}>System status across all runs and visitors</h2>
          <p className="m-0 mt-1 text-xs text-muted">
            Infrastructure readiness and protection below are global technical context, not evidence
            for the selected run.
          </p>
        </div>
        <StatusPill status={presentation} />
      </div>
      {queue && protection ? (
        <div className="grid grid-cols-2 gap-6 max-[760px]:grid-cols-1">
          <div>
            <h3 className="mb-3 mt-0 text-sm font-bold text-ink">
              Shared order-processing backlog
            </h3>
            <dl className={factGridClassName}>
              <Fact label="Connectivity" value={queueConnectivityLabel(queue.connectivity)} />
              <Fact label="Depth (all runs)" value={formatNumber(queue.depth)} />
              <Fact
                label="Oldest wait"
                value={formatDurationSeconds(queue.oldestWaitingAgeSeconds)}
              />
              <Fact label="Last updated" value={formatExpectedTime(queue.observedAt)} small />
            </dl>
            <details className="mt-3 rounded border border-border px-3 py-2 text-sm">
              <summary className="cursor-pointer font-semibold text-muted-strong">
                Backlog details
              </summary>
              <dl className={factGridClassName}>
                <Fact label="Waiting" value={formatNumber(queue.counts.waiting)} />
                <Fact label="Prioritized" value={formatNumber(queue.counts.prioritized)} />
                <Fact label="Paused" value={formatNumber(queue.counts.paused)} />
                <Fact label="Delayed" value={formatNumber(queue.counts.delayed)} />
                <Fact label="Active" value={formatNumber(queue.counts.active)} />
                <Fact label="Failed" value={formatNumber(queue.failedJobs.totalCount)} />
                <Fact
                  label="Retrying jobs"
                  value={formatNumber(queue.retryPressure.retryingJobCount)}
                />
                <Fact
                  label="Retry attempts"
                  value={formatNumber(queue.retryPressure.retryAttemptCount)}
                />
              </dl>
            </details>
            <p className="mb-0 mt-3 text-xs leading-5 text-muted">
              Counts include work from all runs and visitors.
            </p>
          </div>
          <div>
            <div className="mb-3 flex items-start justify-between gap-3">
              <h3 className="m-0 text-sm font-bold text-ink">Shared simulated ERP protection</h3>
              <StatusPill status={erpPresentation} />
            </div>
            <ErpStoryLead story={deriveSharedErpStory(protection)} />
            {/* Retry pressure earns a place in the main view only while it is real. A zero here
                would read as a fact about the shared runtime rather than as its absence. */}
            {protection.retryPressure.retryingJobCount > 0 ? (
              <dl className={factGridClassName}>
                <Fact
                  label="Retrying jobs"
                  value={formatNumber(protection.retryPressure.retryingJobCount)}
                />
              </dl>
            ) : null}
            <details className="mt-3 rounded border border-border px-3 py-2 text-sm">
              <summary className="cursor-pointer font-semibold text-muted-strong">
                Protection details
              </summary>
              <dl className={factGridClassName}>
                <Fact
                  label="Protection"
                  value={
                    protection.circuit
                      ? circuitStateLabel(protection.circuit.state)
                      : "not yet available"
                  }
                />
                <Fact
                  label="Protection note"
                  value={protectionReasonLabel(protection.reason)}
                  small
                />
                <Fact
                  label="Failures before protection pauses calls"
                  value={
                    protection.circuit
                      ? formatNumber(protection.circuit.failureThreshold)
                      : "not yet available"
                  }
                />
                <Fact
                  label="Current failure streak"
                  value={
                    protection.circuit
                      ? formatNumber(protection.circuit.consecutiveFailureCount)
                      : "not yet available"
                  }
                />
                <Fact
                  label="Recovery check delay"
                  value={formatMilliseconds(
                    protection.circuit?.resetTimeoutMs,
                    "not yet available",
                  )}
                />
                <Fact
                  label={protectionClockLabel.pauseBegan}
                  value={formatScheduledTime(protection.circuit?.openedAt)}
                  small
                />
                <Fact
                  label={protectionClockLabel.retryEligibleFrom}
                  value={formatScheduledTime(protection.circuit?.nextAttemptAt)}
                  small
                />
                <Fact
                  label={protectionClockLabel.stateChanged}
                  value={formatExpectedTime(protection.circuit?.lastChangedAt)}
                  small
                />
                <Fact
                  label={protectionClockLabel.projected}
                  value={formatExpectedTime(protection.observedAt)}
                  small
                />
                <Fact
                  label="Retry attempts"
                  value={formatNumber(protection.retryPressure.retryAttemptCount)}
                />
              </dl>
            </details>
            <p className="mb-0 mt-3 text-xs leading-5 text-muted">
              Protection changes only when calls pause, recovery is tested, or normal operation
              resumes.
            </p>
          </div>
        </div>
      ) : (
        <EmptyState>Shared demo-runtime status is unavailable.</EmptyState>
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
  const data = recoveryData(recovery);
  const lag = data?.consistencyLag ?? null;
  const lagAbsence = runEvidenceAbsence(data?.currentRun?.status ?? null, {
    source: "durable-processing",
    pending: "not yet available",
    settled: "Not recorded for this run",
  });
  // A distribution over zero confirmations has no reading, so it states the absence of
  // confirmations rather than the absence of the measurement. "Yet" may only promise evidence that
  // can still arrive, so the lifecycle decides the wording; a pre-run zero is never called settled.
  const distributionAbsence =
    lag?.confirmedOrderCount === 0
      ? runEvidenceAbsence(data?.currentRun?.status ?? null, {
          source: "durable-processing",
          pending: "No confirmations yet",
          settled: "No confirmations were recorded for this run",
        })
      : lagAbsence;

  return (
    <section className={panelHalfClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>{publicVocabulary.consistencyLag}</p>
          <h2 className={panelTitleClassName}>Fast reservation vs final confirmation</h2>
          <p className="m-0 mt-1 text-xs text-muted">{lagMeasurementBoundaryCaption}</p>
        </div>
        <StatusPill status={presentation} />
      </div>
      {lag ? (
        <>
          <FreshnessLine freshness={freshness} />
          <dl className={factGridClassName}>
            <Fact
              label="95% confirmed within"
              value={formatMilliseconds(lag.p95LagMs, distributionAbsence)}
            />
            <Fact
              label="Average"
              value={formatMilliseconds(lag.averageLagMs, distributionAbsence)}
            />
            <Fact label="Longest" value={formatMilliseconds(lag.maxLagMs, distributionAbsence)} />
            <Fact
              label="Awaiting confirmation"
              value={formatNumber(lag.pendingConfirmationCount)}
            />
            <Fact
              label="Oldest pending"
              value={formatDurationSeconds(lag.oldestPendingAgeSeconds)}
            />
            <Fact label="Confirmed" value={formatNumber(lag.confirmedOrderCount)} />
            <Fact label="Measured" value={formatExpectedTime(lag.measuredAt)} />
          </dl>
        </>
      ) : (
        <EmptyState>
          {runEvidenceAbsence(data?.currentRun?.status ?? null, {
            source: "durable-processing",
            pending: "No confirmation evidence yet.",
            settled: "Confirmation evidence is unavailable for this run.",
          })}
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
  const data = recoveryData(recovery);
  const outcome = data?.businessOutcome ?? null;

  return (
    <section className={panelFullClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>{durableCheckoutLens.title}</p>
          <h2 className={panelTitleClassName}>Reservation and confirmation summary</h2>
          <p className="m-0 mt-1 text-xs text-muted">{durableCheckoutLens.caption}</p>
        </div>
        <StatusPill status={presentation} />
      </div>
      {outcome ? (
        <>
          <FreshnessLine freshness={freshness} />
          <dl className={wideFactGridClassName}>
            <Fact
              label={publicVocabulary.uniqueReservationsSecured}
              value={formatNumber(outcome.acceptedReservations)}
            />
            <Fact
              label={publicVocabulary.soldOutRejectionsRecorded}
              value={formatNumber(outcome.soldOutRejections)}
            />
            <Fact
              label="Queued (awaiting first processing start)"
              value={formatNumber(outcome.queuedOrders)}
            />
            <Fact label="Processing" value={formatNumber(outcome.processingOrders)} />
            <Fact label="Retrying" value={formatNumber(outcome.retryingOrders)} />
            <Fact label="Confirmed" value={formatNumber(outcome.confirmedOrders)} />
            <Fact label="Failed" value={formatNumber(outcome.failedOrders)} />
            <Fact
              label={publicVocabulary.pendingReservations}
              value={formatNumber(outcome.pendingPersistenceCount)}
            />
            <Fact
              label={publicVocabulary.notifications}
              value={formatNumber(outcome.notificationsRecorded)}
            />
          </dl>
        </>
      ) : (
        <EmptyState>
          {runEvidenceAbsence(data?.currentRun?.status ?? null, {
            source: "durable-processing",
            pending: "No checkout outcome evidence yet.",
            settled: "Checkout outcome evidence is unavailable for this run.",
          })}
        </EmptyState>
      )}
    </section>
  );
}
