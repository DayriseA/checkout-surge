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
import { FieldHint } from "./field-hint";
import {
  type ChartMarker,
  type ChartSeries,
  SignalChart,
  SignalCursorProvider,
} from "./signal-chart";
import {
  type ChartPoint,
  formatSeconds as formatAxisSeconds,
  formatNumber,
  scale,
} from "./signal-chart-math";
import { SignalCsvDownload } from "./signal-csv-download";

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
 * The single sample-to-points selection shared by the full charts and the Watch signal strip, so
 * both presentations always describe the same evidence.
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

export function GoldSignals({ csvFileName, ...input }: GoldSignalInput & { csvFileName?: string }) {
  const derived = deriveGoldSignalCharts(input);
  const { axis, charts, hasEvidence, headlines } = derived;
  const terminalRun = input.runStatus === "completed" || input.runStatus === "failed";
  if (!hasEvidence) {
    return (
      <section className="col-span-full rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4">
        <p className="m-0 text-xs font-medium text-muted">Sale evidence</p>
        <h2 className="type-title m-0 mt-0.5 text-xl leading-tight text-ink">
          Arrival → reservation → backlog → confirmation
        </h2>
        <SignalHeadlineGrid headlines={headlines} />
      </section>
    );
  }
  const markers = numberedMarkers(derived.markers);
  const confirmationSeries: ChartSeries[] = [
    { label: "Confirmed", points: charts.confirmation.points, tone: "accent" },
  ];
  if (charts.confirmation.secondary) {
    confirmationSeries.push({
      label: "Settled",
      points: settledPoints(charts.confirmation.points),
      tone: "danger",
    });
  }
  return (
    <section className="col-span-full rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 text-xs font-medium text-muted">Sale evidence</p>
          <h2 className="type-title m-0 mt-0.5 text-xl leading-tight text-ink">
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
        {csvFileName ? <SignalCsvDownload csv={signalCsv(charts)} fileName={csvFileName} /> : null}
      </div>
      <SignalHeadlineGrid headlines={headlines} />
      <SignalCursorProvider>
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
            series={[{ label: "Arrivals", points: charts.arrival.points, tone: "accent" }]}
            title="Request arrival"
            unit="attempts/s"
            xMax={charts.arrival.xMax}
          />
          <SignalPanel
            available={charts.backlog.available}
            ariaLabel="Processing backlog timeline"
            caption="Reserved orders waiting for their first processing start."
            headline={headlines.backlog.detail}
            hint={`Drain duration runs from the first queued order to final backlog zero. Run-owned retrying orders are counted separately (${formatNumber(
              input.retryingOrderCount ?? 0,
            )}) because retries can return to processing without re-entering this backlog.`}
            id="watch-signal-backlog"
            markers={markers}
            series={[
              { area: true, label: "Backlog", points: charts.backlog.points, tone: "accent" },
            ]}
            title="Processing backlog"
            unit="orders"
            xMax={charts.backlog.xMax}
          />
          <SignalPanel
            available={charts.confirmation.available}
            ariaLabel="Confirmation timeline"
            caption={
              charts.confirmation.secondary
                ? "Cumulative confirmed orders; settled adds failed orders."
                : "Cumulative confirmed orders."
            }
            headline={headlines.confirmation.detail}
            hint="Reservation-to-confirmation time is elapsed from reservation secured to final confirmation."
            id="watch-signal-confirmation"
            markers={markers}
            series={confirmationSeries}
            title="Reservation-to-confirmation"
            unit="orders"
            xMax={charts.confirmation.xMax}
          />
        </div>
      </SignalCursorProvider>
      <SignalAxisLegend axis={axis} markers={derived.markers} xMax={charts.arrival.xMax} />
    </section>
  );
}

/**
 * The public report's single timeline: orders waiting to be processed against orders confirmed,
 * on one shared scale, so the drain and the convergence read as one story.
 */
export function PublicSignalChart(input: GoldSignalInput) {
  const { axis, charts, markers } = deriveGoldSignalCharts(input);
  const series: ChartSeries[] = [
    ...(charts.backlog.available
      ? [{ area: true, label: "Waiting", points: charts.backlog.points, tone: "accent" as const }]
      : []),
    ...(charts.confirmation.available
      ? [{ label: "Confirmed", points: charts.confirmation.points, tone: "ok" as const }]
      : []),
  ];
  return (
    <section className="rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4">
      <h3 className="type-title m-0 text-base leading-tight text-ink">Orders over time</h3>
      {series.length === 0 ? (
        <p className="m-0 mt-2 text-sm text-muted">
          The order timeline was not recorded for this run.
        </p>
      ) : (
        <>
          <p className="m-0 mb-3 mt-1 text-xs leading-5 text-muted">
            Reserved orders waiting to be processed, and orders confirmed so far.
          </p>
          <SignalCursorProvider>
            <SignalChart
              ariaLabel="Orders over time"
              markers={numberedMarkers(markers)}
              series={series}
              unit="orders"
              xMax={charts.backlog.xMax}
            />
          </SignalCursorProvider>
          <SignalAxisLegend axis={axis} markers={markers} xMax={charts.backlog.xMax} />
        </>
      )}
    </section>
  );
}

function SignalPanel({
  available,
  ariaLabel,
  caption,
  headline,
  hint,
  id,
  markers,
  series,
  title,
  unit,
  xMax,
}: {
  available: boolean;
  ariaLabel: string;
  caption: string;
  headline: string | null;
  hint?: string;
  /** Stable focus target for the signal strip's contextual links. */
  id: string;
  markers: ChartMarker[];
  series: ChartSeries[];
  title: string;
  unit: string;
  xMax: number;
}) {
  return (
    <article
      className="grid grid-cols-[minmax(13rem,0.35fr)_minmax(0,1fr)] gap-4 border-t border-border pt-3 max-[700px]:grid-cols-1"
      id={id}
      tabIndex={-1}
    >
      <div>
        <h3 className="m-0 flex items-center gap-1.5 text-sm font-bold text-ink">
          {title}
          {hint ? <FieldHint label={title} text={hint} /> : null}
        </h3>
        {available && headline ? (
          <p className="m-0 mt-1 text-xs font-semibold text-muted-strong">{headline}</p>
        ) : null}
        <p className="m-0 mt-1 text-xs leading-5 text-muted">{caption}</p>
      </div>
      {available ? (
        <SignalChart
          ariaLabel={ariaLabel}
          markers={markers}
          series={series}
          unit={unit}
          xMax={xMax}
        />
      ) : null}
    </article>
  );
}

/** Names what the axis ends are and which event each numbered marker line stands for. */
function SignalAxisLegend({
  axis,
  markers,
  xMax,
}: {
  axis: SignalAxis;
  markers: EventMarker[];
  xMax: number;
}) {
  return (
    <div className="mt-4 grid gap-1 text-xs text-muted">
      {markers.length > 0 ? (
        <ol className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
          {markers.map((marker, index) => (
            <li className="flex items-center gap-1.5" key={marker.label}>
              <span className="grid size-4 place-items-center rounded-full bg-muted text-[10px] font-bold leading-none text-white">
                {index + 1}
              </span>
              {`${marker.label} · ${formatAxisSeconds(marker.elapsedSeconds)}`}
            </li>
          ))}
        </ol>
      ) : null}
      <p className="m-0">
        {`Shared axis: 0s ${axis.startLabel} · ${formatAxisSeconds(xMax)} ${axis.endLabel}`}
      </p>
    </div>
  );
}

function numberedMarkers(markers: EventMarker[]): ChartMarker[] {
  return markers.map((marker, index) => ({
    elapsedSeconds: marker.elapsedSeconds,
    number: index + 1,
  }));
}

function settledPoints(points: SignalPoint[]): ChartPoint[] {
  return points.flatMap((point) =>
    point.secondaryValue === undefined
      ? []
      : [{ elapsedSeconds: point.elapsedSeconds, value: point.secondaryValue }],
  );
}

/** Long-format CSV of every retained series, including the inventory drain the panels omit. */
export function signalCsv(charts: Record<GoldSignalKey, GoldSignalChart>): string {
  const series: Array<[string, ChartPoint[]]> = [
    ["arrival_attempts_per_second", charts.arrival.points],
    ["remaining_stock", charts.inventory.points],
    ["processing_backlog", charts.backlog.points],
    ["confirmed_orders", charts.confirmation.points],
    ["settled_orders", settledPoints(charts.confirmation.points)],
  ];
  const rows = series.flatMap(([signal, points]) =>
    points.map((point) => `${signal},${point.elapsedSeconds},${point.value}`),
  );
  return ["signal,elapsed_seconds,value", ...rows].join("\n");
}

export function SignalSparkline({
  ariaLabel,
  area,
  points,
  secondary,
  xMax,
}: {
  ariaLabel: string;
  area: boolean;
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
  const singlePoint = coordinates.length === 1 ? coordinates[0] : undefined;

  return (
    <svg
      aria-label={ariaLabel}
      className="block h-24 w-full overflow-visible rounded bg-surface-muted"
      preserveAspectRatio="none"
      role="img"
      viewBox={`0 0 ${width} ${height}`}
    >
      {area && areaPath ? <path className="fill-accent/20" d={areaPath} /> : null}
      {line ? (
        <polyline
          className="fill-none stroke-accent"
          points={line}
          strokeWidth={3}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {singlePoint ? (
        <circle className="fill-accent" cx={singlePoint.x} cy={singlePoint.y} r={4} />
      ) : null}
      {secondary && secondaryLine ? (
        <polyline
          className="fill-none stroke-danger"
          points={secondaryLine}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {secondary && singlePoint?.secondaryY !== null && singlePoint?.secondaryY !== undefined ? (
        <circle className="fill-danger" cx={singlePoint.x} cy={singlePoint.secondaryY} r={3} />
      ) : null}
    </svg>
  );
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

/** Interior events only: the axis ends are already named by the shared-axis legend. */
function terminalEventMarkers(
  summary: RunSignalTimelineSummary,
  arrival: RequestArrivalSummary | null,
): EventMarker[] {
  const markers: EventMarker[] = [];
  if (summary.inventoryDrain.timeToDepletionSeconds !== null) {
    markers.push({
      elapsedSeconds: summary.inventoryDrain.timeToDepletionSeconds,
      label: "Stock depleted",
    });
  }
  if (arrival) {
    markers.push({
      elapsedSeconds: arrival.dispatchDurationSeconds,
      label: "Last checkout attempt",
    });
  }
  if (summary.queueBacklog.backlogDrainedAt) {
    markers.push({
      elapsedSeconds: elapsedSeconds(
        summary.window.anchoredAt,
        summary.queueBacklog.backlogDrainedAt,
      ),
      label: "Backlog drained",
    });
  }
  return markers.sort((left, right) => left.elapsedSeconds - right.elapsedSeconds);
}

function Headline({
  detail,
  id,
  label,
  value,
}: {
  detail?: string | null;
  id?: string;
  label: string;
  value: string;
}) {
  return (
    <div id={id} tabIndex={id ? -1 : undefined}>
      <dt className="text-xs font-bold text-muted">{label}</dt>
      <dd className="m-0 mt-1 font-semibold text-ink">{value}</dd>
      {detail ? <dd className="m-0 mt-0.5 text-xs text-muted-strong">{detail}</dd> : null}
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
      {/* Inventory has no chart panel (it drains in a sliver of the axis), so its detail and the
          signal strip's focus target live here. */}
      <Headline
        detail={headlines.inventory.detail}
        id="watch-signal-inventory"
        label="Inventory"
        value={headlines.inventory.value}
      />
      <Headline label="Processing backlog" value={headlines.backlog.value} />
      <Headline label="Confirmation" value={headlines.confirmation.value} />
    </dl>
  );
}

function elapsedSeconds(startedAt: string, endedAt: string): number {
  return Math.max(0, (Date.parse(endedAt) - Date.parse(startedAt)) / 1_000);
}
