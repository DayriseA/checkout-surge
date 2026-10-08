import type {
  HttpTimingBreakdownSummary,
  RequestArrivalSummary,
  ServerReservationTimingSummary,
  TrafficHttpSummary,
  TransportAttemptCounts,
} from "@checkout-surge/contracts";
import { deriveRecordedReplyCount, hasObservedRequestArrivals } from "@checkout-surge/contracts";
import type { ReactNode } from "react";
import {
  formatCount,
  formatDurationMs,
  formatInstantUtc,
  formatWindowSecondsAdjective,
} from "../lib/presentation/format";
import {
  durableCheckoutLens,
  loadGeneratorLens,
  publicVocabulary,
} from "../lib/presentation/public-vocabulary";
import {
  hasUnknownTrafficCounts,
  trafficEvidenceUnavailableText,
} from "../lib/presentation/traffic-evidence";

/**
 * Presentation for the five transport-attempt counts.
 *
 * The counts are client-side evidence: they describe what the load generator
 * personally witnessed, not what Checkout-Surge recorded. Every label here keeps the
 * generator as the grammatical subject so that a missing observation never
 * reads as a failed request.
 */

/** Column headings name the vantage point, not the topic. */
export { durableCheckoutLens, loadGeneratorLens };

export const transportObservationLabels = {
  planned: "Planned attempts",
  dispatched: "Dispatched",
  repliesRecorded: "Replies recorded",
  transportFailures: "Generator received no reply",
  repliesNotRecorded: "Replies not recorded",
  neverDispatched: "Never dispatched",
} as const;

const unrecordedReplyNote = "load generator stopped before the reply arrived";
const transportFailureNote = "connection failed before a reply";
const undispatchedNote = "scenario window closed before these were sent";
const biasedLatencyNote = "observed replies only";

/** Which numbers the survivorship caveat has to qualify differs per surface. */
export type ObservationSurface = "list" | "detail" | "dashboard";

export interface TransportObservation {
  counts: TransportAttemptCounts;
  transportFailures: number | null;
  repliesRecorded: number | null;
  /** Share of dispatched attempts that recorded a reply; null when nothing was dispatched. */
  coveragePercent: number | null;
  hasUnrecordedReplies: boolean;
  hasUndispatchedAttempts: boolean;
}

export function deriveTransportObservation(
  counts: TransportAttemptCounts,
  transportFailures: number | null,
): TransportObservation {
  const repliesRecorded = deriveRecordedReplyCount(counts, transportFailures);
  return {
    counts,
    transportFailures,
    repliesRecorded,
    coveragePercent: observationCoveragePercent(counts, repliesRecorded),
    hasUnrecordedReplies:
      (counts.interruptedRequests !== null && counts.interruptedRequests > 0) ||
      (transportFailures !== null && transportFailures > 0),
    hasUndispatchedAttempts: counts.unstartedRequests !== null && counts.unstartedRequests > 0,
  };
}

function observationCoveragePercent(
  counts: TransportAttemptCounts,
  repliesRecorded: number | null,
): number | null {
  if (counts.startedRequests === null || repliesRecorded === null || counts.startedRequests === 0) {
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
  if (hasUnknownTrafficCounts(observation.counts)) return trafficEvidenceUnavailableText;
  const recorded = formatNumber(observation.repliesRecorded);
  const planned = formatNumber(observation.counts.plannedRequests);

  if (surface === "list") {
    return `Outcomes and latency cover ${recorded} of ${planned} attempts.`;
  }

  if (surface === "dashboard") {
    return `Reply-dependent outcomes and latency cover ${recorded} of ${planned} attempts. The HTTP failure rate above is a separate load-generator measure and can include connection failures. Durable checkout records below are the authoritative record.`;
  }

  return `Outcomes and latency above cover ${recorded} of ${planned} attempts. The p95 describes replies received only. Durable checkout records are the authoritative record.`;
}

/**
 * Transport funnel and observed outcomes as a definition list, sized for the
 * narrow columns on the run-history list and detail views.
 */
export function TransportObservationSection({
  arrivalSummary,
  counts,
  hideZeroExceptions = false,
  httpTimingBreakdownSummary,
  httpSummary,
  serverReservationTimingSummary,
  startDelaySeconds,
  surface,
  trafficStartedAt,
  className = "",
}: {
  arrivalSummary: RequestArrivalSummary;
  className?: string;
  counts: TransportAttemptCounts;
  hideZeroExceptions?: boolean;
  httpTimingBreakdownSummary?: HttpTimingBreakdownSummary;
  httpSummary: TrafficHttpSummary;
  serverReservationTimingSummary: ServerReservationTimingSummary;
  startDelaySeconds?: number;
  surface: Extract<ObservationSurface, "list" | "detail">;
  trafficStartedAt?: string;
}) {
  const observation = deriveTransportObservation(counts, httpSummary.transportFailures);
  const preparation = deriveHarnessPreparation(arrivalSummary, trafficStartedAt, startDelaySeconds);

  return (
    <section className={`min-w-0 border-t border-border pt-3 ${className}`}>
      <FastReservationEvidence summary={serverReservationTimingSummary} />
      <div className="mt-4 border-t border-border pt-3">
        <RequestArrivalEvidence summary={arrivalSummary} showSeries={surface === "detail"} />
      </div>
      <div className="mt-4 border-t border-border pt-3">
        <LensHeading />
      </div>
      <CoverageMeter observation={observation} />
      <dl className="m-0 mt-3 grid gap-2">
        {preparation ? (
          <>
            <ObservationRow
              label="Configured start delay"
              value={formatDuration(preparation.configuredDelaySeconds)}
            />
            <ObservationRow
              label="Startup overhead beyond configured delay"
              value={formatDuration(preparation.startupOverheadSeconds)}
            />
            <ObservationRow
              label="Time until checkout attempts begin"
              value={formatDuration(preparation.totalPreparationSeconds)}
            />
          </>
        ) : null}
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
        {!hideZeroExceptions ||
        (observation.transportFailures !== null && observation.transportFailures > 0) ? (
          <ObservationRow
            label={transportObservationLabels.transportFailures}
            note={
              observation.transportFailures !== null && observation.transportFailures > 0
                ? transportFailureNote
                : undefined
            }
            subordinate
            value={formatNumber(observation.transportFailures)}
          />
        ) : null}
        {!hideZeroExceptions ||
        (counts.interruptedRequests !== null && counts.interruptedRequests > 0) ? (
          <ObservationRow
            label={transportObservationLabels.repliesNotRecorded}
            note={
              counts.interruptedRequests !== null && counts.interruptedRequests > 0
                ? unrecordedReplyNote
                : undefined
            }
            subordinate
            value={formatNumber(counts.interruptedRequests)}
          />
        ) : null}
        {!hideZeroExceptions ||
        (counts.unstartedRequests !== null && counts.unstartedRequests > 0) ? (
          <ObservationRow
            label={transportObservationLabels.neverDispatched}
            note={observation.hasUndispatchedAttempts ? undispatchedNote : undefined}
            subordinate
            value={formatNumber(counts.unstartedRequests)}
          />
        ) : null}
      </dl>
      <div>
        <h4 className="m-0 mt-4 text-xs font-medium text-muted">Load-generator outcomes</h4>
        <dl className="m-0 mt-2 grid gap-2">
          <ObservationRow
            label={publicVocabulary.acceptedResponses}
            value={formatNumber(httpSummary.acceptedResponses)}
          />
          <ObservationRow
            label={publicVocabulary.soldOutRejectionsSeen}
            value={formatNumber(httpSummary.soldOutResponses)}
          />
          {!hideZeroExceptions ||
          (httpSummary.unexpectedResponses !== null && httpSummary.unexpectedResponses > 0) ? (
            <ObservationRow
              label="Unexpected"
              value={formatNumber(httpSummary.unexpectedResponses)}
            />
          ) : null}
          <ObservationRow
            label="Checkout response p95 (client-observed)"
            note={observation.hasUnrecordedReplies ? biasedLatencyNote : undefined}
            value={formatMilliseconds(httpSummary.p95LatencyMs)}
          />
        </dl>
      </div>
      {httpTimingBreakdownSummary ? (
        <ClientTimingBreakdown summary={httpTimingBreakdownSummary} />
      ) : null}
      <SurvivorshipWarning observation={observation} surface={surface} />
    </section>
  );
}

export function deriveHarnessPreparation(
  arrivalSummary: RequestArrivalSummary,
  trafficStartedAt: string | undefined,
  startDelaySeconds: number | undefined,
): {
  configuredDelaySeconds: number;
  startupOverheadSeconds: number;
  totalPreparationSeconds: number;
} | null {
  if (!arrivalSummary.firstAttemptStartedAt || !trafficStartedAt) return null;
  const totalPreparationSeconds = Math.max(
    0,
    (Date.parse(arrivalSummary.firstAttemptStartedAt) - Date.parse(trafficStartedAt)) / 1_000,
  );
  const configuredDelaySeconds = Math.min(totalPreparationSeconds, startDelaySeconds ?? 0);
  return {
    configuredDelaySeconds,
    startupOverheadSeconds: Math.max(0, totalPreparationSeconds - configuredDelaySeconds),
    totalPreparationSeconds,
  };
}

function FastReservationEvidence({ summary }: { summary: ServerReservationTimingSummary }) {
  return (
    <>
      <h3 className="m-0 text-sm font-bold text-ink">Fast inventory reservation</h3>
      <p className="m-0 mt-0.5 text-xs text-muted">
        Inventory reservation start → reservation decision received
      </p>
      <dl className="m-0 mt-3 grid gap-2">
        <ObservationRow
          label="Observed reservation p95"
          note="bounded p95 estimate"
          value={formatHistogramBoundMilliseconds(summary.redisAtomicReservation.p95Ms)}
        />
        <ObservationRow
          label="Reservation processing p95 bound"
          note="bounded p95 estimate; service entry → response ready"
          value={formatHistogramBoundMilliseconds(summary.reserveOrderService.p95Ms)}
        />
      </dl>
      <p className="m-0 mt-3 rounded-lg border border-border bg-surface-muted p-3 text-xs leading-5 text-muted">
        Environment note: run locally, the load generator, API, database, order-processing service,
        and simulated ERP share one host; on the hosted demo, the load generator runs on its own
        machine. These figures record one run in one environment, not a benchmark.
      </p>
    </>
  );
}

function ClientTimingBreakdown({ summary }: { summary: HttpTimingBreakdownSummary }) {
  return (
    <div className="mt-4 border-t border-border pt-3">
      <h4 className="m-0 text-xs font-medium text-muted">Observed response timing</h4>
      <p className="m-0 mt-0.5 text-xs text-muted">
        Load-generator timing; waiting includes server and dependency queueing
      </p>
      <dl className="m-0 mt-2 grid gap-2">
        <ObservationRow label="Waiting p95" value={formatMilliseconds(summary.waiting?.p95Ms)} />
        <ObservationRow label="Blocked p95" value={formatMilliseconds(summary.blocked?.p95Ms)} />
        <ObservationRow
          label="Connecting p95"
          value={formatMilliseconds(summary.connecting?.p95Ms)}
        />
        <ObservationRow label="Sending p95" value={formatMilliseconds(summary.sending?.p95Ms)} />
        <ObservationRow
          label="Receiving p95"
          value={formatMilliseconds(summary.receiving?.p95Ms)}
        />
        <ObservationRow
          label="TLS handshake p95"
          value={formatMilliseconds(summary.tlsHandshaking?.p95Ms)}
        />
      </dl>
    </div>
  );
}

export function RequestArrivalEvidence({
  summary,
  showSeries = true,
}: {
  summary: RequestArrivalSummary;
  showSeries?: boolean;
}) {
  // A run whose generator never started an attempt still carries a summary; its zeros are an
  // absence of observation and must not be published as a measured peak or dispatch duration.
  const observed = hasObservedRequestArrivals(summary);

  return (
    <>
      <h3 className="m-0 text-sm font-bold text-ink">Request arrival</h3>
      <p className="m-0 mt-0.5 text-xs text-muted">
        checkout attempts started by the load generator
      </p>
      {observed ? (
        <dl className="m-0 mt-3 grid gap-2">
          <ObservationRow
            label={`Peak (${formatWindowSecondsAdjective(summary.peakArrivalWindowSeconds)} window)`}
            value={`${formatNumber(summary.peakArrivalRatePerSecond)} attempts/s`}
          />
          <ObservationRow
            label="Checkout dispatch duration (observed)"
            value={formatDuration(summary.dispatchDurationSeconds)}
          />
        </dl>
      ) : (
        <p className="m-0 mt-3 text-sm font-semibold text-muted">
          No checkout attempt was recorded for this run.
        </p>
      )}
      {showSeries ? (
        <RequestArrivalRateSeries
          emptyText="No arrival windows were recorded for this run."
          samples={summary.arrivalRateSeries}
        />
      ) : null}
    </>
  );
}

const arrivalSeriesDisplayLimit = 12;

export function RequestArrivalRateSeries({
  emptyText,
  samples,
}: {
  /** Only the caller knows whether the load generator can still complete another window. */
  emptyText: string;
  samples: RequestArrivalSummary["arrivalRateSeries"];
}) {
  const visibleSamples = samples.slice(-arrivalSeriesDisplayLimit);

  return (
    <>
      {visibleSamples.length === 0 ? (
        <p className="m-0 mt-3 text-xs text-muted">{emptyText}</p>
      ) : (
        <ol aria-label="Request arrival time series" className="m-0 mt-3 grid gap-1 p-0">
          {visibleSamples.map((sample) => (
            <li
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-xs text-muted"
              key={sample.windowStartedAt}
            >
              {/* Compact clock form: every sample sits inside one run whose dated lifecycle
                  boundaries are rendered alongside this series. */}
              <time dateTime={sample.windowStartedAt}>
                {formatInstantUtc(sample.windowStartedAt, { variant: "timeOnly" }) ?? "n/a"}
              </time>
              <strong className="text-muted-strong">
                {formatNumber(sample.ratePerSecond)} attempts/s
              </strong>
            </li>
          ))}
        </ol>
      )}
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
          note={
            observation.transportFailures !== null && observation.transportFailures > 0
              ? transportFailureNote
              : undefined
          }
          value={formatNumber(observation.transportFailures)}
        />
        <PanelFact
          label={transportObservationLabels.repliesNotRecorded}
          note={
            counts.interruptedRequests !== null && counts.interruptedRequests > 0
              ? unrecordedReplyNote
              : undefined
          }
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
  return (
    <ConditionalCaveat
      show={hasUnknownTrafficCounts(observation.counts) || observation.hasUnrecordedReplies}
    >
      {survivorshipWarningText(observation, surface)}
    </ConditionalCaveat>
  );
}

export function ConditionalCaveat({ children, show }: { children: ReactNode; show: boolean }) {
  if (!show) return null;
  return (
    <p className="m-0 mt-3 rounded-lg border border-warning-line bg-warning-soft p-3 text-xs leading-5 text-warning">
      {children}
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
      <dt className="mb-0.5 text-xs font-medium text-muted">{label}</dt>
      <dd className="m-0 [overflow-wrap:anywhere] text-base font-bold text-ink">
        {value}
        {note ? (
          <span className="mt-1 block text-xs font-normal leading-4 text-muted">{note}</span>
        ) : null}
      </dd>
    </div>
  );
}

function formatNumber(value: number | null): string {
  return formatCount(value) ?? "Unavailable";
}

export function formatMilliseconds(value: number | null | undefined): string {
  return formatDurationMs(value) ?? "n/a";
}

/**
 * A histogram bucket bound is a declared technical parameter, not an elapsed measurement. The
 * buckets are defined in fixed millisecond edges and are read as a ladder, so tiering one edge
 * into seconds while its neighbours stay in milliseconds would hide the unit the ladder is
 * defined in. This is a sanctioned exemption from the tiered duration policy.
 *
 * The bucket edges start at 0.25 ms, so `formatNumber` must keep fractional input.
 */
export function formatHistogramBoundMilliseconds(value: number | null): string {
  return value === null ? "n/a" : `≤ ${formatNumber(value)}ms`;
}

function formatDuration(seconds: number): string {
  return formatDurationMs(seconds * 1_000) ?? "n/a";
}
