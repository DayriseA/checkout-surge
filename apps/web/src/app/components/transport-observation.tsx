import type {
  RequestArrivalSummary,
  TrafficHttpSummary,
  TransportAttemptCounts,
} from "@checkout-surge/contracts";

/**
 * Presentation for the five transport-attempt counts.
 *
 * The counts are client-side evidence: they describe what the load generator
 * personally witnessed, not what the API did. Every label here keeps the
 * generator as the grammatical subject so that a missing observation never
 * reads as a failed request.
 */

/** Column headings name the vantage point, not the topic. */
export const loadGeneratorLens = {
  title: "Load generator",
  caption: "what k6 observed",
} as const;

export const systemOfRecordLens = {
  title: "System of record",
  caption: "what the API recorded",
} as const;

export const transportObservationLabels = {
  planned: "Planned attempts",
  dispatched: "Dispatched",
  repliesRecorded: "Replies recorded",
  transportFailures: "Generator received no reply",
  repliesNotRecorded: "Replies not recorded",
  neverDispatched: "Never dispatched",
} as const;

const unrecordedReplyNote = "generator shut down before the reply arrived";
const transportFailureNote = "connection failed before a reply";
const undispatchedNote = "scenario window closed before these were sent";
const biasedLatencyNote = "observed replies only";

/** Which numbers the survivorship caveat has to qualify differs per surface. */
export type ObservationSurface = "list" | "detail" | "dashboard";

export interface TransportObservation {
  counts: TransportAttemptCounts;
  transportFailures: number;
  repliesRecorded: number;
  /** Share of dispatched attempts that recorded a reply; null when nothing was dispatched. */
  coveragePercent: number | null;
  hasUnrecordedReplies: boolean;
  hasUndispatchedAttempts: boolean;
}

export function deriveTransportObservation(
  counts: TransportAttemptCounts,
  transportFailures: number,
): TransportObservation {
  const repliesRecorded = Math.max(counts.completedRequests - transportFailures, 0);
  return {
    counts,
    transportFailures,
    repliesRecorded,
    coveragePercent: observationCoveragePercent(counts, repliesRecorded),
    hasUnrecordedReplies: counts.interruptedRequests > 0 || transportFailures > 0,
    hasUndispatchedAttempts: counts.unstartedRequests > 0,
  };
}

function observationCoveragePercent(
  counts: TransportAttemptCounts,
  repliesRecorded: number,
): number | null {
  if (counts.startedRequests === 0) {
    return null;
  }

  const percent = Math.round((repliesRecorded / counts.startedRequests) * 100);

  // Never round up into a claim of full coverage while replies are still missing.
  return repliesRecorded < counts.startedRequests ? Math.min(percent, 99) : percent;
}

export function survivorshipWarningText(
  observation: TransportObservation,
  surface: ObservationSurface,
): string {
  const recorded = formatNumber(observation.repliesRecorded);
  const planned = formatNumber(observation.counts.plannedRequests);

  if (surface === "list") {
    return `Outcomes and latency cover ${recorded} of ${planned} attempts.`;
  }

  if (surface === "dashboard") {
    return `Reply-dependent outcomes and latency cover ${recorded} of ${planned} attempts. The HTTP failure rate above is a separate k6 measure and can include connection failures. Run outcomes below are the authoritative record.`;
  }

  return `Outcomes and latency above cover ${recorded} of ${planned} attempts. The p95 describes replies received only. Server-side totals are the authoritative record.`;
}

/**
 * Transport funnel and observed outcomes as a definition list, sized for the
 * narrow columns on the run-history list and detail views.
 */
export function TransportObservationSection({
  arrivalSummary,
  counts,
  httpSummary,
  surface,
}: {
  arrivalSummary: RequestArrivalSummary;
  counts: TransportAttemptCounts;
  httpSummary: TrafficHttpSummary;
  surface: Extract<ObservationSurface, "list" | "detail">;
}) {
  const observation = deriveTransportObservation(counts, httpSummary.transportFailures);

  return (
    <section className="min-w-0 border-t border-border pt-3">
      <RequestArrivalEvidence summary={arrivalSummary} showSeries={surface === "detail"} />
      <div className="mt-4 border-t border-border pt-3">
        <LensHeading />
      </div>
      <CoverageMeter observation={observation} />
      <dl className="m-0 mt-3 grid gap-2">
        <ObservationRow
          label={transportObservationLabels.planned}
          value={formatNumber(counts.plannedRequests)}
        />
        <ObservationRow
          label={transportObservationLabels.dispatched}
          value={formatNumber(counts.startedRequests)}
        />
        <ObservationRow
          label={transportObservationLabels.repliesRecorded}
          value={formatNumber(observation.repliesRecorded)}
        />
        <ObservationRow
          label={transportObservationLabels.transportFailures}
          note={observation.transportFailures > 0 ? transportFailureNote : undefined}
          subordinate
          value={formatNumber(observation.transportFailures)}
        />
        <ObservationRow
          label={transportObservationLabels.repliesNotRecorded}
          note={counts.interruptedRequests > 0 ? unrecordedReplyNote : undefined}
          subordinate
          value={formatNumber(counts.interruptedRequests)}
        />
        <ObservationRow
          label={transportObservationLabels.neverDispatched}
          note={observation.hasUndispatchedAttempts ? undispatchedNote : undefined}
          subordinate
          value={formatNumber(counts.unstartedRequests)}
        />
      </dl>
      <h4 className="m-0 mt-4 text-xs font-bold uppercase text-muted">Observed outcomes</h4>
      <dl className="m-0 mt-2 grid gap-2">
        <ObservationRow label="Accepted" value={formatNumber(httpSummary.acceptedResponses)} />
        <ObservationRow label="Sold out" value={formatNumber(httpSummary.soldOutResponses)} />
        <ObservationRow label="Unexpected" value={formatNumber(httpSummary.unexpectedResponses)} />
        <ObservationRow
          label="p95 latency"
          note={observation.hasUnrecordedReplies ? biasedLatencyNote : undefined}
          value={formatMilliseconds(httpSummary.p95LatencyMs)}
        />
      </dl>
      <SurvivorshipWarning observation={observation} surface={surface} />
    </section>
  );
}

export function RequestArrivalEvidence({
  summary,
  showSeries = true,
}: {
  summary: RequestArrivalSummary;
  showSeries?: boolean;
}) {
  return (
    <>
      <h3 className="m-0 text-sm font-bold text-ink">Request arrival</h3>
      <p className="m-0 mt-0.5 text-xs text-muted">checkout attempts started by k6</p>
      <dl className="m-0 mt-3 grid gap-2">
        <ObservationRow
          label={`Peak (${formatWindow(summary.peakArrivalWindowSeconds)} window)`}
          value={`${formatNumber(summary.peakArrivalRatePerSecond)} attempts/s`}
        />
        <ObservationRow
          label="Dispatch duration"
          value={formatDuration(summary.dispatchDurationSeconds)}
        />
      </dl>
      {showSeries ? (
        <RequestArrivalRateSeries samples={summary.arrivalRateSeries} summary={summary} />
      ) : null}
    </>
  );
}

const arrivalSeriesDisplayLimit = 12;

export function RequestArrivalRateSeries({
  samples,
  summary,
}: {
  samples: RequestArrivalSummary["arrivalRateSeries"];
  summary?: RequestArrivalSummary;
}) {
  const visibleSamples = samples.slice(-arrivalSeriesDisplayLimit);
  const seriesWasTruncated =
    summary !== undefined && summary.arrivalWindowCountObserved > visibleSamples.length;

  return (
    <>
      {visibleSamples.length === 0 ? (
        <p className="m-0 mt-3 text-xs text-muted">No finalized arrival windows.</p>
      ) : (
        <ol aria-label="Request arrival time series" className="m-0 mt-3 grid gap-1 p-0">
          {visibleSamples.map((sample) => (
            <li
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-xs text-muted"
              key={sample.windowStartedAt}
            >
              <time dateTime={sample.windowStartedAt}>
                {new Date(sample.windowStartedAt).toLocaleTimeString("en-US", {
                  hour12: false,
                  timeZone: "UTC",
                })}
              </time>
              <strong className="text-muted-strong">
                {formatNumber(sample.ratePerSecond)} attempts/s
              </strong>
            </li>
          ))}
        </ol>
      )}
      {seriesWasTruncated ? (
        <p className="m-0 mt-2 text-xs text-muted">
          {visibleSamples.length > 0
            ? `Showing the last ${visibleSamples.length} of ${summary.arrivalWindowCountRetained} retained windows (${summary.arrivalWindowCountObserved} observed).`
            : `No samples retained from ${summary.arrivalWindowCountObserved} observed windows.`}
        </p>
      ) : null}
    </>
  );
}

/**
 * Transport funnel as stacked fact tiles, sized for the wide `/watch` panel.
 * The caveat qualifies the live rate metrics rendered above this block.
 */
export function TransportObservationPanelBlock({
  counts,
  httpSummary,
}: {
  counts: TransportAttemptCounts;
  httpSummary: TrafficHttpSummary;
}) {
  const observation = deriveTransportObservation(counts, httpSummary.transportFailures);

  return (
    <>
      <div className="mt-4 border-t border-border pt-3">
        <LensHeading />
      </div>
      <CoverageMeter observation={observation} />
      <dl className="m-0 mt-3 grid grid-cols-3 gap-3 max-[560px]:grid-cols-2">
        <PanelFact
          label={transportObservationLabels.planned}
          value={formatNumber(counts.plannedRequests)}
        />
        <PanelFact
          label={transportObservationLabels.dispatched}
          value={formatNumber(counts.startedRequests)}
        />
        <PanelFact
          label={transportObservationLabels.repliesRecorded}
          value={formatNumber(observation.repliesRecorded)}
        />
      </dl>
      <dl className="m-0 mt-3 grid grid-cols-3 gap-3 max-[560px]:grid-cols-1">
        <PanelFact
          label={transportObservationLabels.transportFailures}
          note={observation.transportFailures > 0 ? transportFailureNote : undefined}
          value={formatNumber(observation.transportFailures)}
        />
        <PanelFact
          label={transportObservationLabels.repliesNotRecorded}
          note={counts.interruptedRequests > 0 ? unrecordedReplyNote : undefined}
          value={formatNumber(counts.interruptedRequests)}
        />
        <PanelFact
          label={transportObservationLabels.neverDispatched}
          note={observation.hasUndispatchedAttempts ? undispatchedNote : undefined}
          value={formatNumber(counts.unstartedRequests)}
        />
      </dl>
      <SurvivorshipWarning observation={observation} surface="dashboard" />
    </>
  );
}

function LensHeading() {
  return (
    <>
      <h3 className="m-0 text-sm font-bold text-ink">{loadGeneratorLens.title}</h3>
      <p className="m-0 mt-0.5 text-xs text-muted">{loadGeneratorLens.caption}</p>
    </>
  );
}

function CoverageMeter({ observation }: { observation: TransportObservation }) {
  if (observation.coveragePercent === null || !observation.hasUnrecordedReplies) {
    return null;
  }

  return (
    <div className="mt-3 grid gap-1">
      <meter
        aria-label="Observation coverage"
        className="meter block h-2 w-full rounded-full border-0 bg-surface-muted"
        max={100}
        min={0}
        value={observation.coveragePercent}
      />
      <p className="m-0 text-xs font-semibold text-muted">
        {observation.coveragePercent}% of dispatched attempts recorded a reply
      </p>
    </div>
  );
}

function SurvivorshipWarning({
  observation,
  surface,
}: {
  observation: TransportObservation;
  surface: ObservationSurface;
}) {
  if (!observation.hasUnrecordedReplies) {
    return null;
  }

  return (
    <p className="m-0 mt-3 rounded-lg border border-[#ecd08f] bg-warning-soft p-3 text-xs leading-5 text-warning">
      {survivorshipWarningText(observation, surface)}
    </p>
  );
}

function ObservationRow({
  label,
  note,
  subordinate = false,
  value,
}: {
  label: string;
  note?: string | undefined;
  subordinate?: boolean;
  value: string;
}) {
  const rowClassName = "grid grid-cols-[minmax(0,1fr)_auto] gap-3";

  return (
    <div className={subordinate ? `${rowClassName} border-l border-border pl-3` : rowClassName}>
      <dt className="text-sm text-muted">
        {label}
        {note ? <span className="mt-1 block text-xs leading-4 text-muted">{note}</span> : null}
      </dt>
      <dd className="m-0 max-w-48 [overflow-wrap:anywhere] text-right text-sm font-semibold text-muted-strong">
        {value}
      </dd>
    </div>
  );
}

function PanelFact({
  label,
  note,
  value,
}: {
  label: string;
  note?: string | undefined;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="mb-1 text-xs font-bold text-muted">{label}</dt>
      <dd className="m-0 [overflow-wrap:anywhere] text-base font-bold text-ink">
        {value}
        {note ? (
          <span className="mt-1 block text-xs font-normal leading-4 text-muted">{note}</span>
        ) : null}
      </dd>
    </div>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatMilliseconds(value: number | undefined): string {
  return value === undefined ? "n/a" : `${formatNumber(value)}ms`;
}

function formatDuration(seconds: number): string {
  return seconds < 1
    ? `${Math.round(seconds * 1_000)}ms`
    : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(seconds)}s`;
}

function formatWindow(seconds: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(seconds)}-second`;
}
