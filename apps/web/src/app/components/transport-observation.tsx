import type { TrafficHttpSummary, TransportAttemptCounts } from "@checkout-surge/contracts";

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
  repliesNotRecorded: "Replies not recorded",
  neverDispatched: "Never dispatched",
} as const;

const unrecordedReplyNote = "generator shut down before the reply arrived";
const undispatchedNote = "scenario window closed before these were sent";
const biasedLatencyNote = "observed replies only";

/** Which numbers the survivorship caveat has to qualify differs per surface. */
export type ObservationSurface = "list" | "detail" | "dashboard";

export interface TransportObservation {
  counts: TransportAttemptCounts;
  /** Share of dispatched attempts that recorded a reply; null when nothing was dispatched. */
  coveragePercent: number | null;
  hasUnrecordedReplies: boolean;
  hasUndispatchedAttempts: boolean;
}

export function deriveTransportObservation(counts: TransportAttemptCounts): TransportObservation {
  return {
    counts,
    coveragePercent: observationCoveragePercent(counts),
    hasUnrecordedReplies: counts.interruptedRequests > 0,
    hasUndispatchedAttempts: counts.unstartedRequests > 0,
  };
}

function observationCoveragePercent(counts: TransportAttemptCounts): number | null {
  if (counts.startedRequests === 0) {
    return null;
  }

  const percent = Math.round((counts.completedRequests / counts.startedRequests) * 100);

  // Never round up into a claim of full coverage while replies are still missing.
  return counts.interruptedRequests > 0 ? Math.min(percent, 99) : percent;
}

export function survivorshipWarningText(
  observation: TransportObservation,
  surface: ObservationSurface,
): string {
  const recorded = formatNumber(observation.counts.completedRequests);
  const planned = formatNumber(observation.counts.plannedRequests);

  if (surface === "list") {
    return `Outcomes and latency cover ${recorded} of ${planned} attempts.`;
  }

  if (surface === "dashboard") {
    return `The rates above cover ${recorded} of ${planned} attempts. The slowest attempts are the ones missing, so latency is understated. Run outcomes below are the authoritative record.`;
  }

  return `Outcomes and latency above cover ${recorded} of ${planned} attempts. The slowest attempts are the ones missing, so the true p95 is higher. Server-side totals are the authoritative record.`;
}

/**
 * Transport funnel and observed outcomes as a definition list, sized for the
 * narrow columns on the run-history list and detail views.
 */
export function TransportObservationSection({
  counts,
  httpSummary,
  surface,
}: {
  counts: TransportAttemptCounts;
  httpSummary: TrafficHttpSummary;
  surface: Extract<ObservationSurface, "list" | "detail">;
}) {
  const observation = deriveTransportObservation(counts);

  return (
    <section className="min-w-0 border-t border-border pt-3">
      <LensHeading />
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
          value={formatNumber(counts.completedRequests)}
        />
        <ObservationRow
          label={transportObservationLabels.repliesNotRecorded}
          note={observation.hasUnrecordedReplies ? unrecordedReplyNote : undefined}
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

/**
 * Transport funnel as stacked fact tiles, sized for the wide `/watch` panel.
 * The dashboard projection carries no terminal HTTP summary, so the caveat
 * qualifies the live rate metrics rendered above this block.
 */
export function TransportObservationPanelBlock({ counts }: { counts: TransportAttemptCounts }) {
  const observation = deriveTransportObservation(counts);

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
          value={formatNumber(counts.completedRequests)}
        />
      </dl>
      <dl className="m-0 mt-3 grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
        <PanelFact
          label={transportObservationLabels.repliesNotRecorded}
          note={observation.hasUnrecordedReplies ? unrecordedReplyNote : undefined}
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
