import type {
  BusinessOutcomeSummary,
  CompletionOutcome,
  CompletionOutcomeStatus,
  DashboardRecoveryResponse,
  HealthStatus,
  InventoryStatus,
  QueueStatus,
  StartDemoRunResponse,
} from "@checkout-surge/contracts";
import type { BackendRead, DashboardBackendSnapshot } from "../lib/api";
import { StatusPill } from "./status-pill";

export type RealtimeConnectionStatus = "connecting" | "connected" | "disconnected" | "unsupported";

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

function formatRate(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) {
    return "n/a";
  }

  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value < 10 ? 2 : 1,
  }).format(value)} ${unit}`;
}

function formatTime(value: string | undefined | null): string {
  if (!value) {
    return "Not started";
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function formatSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "n/a";
  }

  if (value < 1) {
    return `${Math.round(value * 1000)}ms`;
  }

  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)}s`;
}

function formatMilliseconds(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "n/a";
  }

  if (value >= 1000) {
    return formatSeconds(value / 1000);
  }

  return `${Math.round(value)}ms`;
}

function formatMetric(value: number, unit: string): string {
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value < 10 ? 2 : 1,
  }).format(value)} ${unit}`;
}

function recoveryData(
  recovery: BackendRead<DashboardRecoveryResponse>,
): DashboardRecoveryResponse | null {
  return recovery.status === "available" ? recovery.data : null;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className={emptyStateClassName}>{children}</p>;
}

function UnavailableState({ read }: { read: BackendRead<unknown> }) {
  if (read.status === "available") {
    return null;
  }

  return (
    <div className="grid gap-1 rounded-lg border border-[#f7b4ad] bg-danger-soft p-3 leading-6 text-danger">
      <strong>Unavailable</strong>
      <span>{read.reason}</span>
      {read.httpStatus ? <span>HTTP {read.httpStatus}</span> : null}
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

function healthTone(
  status: HealthStatus | "healthy" | "idle",
): Parameters<typeof StatusPill>[0]["tone"] {
  if (status === "ok" || status === "healthy") {
    return "ok";
  }
  if (status === "degraded") {
    return "degraded";
  }
  if (status === "idle") {
    return "idle";
  }
  return "unavailable";
}

function queueTone(queue: QueueStatus | null): Parameters<typeof StatusPill>[0]["tone"] {
  if (!queue) {
    return "idle";
  }
  if (queue.failedJobs.totalCount > 0) {
    return "degraded";
  }
  if (queue.depth > 0 || queue.counts.active > 0) {
    return "pending";
  }
  return "ok";
}

function inventoryTone(
  inventory: InventoryStatus | null,
): Parameters<typeof StatusPill>[0]["tone"] {
  if (!inventory) {
    return "idle";
  }
  if (inventory.pendingPersistenceCount > 0) {
    return "degraded";
  }
  if (inventory.remainingStock === 0) {
    return "blocked";
  }
  return "ok";
}

function outcomeTone(
  outcome: BusinessOutcomeSummary | null,
): Parameters<typeof StatusPill>[0]["tone"] {
  if (!outcome) {
    return "idle";
  }
  if (outcome.failedOrders > 0 || outcome.pendingPersistenceCount > 0) {
    return "degraded";
  }
  if (outcome.processingOrders > 0 || outcome.retryingOrders > 0 || outcome.queuedOrders > 0) {
    return "pending";
  }
  return "ok";
}

function completionOutcomeTone(
  status: CompletionOutcomeStatus,
): Parameters<typeof StatusPill>[0]["tone"] {
  if (status === "confirmed" || status === "notification_recorded") {
    return "ok";
  }
  if (status === "failed") {
    return "degraded";
  }
  if (status === "delayed" || status === "retrying") {
    return "pending";
  }
  return "idle";
}

function completionOutcomeLabel(status: CompletionOutcomeStatus): string {
  return status.replaceAll("_", " ");
}

export function ApiStatusPanel({ snapshot }: { snapshot: DashboardBackendSnapshot }) {
  const liveness = snapshot.liveness.status === "available" ? snapshot.liveness.data : null;
  const readiness = snapshot.readiness.status === "available" ? snapshot.readiness.data : null;
  const status = readiness?.status ?? liveness?.status ?? "unavailable";

  return (
    <section className={panelWideClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>API gateway</p>
          <h2 className={panelTitleClassName}>Service readiness</h2>
        </div>
        <StatusPill label={status} tone={healthTone(status)} />
      </div>
      {snapshot.readiness.status === "available" ? (
        <div className="grid gap-2.5">
          {snapshot.readiness.data.checks.map((check) => (
            <div
              className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 border-t border-border pt-3"
              key={check.name}
            >
              <span>{check.name}</span>
              <StatusPill label={check.status} tone={healthTone(check.status)} />
              {check.message ? (
                <small className="col-span-full text-muted">{check.message}</small>
              ) : null}
            </div>
          ))}
          {snapshot.readiness.data.checks.length === 0 ? (
            <EmptyState>No dependency checks are exposed yet.</EmptyState>
          ) : null}
        </div>
      ) : (
        <UnavailableState read={snapshot.readiness} />
      )}
      <dl className={factGridClassName}>
        <Fact label="Liveness" value={liveness ? liveness.status : "unavailable"} />
        <Fact label="Uptime" value={liveness ? `${Math.round(liveness.uptimeSeconds)}s` : "n/a"} />
        <Fact label="Read timestamp" value={readiness ? formatTime(readiness.timestamp) : "n/a"} />
      </dl>
    </section>
  );
}

export function RecoveryStatusPanel({
  recovery,
  realtimeStatus,
  liveEventCount,
  isRefreshing = false,
  onRefresh,
}: {
  recovery: BackendRead<DashboardRecoveryResponse>;
  realtimeStatus: RealtimeConnectionStatus;
  liveEventCount: number;
  isRefreshing?: boolean;
  onRefresh?: () => void;
}) {
  const data = recoveryData(recovery);
  const run = data?.currentRun ?? null;

  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Recovery</p>
          <h2 className={panelTitleClassName}>Latest backend snapshot</h2>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {onRefresh ? (
            <button
              className={`${controlButtonClassName} min-h-9 px-3 py-2 text-sm`}
              disabled={isRefreshing}
              onClick={onRefresh}
              type="button"
            >
              {isRefreshing ? "Refreshing" : "Refresh"}
            </button>
          ) : null}
          <StatusPill label={run?.status ?? "idle"} tone={run ? "pending" : "idle"} />
        </div>
      </div>
      {data ? (
        <dl className={stackedFactGridClassName}>
          <Fact label="Current run" value={run ? run.presetName : "No active run"} />
          <Fact label="Traffic" value={run?.trafficStatus ?? "Not active"} />
          <Fact label="Recovered at" value={formatTime(data.recoveredAt)} />
          <Fact label="Live stream" value={realtimeStatus} />
          <Fact label="Events applied" value={formatNumber(liveEventCount)} />
        </dl>
      ) : (
        <UnavailableState read={recovery} />
      )}
    </section>
  );
}

const publicPresetControls = [
  "preview-1k",
  "surge-5k",
  "surge-10k",
  "idempotency-check-200",
  "public-custom",
] as const;

export function LoadRunControlsPanel({
  recovery,
  onStartPreset,
  startingPresetSlug = null,
  statusMessage = null,
}: {
  recovery: BackendRead<DashboardRecoveryResponse>;
  onStartPreset?: (presetSlug: string) => Promise<BackendRead<StartDemoRunResponse>>;
  startingPresetSlug?: string | null;
  statusMessage?: string | null;
}) {
  const data = recoveryData(recovery);
  const currentRun = data?.currentRun ?? null;
  const isBlockedByCurrentRun =
    currentRun?.status === "starting" ||
    currentRun?.status === "active" ||
    currentRun?.status === "draining";
  const isStarting = startingPresetSlug !== null;
  const statusLabel = isBlockedByCurrentRun ? currentRun.status : isStarting ? "starting" : "ready";
  const disabledReason =
    recovery.status !== "available"
      ? "Recovery is unavailable, so start gating cannot be verified."
      : isBlockedByCurrentRun
        ? "A run is already starting, active, or draining."
        : onStartPreset
          ? "Ready to start bounded public traffic."
          : "Start action unavailable.";
  const disableStarts =
    recovery.status !== "available" || isBlockedByCurrentRun || isStarting || !onStartPreset;

  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Run controls</p>
          <h2 className={panelTitleClassName}>Preset traffic</h2>
        </div>
        <StatusPill label={statusLabel} tone={isBlockedByCurrentRun ? "pending" : "idle"} />
      </div>
      <div className="grid gap-2.5">
        {publicPresetControls.map((presetSlug) => (
          <button
            className={controlButtonClassName}
            key={presetSlug}
            onClick={() => {
              void onStartPreset?.(presetSlug);
            }}
            type="button"
            disabled={disableStarts}
          >
            {startingPresetSlug === presetSlug ? "Starting" : presetSlug}
          </button>
        ))}
      </div>
      <EmptyState>{disabledReason}</EmptyState>
      {statusMessage ? (
        <p className="m-0 text-sm font-semibold text-muted-strong">{statusMessage}</p>
      ) : null}
    </section>
  );
}

export function RequestSurgePanel({
  recovery,
  liveEventCount,
}: {
  recovery: BackendRead<DashboardRecoveryResponse>;
  liveEventCount: number;
}) {
  const data = recoveryData(recovery);
  const inventory = data?.inventory ?? null;
  const latestMetric = data?.recentMetrics.at(-1) ?? null;
  const requestRateMetric = data
    ? findLatestMetric(data.recentMetrics, (metricName) => metricName.includes("request_rate"))
    : null;

  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Request surge</p>
          <h2 className={panelTitleClassName}>Traffic pressure</h2>
        </div>
        <StatusPill
          label={requestRateMetric ? "metrics live" : inventory ? "reservations live" : "idle"}
          tone={requestRateMetric || inventory ? "ok" : "idle"}
        />
      </div>
      {data ? (
        <dl className={stackedFactGridClassName}>
          <Fact
            label="HTTP request rate"
            value={
              requestRateMetric
                ? formatMetric(requestRateMetric.value, requestRateMetric.unit)
                : "Awaiting k6 metrics"
            }
          />
          <Fact
            label="Reservation rate"
            value={formatRate(inventory?.reservationThroughput.rate, "holds/s")}
          />
          <Fact
            label="Sold-out pressure"
            value={formatNumber(inventory?.soldOutPressure.rejectionCount ?? 0)}
          />
          <Fact label="Live events" value={formatNumber(liveEventCount)} />
          <Fact
            label="Latest metric"
            value={
              latestMetric
                ? `${latestMetric.metricName} at ${formatTime(latestMetric.timestamp)}`
                : "n/a"
            }
            small
          />
        </dl>
      ) : (
        <UnavailableState read={recovery} />
      )}
    </section>
  );
}

function findLatestMetric(
  metrics: DashboardRecoveryResponse["recentMetrics"],
  predicate: (metricName: string) => boolean,
): DashboardRecoveryResponse["recentMetrics"][number] | null {
  for (let index = metrics.length - 1; index >= 0; index -= 1) {
    const metric = metrics[index];

    if (metric && predicate(metric.metricName)) {
      return metric;
    }
  }

  return null;
}

export function InventoryDrainPanel({
  recovery,
}: {
  recovery: BackendRead<DashboardRecoveryResponse>;
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
        <StatusPill
          label={inventory ? `${percentRemaining}% left` : "no data"}
          tone={inventoryTone(inventory)}
        />
      </div>
      {inventory ? (
        <>
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
}: {
  recovery: BackendRead<DashboardRecoveryResponse>;
}) {
  const queue = recoveryData(recovery)?.queue ?? null;

  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Queue pressure</p>
          <h2 className={panelTitleClassName}>orders:process</h2>
        </div>
        <StatusPill
          label={queue ? `${formatNumber(queue.depth)} jobs` : "no data"}
          tone={queueTone(queue)}
        />
      </div>
      {queue ? (
        <dl className={factGridClassName}>
          <Fact label="Waiting" value={formatNumber(queue.counts.waiting)} />
          <Fact label="Active" value={formatNumber(queue.counts.active)} />
          <Fact label="Delayed" value={formatNumber(queue.counts.delayed)} />
          <Fact label="Retrying" value={formatNumber(queue.retryPressure.retryingJobCount)} />
          <Fact label="Failed" value={formatNumber(queue.failedJobs.totalCount)} />
          <Fact label="Oldest wait" value={formatSeconds(queue.oldestWaitingAgeSeconds)} />
        </dl>
      ) : (
        <EmptyState>No queue data.</EmptyState>
      )}
    </section>
  );
}

export function ErpHealthPanel({ recovery }: { recovery: BackendRead<DashboardRecoveryResponse> }) {
  const erp = recoveryData(recovery)?.erp ?? null;

  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>ERP health</p>
          <h2 className={panelTitleClassName}>Downstream dependency</h2>
        </div>
        <StatusPill
          label={erp ? erp.status : "no data"}
          tone={erp ? healthTone(erp.status) : "idle"}
        />
      </div>
      {erp ? (
        <dl className={factGridClassName}>
          <Fact label="Circuit" value={erp.circuit?.state ?? "missing"} />
          <Fact label="Reason" value={erp.reason ?? "normal"} small />
          <Fact label="Retrying" value={formatNumber(erp.retryPressure.retryingJobCount)} />
          <Fact label="Recent attempts" value={formatNumber(erp.recentAttemptCount)} />
          <Fact label="Failures" value={formatNumber(erp.recentFailureCount)} />
          <Fact label="Timeouts" value={formatNumber(erp.recentTimeoutCount)} />
        </dl>
      ) : (
        <EmptyState>No ERP health data.</EmptyState>
      )}
    </section>
  );
}

export function ConsistencyLagPanel({
  recovery,
}: {
  recovery: BackendRead<DashboardRecoveryResponse>;
}) {
  const lag = recoveryData(recovery)?.consistencyLag ?? null;

  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Consistency lag</p>
          <h2 className={panelTitleClassName}>Fast reservation vs final confirmation</h2>
        </div>
        <StatusPill
          label={lag && lag.pendingConfirmationCount > 0 ? "draining" : lag ? "settled" : "no data"}
          tone={lag && lag.pendingConfirmationCount > 0 ? "pending" : lag ? "ok" : "idle"}
        />
      </div>
      {lag ? (
        <dl className={factGridClassName}>
          <Fact label="Reservation" value="Secured" />
          <Fact label="p95 confirmed" value={formatMilliseconds(lag.p95LagMs)} />
          <Fact label="Avg confirmed" value={formatMilliseconds(lag.averageLagMs)} />
          <Fact label="Max confirmed" value={formatMilliseconds(lag.maxLagMs)} />
          <Fact label="Pending" value={formatNumber(lag.pendingConfirmationCount)} />
          <Fact label="Oldest pending" value={formatSeconds(lag.oldestPendingAgeSeconds)} />
          <Fact label="Confirmed" value={formatNumber(lag.confirmedOrderCount)} />
          <Fact label="Measured" value={formatTime(lag.measuredAt)} />
        </dl>
      ) : (
        <EmptyState>No consistency-lag data.</EmptyState>
      )}
    </section>
  );
}

export function RunOutcomesPanel({
  recovery,
}: {
  recovery: BackendRead<DashboardRecoveryResponse>;
}) {
  const outcome = recoveryData(recovery)?.businessOutcome ?? null;

  return (
    <section className={panelFullClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Run outcomes</p>
          <h2 className={panelTitleClassName}>Reservation and confirmation summary</h2>
        </div>
        <StatusPill
          label={outcome ? `${formatNumber(outcome.acceptedReservations)} accepted` : "no data"}
          tone={outcomeTone(outcome)}
        />
      </div>
      {outcome ? (
        <dl className={wideFactGridClassName}>
          <Fact label="Accepted" value={formatNumber(outcome.acceptedReservations)} />
          <Fact label="Sold out" value={formatNumber(outcome.soldOutRejections)} />
          <Fact label="Queued" value={formatNumber(outcome.queuedOrders)} />
          <Fact label="Processing" value={formatNumber(outcome.processingOrders)} />
          <Fact label="Retrying" value={formatNumber(outcome.retryingOrders)} />
          <Fact label="Confirmed" value={formatNumber(outcome.confirmedOrders)} />
          <Fact label="Failed" value={formatNumber(outcome.failedOrders)} />
          <Fact label="Pending persistence" value={formatNumber(outcome.pendingPersistenceCount)} />
          <Fact label="Notifications" value={formatNumber(outcome.notificationsRecorded)} />
        </dl>
      ) : (
        <EmptyState>No business outcome data.</EmptyState>
      )}
    </section>
  );
}

export function CompletionOutcomesPanel({
  recovery,
}: {
  recovery: BackendRead<DashboardRecoveryResponse>;
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
          label={outcomes.length > 0 ? `${formatNumber(outcomes.length)} shown` : "no data"}
          tone={outcomes.length > 0 ? "ok" : "idle"}
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
        <StatusPill
          label={completionOutcomeLabel(outcome.displayStatus)}
          tone={completionOutcomeTone(outcome.displayStatus)}
        />
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
          : "n/a"}
      </td>
      <td className="px-3 py-3 align-top text-muted">
        <div className="grid gap-1">
          <span>{formatTime(outcome.latestEventAt)}</span>
          {outcome.notificationRecordedAt ? (
            <span className="text-xs">Notified {formatTime(outcome.notificationRecordedAt)}</span>
          ) : null}
        </div>
      </td>
      <td className="py-3 pl-3 align-top text-xs text-muted [overflow-wrap:anywhere]">
        {outcome.correlationId}
      </td>
    </tr>
  );
}
