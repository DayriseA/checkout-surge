import {
  type DashboardProjection,
  type DemoRunSnapshot,
  type DownstreamErpStatus,
  deriveOversoldUnits,
} from "@checkout-surge/contracts";
import { useRef } from "react";
import { projectRequestSurge } from "../lib/dashboard-projection-state";
import { deriveRunErpStory } from "../lib/presentation/erp-story";
import type { Freshness } from "../lib/presentation/freshness";
import { downstreamErpStatusLabel, rateWindowLabel } from "../lib/presentation/public-vocabulary";
import { deriveRunConfigFacts } from "../lib/presentation/run-config-presentation";
import { deriveFreshnessPresentationState } from "../lib/presentation/run-presentation-state";
import {
  FreshnessLine,
  findLatestMetric,
  formatDurationSeconds,
  formatFailureSample,
  formatMetric,
  formatNumber,
  formatRate,
} from "./dashboard-panels";
import { StatusPill } from "./status-pill";

/**
 * The raw values behind the live board, keyed as in the watch live-board field mapping. Tuple
 * entries keep the two sources of one row apart so the changed-keys comparison works on raw
 * values, never on formatted strings.
 */
export interface LiveTechnicalBoardValues {
  arrivalRate: number | null;
  dispatched: [attemptsDispatched: number | null, plannedAttempts: number];
  /** The projected downstream status, or `"unavailable"` when its read failed. */
  downstreamErpStatus: DownstreamErpStatus | "unavailable" | null;
  erpFailures: [failures: number, timeouts: number] | null;
  erpProtection: string | null;
  /** The observed confirmation rate with its effective window, from durable records. */
  confirmationRate: [rate: number | null, windowSeconds: number] | null;
  confirmedOrders: number | null;
  failedOrders: number | null;
  httpFailureRate: [value: number, unit: string] | null;
  lagP95Average: [p95LagMs: number | null, averageLagMs: number | null] | null;
  latency: [value: number, unit: string] | null;
  oldestPending: number | null;
  oversoldUnits: number | null;
  pendingConfirmation: number | null;
  pendingPersistence: number | null;
  processingOrders: number | null;
  remainingStock: number | null;
  reservedStock: number | null;
  responseRate: number | null;
  queuedOrders: number | null;
  retryingOrders: number | null;
  soldOutRejections: number | null;
}

export type LiveTechnicalBoardKey = keyof LiveTechnicalBoardValues;

/**
 * Maps one projection (plus its run) to the live board's raw values. Every null source —
 * including a null evidence object, which is normal while starting — stays null so the board can
 * render its `—` placeholder.
 */
export function deriveLiveTechnicalBoardValues(
  projection: DashboardProjection,
  run: DemoRunSnapshot,
): LiveTechnicalBoardValues {
  const surge = projectRequestSurge(projection);
  const outcome = projection.businessOutcome;
  const inventory = projection.inventory;
  const lag = projection.consistencyLag;
  const erp = projection.erp;
  const latencySample = findLatestMetric(
    projection.recentMetrics,
    (name) => name === "traffic.latency",
  );
  const failureRateSample = findLatestMetric(
    projection.recentMetrics,
    (name) => name === "traffic.failure_rate",
  );
  return {
    arrivalRate: surge.arrivalRatePerSecond,
    dispatched: [
      surge.attemptsDispatched,
      deriveRunConfigFacts(run.configSnapshot).plannedAttempts,
    ],
    downstreamErpStatus: projection.runtimeProgress
      ? (projection.runtimeProgress.downstreamErpStatus ?? "unavailable")
      : null,
    erpFailures: erp ? [erp.recentFailureCount, erp.recentTimeoutCount] : null,
    erpProtection: erp ? deriveRunErpStory(erp) : null,
    confirmationRate: projection.runtimeProgress
      ? [
          projection.runtimeProgress.confirmationRatePerSecond,
          projection.runtimeProgress.confirmationRateWindowSeconds,
        ]
      : null,
    confirmedOrders: outcome?.confirmedOrders ?? null,
    failedOrders: outcome?.failedOrders ?? null,
    httpFailureRate: failureRateSample ? [failureRateSample.value, failureRateSample.unit] : null,
    lagP95Average: lag ? [lag.p95LagMs, lag.averageLagMs] : null,
    latency: latencySample ? [latencySample.value, latencySample.unit] : null,
    oldestPending: lag?.oldestPendingAgeSeconds ?? null,
    oversoldUnits:
      outcome && inventory
        ? deriveOversoldUnits({
            reservedUnits: outcome.reservedUnits,
            startingStock: inventory.allocatedStock,
          })
        : null,
    pendingConfirmation: lag?.pendingConfirmationCount ?? null,
    pendingPersistence: inventory?.pendingPersistenceCount ?? null,
    processingOrders: outcome?.processingOrders ?? null,
    remainingStock: inventory?.remainingStock ?? null,
    reservedStock: inventory?.reservedStock ?? null,
    responseRate: surge.responseCompletionRatePerSecond,
    queuedOrders: outcome?.queuedOrders ?? null,
    retryingOrders: outcome?.retryingOrders ?? null,
    // The live sold-out count deliberately reads the Redis-backed pressure counter, which moves
    // during the run; the durable outcome count stays 0 until traffic completes.
    soldOutRejections: inventory?.soldOutPressure.rejectionCount ?? null,
  };
}

/**
 * The changed-keys comparison behind the "changed in the last update" markers: raw values keyed
 * by the field mapping, never formatted strings. A first projection (no previous values) marks
 * nothing.
 */
export function changedLiveBoardKeys(
  previous: LiveTechnicalBoardValues | null,
  next: LiveTechnicalBoardValues,
): Set<LiveTechnicalBoardKey> {
  const changed = new Set<LiveTechnicalBoardKey>();
  if (!previous) return changed;
  for (const key of Object.keys(next) as LiveTechnicalBoardKey[]) {
    if (!sameBoardValue(previous[key], next[key])) changed.add(key);
  }
  return changed;
}

function sameBoardValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => sameBoardValue(value, right[index]))
    );
  }
  return left === right;
}

interface BoardMarkerState {
  changed: ReadonlySet<LiveTechnicalBoardKey>;
  previousValues: LiveTechnicalBoardValues;
  recoveredAt: string;
  runId: string;
}

interface BoardColumn {
  heading: string;
  id: string;
  primary: { key: LiveTechnicalBoardKey; value: string; caption: string };
  rows: Array<{ key: LiveTechnicalBoardKey; label: string; value: string }>;
}

const columnCountClassName = "grid grid-cols-4 gap-4 max-[900px]:grid-cols-2";
const columnHeadingClassName = "m-0 text-xs font-medium text-muted";
const columnPrimaryValueClassName = "m-0 text-2xl font-bold leading-tight text-ink";
const columnPrimaryCaptionClassName = "m-0 text-xs font-bold text-muted";
const rowTermClassName = "mb-0.5 text-xs font-medium text-muted";
const rowValueClassName = "m-0 [overflow-wrap:anywhere] text-sm font-semibold text-ink";

/**
 * The compact live board inside Watch's run card while a run is starting, active, or
 * draining: one freshness line and status pill, an attempt-based progress bar, the four pipeline
 * columns, and the changed-since-last-projection markers. Report-mode panels stay in
 * `TechnicalGroups`; this component only reads projections and never talks to the transport.
 */
export function LiveTechnicalBoard({
  freshness,
  projection,
  run,
}: {
  freshness: Freshness;
  projection: DashboardProjection;
  run: DemoRunSnapshot;
}) {
  const values = deriveLiveTechnicalBoardValues(projection, run);
  // OperatorDashboard re-renders every 2 s on its clock ticker. Markers recompute only when a
  // projection with a new recoveredAt arrives, so a clock-only re-render keeps the last markers.
  // A recoveredAt jump that also switches runs is the new run's first projection, which marks
  // nothing rather than the differences from the previous run's last values.
  const markerRef = useRef<BoardMarkerState | null>(null);
  let marker = markerRef.current;
  if (marker === null || marker.recoveredAt !== projection.recoveredAt) {
    const isNewRun = marker !== null && marker.runId !== run.runId;
    marker = {
      recoveredAt: projection.recoveredAt,
      previousValues: values,
      runId: run.runId,
      changed:
        marker === null || isNewRun
          ? new Set<LiveTechnicalBoardKey>()
          : changedLiveBoardKeys(marker.previousValues, values),
    };
    markerRef.current = marker;
  }
  const changed = marker.changed;
  const outcome = projection.businessOutcome;
  const inventory = projection.inventory;
  const columns: BoardColumn[] = [
    {
      heading: "1 · Arrival",
      id: "watch-signal-arrival",
      primary: {
        key: "arrivalRate",
        value: formatNumber(values.arrivalRate),
        caption: "attempts/s",
      },
      rows: [
        {
          key: "dispatched",
          label: "Dispatched",
          value: `${formatNumber(values.dispatched[0])} / ${formatNumber(values.dispatched[1])}`,
        },
        { key: "responseRate", label: "Responses", value: formatRate(values.responseRate, "/s") },
        {
          key: "latency",
          label: "Latency (mean)",
          value: values.latency ? formatMetric(values.latency[0], values.latency[1]) : "—",
        },
        {
          key: "httpFailureRate",
          label: "HTTP failures",
          value: values.httpFailureRate
            ? formatFailureSample(values.httpFailureRate[0], values.httpFailureRate[1])
            : "—",
        },
      ],
    },
    {
      heading: "2 · Stock",
      id: "watch-signal-inventory",
      primary: {
        key: "remainingStock",
        value: formatNumber(values.remainingStock),
        caption: `of ${formatNumber(inventory?.allocatedStock ?? null)} left`,
      },
      rows: [
        { key: "reservedStock", label: "Reserved", value: formatNumber(values.reservedStock) },
        {
          key: "soldOutRejections",
          label: "Sold-out rejections",
          value: formatNumber(values.soldOutRejections),
        },
        { key: "oversoldUnits", label: "Oversold", value: formatNumber(values.oversoldUnits) },
        {
          key: "pendingPersistence",
          label: "Awaiting storage",
          value: formatNumber(values.pendingPersistence),
        },
      ],
    },
    {
      heading: "3 · Processing",
      id: "watch-signal-backlog",
      primary: {
        key: "queuedOrders",
        value: formatNumber(values.queuedOrders),
        caption: "queued",
      },
      rows: [
        {
          key: "processingOrders",
          label: "In progress",
          value: formatNumber(values.processingOrders),
        },
        { key: "retryingOrders", label: "Retrying", value: formatNumber(values.retryingOrders) },
        {
          key: "erpFailures",
          label: "ERP fail / timeout",
          value: values.erpFailures
            ? `${formatNumber(values.erpFailures[0])} / ${formatNumber(values.erpFailures[1])}`
            : "—",
        },
        {
          key: "erpProtection",
          label: "ERP protection",
          value: values.erpProtection ?? "—",
        },
        {
          key: "downstreamErpStatus",
          label: "Downstream ERP",
          value:
            values.downstreamErpStatus === null
              ? "—"
              : values.downstreamErpStatus === "unavailable"
                ? "Status unavailable"
                : downstreamErpStatusLabel(values.downstreamErpStatus),
        },
      ],
    },
    {
      heading: "4 · Confirmation",
      id: "watch-signal-confirmation",
      primary: {
        key: "confirmedOrders",
        value: formatNumber(values.confirmedOrders),
        caption: `of ${formatNumber(outcome?.acceptedReservations ?? null)} confirmed`,
      },
      rows: [
        {
          key: "confirmationRate",
          label: values.confirmationRate
            ? `Confirmation rate (${rateWindowLabel(values.confirmationRate[1])})`
            : "Confirmation rate",
          value: values.confirmationRate
            ? formatRate(values.confirmationRate[0], "confirmations/s")
            : "—",
        },
        {
          key: "pendingConfirmation",
          label: "Pending",
          value: formatNumber(values.pendingConfirmation),
        },
        {
          key: "oldestPending",
          label: "Oldest pending",
          value: formatDurationSeconds(values.oldestPending),
        },
        {
          key: "failedOrders",
          label: "Failed orders",
          value: formatNumber(values.failedOrders),
        },
        {
          key: "lagP95Average",
          label: "p95 · avg",
          value: values.lagP95Average
            ? `${formatNumber(values.lagP95Average[0])} · ${formatNumber(values.lagP95Average[1])} ms`
            : "—",
        },
      ],
    },
  ];
  const [attemptsDispatched, plannedAttempts] = values.dispatched;
  return (
    <section className="min-w-0 rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <FreshnessLine freshness={freshness} />
        <StatusPill status={deriveFreshnessPresentationState(freshness)} />
      </div>
      {attemptsDispatched === null ? null : (
        <div
          aria-label="Attempts dispatched"
          aria-valuemax={plannedAttempts}
          aria-valuenow={attemptsDispatched}
          className="mb-4 h-2 w-full overflow-hidden rounded-full bg-surface-muted"
          role="progressbar"
        >
          <div
            className="h-full rounded-full bg-accent"
            style={{
              width: `${Math.min(100, Math.round((attemptsDispatched / plannedAttempts) * 100))}%`,
            }}
          />
        </div>
      )}
      <div className={columnCountClassName}>
        {columns.map((column) => (
          <section className="min-w-0" id={column.id} key={column.id} tabIndex={-1}>
            <h3 className={columnHeadingClassName}>{column.heading}</h3>
            <p className={columnPrimaryValueClassName}>
              <ChangedDot changed={changed.has(column.primary.key)} />
              {column.primary.value}
            </p>
            <p className={columnPrimaryCaptionClassName}>{column.primary.caption}</p>
            <dl className="m-0 mt-3 grid gap-2">
              {column.rows.map((row) => (
                <div className="min-w-0" key={row.key}>
                  <dt className={rowTermClassName}>{row.label}</dt>
                  <dd className={rowValueClassName}>
                    <ChangedDot changed={changed.has(row.key)} />
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="m-0 mt-3 text-xs leading-5 text-muted">
        <span aria-hidden="true" className="mr-1 inline-block size-2 rounded-full bg-accent" />
        changed in the last update
      </p>
    </section>
  );
}

/** The decorative changed marker: no live region, no animation, no announcement. */
function ChangedDot({ changed }: { changed: boolean }) {
  if (!changed) return null;
  return (
    <span
      aria-hidden="true"
      className="mr-1 inline-block size-2 rounded-full bg-accent"
      data-changed=""
    />
  );
}
