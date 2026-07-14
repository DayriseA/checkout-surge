import {
  emptyHttpTimingBreakdownSummary,
  type TrafficExecutionStartRequest,
} from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import { K6RunAccumulator, parseK6SummaryMetrics } from "../src/application/k6-output-parser.js";
import { BoundedStdoutTail, readK6SummaryExport } from "../src/application/k6-runner.js";
import { generateK6Script } from "../src/application/k6-script.js";

const startedAt = new Date("2026-06-20T12:00:00.000Z");
const completedAt = new Date("2026-06-20T12:00:05.000Z");
const request = {
  runId: "55555555-5555-4555-8555-555555555555",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  apiBaseUrl: "http://localhost:4000",
  buyEndpointPath: "/buy",
  correlationId: "corr-summary-test",
  configSnapshot: {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 10,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 5,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 10,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 0,
      maxTps: 10,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 1000,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 1,
      retryPolicy: { maxAttempts: 1, initialBackoffMs: 0 },
      drainTimeoutSeconds: 10,
      pendingPersistenceRetryAfterSeconds: 1,
      circuitBreakerFailureThreshold: 1,
      circuitBreakerResetTimeoutMs: 1000,
    },
  },
} satisfies TrafficExecutionStartRequest;

describe("parseK6SummaryMetrics", () => {
  it("parses flat summary-export counters, rates, trends, and all timing phases", () => {
    const parsed = parseK6SummaryMetrics(
      JSON.stringify({
        metrics: {
          http_reqs: { count: 12 },
          checkout_reservation_accepted: { count: 0 },
          checkout_sold_out: { count: 10 },
          checkout_unexpected_response: { count: 2 },
          iterations: { count: 11.6 },
          dropped_iterations: { count: 1 },
          http_req_failed: { value: 0.25 },
          http_req_duration: { avg: 30, "p(95)": 50 },
          http_req_blocked: { avg: 1, "p(95)": 2 },
          http_req_connecting: { avg: 3, "p(95)": 4 },
          http_req_tls_handshaking: { avg: 5, "p(95)": 6 },
          http_req_sending: { avg: 7, "p(95)": 8 },
          http_req_waiting: { avg: 9, "p(95)": 10 },
          http_req_receiving: { avg: 11, "p(95)": 12 },
          ignored_metric: { count: 999 },
        },
      }),
    );

    expect(parsed).toMatchObject({
      httpRequests: 12,
      acceptedResponses: 0,
      soldOutResponses: 10,
      unexpectedResponses: 2,
      completedIterations: 12,
      droppedIterations: 1,
      httpFailureRate: 0.25,
      requestDuration: { averageMs: 30, p95Ms: 50 },
      timingPhases: {
        http_req_blocked: { averageMs: 1, p95Ms: 2 },
        http_req_connecting: { averageMs: 3, p95Ms: 4 },
        http_req_tls_handshaking: { averageMs: 5, p95Ms: 6 },
        http_req_sending: { averageMs: 7, p95Ms: 8 },
        http_req_waiting: { averageMs: 9, p95Ms: 10 },
        http_req_receiving: { averageMs: 11, p95Ms: 12 },
      },
    });
  });

  it("parses wrapped values and ignores wrong-typed or nonfinite supported fields", () => {
    const parsed = parseK6SummaryMetrics(
      JSON.stringify({
        metrics: {
          http_reqs: { values: { count: 4 } },
          checkout_reservation_accepted: { count: "4", values: { count: 3 } },
          checkout_sold_out: { count: -1 },
          checkout_unexpected_response: { count: null },
          http_req_failed: { values: { rate: 0 } },
          http_req_duration: { values: { avg: 0, "p(95)": null } },
        },
      }),
    );
    expect(parsed).toEqual({
      httpRequests: 4,
      acceptedResponses: 3,
      httpFailureRate: 0,
      requestDuration: { averageMs: 0, p95Ms: null },
      timingPhases: {},
    });
  });

  it("ignores JSON numeric overflow without rejecting other supported fields", () => {
    expect(
      parseK6SummaryMetrics(
        '{"metrics":{"http_reqs":{"count":4},"checkout_reservation_accepted":{"count":1e309},"http_req_failed":{"value":1e309},"http_req_duration":{"avg":1e309,"p(95)":5}}}',
      ),
    ).toEqual({
      httpRequests: 4,
      requestDuration: { averageMs: null, p95Ms: 5 },
      timingPhases: {},
    });
  });

  it("scans arbitrary malformed text and returns the last supported balanced object", () => {
    const parsed = parseK6SummaryMetrics(
      'log { malformed\n{"metrics":{"http_reqs":{"count":1}}}\n' +
        `${JSON.stringify({ message: 'brace } and escaped " { text' })}\n` +
        '{"metrics":{"http_reqs":{"count":0}}}',
    );
    expect(parsed?.httpRequests).toBe(0);
    expect(parseK6SummaryMetrics('{"metrics":{"unknown":{"count":1}}}')).toBeNull();
    expect(parseK6SummaryMetrics("not json\n{broken")).toBeNull();
  });
});

describe("K6RunAccumulator summary precedence", () => {
  it("selects each metric independently and preserves authoritative zero", () => {
    const accumulator = createAccumulator();
    accumulator.observe({ type: "Point", metric: "http_reqs", data: { value: 9 } });
    accumulator.observe({
      type: "Point",
      metric: "checkout_reservation_accepted",
      data: { value: 7 },
    });
    accumulator.observe({ type: "Point", metric: "http_req_waiting", data: { value: 20 } });
    accumulator.observe({ type: "Point", metric: "http_req_waiting", data: { value: 40 } });

    const report = accumulator.completionReport({
      status: "succeeded",
      completedAt,
      summaryMetrics: {
        httpRequests: 0,
        soldOutResponses: 2,
        requestDuration: { averageMs: 12, p95Ms: 18 },
        timingPhases: {
          http_req_blocked: { averageMs: 1, p95Ms: 3 },
        },
      },
    });

    expect(report.httpSummary).toMatchObject({
      emittedRequests: 0,
      completedRequests: 0,
      acceptedResponses: 7,
      soldOutResponses: 2,
      unexpectedResponses: 0,
      p95LatencyMs: 18,
    });
    expect(report.loadRunDiagnosticsSummary.terminalMetricSources).toEqual({
      emittedRequests: "summary_export",
      completedRequests: "summary_export",
      acceptedResponses: "point_stream",
      soldOutResponses: "summary_export",
      unexpectedResponses: null,
      droppedIterations: null,
      completedIterations: null,
    });
    expect(report.loadRunDiagnosticsSummary.summaryExportWarnings).toEqual([
      "k6_outcome_counter_point_stream_fallback_used",
      "k6_outcome_counter_summary_export_unavailable",
    ]);
    expect(report.httpTimingBreakdownSummary).toEqual({
      blocked: { averageMs: 1, p95Ms: 3 },
      connecting: null,
      tlsHandshaking: null,
      sending: null,
      waiting: { averageMs: 30, p95Ms: null },
      receiving: null,
    });
  });

  it("keeps duration aggregation bounded and leaves p95 unavailable without a summary", () => {
    const accumulator = createAccumulator();
    for (let value = 0; value < 20_000; value += 1) {
      accumulator.observe({ type: "Point", metric: "http_req_duration", data: { value } });
    }
    const report = accumulator.completionReport({ status: "succeeded", completedAt });
    expect(report.httpSummary).not.toHaveProperty("p95LatencyMs");
    expect(report.httpTimingBreakdownSummary).toEqual(emptyHttpTimingBreakdownSummary);
  });
});

describe("summary export fallback", () => {
  it.each([
    [Object.assign(new Error("missing"), { code: "ENOENT" }), "summary_export_missing"],
    [new Error("permission denied"), "summary_export_read_failed"],
  ])("distinguishes read failures and parses the bounded stdout fallback", async (error, warning) => {
    const result = await readK6SummaryExport(
      "/tmp/summary.json",
      'point noise {"metrics":{"http_reqs":{"count":3}}}',
      async () => {
        throw error;
      },
    );
    expect(result).toEqual({ metrics: { httpRequests: 3, timingPhases: {} }, warning });
  });

  it("distinguishes an invalid export", async () => {
    expect(await readK6SummaryExport("/tmp/summary.json", "no fallback", async () => "{}")).toEqual(
      { metrics: null, warning: "summary_export_invalid" },
    );
  });

  it("retains a strict byte-bounded tail", () => {
    const tail = new BoundedStdoutTail(8);
    tail.push("12345");
    tail.push("67890");
    expect(tail.byteLength()).toBe(8);
    expect(tail.toString()).toBe("34567890");
    tail.push("abcdefghijkl");
    expect(tail.byteLength()).toBe(8);
    expect(tail.toString()).toBe("efghijkl");
  });
});

function createAccumulator(): K6RunAccumulator {
  const generated = generateK6Script(request);
  return new K6RunAccumulator({
    runId: request.runId,
    correlationId: request.correlationId,
    plannedRequests: generated.plannedRequests,
    startedAt,
    executionPlan: generated.executionPlan,
  });
}
