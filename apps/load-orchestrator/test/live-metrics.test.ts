import type { LoadMetricIngestRequest, MetricSample } from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import { MetricBatcher } from "../src/application/api-client.js";
import { K6JsonLineFramer } from "../src/application/k6-json-line-framer.js";
import { K6LiveMetricAggregator } from "../src/application/k6-live-metric-aggregator.js";
import type { K6Point } from "../src/application/k6-output-parser.js";

const windowStart = "2026-06-20T12:00:00.000Z";
const nextWindow = "2026-06-20T12:00:01.000Z";

describe("K6LiveMetricAggregator", () => {
  it("emits summed request rate, mean latency, and failure fraction for a closed window", () => {
    const aggregator = new K6LiveMetricAggregator();
    const points = [
      point("http_reqs", 1, windowStart),
      point("http_reqs", 3, windowStart),
      point("http_req_duration", 20, windowStart),
      point("http_req_duration", 40, windowStart),
      point("http_req_failed", 0, windowStart),
      point("http_req_failed", 1, windowStart),
    ];

    expect(points.flatMap((entry) => aggregator.observe(entry))).toEqual([]);
    expect(aggregator.flush()).toEqual([
      metric("traffic.scheduled_request_rate", 4, "requests_per_second"),
      metric("traffic.latency", 30, "ms"),
      metric("traffic.failure_rate", 0.5, "ratio"),
    ]);
  });

  it("scales request deltas by the full configured window and validates the width", () => {
    const aggregator = new K6LiveMetricAggregator({ windowMs: 2_000 });
    aggregator.observe(point("http_reqs", 4, windowStart));

    expect(aggregator.flush()).toEqual([
      metric("traffic.scheduled_request_rate", 2, "requests_per_second"),
    ]);
    expect(() => new K6LiveMetricAggregator({ windowMs: 0 })).toThrow(/greater than zero/);
    expect(() => new K6LiveMetricAggregator({ windowMs: Number.NaN })).toThrow(/finite/);
  });

  it("closes the prior window on a newer event and flushes the final window only once", () => {
    const aggregator = new K6LiveMetricAggregator();
    aggregator.observe(point("http_reqs", 2, windowStart));

    expect(aggregator.observe(point("http_reqs", 1, nextWindow))).toEqual([
      metric("traffic.scheduled_request_rate", 2, "requests_per_second"),
    ]);
    expect(aggregator.flush()).toEqual([
      {
        ...metric("traffic.scheduled_request_rate", 1, "requests_per_second"),
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

  it("emits no metric without observations and preserves an observed zero request rate", () => {
    expect(new K6LiveMetricAggregator().flush()).toEqual([]);

    const requestOnly = new K6LiveMetricAggregator();
    requestOnly.observe(point("http_reqs", 0, windowStart));
    expect(requestOnly.flush()).toEqual([
      metric("traffic.scheduled_request_rate", 0, "requests_per_second"),
    ]);

    const latencyOnly = new K6LiveMetricAggregator();
    latencyOnly.observe(point("http_req_duration", 0, windowStart));
    expect(latencyOnly.flush()).toEqual([metric("traffic.latency", 0, "ms")]);
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
