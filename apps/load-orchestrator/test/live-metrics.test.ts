import {
  type LoadMetricIngestRequest,
  liveTrafficMetricWindowSeconds,
  type MetricSample,
} from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import { LoadApiHttpError, MetricBatcher } from "../src/application/api-client.js";
import { K6JsonLineFramer } from "../src/application/k6-json-line-framer.js";
import { K6LiveMetricAggregator } from "../src/application/k6-live-metric-aggregator.js";
import type { K6Point } from "../src/application/k6-output-parser.js";

const windowStart = "2026-06-20T12:00:00.000Z";
const nextWindow = "2026-06-20T12:00:01.000Z";

describe("K6LiveMetricAggregator", () => {
  it("keeps attempt arrival separate from response completion in one window", () => {
    const aggregator = new K6LiveMetricAggregator();
    const points = [
      point("checkout_attempts_started", 6, windowStart),
      point("http_reqs", 1, windowStart),
      point("http_reqs", 3, windowStart),
      point("http_req_duration", 20, windowStart),
      point("http_req_duration", 40, windowStart),
      point("http_req_failed", 0, windowStart),
      point("http_req_failed", 1, windowStart),
    ];

    expect(points.flatMap((entry) => aggregator.observe(entry))).toEqual([]);
    expect(aggregator.flush()).toEqual([
      metric("traffic.request_arrival_rate", 6, "requests_per_second"),
      metric("traffic.response_completion_rate", 4, "requests_per_second"),
      metric("traffic.latency", 30, "ms"),
      metric("traffic.failure_rate", 0.5, "ratio"),
    ]);
    expect(aggregator.requestArrivalSummary().peakArrivalWindowSeconds).toBe(
      liveTrafficMetricWindowSeconds,
    );
  });

  it("scales request deltas by the full configured window and validates the width", () => {
    const aggregator = new K6LiveMetricAggregator({ windowMs: 2_000 });
    aggregator.observe(point("http_reqs", 4, windowStart));

    expect(aggregator.flush()).toEqual([
      metric("traffic.response_completion_rate", 2, "requests_per_second"),
    ]);
    expect(() => new K6LiveMetricAggregator({ windowMs: 0 })).toThrow(/greater than zero/);
    expect(() => new K6LiveMetricAggregator({ windowMs: Number.NaN })).toThrow(/finite/);
  });

  it("closes the prior window on a newer event and flushes the final window only once", () => {
    const aggregator = new K6LiveMetricAggregator();
    aggregator.observe(point("http_reqs", 2, windowStart));

    expect(aggregator.observe(point("http_reqs", 1, nextWindow))).toEqual([
      metric("traffic.response_completion_rate", 2, "requests_per_second"),
    ]);
    expect(aggregator.flush()).toEqual([
      {
        ...metric("traffic.response_completion_rate", 1, "requests_per_second"),
        timestamp: nextWindow,
      },
    ]);
    expect(aggregator.flush()).toEqual([]);
  });

  it("ignores malformed, unsupported, negative, invalid-rate, and finalized late points", () => {
    for (const invalidTimestamp of ["not-a-time", "0", "2026-06-20", "2026-06-20T12:00:00"]) {
      const strictTimestampAggregator = new K6LiveMetricAggregator();
      expect(strictTimestampAggregator.observe(point("http_reqs", 1, invalidTimestamp))).toEqual(
        [],
      );
      expect(strictTimestampAggregator.flush()).toEqual([]);
    }
    const aggregator = new K6LiveMetricAggregator();
    expect(aggregator.observe(point("http_reqs", -1, windowStart))).toEqual([]);
    expect(aggregator.observe(point("http_req_failed", 0.5, windowStart))).toEqual([]);
    expect(aggregator.observe(point("unsupported", 1, windowStart))).toEqual([]);
    aggregator.observe(point("http_reqs", 1, windowStart));
    aggregator.observe(point("http_reqs", 1, nextWindow));

    expect(aggregator.observe(point("http_reqs", 99, windowStart))).toEqual([]);
    expect(aggregator.retainedWindowCount()).toBe(1);
    expect(aggregator.flush()[0]?.value).toBe(1);
  });

  it("ignores overflow-causing observations and never emits a non-finite value", () => {
    const aggregator = new K6LiveMetricAggregator();
    aggregator.observe(point("http_reqs", Number.MAX_VALUE, windowStart));
    aggregator.observe(point("http_reqs", Number.MAX_VALUE, windowStart));
    aggregator.observe(point("http_req_duration", Number.MAX_VALUE, windowStart));
    aggregator.observe(point("http_req_duration", Number.MAX_VALUE, windowStart));
    aggregator.observe(point("http_req_failed", 1, windowStart));

    const samples = aggregator.flush();
    expect(samples.map((sample) => sample.value)).toEqual([Number.MAX_VALUE, Number.MAX_VALUE, 1]);
    expect(samples.every((sample) => Number.isFinite(sample.value))).toBe(true);

    const derivedOverflow = new K6LiveMetricAggregator({ windowMs: Number.MIN_VALUE });
    derivedOverflow.observe(point("http_reqs", 1, "1970-01-01T00:00:00.000Z"));
    derivedOverflow.observe(point("http_req_duration", 1, "1970-01-01T00:00:00.000Z"));
    expect(derivedOverflow.flush()).toEqual([
      {
        metricName: "traffic.latency",
        value: 1,
        unit: "ms",
        timestamp: "1970-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("emits no metric without observations and preserves an observed zero completion rate", () => {
    expect(new K6LiveMetricAggregator().flush()).toEqual([]);

    const requestOnly = new K6LiveMetricAggregator();
    requestOnly.observe(point("http_reqs", 0, windowStart));
    expect(requestOnly.flush()).toEqual([
      metric("traffic.response_completion_rate", 0, "requests_per_second"),
    ]);

    const latencyOnly = new K6LiveMetricAggregator();
    latencyOnly.observe(point("http_req_duration", 0, windowStart));
    expect(latencyOnly.flush()).toEqual([metric("traffic.latency", 0, "ms")]);
  });

  it("reports a slow-response burst at attempt time, retains its peak, and bounds its series", () => {
    const aggregator = new K6LiveMetricAggregator({ plannedRequests: 230 });
    const samples = [];
    for (let index = 0; index < 100; index += 1) {
      samples.push(...aggregator.observe(point("checkout_attempts_started", 1, windowStart)));
    }

    for (let window = 1; window <= 130; window += 1) {
      const timestamp = new Date(Date.parse(windowStart) + window * 1_000).toISOString();
      if (window <= 3) {
        samples.push(...aggregator.observe(point("http_reqs", window === 3 ? 50 : 25, timestamp)));
      }
      samples.push(...aggregator.observe(point("checkout_attempts_started", 1, timestamp)));
    }
    samples.push(...aggregator.flush());

    expect(samples).toContainEqual(
      metric("traffic.request_arrival_rate", 100, "requests_per_second"),
    );
    expect(samples).toContainEqual({
      ...metric("traffic.response_completion_rate", 25, "requests_per_second"),
      timestamp: nextWindow,
    });
    expect(samples).toContainEqual({
      ...metric("traffic.response_completion_rate", 50, "requests_per_second"),
      timestamp: "2026-06-20T12:00:03.000Z",
    });

    const summary = aggregator.requestArrivalSummary();
    expect(summary).toMatchObject({
      firstAttemptStartedAt: windowStart,
      peakArrivalRatePerSecond: 100,
      peakArrivalWindowSeconds: 1,
      arrivalWindowCountObserved: 131,
      arrivalWindowCountRetained: 120,
      arrivalSeriesLimit: 120,
    });
    expect(summary.arrivalRateSeries).toHaveLength(120);
  });

  it("emits bounded cumulative dispatch progress before any response completes", () => {
    const aggregator = new K6LiveMetricAggregator({ plannedRequests: 10 });
    const samples = Array.from({ length: 10 }, () =>
      aggregator.observe(point("checkout_attempts_started", 1, windowStart)),
    ).flat();

    expect(samples.at(-1)).toEqual({
      metricName: "traffic.attempts_dispatched",
      value: 10,
      unit: "requests",
      timestamp: windowStart,
    });
    expect(samples).toHaveLength(10);
  });
});

describe("K6JsonLineFramer", () => {
  it("preserves split lines and returns a final unterminated line", () => {
    const framer = new K6JsonLineFramer();
    expect(framer.push('{"one":')).toEqual([]);
    expect(framer.push('1}\n{"two":2}')).toEqual(['{"one":1}']);
    expect(framer.finish()).toEqual(['{"two":2}']);
  });

  it("drops an oversized line until newline without retaining an unbounded buffer", () => {
    const framer = new K6JsonLineFramer({ maxLineLength: 8 });
    expect(framer.push("123456789012345")).toEqual([]);
    expect(framer.retainedCharacterCount()).toBe(0);
    expect(framer.push('\n{"ok":1}\n')).toEqual(['{"ok":1}']);
  });
});

describe("MetricBatcher", () => {
  it("reuses one envelope across three attempts and gives the next batch a new ID", async () => {
    const sent: LoadMetricIngestRequest[] = [];
    let nowCall = 0;
    const batcher = new MetricBatcher({
      runId: "55555555-5555-4555-8555-555555555555",
      correlationId: "corr",
      maxBatchSize: 1,
      now: () => new Date(Date.UTC(2026, 6, 13, 0, 0, nowCall++)),
      client: {
        sendMetrics: async (batch) => {
          sent.push(batch);
          if (sent.length < 3) throw new Error("transport failure");
        },
      },
    });

    await batcher.add(sample(1));
    await batcher.add(sample(2));
    await batcher.close();

    expect(sent).toHaveLength(4);
    expect(
      sent.slice(0, 3).map(({ batchId, observedAt, samples }) => ({
        batchId,
        observedAt,
        samples,
      })),
    ).toEqual(
      Array(3).fill({
        batchId: sent[0]?.batchId,
        observedAt: sent[0]?.observedAt,
        samples: [sample(1)],
      }),
    );
    expect(sent[3]?.batchId).not.toBe(sent[0]?.batchId);
    expect(sent[3]?.samples).toEqual([sample(2)]);
  });

  it("retries a transient failure without reordering or losing samples", async () => {
    const sent: number[][] = [];
    let attempts = 0;
    const batcher = new MetricBatcher({
      runId: "55555555-5555-4555-8555-555555555555",
      correlationId: "corr",
      maxBatchSize: 2,
      client: {
        sendMetrics: async (batch) => {
          sent.push(batch.samples.map((entry) => entry.value));
          attempts += 1;
          if (attempts === 1) throw new Error("transport failure");
        },
      },
    });

    await batcher.add(sample(1));
    const firstBatch = batcher.add(sample(2));
    await batcher.add(sample(3));
    await batcher.add(sample(4));
    await firstBatch;
    await batcher.close();

    expect(sent).toEqual([
      [1, 2],
      [1, 2],
      [3, 4],
    ]);
    expect(batcher.lossTotals()).toEqual({ sampleCount: 0, batchCount: 0 });
  });

  it("counts a batch as lost after the retry bound is exhausted", async () => {
    const sendMetrics = vi.fn(async () => {
      throw new Error("transport failure");
    });
    const batcher = new MetricBatcher({
      runId: "55555555-5555-4555-8555-555555555555",
      correlationId: "corr",
      maxBatchSize: 2,
      client: { sendMetrics },
    });

    await batcher.add(sample(1));
    await batcher.add(sample(2));
    await batcher.close();

    expect(sendMetrics).toHaveBeenCalledTimes(3);
    expect(batcher.lossTotals()).toEqual({ sampleCount: 2, batchCount: 1 });
  });

  it("does not retry non-retryable HTTP failures", async () => {
    const sendMetrics = vi.fn(async () => {
      throw new LoadApiHttpError("invalid request");
    });
    const batcher = new MetricBatcher({
      runId: "55555555-5555-4555-8555-555555555555",
      correlationId: "corr",
      maxBatchSize: 1,
      client: { sendMetrics },
    });

    await batcher.add(sample(1));
    await batcher.close();

    expect(sendMetrics).toHaveBeenCalledOnce();
    expect(batcher.lossTotals()).toEqual({ sampleCount: 1, batchCount: 1 });
  });

  it("sends batches single-flight and preserves samples arriving during a pending send", async () => {
    const sent: LoadMetricIngestRequest[] = [];
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const batcher = new MetricBatcher({
      runId: "55555555-5555-4555-8555-555555555555",
      correlationId: "corr",
      maxBatchSize: 1,
      maxBufferedSamples: 2,
      client: {
        sendMetrics: async (batch) => {
          sent.push(batch);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => releases.push(resolve));
          inFlight -= 1;
        },
      },
    });

    const first = batcher.add(sample(1));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const second = batcher.add(sample(2));
    expect(sent).toHaveLength(1);
    releases.shift()?.();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    releases.shift()?.();
    await Promise.all([first, second]);
    await batcher.close();

    expect(maxInFlight).toBe(1);
    expect(sent.flatMap((batch) => batch.samples.map((entry) => entry.value))).toEqual([1, 2]);
  });

  it("close waits for the active batch and a final queued partial batch", async () => {
    const sent: LoadMetricIngestRequest[] = [];
    let release: () => void = () => undefined;
    const firstSend = new Promise<void>((resolve) => {
      release = resolve;
    });
    const batcher = new MetricBatcher({
      runId: "55555555-5555-4555-8555-555555555555",
      correlationId: "corr",
      maxBatchSize: 2,
      client: {
        sendMetrics: vi.fn(async (batch) => {
          sent.push(batch);
          if (sent.length === 1) await firstSend;
        }),
      },
    });

    await batcher.add(sample(1));
    const sizeFlush = batcher.add(sample(2));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await batcher.add(sample(3));
    let closed = false;
    const closing = batcher.close().then(() => {
      closed = true;
    });
    expect(closed).toBe(false);
    release();
    await Promise.all([sizeFlush, closing]);

    expect(sent.map((batch) => batch.samples.map((entry) => entry.value))).toEqual([[1, 2], [3]]);
  });

  it("drops the newest sample and reports it when the bounded buffer is full", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const overflow = vi.fn();
    const sent: LoadMetricIngestRequest[] = [];
    const batcher = new MetricBatcher({
      runId: "55555555-5555-4555-8555-555555555555",
      correlationId: "corr",
      maxBatchSize: 2,
      maxBufferedSamples: 2,
      onOverflow: overflow,
      client: {
        sendMetrics: async (batch) => {
          sent.push(batch);
          if (sent.length === 1) await gate;
        },
      },
    });

    void batcher.add(sample(1));
    void batcher.add(sample(2));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    void batcher.add(sample(3));
    void batcher.add(sample(4));
    await batcher.add(sample(5));
    expect(overflow).toHaveBeenCalledWith(sample(5));
    release();
    await batcher.close();
    expect(sent.flatMap((batch) => batch.samples.map((entry) => entry.value))).toEqual([
      1, 2, 3, 4,
    ]);
    expect(batcher.lossTotals()).toEqual({ sampleCount: 1, batchCount: 1 });
  });

  it("bounds retries while closing a final partial batch", async () => {
    const sendMetrics = vi.fn(async () => {
      throw new Error("transport failure");
    });
    const batcher = new MetricBatcher({
      runId: "55555555-5555-4555-8555-555555555555",
      correlationId: "corr",
      maxBatchSize: 2,
      client: { sendMetrics },
    });

    await batcher.add(sample(1));
    await batcher.close();

    expect(sendMetrics).toHaveBeenCalledTimes(3);
    expect(batcher.lossTotals()).toEqual({ sampleCount: 1, batchCount: 1 });
  });

  it("abandons pending retries when discarded", async () => {
    const sendMetrics = vi.fn(async () => {
      throw new Error("transport failure");
    });
    const batcher = new MetricBatcher({
      runId: "55555555-5555-4555-8555-555555555555",
      correlationId: "corr",
      maxBatchSize: 1,
      client: { sendMetrics },
    });

    const add = batcher.add(sample(1));
    await vi.waitFor(() => expect(sendMetrics).toHaveBeenCalledOnce());
    await batcher.discard();
    await add;

    expect(sendMetrics).toHaveBeenCalledOnce();
    expect(batcher.lossTotals()).toEqual({ sampleCount: 0, batchCount: 0 });
  });
});

function point(metricName: string, value: number, time: string): K6Point {
  return { type: "Point", metric: metricName, data: { value, time } };
}

function metric(metricName: MetricSample["metricName"], value: number, unit: string): MetricSample {
  return { metricName, value, unit, timestamp: windowStart };
}

function sample(value: number): MetricSample {
  return metric("traffic.latency", value, "ms");
}
