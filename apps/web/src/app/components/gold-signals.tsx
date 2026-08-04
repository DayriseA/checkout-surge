import type {
  ConsistencyLagSummary,
  DemoRunStatus,
  RequestArrivalSummary,
  RunSignalTimelineHeadline,
  RunSignalTimelineSummary,
} from "@checkout-surge/contracts";
import { hasObservedRequestArrivals } from "@checkout-surge/contracts";
import type { RunSignalLiveSample } from "../lib/dashboard-projection-state";
import { formatDurationMs, formatWindowSecondsAdjective } from "../lib/presentation/format";
import {
  isRunEvidenceSettled,
  liveTrafficMetricWindowSeconds,
  publicVocabulary,
  rateWindowLabel,
  runEvidenceAbsence,
} from "../lib/presentation/public-vocabulary";

type SignalPoint = {
  elapsedSeconds: number;
  value: number;
  secondaryValue?: number;
};

type EventMarker = { elapsedSeconds: number; label: string };

/** Axis origin and the two boundary phrases that name what the origin and the maximum are. */
type SignalAxis = { originMs: number; startLabel: string; endLabel: string };

const oversellUnknownPhrase = "oversell unknown";

export function GoldSignals({
  acceptedReservations,
  arrivalSummary,
  liveLag = null,
  liveSamples,
  oversoldUnits,
  retryingOrderCount = 0,
  runStatus,
  startingStock = null,
  terminalSummary,
}: {
  acceptedReservations: number | null;
  arrivalSummary: RequestArrivalSummary | null;
  liveLag?: ConsistencyLagSummary | null;
  liveSamples?: RunSignalLiveSample[];
  oversoldUnits: number | null;
  retryingOrderCount?: number;
  runStatus: DemoRunStatus | null;
  startingStock?: number | null;
  terminalSummary: RunSignalTimelineSummary | null;
}) {
  const terminal = terminalSummary;
  const terminalRun = runStatus === "completed" || runStatus === "failed";
  // Arrival is load-generator evidence and is already final while a draining run keeps
  // processing; the other three panels describe durable work that is still arriving.
  const trafficSettled = runStatus !== null && isRunEvidenceSettled(runStatus, "load-generator");
  const missingTrafficEvidence = runEvidenceAbsence(runStatus, {
    source: "load-generator",
    pending: "Not yet available",
    settled: "Not recorded for this run",
  });
  const missingEvidence = runEvidenceAbsence(runStatus, {
    source: "durable-processing",
    pending: "Not yet available",
    settled: "Not recorded for this run",
  });
  const arrivalEvidence = observedArrivalEvidence(arrivalSummary);
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
  if (!terminal && !arrivalEvidence && displayedLiveSamples.length === 0) {
    return (
      <section className="col-span-12 rounded-lg border border-border bg-surface p-4">
        <p className="m-0 text-xs font-bold uppercase text-muted">Sale evidence</p>
        <h2 className="m-0 mt-1 text-xl font-bold leading-tight text-ink">
          Arrival → reservation → backlog → confirmation
        </h2>
        <dl className="m-0 mt-4 grid grid-cols-4 gap-3 max-[900px]:grid-cols-2">
          <Headline label="Request arrival" value={missingTrafficEvidence} />
          <Headline label="Inventory drain" value={missingEvidence} />
          <Headline label="Processing backlog" value={missingEvidence} />
          <Headline label="Confirmation convergence" value={missingEvidence} />
        </dl>
      </section>
    );
  }
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
    : displayedLiveSamples.map((sample) => ({
        elapsedSeconds: toAxisElapsed(sample.recoveredAt),
        value: sample.confirmedOrderCount,
        secondaryValue: sample.settledOrderCount,
      }));
  const arrivalAvailable = arrivalEvidence !== null || arrivalPoints.length > 0;
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
        ...displayedLiveSamples.map((sample) => toAxisElapsed(sample.recoveredAt)),
        ...arrivalPoints.map((point) => point.elapsedSeconds),
      );
  const markers = terminal ? terminalEventMarkers(terminal, arrivalEvidence) : [];
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
    : terminalRun
      ? "Final convergence evidence unavailable"
      : `Convergence in progress · ${formatNumber(livePending)} pending`;
  const displayedStartingStock = terminal?.inventoryDrain.startingStock ?? startingStock;
  const acceptedReservationsText =
    acceptedReservations === null ? missingEvidence : formatNumber(acceptedReservations);
  const oversoldPhrase =
    oversoldUnits === null ? oversellUnknownPhrase : `${formatNumber(oversoldUnits)} oversold`;

  return (
    <section className="col-span-12 rounded-lg border border-border bg-surface p-4">
      <div className="mb-4">
        <p className="m-0 text-xs font-bold uppercase text-muted">Sale evidence</p>
        <h2 className="m-0 mt-1 text-xl font-bold leading-tight text-ink">
          Arrival → reservation → backlog → confirmation
        </h2>
        <p className="m-0 mt-1 text-xs leading-5 text-muted">
          {terminal
            ? arrivalAvailable
              ? `All panels cover the ${recordedRunDescriptor(runStatus)} from its first checkout attempt to its final timeline boundary.`
              : `The timeline panels cover the ${recordedRunDescriptor(runStatus)} through its final timeline boundary; request-arrival evidence was not recorded.`
            : terminalRun
              ? "Final timeline evidence was not recorded; the run evidence that was recorded is shown where available."
              : "Live panels show the available run updates."}
        </p>
      </div>
      <div className="grid gap-4">
        <SignalPanel
          available={arrivalAvailable}
          ariaLabel={`Request arrival peaked at ${formatRate(
            arrivalEvidence?.peakArrivalRatePerSecond ??
              Math.max(0, ...arrivalPoints.map((point) => point.value)),
          )}.`}
          caption={`Checkout attempts started by the load generator in ${
            arrivalEvidence
              ? formatWindowSecondsAdjective(arrivalEvidence.peakArrivalWindowSeconds)
              : formatWindowSecondsAdjective(liveTrafficMetricWindowSeconds)
          } windows.`}
          headline={`${arrivalEvidence ? "Peak " : trafficSettled ? "Retained peak " : "Latest available peak "}${formatRate(
            arrivalEvidence?.peakArrivalRatePerSecond ??
              Math.max(0, ...arrivalPoints.map((point) => point.value)),
          )}`}
          markers={markers}
          points={arrivalPoints}
          title="Request arrival"
          unavailableText={missingTrafficEvidence}
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
          }, with ${oversoldUnits === null ? oversellUnknownPhrase : `${formatNumber(oversoldUnits)} oversold units`}.`}
          area
          caption="Stock remaining after immediate reservations; oversold units exceed starting stock."
          headline={`Start ${
            displayedStartingStock === null ? missingEvidence : formatNumber(displayedStartingStock)
          } · ${formatNumber(
            terminal?.inventoryDrain.remainingStock ?? inventoryPoints.at(-1)?.value ?? 0,
          )} remaining · ${oversoldPhrase}${
            terminal
              ? terminal.inventoryDrain.timeToDepletionSeconds === null
                ? " · not depleted"
                : ` · depleted in ${formatDuration(terminal.inventoryDrain.timeToDepletionSeconds)}`
              : ""
          }`}
          markers={markers}
          points={inventoryPoints}
          title="Inventory remaining"
          unavailableText={missingEvidence}
          xMax={xMax}
        />
        <SignalPanel
          available={backlogAvailable}
          ariaLabel={`Processing backlog peaked at ${formatNumber(
            terminal?.queueBacklog.peakBacklog ?? livePeakBacklog,
          )} orders.`}
          area
          caption={`Current and final backlog counts are reserved orders awaiting their first processing start. Drain duration runs from the first queued order to final backlog zero. Run-owned retrying orders are shown separately (${formatNumber(
            retryingOrderCount,
          )}) because retries can return to processing without re-entering this backlog.`}
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
          unavailableText={missingEvidence}
          xMax={xMax}
        />
        <SignalPanel
          available={convergenceAvailable}
          ariaLabel={`Of ${acceptedReservationsText} ${publicVocabulary.uniqueReservationsSecured.toLowerCase()}, ${formatNumber(
            convergence?.confirmedOrderCount ?? liveConfirmed,
          )} were confirmed, ${formatNumber(
            convergence?.failedOrderCount ?? liveFailed,
          )} failed, and ${formatNumber(
            convergence?.pendingAtCaptureCount ?? livePending,
          )} remain pending. ${convergenceStatus}.`}
          caption="Cumulative confirmed orders. Reservation-to-confirmation time is elapsed from reservation secured to final confirmation."
          headline={`${formatNumber(
            convergence?.confirmedOrderCount ?? liveConfirmed,
          )}/${acceptedReservationsText} confirmed · ${formatNumber(
            convergence?.failedOrderCount ?? liveFailed,
          )} failed · ${formatNumber(convergence?.pendingAtCaptureCount ?? livePending)} pending`}
          markers={markers}
          points={convergencePoints}
          secondary={Boolean((convergence?.failedOrderCount ?? liveFailed) > 0)}
          title="Reservation-to-confirmation"
          unavailableText={missingEvidence}
          xMax={xMax}
          {...(lag
            ? {
                secondaryHeadline: `Lag avg ${formatMilliseconds(lag.averageLagMs, missingEvidence)}, p95 ${formatMilliseconds(
                  lag.p95LagMs,
                  missingEvidence,
                )}, max ${formatMilliseconds(lag.maxLagMs, missingEvidence)} · ${convergenceStatus}`,
              }
            : { secondaryHeadline: `Lag ${missingEvidence} · ${convergenceStatus}` })}
        />
      </div>
      <p className="m-0 mt-4 text-xs text-muted">
        {`Shared axis: 0s ${axis.startLabel} · ${formatAxisSeconds(xMax)} ${axis.endLabel}`}
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
  /** Null whenever the authoritative inventory snapshot for the run is missing. */
  oversoldUnits: number | null;
}) {
  if (!headline) {
    return <p className="m-0 mt-3 text-xs text-muted">Signal timeline evidence unavailable.</p>;
  }
  const arrival = observedArrivalEvidence(arrivalSummary);
  const confirmation = headline.confirmationConvergence;
  return (
    <dl className="m-0 mt-3 grid grid-cols-4 gap-3 max-[900px]:grid-cols-2">
      <Headline
        label="Request arrival"
        value={
          arrival
            ? `Peak ${formatRate(arrival.peakArrivalRatePerSecond)} (${rateWindowLabel(
                arrival.peakArrivalWindowSeconds,
              )}) · dispatched in ${formatDuration(arrival.dispatchDurationSeconds)}`
            : "Not recorded for this run"
        }
      />
      <Headline
        label="Inventory"
        value={`Start ${formatNumber(headline.inventoryDrain.startingStock)} · ${formatNumber(
          headline.inventoryDrain.remainingStock,
        )} remaining · ${
          oversoldUnits === null ? oversellUnknownPhrase : `${formatNumber(oversoldUnits)} oversold`
        } · ${
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
          "unavailable",
        )}, p95 ${formatMilliseconds(confirmation.p95LagMs, "unavailable")}, max ${formatMilliseconds(
          confirmation.maxLagMs,
          "unavailable",
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
  unavailableText = "Not yet available",
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
  unavailableText?: string;
  xMax: number;
}) {
  if (!available) {
    return (
      <article className="grid grid-cols-[minmax(13rem,0.35fr)_minmax(0,1fr)] gap-4 border-t border-border pt-3 max-[700px]:grid-cols-1">
        <div>
          <h3 className="m-0 text-sm font-bold text-ink">{title}</h3>
          <p className="m-0 mt-1 text-base font-bold text-muted">{unavailableText}</p>
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

function elapsedSeconds(startedAt: string, endedAt: string): number {
  return Math.max(0, (Date.parse(endedAt) - Date.parse(startedAt)) / 1_000);
}

function formatRate(value: number): string {
  return `${formatNumber(value)} attempts/s`;
}

function formatDuration(value: number): string {
  return formatDurationMs(value * 1_000) ?? "not yet available";
}

function formatMilliseconds(value: number | null, absent = "not yet available"): string {
  return formatDurationMs(value) ?? absent;
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
