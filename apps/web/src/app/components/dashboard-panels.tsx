import type { CompletionOutcome, DashboardProjection } from "@checkout-surge/contracts";
import type { BackendRead } from "../lib/api";
import { projectRequestSurge } from "../lib/dashboard-projection-state";
import { formatDashboardTime } from "../lib/dashboard-time";
import type { Freshness, RealtimeConnectionStatus } from "../lib/presentation/freshness";
import {
  deriveCompletionOutcomePresentationState,
  deriveFreshnessPresentationState,
  type PresentationState,
} from "../lib/presentation/run-presentation-state";
import { StatusPill } from "./status-pill";
import {
  RequestArrivalRateSeries,
  systemOfRecordLens,
  TransportObservationPanelBlock,
} from "./transport-observation";

export type { RealtimeConnectionStatus } from "../lib/presentation/freshness";

const panelClassName =
  "min-w-0 rounded-lg border border-border bg-surface p-4 max-[900px]:col-span-full";
const panelNarrowClassName = `${panelClassName} col-span-4`;
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
const factTermClassName = "mb-1 text-xs font-bold text-muted";
const factValueClassName = "m-0 [overflow-wrap:anywhere] text-base font-bold text-ink";
const smallValueClassName = "m-0 [overflow-wrap:anywhere] text-sm font-semibold text-ink";
const controlButtonClassName =
  "min-h-10 rounded-lg border border-border bg-surface px-3.5 py-2.5 font-semibold text-muted-strong disabled:cursor-not-allowed disabled:opacity-60";

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatRate(value: number | null | undefined, unit: string, absent = "—"): string {
  if (value === null || value === undefined) {
    return absent;
  }

  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value < 10 ? 2 : 1,
  }).format(value)} ${unit}`;
}

function formatExpectedTime(value: string | undefined | null): string {
  return value ? formatDashboardTime(value) : "not yet available";
}

function formatScheduledTime(value: string | undefined | null): string {
  return value ? formatDashboardTime(value) : "not scheduled";
}

function formatOptionalTime(value: string | undefined | null): string {
  return value ? formatDashboardTime(value) : "—";
}

function formatSeconds(value: number | null | undefined, absent = "—"): string {
  if (value === null || value === undefined) {
    return absent;
  }

  if (value < 1) {
    return `${Math.round(value * 1000)}ms`;
  }

  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)}s`;
}

function formatMilliseconds(value: number | null | undefined, absent = "—"): string {
  if (value === null || value === undefined) {
    return absent;
  }

  if (value >= 1000) {
    return formatSeconds(value / 1000, absent);
  }

  return `${Math.round(value)}ms`;
}

function formatMetric(value: number, unit: string): string {
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
  if (read.status === "loading") {
    return <EmptyState>Checking availability.</EmptyState>;
  }

  return (
    <div className="grid gap-1 rounded-lg border border-[#f7b4ad] bg-danger-soft p-3 leading-6 text-danger">
      <strong>Unavailable</strong>
      <span>{read.reason}</span>
      {read.httpStatus ? <span>HTTP {read.httpStatus}</span> : null}
      {read.correlationId ? <span>Correlation {read.correlationId}</span> : null}
    </div>
  );
}

function Fact({ label, value, small = false }: { label: string; value: string; small?: boolean }) {
  return (
    <div className={factItemClassName}>
      <dt className={factTermClassName}>{label}</dt>
      <dd className={small ? smallValueClassName : factValueClassName}>{value}</dd>
    </div>
  );
}

function FreshnessLine({ freshness }: { freshness: Freshness }) {
  const updated = formatDashboardTime(freshness.observedAt);
  const notApplicable = freshness.final
    ? `Final, as of ${updated}`
    : `As of ${updated} · no active run`;
  const copy = {
    connecting: `Updated ${updated} · connecting to live updates`,
    disconnected: `Updated ${updated} · disconnected, showing last known values`,
    live: `Updated ${updated} · live`,
    "not-applicable": notApplicable,
    "retained-fresh": `Updated ${updated} · connected, no update expected`,
    stale: `Updated ${updated} · stale, showing last known values`,
    unsupported: `Updated ${updated} · live updates unsupported`,
  }[freshness.state];

  return <p className="m-0 mb-3 text-xs leading-5 text-muted">{copy}</p>;
}

export function RecoveryStatusPanel({
  recovery,
  realtimeStatus,
  liveProjectionCount,
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
  liveProjectionCount: number;
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

  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Current state</p>
          <h2 className={panelTitleClassName}>Run availability and updates</h2>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {onRefresh && recovery.status !== "loading" ? (
            <button
              className={`${controlButtonClassName} min-h-9 px-3 py-2 text-sm`}
              disabled={isRefreshing}
              onClick={onRefresh}
              type="button"
            >
              {isRefreshing ? "Refreshing" : "Refresh"}
            </button>
          ) : null}
          <StatusPill status={presentation} />
        </div>
      </div>
      {hasLastKnownGoodSyncIssue ? (
        <div className="mb-3 grid gap-1 rounded-lg border border-border bg-surface-muted p-3 leading-6 text-muted-strong">
          <strong>Last-known-good projection</strong>
          <span>
            {isRefreshing
              ? "Refreshing authoritative snapshot now."
              : isRetryScheduled && retryDelayMs !== null
                ? `Retry scheduled in ${formatSeconds(retryDelayMs / 1000)} (attempt ${retryAttempt}).`
                : "Authoritative recovery is unavailable."}
          </span>
          {syncIssue ? <span>{syncIssue.reason}</span> : null}
          {syncIssue?.httpStatus ? <span>HTTP {syncIssue.httpStatus}</span> : null}
          {syncIssue?.correlationId ? <span>Correlation {syncIssue.correlationId}</span> : null}
        </div>
      ) : null}
      {data ? (
        <>
          {freshness ? <FreshnessLine freshness={freshness} /> : null}
          <dl className={stackedFactGridClassName}>
            <Fact label="Current run" value={run ? run.presetName : "No active run"} />
            <Fact label="Traffic" value={run?.trafficStatus ?? "Not active"} />
            <Fact label="Update stream" value={realtimeStatus} />
            <Fact label="Projections applied" value={formatNumber(liveProjectionCount)} />
          </dl>
        </>
      ) : (
        <UnavailableState read={recovery} />
      )}
    </section>
  );
}

export function RequestSurgePanel({
  recovery,
  liveProjectionCount,
  freshness,
}: {
  recovery: BackendRead<DashboardProjection>;
  liveProjectionCount: number;
  freshness: Freshness;
}) {
  const data = recoveryData(recovery);
  const inventory = data?.inventory ?? null;
  const transportAttemptCounts = data?.transportAttemptCounts ?? null;
  const httpSummary = data?.httpSummary ?? null;
  const requestSurge = data ? projectRequestSurge(data) : null;
  const latestMetric = data?.recentMetrics.at(-1) ?? null;
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
          <h2 className={panelTitleClassName}>Traffic pressure</h2>
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
                  ? `Peak request arrival rate (${requestSurge.arrivalWindowSeconds}-second windows)`
                  : "Request arrival rate (1-second window)"
              }
              value={
                requestSurge?.arrivalRatePerSecond !== null &&
                requestSurge?.arrivalRatePerSecond !== undefined
                  ? formatObservedRequestRate(requestSurge.arrivalRatePerSecond)
                  : "Awaiting first full arrival window"
              }
            />
            <Fact
              label="Attempts dispatched"
              value={
                requestSurge?.attemptsDispatched === null ||
                requestSurge?.attemptsDispatched === undefined
                  ? "Awaiting dispatch"
                  : formatNumber(requestSurge.attemptsDispatched)
              }
            />
            <Fact
              label="Dispatch duration"
              value={formatSeconds(requestSurge?.dispatchDurationSeconds, "not yet available")}
            />
            <Fact
              label="Response completion rate"
              value={formatRate(
                requestSurge?.responseCompletionRatePerSecond,
                "responses/s",
                "not yet available",
              )}
            />
            <Fact
              label="Window mean HTTP latency"
              value={
                latencyMetric
                  ? formatMetric(latencyMetric.value, latencyMetric.unit)
                  : "Awaiting k6 metrics"
              }
            />
            <Fact
              label="Window HTTP failure rate"
              value={
                failureRateMetric
                  ? formatFailureSample(failureRateMetric.value, failureRateMetric.unit)
                  : "Awaiting k6 metrics"
              }
            />
          </dl>
          <dl className={stackedFactGridClassName}>
            <Fact
              label={`Peak reservation rate (1-second windows, trailing ${inventory?.reservationThroughput.windowSeconds ?? 60}s)`}
              value={formatRate(
                inventory?.reservationThroughput.peakRatePerSecond,
                "reservations/s",
                "not yet available",
              )}
            />
            <Fact
              label={`Reservations in last ${inventory?.reservationThroughput.windowSeconds ?? 60}s`}
              value={formatNumber(inventory?.reservationThroughput.successfulReservationCount ?? 0)}
            />
            <Fact
              label="Sold-out pressure"
              value={formatNumber(inventory?.soldOutPressure.rejectionCount ?? 0)}
            />
            <Fact label="Live projections" value={formatNumber(liveProjectionCount)} />
            <Fact
              label="Latest metric"
              value={
                latestMetric
                  ? `${latestMetric.metricName} at ${formatExpectedTime(latestMetric.timestamp)}`
                  : "not yet available"
              }
              small
            />
          </dl>
          <p className="mb-0 mt-3 text-xs leading-5 text-muted">
            Arrival counts checkout attempts when k6 starts them. Response completion, latency, and
            failures are separate HTTP observations on the shared 1-second producer event-time
            window.
          </p>
          {requestSurge &&
          (data.requestArrivalSummary !== null || requestSurge.arrivalRateSeries.length > 0) ? (
            <RequestArrivalRateSeries
              samples={requestSurge.arrivalRateSeries}
              {...(data.requestArrivalSummary ? { summary: data.requestArrivalSummary } : {})}
            />
          ) : null}
          {transportAttemptCounts && httpSummary ? (
            <TransportObservationPanelBlock
              counts={transportAttemptCounts}
              httpSummary={httpSummary}
            />
          ) : (
            <p className="mb-0 mt-3 text-xs leading-5 text-muted">
              Terminal transport attempt counts appear here once traffic completion evidence is
              recorded.
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
  const inventory = recoveryData(recovery)?.inventory ?? null;
  const percentRemaining =
    inventory && inventory.allocatedStock > 0
      ? Math.round((inventory.remainingStock / inventory.allocatedStock) * 100)
      : 0;

  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Inventory drain</p>
          <h2 className={panelTitleClassName}>Stock hold path</h2>
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
            <Fact label="Allocated" value={formatNumber(inventory.allocatedStock)} />
            <Fact label="Remaining" value={formatNumber(inventory.remainingStock)} />
            <Fact label="Reserved" value={formatNumber(inventory.reservedStock)} />
            <Fact label="Pending" value={formatNumber(inventory.pendingPersistenceCount)} />
            <Fact label="Expired" value={formatNumber(inventory.expiredReservationCount)} />
            <Fact
              label="Oldest pending"
              value={formatSeconds(inventory.oldestPendingPersistenceAgeSeconds)}
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
        <EmptyState>No inventory data.</EmptyState>
      )}
    </section>
  );
}

export function QueuePressurePanel({
  recovery,
  presentation,
  freshness,
}: {
  recovery: BackendRead<DashboardProjection>;
  presentation: PresentationState;
  freshness: Freshness;
}) {
  const queue = recoveryData(recovery)?.queue ?? null;

  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Queue pressure</p>
          <h2 className={panelTitleClassName}>orders:process</h2>
        </div>
        <StatusPill status={presentation} />
      </div>
      {queue ? (
        <>
          <FreshnessLine freshness={freshness} />
          <dl className={factGridClassName}>
            <Fact label="Waiting" value={formatNumber(queue.counts.waiting)} />
            <Fact label="Active" value={formatNumber(queue.counts.active)} />
            <Fact label="Delayed" value={formatNumber(queue.counts.delayed)} />
            <Fact label="Retrying" value={formatNumber(queue.retryPressure.retryingJobCount)} />
            <Fact label="Failed" value={formatNumber(queue.failedJobs.totalCount)} />
            <Fact label="Oldest wait" value={formatSeconds(queue.oldestWaitingAgeSeconds)} />
            <Fact label="Queue inspected" value={formatExpectedTime(queue.updatedAt)} small />
          </dl>
          <p className="mb-0 mt-3 text-xs leading-5 text-muted">
            Enqueues publish live; the API refreshes worker drain, retry, and failure state from the
            authoritative inspector every 2 seconds until the queue drains.
          </p>
        </>
      ) : (
        <EmptyState>No queue data.</EmptyState>
      )}
    </section>
  );
}

export function ErpHealthPanel({
  recovery,
  presentation,
  freshness,
}: {
  recovery: BackendRead<DashboardProjection>;
  presentation: PresentationState;
  freshness: Freshness;
}) {
  const erp = recoveryData(recovery)?.erp ?? null;

  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>ERP health</p>
          <h2 className={panelTitleClassName}>Downstream dependency</h2>
        </div>
        <StatusPill status={presentation} />
      </div>
      {erp ? (
        <>
          <FreshnessLine freshness={freshness} />
          <dl className={factGridClassName}>
            <Fact label="Circuit" value={erp.circuit?.state ?? "not yet available"} />
            <Fact label="Reason" value={erp.reason ?? "normal"} small />
            <Fact label="Retrying" value={formatNumber(erp.retryPressure.retryingJobCount)} />
            <Fact label="Recent attempts" value={formatNumber(erp.recentAttemptCount)} />
            <Fact label="Failures" value={formatNumber(erp.recentFailureCount)} />
            <Fact label="Timeouts" value={formatNumber(erp.recentTimeoutCount)} />
            <Fact
              label="Failure threshold"
              value={erp.circuit ? formatNumber(erp.circuit.failureThreshold) : "—"}
            />
            <Fact
              label="Consecutive failures"
              value={erp.circuit ? formatNumber(erp.circuit.consecutiveFailureCount) : "—"}
            />
            <Fact
              label="Reset timeout"
              value={erp.circuit ? formatMilliseconds(erp.circuit.resetTimeoutMs) : "—"}
            />
            <Fact label="Breaker opened" value={formatScheduledTime(erp.circuit?.openedAt)} small />
            <Fact
              label="Next probe"
              value={formatScheduledTime(erp.circuit?.nextAttemptAt)}
              small
            />
            <Fact
              label="Breaker reported"
              value={formatExpectedTime(erp.circuit?.updatedAt)}
              small
            />
            <Fact label="API projection" value={formatExpectedTime(erp.updatedAt)} small />
            <Fact
              label="Attempt window"
              value={`${formatNumber(erp.recentAttemptWindowSeconds)}s`}
            />
          </dl>
        </>
      ) : (
        <EmptyState>No ERP health data.</EmptyState>
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
  const lag = recoveryData(recovery)?.consistencyLag ?? null;

  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Consistency lag</p>
          <h2 className={panelTitleClassName}>Fast reservation vs final confirmation</h2>
        </div>
        <StatusPill status={presentation} />
      </div>
      {lag ? (
        <>
          <FreshnessLine freshness={freshness} />
          <dl className={factGridClassName}>
            <Fact
              label="p95 confirmed"
              value={formatMilliseconds(lag.p95LagMs, "not yet available")}
            />
            <Fact
              label="Avg confirmed"
              value={formatMilliseconds(lag.averageLagMs, "not yet available")}
            />
            <Fact
              label="Max confirmed"
              value={formatMilliseconds(lag.maxLagMs, "not yet available")}
            />
            <Fact label="Pending" value={formatNumber(lag.pendingConfirmationCount)} />
            <Fact label="Oldest pending" value={formatSeconds(lag.oldestPendingAgeSeconds)} />
            <Fact label="Confirmed" value={formatNumber(lag.confirmedOrderCount)} />
            <Fact label="Measured" value={formatExpectedTime(lag.measuredAt)} />
          </dl>
        </>
      ) : (
        <EmptyState>No consistency-lag data.</EmptyState>
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
  const outcome = recoveryData(recovery)?.businessOutcome ?? null;

  return (
    <section className={panelFullClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>{systemOfRecordLens.title}</p>
          <h2 className={panelTitleClassName}>Reservation and confirmation summary</h2>
          <p className="m-0 mt-1 text-xs text-muted">{systemOfRecordLens.caption}</p>
        </div>
        <StatusPill status={presentation} />
      </div>
      {outcome ? (
        <>
          <FreshnessLine freshness={freshness} />
          <dl className={wideFactGridClassName}>
            <Fact label="Accepted" value={formatNumber(outcome.acceptedReservations)} />
            <Fact label="Sold out" value={formatNumber(outcome.soldOutRejections)} />
            <Fact label="Queued" value={formatNumber(outcome.queuedOrders)} />
            <Fact label="Processing" value={formatNumber(outcome.processingOrders)} />
            <Fact label="Retrying" value={formatNumber(outcome.retryingOrders)} />
            <Fact label="Confirmed" value={formatNumber(outcome.confirmedOrders)} />
            <Fact label="Failed" value={formatNumber(outcome.failedOrders)} />
            <Fact
              label="Pending persistence"
              value={formatNumber(outcome.pendingPersistenceCount)}
            />
            <Fact label="Notifications" value={formatNumber(outcome.notificationsRecorded)} />
          </dl>
        </>
      ) : (
        <EmptyState>No business outcome data.</EmptyState>
      )}
    </section>
  );
}

export function CompletionOutcomesPanel({
  recovery,
}: {
  recovery: BackendRead<DashboardProjection>;
}) {
  const outcomes = recoveryData(recovery)?.recentCompletionOutcomes ?? [];

  return (
    <section className={panelFullClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Completion outcomes</p>
          <h2 className={panelTitleClassName}>Recent order workflow results</h2>
        </div>
        <StatusPill
          status={{
            label: outcomes.length > 0 ? `${formatNumber(outcomes.length)} shown` : "no data",
            tone: outcomes.length > 0 ? "ok" : "idle",
          }}
        />
      </div>
      {outcomes.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase text-muted">
                <th className="py-2 pr-3 font-bold">Status</th>
                <th className="px-3 py-2 font-bold">Order</th>
                <th className="px-3 py-2 font-bold">ERP</th>
                <th className="px-3 py-2 font-bold">Latest</th>
                <th className="py-2 pl-3 font-bold">Correlation</th>
              </tr>
            </thead>
            <tbody>
              {outcomes.map((outcome) => (
                <CompletionOutcomeRow key={outcome.orderId} outcome={outcome} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState>No recent order outcomes.</EmptyState>
      )}
    </section>
  );
}

function CompletionOutcomeRow({ outcome }: { outcome: CompletionOutcome }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="py-3 pr-3 align-top">
        <StatusPill status={deriveCompletionOutcomePresentationState(outcome.displayStatus)} />
      </td>
      <td className="px-3 py-3 align-top">
        <div className="grid gap-1">
          <span className="font-semibold text-ink">{outcome.publicOrderId}</span>
          <span className="text-xs text-muted [overflow-wrap:anywhere]">{outcome.orderId}</span>
        </div>
      </td>
      <td className="px-3 py-3 align-top text-muted">
        {outcome.latestErpAttemptStatus
          ? `${outcome.latestErpAttemptStatus}${outcome.latestErpErrorCode ? `:${outcome.latestErpErrorCode}` : ""}`
          : "—"}
      </td>
      <td className="px-3 py-3 align-top text-muted">
        <div className="grid gap-1">
          <span>{formatExpectedTime(outcome.latestEventAt)}</span>
          {outcome.notificationRecordedAt ? (
            <span className="text-xs">
              Notified {formatOptionalTime(outcome.notificationRecordedAt)}
            </span>
          ) : null}
        </div>
      </td>
      <td className="py-3 pl-3 align-top text-xs text-muted [overflow-wrap:anywhere]">
        {outcome.correlationId}
      </td>
    </tr>
  );
}
