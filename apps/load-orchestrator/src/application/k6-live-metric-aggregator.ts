import { isoTimestampSchema, type MetricSample } from "@checkout-surge/contracts";
import type { K6Point } from "./k6-output-parser.js";

interface TrafficMetricWindow {
  startMs: number;
  requestCount: number;
  requestObservationCount: number;
  latencySum: number;
  latencyCount: number;
  failureSum: number;
  failureCount: number;
}

/**
 * Aggregates supported k6 points into one aligned event-time window. A newer
 * window finalizes the prior one; late points for finalized/older windows are
 * ignored. Overflow-causing observations are ignored, and a derived sample is
 * omitted if it cannot be represented as a finite contract value.
 */
export class K6LiveMetricAggregator {
  private readonly windowMs: number;
  private currentWindow: TrafficMetricWindow | null = null;
  private finalizedThroughMs = Number.NEGATIVE_INFINITY;

  constructor(options: { windowMs?: number } = {}) {
    this.windowMs = options.windowMs ?? 1_000;
    if (!Number.isFinite(this.windowMs) || this.windowMs <= 0) {
      throw new Error("k6 live metric windowMs must be finite and greater than zero.");
    }
  }

  observe(point: K6Point): MetricSample[] {
    const normalized = normalizeLivePoint(point);
    if (!normalized) return [];

    const windowStartMs = Math.floor(normalized.timestampMs / this.windowMs) * this.windowMs;
    if (!Number.isFinite(windowStartMs) || windowStartMs <= this.finalizedThroughMs) return [];

    const closed =
      this.currentWindow && windowStartMs > this.currentWindow.startMs
        ? this.finalizeCurrentWindow()
        : [];

    if (this.currentWindow && windowStartMs < this.currentWindow.startMs) return closed;

    this.currentWindow ??= createWindow(windowStartMs);
    accumulateLivePoint(this.currentWindow, normalized.metric, normalized.value);
    return closed;
  }

  flush(): MetricSample[] {
    return this.currentWindow ? this.finalizeCurrentWindow() : [];
  }

  retainedWindowCount(): number {
    return this.currentWindow ? 1 : 0;
  }

  private finalizeCurrentWindow(): MetricSample[] {
    const window = this.currentWindow;
    if (!window) return [];

    this.currentWindow = null;
    this.finalizedThroughMs = window.startMs;
    const timestamp = new Date(window.startMs).toISOString();
    const samples: MetricSample[] = [];
    const requestRate = window.requestCount / (this.windowMs / 1_000);
    if (window.requestObservationCount > 0 && Number.isFinite(requestRate)) {
      samples.push({
        metricName: "traffic.scheduled_request_rate",
        value: requestRate,
        unit: "requests_per_second",
        timestamp,
      });
    }
    const meanLatency = window.latencySum / window.latencyCount;
    if (window.latencyCount > 0 && Number.isFinite(meanLatency)) {
      samples.push({
        metricName: "traffic.latency",
        value: meanLatency,
        unit: "ms",
        timestamp,
      });
    }
    const failureRate = window.failureSum / window.failureCount;
    if (window.failureCount > 0 && Number.isFinite(failureRate)) {
      samples.push({
        metricName: "traffic.failure_rate",
        value: failureRate,
        unit: "ratio",
        timestamp,
      });
    }
    return samples;
  }
}

type NormalizedLivePoint = {
  metric: "http_reqs" | "http_req_duration" | "http_req_failed";
  value: number;
  timestampMs: number;
};

function normalizeLivePoint(point: K6Point): NormalizedLivePoint | null {
  if (point.type !== "Point" || !point.data) return null;
  if (
    point.metric !== "http_reqs" &&
    point.metric !== "http_req_duration" &&
    point.metric !== "http_req_failed"
  ) {
    return null;
  }

  const timestamp = isoTimestampSchema.safeParse(point.data.time);
  const value = Number(point.data.value);
  if (!timestamp.success || !Number.isFinite(value)) return null;
  if ((point.metric === "http_reqs" || point.metric === "http_req_duration") && value < 0) {
    return null;
  }
  if (point.metric === "http_req_failed" && value !== 0 && value !== 1) return null;
  return { metric: point.metric, value, timestampMs: Date.parse(timestamp.data) };
}

function createWindow(startMs: number): TrafficMetricWindow {
  return {
    startMs,
    requestCount: 0,
    requestObservationCount: 0,
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
    case "http_reqs": {
      const nextRequestCount = window.requestCount + value;
      if (!Number.isFinite(nextRequestCount)) return;
      window.requestCount = nextRequestCount;
      window.requestObservationCount += 1;
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
