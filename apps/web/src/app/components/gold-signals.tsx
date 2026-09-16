import type {
  ConsistencyLagSummary,
  DemoRunStatus,
  RequestArrivalSummary,
  RunSignalTimelineSummary,
} from "@checkout-surge/contracts";
import { hasObservedRequestArrivals } from "@checkout-surge/contracts";
import type { RunSignalLiveSample } from "../lib/dashboard-projection-state";
import { formatWindowSecondsAdjective } from "../lib/presentation/format";
import { liveTrafficMetricWindowSeconds } from "../lib/presentation/public-vocabulary";
import {
  deriveSignalHeadlines,
  type SignalHeadlines,
  selectConfirmationLiveSamples,
} from "../lib/presentation/signal-headlines";

export type SignalPoint = {
  elapsedSeconds: number;
  value: number;
  secondaryValue?: number;
};

export type EventMarker = { elapsedSeconds: number; label: string };

/** Axis origin and the two boundary phrases that name what the origin and the maximum are. */
export type SignalAxis = { originMs: number; startLabel: string; endLabel: string };

export type GoldSignalKey = "arrival" | "inventory" | "backlog" | "confirmation";

export interface GoldSignalChart {
  area: boolean;
  available: boolean;
  points: SignalPoint[];
  secondary: boolean;
  xMax: number;
}

export interface GoldSignalCharts {
  axis: SignalAxis;
  charts: Record<GoldSignalKey, GoldSignalChart>;
  /** False when no timeline, arrival evidence, or displayed live sample exists at all. */
  hasEvidence: boolean;
  headlines: SignalHeadlines;
  markers: EventMarker[];
}

export type GoldSignalInput = {
  acceptedReservations: number | null;
  arrivalSummary: RequestArrivalSummary | null;
  failedOrders?: number | null;
  liveLag?: ConsistencyLagSummary | null;
  liveSamples?: RunSignalLiveSample[];
  oversoldUnits: number | null;
  retryingOrderCount?: number;
  runStatus: DemoRunStatus | null;
  startingStock?: number | null;
  terminalSummary: RunSignalTimelineSummary | null;
};

/**
 * The single sample-to-points selection shared by the full Advanced charts and the Basic Watch
 * signal strip, so both presentations always describe the same evidence.
 */
export function deriveGoldSignalCharts(input: GoldSignalInput): GoldSignalCharts {
  const terminal = input.terminalSummary;
  const terminalRun = input.runStatus === "completed" || input.runStatus === "failed";
  const startingStock = input.startingStock ?? null;
  // Arrival is load-generator evidence and is already final while a draining run keeps
  // processing; the other three panels describe durable work that is still arriving.
  const arrivalEvidence = observedArrivalEvidence(input.arrivalSummary);
  const retainedLiveSamples = input.liveSamples ?? [];
  const arrivalStartIndex = retainedLiveSamples.findIndex(
    (sample) => sample.arrivalRatePerSecond !== null && sample.arrivalRatePerSecond > 0,
  );
  const liveStartIndex =
    arrivalStartIndex >= 0
      ? arrivalStartIndex
      : retainedLiveSamples.findIndex(
          (sample) =>
            (startingStock !== null &&
              sample.remainingStock !== null &&
              sample.remainingStock < startingStock) ||
            (sample.queueBacklog ?? 0) > 0 ||
            sample.confirmedOrderCount > 0 ||
            sample.failedOrderCount > 0 ||
            sample.pendingOrderCount > 0,
        );
  const displayedLiveSamples = liveStartIndex < 0 ? [] : retainedLiveSamples.slice(liveStartIndex);
  const confirmationLiveSamples = selectConfirmationLiveSamples(displayedLiveSamples);
  const headlines = deriveSignalHeadlines({
    acceptedReservations: input.acceptedReservations,
    arrivalSummary: input.arrivalSummary,
    failedOrders: input.failedOrders ?? null,
    liveLag: input.liveLag ?? null,
    liveSamples: displayedLiveSamples,
    oversoldUnits: input.oversoldUnits,
    runStatus: input.runStatus,
    startingStock,
    terminalSummary: input.terminalSummary,
  });
  const axis = deriveSignalAxis({
    arrival: arrivalEvidence,
    firstLiveSampleAt: displayedLiveSamples[0]?.recoveredAt ?? null,
    terminal,
    terminalRun,
  });
  const timelineOriginMs = axis.originMs;
  const toAxisElapsed = (timestamp: string) =>
    Number.isFinite(timelineOriginMs)
      ? Math.max(0, (Date.parse(timestamp) - timelineOriginMs) / 1_000)
      : 0;
  // Producer-owned arrival windows outrank browser sampling whenever the run reported any.
  const arrivalPoints: SignalPoint[] = arrivalEvidence
    ? arrivalEvidence.arrivalRateSeries.map((sample) => ({
        elapsedSeconds: toAxisElapsed(sample.windowStartedAt),
        value: sample.ratePerSecond,
      }))
    : displayedLiveSamples.flatMap((sample) =>
        sample.arrivalRatePerSecond === null
          ? []
          : [
              {
                elapsedSeconds: toAxisElapsed(sample.recoveredAt),
                value: sample.arrivalRatePerSecond,
              },
            ],
      );
  const inventoryPoints: SignalPoint[] = terminal
    ? terminal.inventoryDrain.remainingStockSeries.map((sample) => ({
        elapsedSeconds: sample.elapsedSeconds,
        value: sample.remainingStock,
      }))
    : displayedLiveSamples.flatMap((sample) =>
        sample.remainingStock === null
          ? []
          : [
              {
                elapsedSeconds: toAxisElapsed(sample.recoveredAt),
                value: sample.remainingStock,
              },
            ],
      );
  const backlogPoints: SignalPoint[] = terminal
    ? terminal.queueBacklog.backlogSeries.map((sample) => ({
        elapsedSeconds: sample.elapsedSeconds,
        value: sample.backlog,
      }))
    : displayedLiveSamples.flatMap((sample) =>
        sample.queueBacklog === null
          ? []
          : [
              {
                elapsedSeconds: toAxisElapsed(sample.recoveredAt),
                value: sample.queueBacklog,
              },
            ],
      );
  const convergencePoints: SignalPoint[] = terminal
    ? terminal.confirmationConvergence.convergenceSeries.map((sample) => ({
        elapsedSeconds: sample.elapsedSeconds,
        value: sample.cumulativeConfirmedOrderCount,
        secondaryValue: sample.cumulativeSettledOrderCount,
      }))
    : confirmationLiveSamples.map((sample) => ({
        elapsedSeconds: toAxisElapsed(sample.recoveredAt),
        value: sample.confirmedOrderCount,
        secondaryValue: sample.settledOrderCount,
      }));
  const arrivalAvailable = arrivalEvidence !== null || arrivalPoints.length > 0;
  const inventoryAvailable = terminal !== null || inventoryPoints.length > 0;
  const backlogAvailable = terminal !== null || backlogPoints.length > 0;
  const convergenceAvailable = terminal !== null || confirmationLiveSamples.length > 0;
  const xMax = terminal
    ? elapsedSeconds(terminal.window.anchoredAt, terminal.window.endedAt)
    : Math.max(
        0,
        ...displayedLiveSamples.map((sample) => toAxisElapsed(sample.recoveredAt)),
        ...arrivalPoints.map((point) => point.elapsedSeconds),
      );
  const markers = terminal ? terminalEventMarkers(terminal, arrivalEvidence) : [];
  const confirmationSecondary = Boolean(
    (terminal?.confirmationConvergence.failedOrderCount ?? input.failedOrders ?? 0) > 0,
  );
  return {
    axis,
    charts: {
      arrival: {
        area: false,
        available: arrivalAvailable,
        points: arrivalPoints,
        secondary: false,
        xMax,
      },
      inventory: {
        area: true,
        available: inventoryAvailable,
        points: inventoryPoints,
        secondary: false,
        xMax,
      },
      backlog: {
        area: true,
        available: backlogAvailable,
        points: backlogPoints,
        secondary: false,
        xMax,
      },
      confirmation: {
        area: false,
        available: convergenceAvailable,
        points: convergencePoints,
        secondary: confirmationSecondary,
        xMax,
      },
    },
    hasEvidence: Boolean(terminal || arrivalEvidence || displayedLiveSamples.length > 0),
    headlines,
    markers,
  };
}

export function GoldSignals(input: GoldSignalInput) {
  const { axis, charts, hasEvidence, headlines, markers } = deriveGoldSignalCharts(input);
  const terminalRun = input.runStatus === "completed" || input.runStatus === "failed";
  if (!hasEvidence) {
    return (
      <section className="col-span-full rounded-lg border border-border bg-surface p-4">
        <p className="m-0 text-xs font-bold uppercase text-muted">Sale evidence</p>
        <h2 className="m-0 mt-1 text-xl font-bold leading-tight text-ink">
          Arrival → reservation → backlog → confirmation
        </h2>
        <SignalHeadlineGrid headlines={headlines} />
      </section>
    );
  }
  return (
    <section className="col-span-full rounded-lg border border-border bg-surface p-4">
      <div className="mb-4">
        <p className="m-0 text-xs font-bold uppercase text-muted">Sale evidence</p>
        <h2 className="m-0 mt-1 text-xl font-bold leading-tight text-ink">
          Arrival → reservation → backlog → confirmation
        </h2>
        <p className="m-0 mt-1 text-xs leading-5 text-muted">
          {input.terminalSummary
            ? charts.arrival.available
              ? `All panels cover the ${recordedRunDescriptor(input.runStatus)} from its first checkout attempt to its final timeline boundary.`
              : `The timeline panels cover the ${recordedRunDescriptor(input.runStatus)} through its final timeline boundary; request-arrival evidence was not recorded.`
            : terminalRun
              ? "Final timeline evidence was not recorded; the run evidence that was recorded is shown where available."
              : "Live panels show the available run updates."}
        </p>
      </div>
      <SignalHeadlineGrid headlines={headlines} />
      <div className="grid gap-4">
        <SignalPanel
          available={charts.arrival.available}
          ariaLabel="Request arrival timeline"
          caption={`Checkout attempts started by the load generator in ${
            input.arrivalSummary && hasObservedRequestArrivals(input.arrivalSummary)
              ? formatWindowSecondsAdjective(input.arrivalSummary.peakArrivalWindowSeconds)
              : formatWindowSecondsAdjective(liveTrafficMetricWindowSeconds)
          } windows.`}
          headline={headlines.arrival.detail}
          id="watch-signal-arrival"
          markers={markers}
          points={charts.arrival.points}
          title="Request arrival"
          xMax={charts.arrival.xMax}
        />
        <SignalPanel
          available={charts.inventory.available}
          ariaLabel="Inventory timeline"
          area
          caption="Stock remaining after immediate reservations; oversold units exceed starting stock."
          headline={headlines.inventory.detail}
          id="watch-signal-inventory"
          markers={markers}
          points={charts.inventory.points}
          title="Inventory remaining"
          xMax={charts.inventory.xMax}
        />
        <SignalPanel
          available={charts.backlog.available}
          ariaLabel="Processing backlog timeline"
          area
          caption={`Current and final backlog counts are reserved orders awaiting their first processing start. Drain duration runs from the first queued order to final backlog zero. Run-owned retrying orders are shown separately (${formatNumber(
            input.retryingOrderCount ?? 0,
          )}) because retries can return to processing without re-entering this backlog.`}
          headline={headlines.backlog.detail}
          id="watch-signal-backlog"
          markers={markers}
          points={charts.backlog.points}
          title="Processing backlog"
          xMax={charts.backlog.xMax}
        />
        <SignalPanel
          available={charts.confirmation.available}
          ariaLabel="Confirmation timeline"
          caption="Cumulative confirmed orders. Reservation-to-confirmation time is elapsed from reservation secured to final confirmation."
          headline={headlines.confirmation.detail}
          id="watch-signal-confirmation"
          markers={markers}
          points={charts.confirmation.points}
          secondary={charts.confirmation.secondary}
          title="Reservation-to-confirmation"
          xMax={charts.confirmation.xMax}
        />
      </div>
      <p className="m-0 mt-4 text-xs text-muted">
        {`Shared axis: 0s ${axis.startLabel} · ${formatAxisSeconds(charts.arrival.xMax)} ${axis.endLabel}`}
      </p>
    </section>
  );
}

function SignalPanel({
  available = true,
  ariaLabel,
  area = false,
  caption,
  headline,
  id,
  markers,
  points,
  secondary = false,
  title,
  xMax,
}: {
  available?: boolean;
  ariaLabel: string;
  area?: boolean;
  caption: string;
  headline: string | null;
  /** Stable focus target for the Basic signal strip's contextual links. */
  id?: string;
  markers: EventMarker[];
  points: SignalPoint[];
  secondary?: boolean;
  title: string;
  xMax: number;
}) {
  if (!available) {
    return (
      <article
        className="grid grid-cols-[minmax(13rem,0.35fr)_minmax(0,1fr)] gap-4 border-t border-border pt-3 max-[700px]:grid-cols-1"
        id={id}
        tabIndex={-1}
      >
        <div>
          <h3 className="m-0 text-sm font-bold text-ink">{title}</h3>
          <p className="m-0 mt-1 text-xs leading-5 text-muted">{caption}</p>
        </div>
      </article>
    );
  }
  return (
    <article
      className="grid grid-cols-[minmax(13rem,0.35fr)_minmax(0,1fr)] gap-4 border-t border-border pt-3 max-[700px]:grid-cols-1"
      id={id}
      tabIndex={-1}
    >
      <div>
        <h3 className="m-0 text-sm font-bold text-ink">{title}</h3>
        {headline ? (
          <p className="m-0 mt-1 text-xs font-semibold text-muted-strong">{headline}</p>
        ) : null}
        <p className="m-0 mt-1 text-xs leading-5 text-muted">{caption}</p>
      </div>
      <div>
        <SignalSparkline
          ariaLabel={ariaLabel}
          area={area}
          markers={markers}
          points={points}
          secondary={secondary}
          xMax={xMax}
        />
        <details className="mt-2 text-xs text-muted">
          <summary className="cursor-pointer font-semibold">Text samples</summary>
          {points.length === 0 ? (
            <p>No samples retained.</p>
          ) : (
            <ol className="m-0 mt-2 grid max-h-40 gap-1 overflow-auto pl-5">
              {points.map((point) => (
                <li key={point.elapsedSeconds}>
                  {formatAxisSeconds(point.elapsedSeconds)}: {formatNumber(point.value)}
                  {secondary && point.secondaryValue !== undefined
                    ? ` confirmed, ${formatNumber(point.secondaryValue)} settled`
                    : ""}
                </li>
              ))}
            </ol>
          )}
        </details>
      </div>
    </article>
  );
}

export function SignalSparkline({
  ariaLabel,
  area,
  markers,
  points,
  secondary,
  xMax,
}: {
  ariaLabel: string;
  area: boolean;
  markers: EventMarker[];
  points: SignalPoint[];
  secondary: boolean;
  xMax: number;
}) {
  const width = 640;
  const height = 96;
  const yMax = Math.max(1, ...points.flatMap((point) => [point.value, point.secondaryValue ?? 0]));
  const coordinates = points.map((point) => ({
    x: scale(point.elapsedSeconds, xMax, width),
    y: height - scale(point.value, yMax, height),
    secondaryY:
      point.secondaryValue === undefined
        ? null
        : height - scale(point.secondaryValue, yMax, height),
  }));
  const line = coordinates.map((point) => `${point.x},${point.y}`).join(" ");
  const secondaryLine = coordinates
    .flatMap((point) => (point.secondaryY === null ? [] : [`${point.x},${point.secondaryY}`]))
    .join(" ");
  const areaPath =
    coordinates.length === 0
      ? ""
      : `M 0 ${height} L ${line.replaceAll(" ", " L ")} L ${width} ${height} Z`;

  return (
    <svg
      aria-label={ariaLabel}
      className="block h-24 w-full overflow-visible rounded bg-surface-muted"
      preserveAspectRatio="none"
      role="img"
      viewBox={`0 0 ${width} ${height}`}
    >
      {markers.map((marker) => (
        <line
          className="stroke-border"
          key={`${marker.label}-${marker.elapsedSeconds}`}
          x1={scale(marker.elapsedSeconds, xMax, width)}
          x2={scale(marker.elapsedSeconds, xMax, width)}
          y1={0}
          y2={height}
        >
          <title>{marker.label}</title>
        </line>
      ))}
      {area && areaPath ? <path className="fill-accent/20" d={areaPath} /> : null}
      {line ? (
        <polyline
          className="fill-none stroke-accent"
          points={line}
          strokeWidth={3}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {secondary && secondaryLine ? (
        <polyline
          className="fill-none stroke-danger"
          points={secondaryLine}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}

export function scale(value: number, maximum: number, range: number): number {
  return Math.max(0, Math.min(range, (value / Math.max(1, maximum)) * range));
}

/** Contracts decide what counts as an observation; this only narrows the unobserved case away. */
function observedArrivalEvidence(
  summary: RequestArrivalSummary | null,
): RequestArrivalSummary | null {
  return summary && hasObservedRequestArrivals(summary) ? summary : null;
}

/**
 * All four panels share one axis, so its origin is the earliest evidence any of them can plot and
 * the boundary phrases must name whichever source supplied it.
 */
function deriveSignalAxis(input: {
  arrival: RequestArrivalSummary | null;
  firstLiveSampleAt: string | null;
  terminal: RunSignalTimelineSummary | null;
  terminalRun: boolean;
}): SignalAxis {
  if (input.terminal) {
    return {
      originMs: Date.parse(input.terminal.window.anchoredAt),
      startLabel: "first checkout attempt",
      endLabel: "final timeline boundary",
    };
  }
  const arrivalOriginMs = Date.parse(
    input.arrival?.firstAttemptStartedAt ??
      input.arrival?.arrivalRateSeries[0]?.windowStartedAt ??
      "",
  );
  const liveOriginMs = Date.parse(input.firstLiveSampleAt ?? "");
  const hasLiveOrigin = Number.isFinite(liveOriginMs);
  const browserUpdate = input.terminalRun ? "retained run update" : "available update";
  const arrivalStartsAxis =
    Number.isFinite(arrivalOriginMs) && (!hasLiveOrigin || arrivalOriginMs < liveOriginMs);
  if (arrivalStartsAxis) {
    return {
      originMs: arrivalOriginMs,
      startLabel: "first checkout attempt",
      endLabel: hasLiveOrigin ? `latest ${browserUpdate}` : "last recorded arrival window",
    };
  }
  return {
    originMs: liveOriginMs,
    startLabel: `first ${browserUpdate}`,
    endLabel: `latest ${browserUpdate}`,
  };
}

function recordedRunDescriptor(status: DemoRunStatus | null): string {
  if (status === "completed") return "completed run";
  if (status === "failed") return "failed run";
  return "recorded run window";
}

function terminalEventMarkers(
  summary: RunSignalTimelineSummary,
  arrival: RequestArrivalSummary | null,
): EventMarker[] {
  const markers: EventMarker[] = [{ elapsedSeconds: 0, label: "first checkout attempt" }];
  if (summary.inventoryDrain.timeToDepletionSeconds !== null) {
    markers.push({
      elapsedSeconds: summary.inventoryDrain.timeToDepletionSeconds,
      label: "stock depleted",
    });
  }
  if (arrival) {
    markers.push({
      elapsedSeconds: arrival.dispatchDurationSeconds,
      label: "last checkout attempt",
    });
  }
  if (summary.queueBacklog.backlogDrainedAt) {
    markers.push({
      elapsedSeconds: elapsedSeconds(
        summary.window.anchoredAt,
        summary.queueBacklog.backlogDrainedAt,
      ),
      label: "backlog drained",
    });
  }
  markers.push({
    elapsedSeconds: elapsedSeconds(summary.window.anchoredAt, summary.window.endedAt),
    label: "final timeline boundary",
  });
  return markers;
}

function Headline({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-bold text-muted">{label}</dt>
      <dd className="m-0 mt-1 font-semibold text-ink">{value}</dd>
    </div>
  );
}

function SignalHeadlineGrid({ headlines }: { headlines: SignalHeadlines }) {
  return (
    <dl
      className="m-0 mb-4 grid grid-cols-4 gap-3 max-[900px]:grid-cols-2"
      data-signal-headlines=""
    >
      <Headline label="Request arrival" value={headlines.arrival.value} />
      <Headline label="Inventory" value={headlines.inventory.value} />
      <Headline label="Processing backlog" value={headlines.backlog.value} />
      <Headline label="Confirmation" value={headlines.confirmation.value} />
    </dl>
  );
}

function elapsedSeconds(startedAt: string, endedAt: string): number {
  return Math.max(0, (Date.parse(endedAt) - Date.parse(startedAt)) / 1_000);
}

/**
 * Chart-axis coordinates, not named measurements. They keep one fixed unit so tick labels and
 * sample rows stay directly comparable down a column; that is the technical-details reason this
 * surface does not use the tiered duration policy.
 */
function formatAxisSeconds(value: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}s`;
}

/**
 * Signal magnitudes can be fractional (rates, sampled backlog values), so they keep two decimals
 * rather than the whole-count formatter. Grouping still follows the shared `en-US` policy.
 */
function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}
