import {
  arrivalRateSeriesLimit,
  isoTimestampSchema,
  liveTrafficMetricWindowSeconds,
  type MetricSample,
  type RequestArrivalSummary,
} from "@checkout-surge/contracts";
import type { K6Point } from "./k6-output-parser.js";

const windowMs = liveTrafficMetricWindowSeconds * 1_000;

interface TrafficMetricWindow {
  startMs: number;
  arrivalCount: number;
  arrivalObservationCount: number;
  completionCount: number;
  completionObservationCount: number;
  latencySum: number;
  latencyCount: number;
  failureSum: number;
  failureCount: number;
}

/**
 * Aggregates supported k6 points into one aligned event-time window. A newer
 * window finalizes the prior one; late points for finalized/older windows are
 * ignored. Overflow-causing observations are ignored.
 */
export class K6LiveMetricAggregator {
  private readonly dispatchProgress: { plannedRequests: number; step: number } | null;
  private currentWindow: TrafficMetricWindow | null = null;
  private finalizedThroughMs = Number.NEGATIVE_INFINITY;
  private attemptsDispatched = 0;
  private lastReportedAttemptsDispatched = 0;
  private firstAttemptAtMs: number | null = null;
  private lastAttemptAtMs: number | null = null;
  private peakArrivalRatePerSecond = 0;
  private arrivalWindowCountObserved = 0;
  private readonly arrivalRateSeries: RequestArrivalSummary["arrivalRateSeries"] = [];

  constructor(options: { plannedRequests?: number } = {}) {
    if (
      options.plannedRequests !== undefined &&
      (!Number.isSafeInteger(options.plannedRequests) || options.plannedRequests <= 0)
    ) {
      throw new Error("k6 plannedRequests must be a positive safe integer.");
    }
    this.dispatchProgress = options.plannedRequests
      ? {
          plannedRequests: options.plannedRequests,
          step: Math.max(1, Math.ceil(options.plannedRequests / 10)),
        }
      : null;
  }

  observe(point: K6Point): MetricSample[] {
    const normalized = normalizeLivePoint(point);
    if (!normalized) return [];

    const windowStartMs = Math.floor(normalized.timestampMs / windowMs) * windowMs;
    if (!Number.isFinite(windowStartMs) || windowStartMs <= this.finalizedThroughMs) return [];

    const closed =
      this.currentWindow && windowStartMs > this.currentWindow.startMs
        ? this.finalizeCurrentWindow()
        : [];

    if (this.currentWindow && windowStartMs < this.currentWindow.startMs) return closed;

    this.currentWindow ??= createWindow(windowStartMs);
    accumulateLivePoint(this.currentWindow, normalized.metric, normalized.value);
    return [...closed, ...this.dispatchProgressSample(normalized)];
  }

  flush(): MetricSample[] {
    return this.currentWindow ? this.finalizeCurrentWindow() : [];
  }

  retainedWindowCount(): number {
    return this.currentWindow ? 1 : 0;
  }

  requestArrivalSummary(): RequestArrivalSummary {
    return {
      firstAttemptStartedAt:
        this.firstAttemptAtMs === null ? null : new Date(this.firstAttemptAtMs).toISOString(),
      peakArrivalRatePerSecond: this.peakArrivalRatePerSecond,
      peakArrivalWindowSeconds: windowMs / 1_000,
      dispatchDurationSeconds:
        this.firstAttemptAtMs === null || this.lastAttemptAtMs === null
          ? 0
          : (this.lastAttemptAtMs - this.firstAttemptAtMs) / 1_000,
      arrivalRateSeries: [...this.arrivalRateSeries],
      arrivalWindowCountObserved: this.arrivalWindowCountObserved,
      arrivalWindowCountRetained: this.arrivalRateSeries.length,
      arrivalSeriesLimit: arrivalRateSeriesLimit,
    };
  }

  private finalizeCurrentWindow(): MetricSample[] {
    const window = this.currentWindow;
    if (!window) return [];

    this.currentWindow = null;
    this.finalizedThroughMs = window.startMs;
    const timestamp = new Date(window.startMs).toISOString();
    const samples: MetricSample[] = [];
    const arrivalRate = window.arrivalCount / (windowMs / 1_000);
    if (window.arrivalObservationCount > 0) {
      samples.push({
        metricName: "traffic.request_arrival_rate",
        value: arrivalRate,
        unit: "requests_per_second",
        timestamp,
      });
      this.rememberArrivalWindow(timestamp, arrivalRate);
    }
    const completionRate = window.completionCount / (windowMs / 1_000);
    if (window.completionObservationCount > 0) {
      samples.push({
        metricName: "traffic.response_completion_rate",
        value: completionRate,
        unit: "requests_per_second",
        timestamp,
      });
    }
    const meanLatency = window.latencySum / window.latencyCount;
    if (window.latencyCount > 0) {
      samples.push({
        metricName: "traffic.latency",
        value: meanLatency,
        unit: "ms",
        timestamp,
      });
    }
    const failureRate = window.failureSum / window.failureCount;
    if (window.failureCount > 0) {
      samples.push({
        metricName: "traffic.failure_rate",
        value: failureRate,
        unit: "ratio",
        timestamp,
      });
    }
    return samples;
  }

  private dispatchProgressSample(normalized: NormalizedLivePoint): MetricSample[] {
    if (normalized.metric !== "checkout_attempts_started" || normalized.value === 0) return [];
    const nextAttemptsDispatched = this.attemptsDispatched + normalized.value;
    if (!Number.isFinite(nextAttemptsDispatched)) return [];
    this.attemptsDispatched = nextAttemptsDispatched;
    this.firstAttemptAtMs =
      this.firstAttemptAtMs === null
        ? normalized.timestampMs
        : Math.min(this.firstAttemptAtMs, normalized.timestampMs);
    this.lastAttemptAtMs =
      this.lastAttemptAtMs === null
        ? normalized.timestampMs
        : Math.max(this.lastAttemptAtMs, normalized.timestampMs);
    const progress = this.dispatchProgress;
    if (
      progress === null ||
      (this.lastReportedAttemptsDispatched > 0 &&
        this.attemptsDispatched - this.lastReportedAttemptsDispatched < progress.step &&
        this.attemptsDispatched < progress.plannedRequests)
    ) {
      return [];
    }
    this.lastReportedAttemptsDispatched = this.attemptsDispatched;
    return [
      {
        metricName: "traffic.attempts_dispatched",
        value: this.attemptsDispatched,
        unit: "requests",
        timestamp: new Date(normalized.timestampMs).toISOString(),
      },
    ];
  }

  private rememberArrivalWindow(windowStartedAt: string, ratePerSecond: number): void {
    this.peakArrivalRatePerSecond = Math.max(this.peakArrivalRatePerSecond, ratePerSecond);
    this.arrivalWindowCountObserved += 1;
    this.arrivalRateSeries.push({ windowStartedAt, ratePerSecond });
    if (this.arrivalRateSeries.length > arrivalRateSeriesLimit) this.arrivalRateSeries.shift();
  }
}

type NormalizedLivePoint = {
  metric: "checkout_attempts_started" | "http_reqs" | "http_req_duration" | "http_req_failed";
  value: number;
  timestampMs: number;
};

function normalizeLivePoint(point: K6Point): NormalizedLivePoint | null {
  if (point.type !== "Point" || !point.data) return null;
  if (
    point.metric !== "checkout_attempts_started" &&
    point.metric !== "http_reqs" &&
    point.metric !== "http_req_duration" &&
    point.metric !== "http_req_failed"
  ) {
    return null;
  }

  const timestamp = isoTimestampSchema.safeParse(point.data.time);
  const value = Number(point.data.value);
  if (!timestamp.success || !Number.isFinite(value)) return null;
  if (
    (point.metric === "checkout_attempts_started" ||
      point.metric === "http_reqs" ||
      point.metric === "http_req_duration") &&
    value < 0
  ) {
    return null;
  }
  if (point.metric === "http_req_failed" && value !== 0 && value !== 1) return null;
  return { metric: point.metric, value, timestampMs: Date.parse(timestamp.data) };
}

function createWindow(startMs: number): TrafficMetricWindow {
  return {
    startMs,
    arrivalCount: 0,
    arrivalObservationCount: 0,
    completionCount: 0,
    completionObservationCount: 0,
    latencySum: 0,
    latencyCount: 0,
    failureSum: 0,
    failureCount: 0,
  };
}

function accumulateLivePoint(
  window: TrafficMetricWindow,
  metric: NormalizedLivePoint["metric"],
  value: number,
): void {
  switch (metric) {
    case "checkout_attempts_started": {
      const nextArrivalCount = window.arrivalCount + value;
      if (!Number.isFinite(nextArrivalCount)) return;
      window.arrivalCount = nextArrivalCount;
      window.arrivalObservationCount += 1;
      break;
    }
    case "http_reqs": {
      const nextCompletionCount = window.completionCount + value;
      if (!Number.isFinite(nextCompletionCount)) return;
      window.completionCount = nextCompletionCount;
      window.completionObservationCount += 1;
      break;
    }
    case "http_req_duration": {
      const nextLatencySum = window.latencySum + value;
      if (!Number.isFinite(nextLatencySum)) return;
      window.latencySum = nextLatencySum;
      window.latencyCount += 1;
      break;
    }
    case "http_req_failed":
      window.failureSum += value;
      window.failureCount += 1;
      break;
  }
}
