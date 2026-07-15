import type {
  HttpTimingBreakdownSummary,
  LoadExecutionPlan,
  LoadRunDiagnosticsSummary,
  SummaryExportWarning,
  TerminalMetricSource,
  TerminalMetricSources,
  TrafficCompletionReport,
} from "@checkout-surge/contracts";
import type { InitialLoadRunDiagnostics } from "./load-run-diagnostics.js";

export class BoundedStderrCollector {
  private pending = "";
  private pendingCarriageReturn = false;
  private pendingWasTruncated = false;
  private readonly lines: string[] = [];
  private observed = 0;
  private truncated = 0;
  push(chunk: string): void {
    let remainingChunk = chunk;
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      if (remainingChunk.startsWith("\n")) {
        this.rememberPending();
        remainingChunk = remainingChunk.slice(1);
      } else {
        this.append("\r");
      }
    }
    const segments = remainingChunk.split("\n");
    for (const [index, segment] of segments.entries()) {
      const isComplete = index < segments.length - 1;
      const endsWithCarriageReturn = segment.endsWith("\r");
      const normalized = endsWithCarriageReturn ? segment.slice(0, -1) : segment;
      this.append(normalized);
      if (isComplete) this.rememberPending();
      else if (endsWithCarriageReturn) this.pendingCarriageReturn = true;
    }
  }
  finish(): void {
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      this.append("\r");
    }
    if (this.pending.length > 0 || this.pendingWasTruncated) this.rememberPending();
  }
  private append(value: string) {
    const remaining = 500 - this.pending.length;
    if (value.length > remaining) this.pendingWasTruncated = true;
    if (remaining > 0) this.pending += value.slice(0, remaining);
  }
  snapshot() {
    return {
      stderrLines: [...this.lines],
      stderrLineCountObserved: this.observed,
      stderrLineCountRetained: this.lines.length,
      stderrRetainedLineLimit: 50 as const,
      stderrLineTruncationLength: 500 as const,
      stderrLineTruncatedCount: this.truncated,
    };
  }
  private rememberPending() {
    this.observed += 1;
    if (this.pendingWasTruncated) this.truncated += 1;
    this.lines.push(this.pending);
    if (this.lines.length > 50) this.lines.shift();
    this.pending = "";
    this.pendingWasTruncated = false;
  }
}

export type K6Point = {
  type?: string;
  metric?: string;
  data?: {
    time?: string;
    value?: number;
  };
};

export interface K6TrendSummary {
  averageMs: number | null;
  p95Ms: number | null;
}

export interface K6SummaryMetrics {
  httpRequests?: number;
  acceptedResponses?: number;
  soldOutResponses?: number;
  unexpectedResponses?: number;
  droppedIterations?: number;
  completedIterations?: number;
  httpFailureRate?: number;
  requestDuration?: K6TrendSummary;
  timingPhases: Partial<Record<K6TimingMetric, K6TrendSummary>>;
}

export type K6TimingMetric =
  | "http_req_blocked"
  | "http_req_connecting"
  | "http_req_tls_handshaking"
  | "http_req_sending"
  | "http_req_waiting"
  | "http_req_receiving";

type PointAggregate = { sum: number; count: number };

const timingMetricFields = {
  http_req_blocked: "blocked",
  http_req_connecting: "connecting",
  http_req_tls_handshaking: "tlsHandshaking",
  http_req_sending: "sending",
  http_req_waiting: "waiting",
  http_req_receiving: "receiving",
} as const satisfies Record<K6TimingMetric, keyof HttpTimingBreakdownSummary>;

const counterMetricFields = {
  http_reqs: "httpRequests",
  checkout_reservation_accepted: "acceptedResponses",
  checkout_sold_out_rejections: "soldOutResponses",
  checkout_unexpected_responses: "unexpectedResponses",
  dropped_iterations: "droppedIterations",
  iterations: "completedIterations",
} as const satisfies Record<string, keyof K6SummaryMetrics>;

export class K6RunAccumulator {
  private readonly pointAggregates = new Map<string, PointAggregate>();

  constructor(
    private readonly options: {
      runId: string;
      correlationId: string;
      plannedRequests: number;
      startedAt: Date;
      diagnostics?: InitialLoadRunDiagnostics;
      executionPlan: LoadExecutionPlan;
      stderr?: BoundedStderrCollector;
    },
  ) {}

  observe(point: K6Point): void {
    if (point.type !== "Point" || !point.metric || !point.data) {
      return;
    }

    const value = Number(point.data.value);

    if (!Number.isFinite(value) || value < 0) {
      return;
    }

    if (!supportedPointMetrics.has(point.metric)) return;
    const aggregate = this.pointAggregates.get(point.metric) ?? { sum: 0, count: 0 };
    const sum = aggregate.sum + value;
    if (!Number.isFinite(sum)) return;
    aggregate.sum = sum;
    aggregate.count += 1;
    this.pointAggregates.set(point.metric, aggregate);
  }

  completionReport(input: {
    status: "succeeded" | "failed";
    exitCode?: number;
    errorMessage?: string;
    completedAt: Date;
    summaryMetrics?: K6SummaryMetrics;
    summaryExportWarning?: SummaryExportWarning;
  }): TrafficCompletionReport {
    const emittedRequests = this.selectCount(input.summaryMetrics?.httpRequests, "http_reqs");
    const acceptedResponses = this.selectCount(
      input.summaryMetrics?.acceptedResponses,
      "checkout_reservation_accepted",
    );
    const soldOutResponses = this.selectCount(
      input.summaryMetrics?.soldOutResponses,
      "checkout_sold_out_rejections",
    );
    const unexpectedResponses = this.selectCount(
      input.summaryMetrics?.unexpectedResponses,
      "checkout_unexpected_responses",
    );
    const droppedIterations = this.selectCount(
      input.summaryMetrics?.droppedIterations,
      "dropped_iterations",
    );
    const completedIterations = this.selectCount(
      input.summaryMetrics?.completedIterations,
      "iterations",
    );
    const pointFailureRate = this.pointAverage("http_req_failed");
    const failureRate = input.summaryMetrics?.httpFailureRate ?? pointFailureRate ?? 0;
    const httpFailedRequests = Math.round(failureRate * emittedRequests.value);
    const failedRequests = Math.max(
      unexpectedResponses.value,
      httpFailedRequests - soldOutResponses.value,
      0,
    );
    const trafficDeliverySummary = this.trafficDeliverySummary({
      emittedRequests,
      droppedIterations,
      completedIterations,
    });
    const terminalMetricSources: TerminalMetricSources = {
      emittedRequests: emittedRequests.source,
      completedRequests: emittedRequests.source,
      acceptedResponses: acceptedResponses.source,
      soldOutResponses: soldOutResponses.source,
      unexpectedResponses: unexpectedResponses.source,
      droppedIterations: droppedIterations.source,
      completedIterations: completedIterations.source,
    };
    const summaryExportWarnings = this.summaryWarnings({
      initial: input.summaryExportWarning,
      outcomes: [acceptedResponses, soldOutResponses, unexpectedResponses],
    });
    const timingBreakdown = this.timingBreakdown(input.summaryMetrics);
    const durationP95 = input.summaryMetrics?.requestDuration?.p95Ms;

    return {
      runId: this.options.runId,
      status: input.status,
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      httpSummary: {
        plannedRequests: this.options.plannedRequests,
        emittedRequests: emittedRequests.value,
        completedRequests: emittedRequests.value,
        failedRequests,
        acceptedResponses: acceptedResponses.value,
        soldOutResponses: soldOutResponses.value,
        unexpectedResponses: unexpectedResponses.value,
        ...(durationP95 === undefined || durationP95 === null ? {} : { p95LatencyMs: durationP95 }),
        failureRate,
      },
      trafficOutcomeSummary: {
        acceptedResponses: acceptedResponses.value,
        soldOutResponses: soldOutResponses.value,
        unexpectedResponses: unexpectedResponses.value,
      },
      trafficDeliverySummary,
      httpTimingBreakdownSummary: timingBreakdown,
      loadRunDiagnosticsSummary: {
        startedAt: this.options.startedAt.toISOString(),
        completedAt: input.completedAt.toISOString(),
        ...(this.options.diagnostics ?? {
          nproc: null,
          ulimitNofile: null,
          processMaxOpenFiles: null,
          networkDiagnostics: null,
          k6Version: null,
          executionPlan: this.options.executionPlan,
        }),
        ...(this.options.stderr?.snapshot() ?? {
          stderrLines: [],
          stderrLineCountObserved: 0,
          stderrLineCountRetained: 0,
          stderrRetainedLineLimit: 50 as const,
          stderrLineTruncationLength: 500 as const,
          stderrLineTruncatedCount: 0,
        }),
        terminalMetricSources,
        summaryExportWarnings,
      } satisfies LoadRunDiagnosticsSummary,
      apiRequestLifecycleSummary: {
        completedRequests: emittedRequests.value,
        failedRequests,
      },
      completedAt: input.completedAt.toISOString(),
      correlationId: this.options.correlationId,
    };
  }

  private selectCount(summaryValue: number | undefined, metric: string) {
    if (summaryValue !== undefined)
      return { value: summaryValue, valueOrNull: summaryValue, source: "summary_export" as const };
    const point = this.pointAggregates.get(metric);
    if (point)
      return {
        value: Math.round(point.sum),
        valueOrNull: Math.round(point.sum),
        source: "point_stream" as const,
      };
    return { value: 0, valueOrNull: null, source: null };
  }

  private trafficDeliverySummary(input: {
    emittedRequests: SelectedCount;
    droppedIterations: SelectedCount;
    completedIterations: SelectedCount;
  }) {
    const planned = this.options.plannedRequests;
    const plan = this.options.executionPlan;
    const notes: string[] = [];

    if (input.droppedIterations.value > 0) {
      notes.push("k6_dropped_iterations_observed");
    }

    return {
      plannedRequests: planned,
      emittedRequests: input.emittedRequests.value,
      trafficMode: plan.trafficMode,
      plannedBuyers: plan.trafficMode === "buyer-spike" ? plan.buyerCount : null,
      scheduledRatePerSecond:
        plan.trafficMode === "steady-arrival-rate" ? plan.ratePerSecond : null,
      configuredDurationSeconds:
        plan.trafficMode === "steady-arrival-rate" ? plan.durationSeconds : null,
      preAllocatedVUs: plan.trafficMode === "steady-arrival-rate" ? plan.preAllocatedVus : null,
      maxVUs: plan.trafficMode === "steady-arrival-rate" ? plan.maxVus : null,
      droppedIterations: input.droppedIterations.value,
      completedIterations: input.completedIterations.valueOrNull,
      unstartedIterations:
        input.completedIterations.valueOrNull === null
          ? null
          : Math.max(
              0,
              planned - input.completedIterations.valueOrNull - input.droppedIterations.value,
            ),
      requestShortfall: Math.max(0, planned - input.emittedRequests.value),
      notes,
    };
  }

  private pointAverage(metric: string): number | null {
    const aggregate = this.pointAggregates.get(metric);
    return aggregate && aggregate.count > 0 ? aggregate.sum / aggregate.count : null;
  }

  private timingBreakdown(summary: K6SummaryMetrics | undefined): HttpTimingBreakdownSummary {
    const result = {} as HttpTimingBreakdownSummary;
    for (const [metric, field] of Object.entries(timingMetricFields) as [
      K6TimingMetric,
      keyof HttpTimingBreakdownSummary,
    ][]) {
      const summaryTrend = summary?.timingPhases[metric];
      const pointAverage = this.pointAverage(metric);
      result[field] =
        summaryTrend ?? (pointAverage === null ? null : { averageMs: pointAverage, p95Ms: null });
    }
    return result;
  }

  private summaryWarnings(input: {
    initial: SummaryExportWarning | undefined;
    outcomes: SelectedCount[];
  }): SummaryExportWarning[] {
    const warnings = new Set<SummaryExportWarning>();
    if (input.initial) warnings.add(input.initial);
    if (input.outcomes.some((outcome) => outcome.source === "point_stream"))
      warnings.add("k6_outcome_counter_point_stream_fallback_used");
    if (input.outcomes.some((outcome) => outcome.source === null))
      warnings.add("k6_outcome_counter_summary_export_unavailable");
    return [...warnings];
  }
}

type SelectedCount = {
  value: number;
  valueOrNull: number | null;
  source: TerminalMetricSource | null;
};

const supportedPointMetrics = new Set([
  ...Object.keys(counterMetricFields),
  ...Object.keys(timingMetricFields),
  "http_req_duration",
  "http_req_failed",
]);

export function parseK6SummaryMetrics(text: string): K6SummaryMetrics | null {
  let lastSummary: K6SummaryMetrics | null = null;
  for (const objectText of extractJsonObjects(text)) {
    try {
      const parsed = JSON.parse(objectText) as unknown;
      const summary = parseSummaryObject(parsed);
      if (summary) lastSummary = summary;
    } catch {
      // Arbitrary stdout may contain malformed objects and non-JSON log text.
    }
  }
  return lastSummary;
}

function parseSummaryObject(value: unknown): K6SummaryMetrics | null {
  if (!isRecord(value) || !isRecord(value.metrics)) return null;
  const summary: K6SummaryMetrics = { timingPhases: {} };
  let supported = false;
  for (const [metricName, field] of Object.entries(counterMetricFields)) {
    const count = readCounter(value.metrics[metricName]);
    if (count !== undefined) {
      Object.assign(summary, { [field]: count });
      supported = true;
    }
  }
  const failureRate = readRate(value.metrics.http_req_failed);
  if (failureRate !== undefined) {
    summary.httpFailureRate = failureRate;
    supported = true;
  }
  const requestDuration = readTrend(value.metrics.http_req_duration);
  if (requestDuration) {
    summary.requestDuration = requestDuration;
    supported = true;
  }
  for (const metric of Object.keys(timingMetricFields) as K6TimingMetric[]) {
    const trend = readTrend(value.metrics[metric]);
    if (trend) {
      summary.timingPhases[metric] = trend;
      supported = true;
    }
  }
  return supported ? summary : null;
}

function readCounter(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const count =
    finiteNonnegative(value.count) ??
    (isRecord(value.values) ? finiteNonnegative(value.values.count) : undefined);
  return count === undefined ? undefined : Math.round(count);
}

function readTrend(value: unknown): K6TrendSummary | undefined {
  if (!isRecord(value)) return undefined;
  const values = isRecord(value.values) ? value.values : value;
  const averageMs = finiteNonnegative(values.avg) ?? null;
  const p95Ms = finiteNonnegative(values["p(95)"]) ?? null;
  return averageMs === null && p95Ms === null ? undefined : { averageMs, p95Ms };
}

function readRate(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const values = isRecord(value.values) ? value.values : value;
  const rate = finitePercentage(values.value) ?? finitePercentage(values.rate);
  return rate;
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finitePercentage(value: unknown): number | undefined {
  const number = finiteNonnegative(value);
  return number !== undefined && number <= 1 ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function* extractJsonObjects(text: string): Generator<string> {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          yield text.slice(start, index + 1);
          start = index;
          break;
        }
      }
    }
  }
}

export function parseK6JsonLine(line: string): K6Point | null {
  try {
    const parsed = JSON.parse(line) as K6Point;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
