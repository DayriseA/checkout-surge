import type {
  ConsistencyLagSummary,
  RequestArrivalSummary,
  RunSignalTimelineHeadline,
  RunSignalTimelineSummary,
} from "@checkout-surge/contracts";
import type { RunSignalLiveSample } from "../lib/dashboard-projection-state";
import {
  formatCount,
  formatDurationMs,
  formatWindowSecondsAdjective,
} from "../lib/presentation/format";

type SignalPoint = {
  elapsedSeconds: number;
  value: number;
  secondaryValue?: number;
};

type EventMarker = { elapsedSeconds: number; label: string };

export function GoldSignals({
  acceptedReservations,
  arrivalSummary,
  liveLag = null,
  liveSamples,
  oversoldUnits,
  retryingOrderCount = 0,
  startingStock = null,
  terminalSummary,
}: {
  acceptedReservations: number;
  arrivalSummary: RequestArrivalSummary | null;
  liveLag?: ConsistencyLagSummary | null;
  liveSamples?: RunSignalLiveSample[];
  oversoldUnits: number;
  retryingOrderCount?: number;
  startingStock?: number | null;
  terminalSummary: RunSignalTimelineSummary | null;
}) {
  const terminal = terminalSummary;
  const retainedLiveSamples = liveSamples ?? [];
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
  if (!terminal && displayedLiveSamples.length === 0) {
    const absence = liveSamples ? "Not yet available" : "Unavailable for this run";
    return (
      <section className="col-span-12 rounded-lg border border-border bg-surface p-4">
        <p className="m-0 text-xs font-bold uppercase text-muted">Four Gold Signals</p>
        <h2 className="m-0 mt-1 text-xl font-bold leading-tight text-ink">
          Arrival → reservation → backlog → confirmation
        </h2>
        <dl className="m-0 mt-4 grid grid-cols-4 gap-3 max-[900px]:grid-cols-2">
          <Headline label="Request arrival" value={absence} />
          <Headline label="Inventory drain" value={absence} />
          <Headline label="Processing backlog" value={absence} />
          <Headline label="Confirmation convergence" value={absence} />
        </dl>
      </section>
    );
  }
  const timelineOriginMs = Date.parse(
    terminal?.window.anchoredAt ?? displayedLiveSamples[0]?.recoveredAt ?? "",
  );
  const toLiveElapsed = (timestamp: string) =>
    Number.isFinite(timelineOriginMs)
      ? Math.max(0, (Date.parse(timestamp) - timelineOriginMs) / 1_000)
      : 0;
  const arrivalPoints: SignalPoint[] =
    terminal && arrivalSummary
      ? arrivalSummary.arrivalRateSeries.map((sample) => ({
          elapsedSeconds: Math.max(
            0,
            (Date.parse(sample.windowStartedAt) - timelineOriginMs) / 1_000,
          ),
          value: sample.ratePerSecond,
        }))
      : displayedLiveSamples.flatMap((sample) =>
          sample.arrivalRatePerSecond === null
            ? []
            : [
                {
                  elapsedSeconds: toLiveElapsed(sample.recoveredAt),
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
                elapsedSeconds: toLiveElapsed(sample.recoveredAt),
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
                elapsedSeconds: toLiveElapsed(sample.recoveredAt),
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
    : displayedLiveSamples.map((sample) => ({
        elapsedSeconds: toLiveElapsed(sample.recoveredAt),
        value: sample.confirmedOrderCount,
        secondaryValue: sample.settledOrderCount,
      }));
  const arrivalAvailable = terminal !== null || arrivalPoints.length > 0;
  const inventoryAvailable = terminal !== null || inventoryPoints.length > 0;
  const backlogAvailable = terminal !== null || backlogPoints.length > 0;
  const convergenceAvailable =
    terminal !== null ||
    liveLag !== null ||
    displayedLiveSamples.some(
      (sample) =>
        sample.confirmedOrderCount > 0 ||
        sample.failedOrderCount > 0 ||
        sample.pendingOrderCount > 0,
    );
  const xMax = terminal
    ? elapsedSeconds(terminal.window.anchoredAt, terminal.window.endedAt)
    : Math.max(
        0,
        ...displayedLiveSamples.map((sample) => toLiveElapsed(sample.recoveredAt)),
        ...arrivalPoints.map((point) => point.elapsedSeconds),
      );
  const markers = terminal ? terminalEventMarkers(terminal, arrivalSummary) : [];
  const livePeakBacklog = Math.max(0, ...backlogPoints.map((point) => point.value));
  const liveConfirmed = displayedLiveSamples.at(-1)?.confirmedOrderCount ?? 0;
  const liveFailed = displayedLiveSamples.at(-1)?.failedOrderCount ?? 0;
  const livePending = displayedLiveSamples.at(-1)?.pendingOrderCount ?? 0;
  const convergence = terminal?.confirmationConvergence;
  const lag = convergence ?? liveLag;
  const convergenceStatus = terminal
    ? terminal.convergenceDurationSeconds === null
      ? terminal.confirmationConvergence.pendingAtCaptureCount > 0
        ? `Convergence incomplete · ${formatNumber(
            terminal.confirmationConvergence.pendingAtCaptureCount,
          )} pending`
        : "Convergence duration unavailable"
      : `Converged in ${formatDuration(terminal.convergenceDurationSeconds)}`
    : `Convergence in progress · ${formatNumber(livePending)} pending`;
  const displayedStartingStock = terminal?.inventoryDrain.startingStock ?? startingStock;

  return (
    <section className="col-span-12 rounded-lg border border-border bg-surface p-4">
      <div className="mb-4">
        <p className="m-0 text-xs font-bold uppercase text-muted">Four Gold Signals</p>
        <h2 className="m-0 mt-1 text-xl font-bold leading-tight text-ink">
          Arrival → reservation → backlog → confirmation
        </h2>
        <p className="m-0 mt-1 text-xs leading-5 text-muted">
          {terminal
            ? "All panels share elapsed seconds from the first checkout attempt."
            : "All panels share elapsed seconds from the first retained live projection."}{" "}
          {terminal
            ? `PostgreSQL-derived terminal series use ${
                formatCount(terminal.window.bucketCount) ?? "an unavailable number of"
              } buckets of ${formatAxisSeconds(terminal.window.bucketWidthSeconds)} each.`
            : "Reloading restarts this bounded live window."}
        </p>
      </div>
      <div className="grid gap-4">
        <SignalPanel
          available={arrivalAvailable}
          ariaLabel={`Request arrival peaked at ${formatRate(
            arrivalSummary?.peakArrivalRatePerSecond ??
              Math.max(0, ...arrivalPoints.map((point) => point.value)),
          )}.`}
          caption={`Checkout attempts started by k6 in ${
            terminal && arrivalSummary
              ? formatWindowSecondsAdjective(arrivalSummary.peakArrivalWindowSeconds)
              : "one-second"
          } producer event-time windows.`}
          headline={`${arrivalSummary ? "Peak " : "Latest/retained peak "}${formatRate(
            arrivalSummary?.peakArrivalRatePerSecond ??
              Math.max(0, ...arrivalPoints.map((point) => point.value)),
          )}`}
          markers={markers}
          points={arrivalPoints}
          title="Request arrival"
          xMax={xMax}
        />
        <SignalPanel
          available={inventoryAvailable}
          ariaLabel={`Inventory has ${formatNumber(
            terminal?.inventoryDrain.remainingStock ?? inventoryPoints.at(-1)?.value ?? 0,
          )} units remaining from ${
            displayedStartingStock === null
              ? "an unavailable starting stock"
              : `${formatNumber(displayedStartingStock)} starting units`
          }, with ${formatNumber(oversoldUnits)} oversold units.`}
          area
          caption="Stock remaining after immediate reservations; oversell is reserved units above starting stock."
          headline={`Start ${
            displayedStartingStock === null
              ? "not yet available"
              : formatNumber(displayedStartingStock)
          } · ${formatNumber(
            terminal?.inventoryDrain.remainingStock ?? inventoryPoints.at(-1)?.value ?? 0,
          )} remaining · ${formatNumber(oversoldUnits)} oversold${
            terminal
              ? terminal.inventoryDrain.timeToDepletionSeconds === null
                ? " · not depleted"
                : ` · depleted in ${formatDuration(terminal.inventoryDrain.timeToDepletionSeconds)}`
              : ""
          }`}
          markers={markers}
          points={inventoryPoints}
          title="Inventory remaining"
          xMax={xMax}
        />
        <SignalPanel
          available={backlogAvailable}
          ariaLabel={`Processing backlog peaked at ${formatNumber(
            terminal?.queueBacklog.peakBacklog ?? livePeakBacklog,
          )} orders.`}
          area
          caption={`Live and durable backlog counts are accepted orders awaiting their first processing start. Drain duration runs from the first queued order to final backlog zero. Run-owned retrying orders are shown separately (${formatNumber(
            retryingOrderCount,
          )}) because retries can re-enter BullMQ without re-entering this backlog.`}
          headline={`Peak ${formatNumber(
            terminal?.queueBacklog.peakBacklog ?? livePeakBacklog,
          )} orders${
            terminal
              ? terminal.queueBacklog.drainDurationSeconds === null
                ? " · drain duration unavailable"
                : ` · drained in ${formatDuration(terminal.queueBacklog.drainDurationSeconds)}`
              : ""
          }`}
          markers={markers}
          points={backlogPoints}
          title="Processing backlog"
          xMax={xMax}
        />
        <SignalPanel
          available={convergenceAvailable}
          ariaLabel={`Of ${formatNumber(
            acceptedReservations,
          )} unique reservations secured, ${formatNumber(
            convergence?.confirmedOrderCount ?? liveConfirmed,
          )} were confirmed, ${formatNumber(
            convergence?.failedOrderCount ?? liveFailed,
          )} failed, and ${formatNumber(
            convergence?.pendingAtCaptureCount ?? livePending,
          )} remain pending. ${convergenceStatus}.`}
          caption="Cumulative confirmed orders. Lag is order confirmedAt minus reservation securedAt over confirmed orders only."
          headline={`${formatNumber(
            convergence?.confirmedOrderCount ?? liveConfirmed,
          )}/${formatNumber(acceptedReservations)} confirmed · ${formatNumber(
            convergence?.failedOrderCount ?? liveFailed,
          )} failed · ${formatNumber(convergence?.pendingAtCaptureCount ?? livePending)} pending`}
          markers={markers}
          points={convergencePoints}
          secondary={Boolean((convergence?.failedOrderCount ?? liveFailed) > 0)}
          title="Reservation-to-confirmation"
          xMax={xMax}
          {...(lag
            ? {
                secondaryHeadline: `Lag avg ${formatMilliseconds(lag.averageLagMs)}, p95 ${formatMilliseconds(
                  lag.p95LagMs,
                )}, max ${formatMilliseconds(lag.maxLagMs)} · ${convergenceStatus}`,
              }
            : { secondaryHeadline: `Lag not yet available · ${convergenceStatus}` })}
        />
      </div>
      <p className="m-0 mt-4 text-xs text-muted">
        {terminal
          ? `Shared axis: 0s first checkout attempt · ${formatAxisSeconds(xMax)} terminal timeline boundary`
          : `Shared axis: 0s first retained live projection · ${formatAxisSeconds(xMax)} latest retained live projection`}
      </p>
    </section>
  );
}

export function GoldSignalHeadlines({
  arrivalSummary,
  headline,
  oversoldUnits,
}: {
  arrivalSummary: RequestArrivalSummary;
  headline: RunSignalTimelineHeadline | null;
  oversoldUnits: number;
}) {
  if (!headline) {
    return <p className="m-0 mt-3 text-xs text-muted">Signal timeline evidence unavailable.</p>;
  }
  const confirmation = headline.confirmationConvergence;
  return (
    <dl className="m-0 mt-3 grid grid-cols-4 gap-3 max-[900px]:grid-cols-2">
      <Headline
        label="Request arrival"
        value={`Peak ${formatRate(arrivalSummary.peakArrivalRatePerSecond)} · dispatched in ${formatDuration(
          arrivalSummary.dispatchDurationSeconds,
        )}`}
      />
      <Headline
        label="Inventory"
        value={`Start ${formatNumber(headline.inventoryDrain.startingStock)} · ${formatNumber(
          headline.inventoryDrain.remainingStock,
        )} remaining · ${formatNumber(oversoldUnits)} oversold · ${
          headline.inventoryDrain.timeToDepletionSeconds === null
            ? "not depleted"
            : `depleted in ${formatDuration(headline.inventoryDrain.timeToDepletionSeconds)}`
        }`}
      />
      <Headline
        label="Processing backlog"
        value={`Peak ${formatNumber(headline.queueBacklog.peakBacklog)} · ${
          headline.queueBacklog.drainDurationSeconds === null
            ? "drain duration unavailable"
            : `drained in ${formatDuration(headline.queueBacklog.drainDurationSeconds)}`
        } · first queued order to final backlog zero`}
      />
      <Headline
        label="Confirmation"
        value={`${formatNumber(confirmation.confirmedOrderCount)} confirmed · ${formatNumber(
          confirmation.failedOrderCount,
        )} failed · ${formatNumber(confirmation.pendingAtCaptureCount)} pending · lag avg ${formatMilliseconds(
          confirmation.averageLagMs,
        )}, p95 ${formatMilliseconds(confirmation.p95LagMs)}, max ${formatMilliseconds(
          confirmation.maxLagMs,
        )} · ${
          headline.convergenceDurationSeconds === null
            ? confirmation.pendingAtCaptureCount > 0
              ? "convergence incomplete"
              : "convergence duration unavailable"
            : `converged in ${formatDuration(headline.convergenceDurationSeconds)}`
        }`}
      />
    </dl>
  );
}

function SignalPanel({
  available = true,
  ariaLabel,
  area = false,
  caption,
  headline,
  markers,
  points,
  secondary = false,
  secondaryHeadline,
  title,
  xMax,
}: {
  available?: boolean;
  ariaLabel: string;
  area?: boolean;
  caption: string;
  headline: string;
  markers: EventMarker[];
  points: SignalPoint[];
  secondary?: boolean;
  secondaryHeadline?: string;
  title: string;
  xMax: number;
}) {
  if (!available) {
    return (
      <article className="grid grid-cols-[minmax(13rem,0.35fr)_minmax(0,1fr)] gap-4 border-t border-border pt-3 max-[700px]:grid-cols-1">
        <div>
          <h3 className="m-0 text-sm font-bold text-ink">{title}</h3>
          <p className="m-0 mt-1 text-base font-bold text-muted">Not yet available</p>
          <p className="m-0 mt-1 text-xs leading-5 text-muted">{caption}</p>
        </div>
      </article>
    );
  }
  return (
    <article className="grid grid-cols-[minmax(13rem,0.35fr)_minmax(0,1fr)] gap-4 border-t border-border pt-3 max-[700px]:grid-cols-1">
      <div>
        <h3 className="m-0 text-sm font-bold text-ink">{title}</h3>
        <p className="m-0 mt-1 text-base font-bold text-ink">{headline}</p>
        {secondaryHeadline ? (
          <p className="m-0 mt-1 text-xs font-semibold text-muted-strong">{secondaryHeadline}</p>
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
    label: "terminal timeline boundary",
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

function elapsedSeconds(startedAt: string, endedAt: string): number {
  return Math.max(0, (Date.parse(endedAt) - Date.parse(startedAt)) / 1_000);
}

function formatRate(value: number): string {
  return `${formatNumber(value)} attempts/s`;
}

function formatDuration(value: number): string {
  return formatDurationMs(value * 1_000) ?? "not yet available";
}

function formatMilliseconds(value: number | null): string {
  return formatDurationMs(value) ?? "not yet available";
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
