import {
  deriveRecordedReplyCount,
  emptyHttpTimingBreakdownSummary,
  type TrafficExecutionStartRequest,
  trafficCompletionReportSchema,
} from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import {
  counterMetricFields,
  K6RunAccumulator,
  parseK6JsonLine,
  parseK6SummaryMetrics,
} from "../src/application/k6-output-parser.js";
import { generateK6Script } from "../src/application/k6-script.js";
import { processBootId } from "../src/application/traffic-execution-service.js";

const startedAt = new Date("2026-06-20T12:00:00.000Z");
const completedAt = new Date("2026-06-20T12:00:05.000Z");
const request = {
  runId: "55555555-5555-4555-8555-555555555555",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  apiBaseUrl: "http://localhost:4000",
  expectedBootId: processBootId,
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
    },
    erpConfig: {
      latencyMs: 0,
      maxTps: 10,
      errorRate: 0,
      forcedOutage: false,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 1,
    },
  },
} satisfies TrafficExecutionStartRequest;

describe("parseK6SummaryMetrics", () => {
  it("parses flat summary-export counters, rates, trends, and all timing phases", () => {
    const parsed = parseK6SummaryMetrics(
      JSON.stringify({
        metrics: {
          http_reqs: { count: 12 },
          checkout_attempts_started: { count: 14 },
          checkout_responses_completed: { count: 12 },
          checkout_reservation_accepted: { count: 0 },
          checkout_sold_out_rejections: { count: 10 },
          checkout_transport_failures: { count: 1 },
          checkout_request_timeouts: { count: 1 },
          checkout_unexpected_responses: { count: 2 },
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
      attemptsStarted: 14,
      responsesCompleted: 12,
      acceptedResponses: 0,
      soldOutResponses: 10,
      transportFailures: 1,
      requestTimeouts: 1,
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
          checkout_sold_out_rejections: { count: -1 },
          checkout_unexpected_responses: { count: null },
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

  it("requires one supported JSON summary document", () => {
    expect(parseK6SummaryMetrics('log noise\n{"metrics":{"http_reqs":{"count":1}}}')).toBeNull();
    expect(
      parseK6SummaryMetrics(
        '{"metrics":{"http_reqs":{"count":1}}}{"metrics":{"http_reqs":{"count":0}}}',
      ),
    ).toBeNull();
    expect(parseK6SummaryMetrics('{"metrics":{"unknown":{"count":1}}}')).toBeNull();
    expect(parseK6SummaryMetrics("not json\n{broken")).toBeNull();
  });
});

describe("k6 counter initialization", () => {
  it("initializes every counter the parser reads in the generated script's setup", () => {
    const script = generateK6Script(request).contents;
    const setupStart = script.indexOf("export function setup()");
    const initialized = script.slice(setupStart, script.indexOf("counter.add(0)", setupStart));
    const variables = new Map(
      [...script.matchAll(/const (\w+) = new Counter\("(\w+)"\);/g)].map(([, variable, metric]) => [
        metric,
        variable,
      ]),
    );
    for (const metric of Object.keys(counterMetricFields)) {
      expect(variables.get(metric), metric).toBeDefined();
      expect(initialized).toContain(`    ${variables.get(metric)},`);
    }
  });

  it("drops zero counter samples from the point stream but keeps zero rate samples", () => {
    const point = (metric: string, value: number) =>
      parseK6JsonLine(JSON.stringify({ type: "Point", metric, data: { value } }));
    expect(point("checkout_transport_failures", 0)).toBeNull();
    expect(point("checkout_attempts_started", 0)).toBeNull();
    expect(point("checkout_transport_failures", 1)).not.toBeNull();
    expect(point("http_req_failed", 0)).not.toBeNull();
  });
});

describe("K6RunAccumulator summary precedence", () => {
  it("reports a clean run's initialized zero counters from the export without warnings", () => {
    const summaryMetrics = parseK6SummaryMetrics(
      JSON.stringify({
        metrics: {
          checkout_attempts_started: { count: 10 },
          checkout_responses_completed: { count: 10 },
          checkout_reservation_accepted: { count: 10 },
          checkout_sold_out_rejections: { count: 0 },
          checkout_transport_failures: { count: 0 },
          checkout_request_timeouts: { count: 0 },
          checkout_unexpected_responses: { count: 0 },
          http_reqs: { count: 10 },
          iterations: { count: 10 },
          dropped_iterations: { count: 0 },
          http_req_failed: { value: 0 },
        },
      }),
    );
    if (!summaryMetrics) throw new Error("Expected a valid k6 export");
    const report = createAccumulator().completionReport({
      status: "succeeded",
      completedAt,
      summaryMetrics,
    });
    expect(trafficCompletionReportSchema.parse(report).httpSummary).toEqual({
      failedRequests: 0,
      acceptedResponses: 10,
      soldOutResponses: 0,
      transportFailures: 0,
      requestTimeouts: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    });
    expect(report.trafficDeliverySummary.droppedIterations).toBe(0);
    expect(Object.values(report.loadRunDiagnosticsSummary.terminalMetricSources)).toEqual(
      Array(8).fill("summary_export"),
    );
    expect(report.loadRunDiagnosticsSummary.summaryExportWarnings).toEqual([]);
  });

  it("keeps unsourced counters unknown when the export is missing, retaining streamed evidence", () => {
    const accumulator = createAccumulator();
    accumulator.observe({
      type: "Point",
      metric: "checkout_reservation_accepted",
      data: { value: 3 },
    });
    const report = accumulator.completionReport({
      status: "failed",
      completedAt,
      summaryExportWarning: "summary_export_missing",
    });
    expect(trafficCompletionReportSchema.parse(report).httpSummary).toEqual({
      failedRequests: null,
      acceptedResponses: 3,
      soldOutResponses: null,
      transportFailures: null,
      requestTimeouts: null,
      unexpectedResponses: null,
      failureRate: null,
    });
    expect(report.transportAttemptCounts).toEqual({
      plannedRequests: 10,
      startedRequests: null,
      completedRequests: null,
      interruptedRequests: null,
      unstartedRequests: null,
    });
    expect(report.trafficDeliverySummary.droppedIterations).toBeNull();
    expect(report.trafficDeliverySummary.completedIterations).toBeNull();
    expect(report.loadRunDiagnosticsSummary.summaryExportWarnings).toContain(
      "summary_export_missing",
    );
    expect(report.loadRunDiagnosticsSummary.terminalMetricSources.transportFailures).toBeNull();
  });

  it("selects each metric independently and preserves authoritative zero", () => {
    const accumulator = createAccumulator();
    accumulator.observe({ type: "Point", metric: "checkout_attempts_started", data: { value: 9 } });
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
        attemptsStarted: 0,
        responsesCompleted: 0,
        soldOutResponses: 2,
        requestDuration: { averageMs: 12, p95Ms: 18 },
        timingPhases: {
          http_req_blocked: { averageMs: 1, p95Ms: 3 },
        },
      },
    });

    expect(report.transportAttemptCounts).toMatchObject({
      startedRequests: 0,
      completedRequests: 0,
      interruptedRequests: 0,
      unstartedRequests: 10,
    });
    expect(report.httpSummary).toMatchObject({
      acceptedResponses: 7,
      soldOutResponses: 2,
      unexpectedResponses: null,
      p95LatencyMs: 18,
    });
    expect(report.loadRunDiagnosticsSummary.terminalMetricSources).toEqual({
      startedRequests: "summary_export",
      completedRequests: "summary_export",
      acceptedResponses: "point_stream",
      soldOutResponses: "summary_export",
      transportFailures: null,
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

  it("leaves p95 unavailable without a summary", () => {
    const accumulator = createAccumulator();
    accumulator.observe({ type: "Point", metric: "http_req_duration", data: { value: 10 } });
    const report = accumulator.completionReport({ status: "succeeded", completedAt });
    expect(report.httpSummary).not.toHaveProperty("p95LatencyMs");
    expect(report.httpTimingBreakdownSummary).toEqual(emptyHttpTimingBreakdownSummary);
  });
});

describe("K6RunAccumulator transport-attempt reconciliation", () => {
  it("reports started attempts still in flight at shutdown as interrupted, never unstarted", () => {
    const accumulator = createAccumulator({ buyerCount: 1_000 });
    const report = accumulator.completionReport({
      status: "failed",
      completedAt,
      summaryMetrics: {
        attemptsStarted: 1_000,
        responsesCompleted: 750,
        httpRequests: 750,
        acceptedResponses: 250,
        soldOutResponses: 500,
        unexpectedResponses: 0,
        timingPhases: {},
      },
    });

    expect(report.transportAttemptCounts).toMatchObject({
      plannedRequests: 1_000,
      startedRequests: 1_000,
      completedRequests: 750,
      interruptedRequests: 250,
      unstartedRequests: 0,
    });
    expect(report.trafficDeliverySummary).not.toHaveProperty("startedRequests");
    expect(report.loadRunDiagnosticsSummary.terminalMetricSources).toMatchObject({
      startedRequests: "summary_export",
      completedRequests: "summary_export",
    });
  });

  it("reports attempts that never reached the started counter as unstarted", () => {
    const accumulator = createAccumulator({ buyerCount: 1_000 });
    const report = accumulator.completionReport({
      status: "succeeded",
      completedAt,
      summaryMetrics: {
        attemptsStarted: 750,
        responsesCompleted: 750,
        httpRequests: 750,
        timingPhases: {},
      },
    });

    expect(report.transportAttemptCounts).toMatchObject({
      plannedRequests: 1_000,
      startedRequests: 750,
      completedRequests: 750,
      interruptedRequests: 0,
      unstartedRequests: 250,
    });
  });

  it("reconciles a mixed run with both interrupted and unstarted attempts", () => {
    const accumulator = createAccumulator({ buyerCount: 1_000 });
    const report = accumulator.completionReport({
      status: "failed",
      completedAt,
      summaryMetrics: {
        attemptsStarted: 800,
        responsesCompleted: 750,
        httpRequests: 750,
        timingPhases: {},
      },
    });

    expect(report.transportAttemptCounts).toMatchObject({
      plannedRequests: 1_000,
      startedRequests: 800,
      completedRequests: 750,
      interruptedRequests: 50,
      unstartedRequests: 200,
    });
  });

  it("falls back to http_reqs for completion without erasing a larger explicit started count", () => {
    const accumulator = createAccumulator({ buyerCount: 1_000 });
    const report = accumulator.completionReport({
      status: "failed",
      completedAt,
      summaryMetrics: {
        attemptsStarted: 1_000,
        httpRequests: 750,
        timingPhases: {},
      },
    });

    expect(report.transportAttemptCounts).toMatchObject({
      startedRequests: 1_000,
      completedRequests: 750,
      interruptedRequests: 250,
      unstartedRequests: 0,
    });
    expect(report.loadRunDiagnosticsSummary.terminalMetricSources).toMatchObject({
      startedRequests: "summary_export",
      completedRequests: "summary_export",
    });
  });

  it("counts a reply whose outcome was not recorded at the stop as interrupted", () => {
    // k6 drops the samples of a VU whose context the graceful stop ended, so the reply's
    // http_reqs sample, and even the completion counter, can be recorded without its outcome.
    const summaryMetrics = parseK6SummaryMetrics(
      JSON.stringify({
        metrics: {
          checkout_attempts_started: { count: 10 },
          checkout_responses_completed: { count: 10 },
          checkout_reservation_accepted: { count: 9 },
          checkout_sold_out_rejections: { count: 0 },
          checkout_transport_failures: { count: 0 },
          checkout_request_timeouts: { count: 0 },
          checkout_unexpected_responses: { count: 0 },
          http_reqs: { count: 10 },
          iterations: { count: 9 },
          dropped_iterations: { count: 0 },
        },
      }),
    );
    if (!summaryMetrics) throw new Error("Expected a valid k6 export");
    const report = createAccumulator().completionReport({
      status: "succeeded",
      completedAt,
      summaryMetrics,
    });

    expect(trafficCompletionReportSchema.parse(report).transportAttemptCounts).toEqual({
      plannedRequests: 10,
      startedRequests: 10,
      completedRequests: 9,
      interruptedRequests: 1,
      unstartedRequests: 0,
    });
    expect(
      deriveRecordedReplyCount(report.transportAttemptCounts, report.httpSummary.transportFailures),
    ).toBe(9);
    expect(report.loadRunDiagnosticsSummary.terminalMetricSources.completedRequests).toBe(
      "summary_export",
    );
  });

  it("sums streamed outcome counters when the export is missing", () => {
    const accumulator = createAccumulator();
    for (const [metric, value] of [
      ["checkout_attempts_started", 10],
      ["checkout_responses_completed", 10],
      ["checkout_reservation_accepted", 3],
      ["checkout_sold_out_rejections", 4],
      ["checkout_transport_failures", 1],
      ["checkout_unexpected_responses", 1],
    ] as const) {
      accumulator.observe({ type: "Point", metric, data: { value } });
    }
    const report = accumulator.completionReport({
      status: "failed",
      completedAt,
      summaryExportWarning: "summary_export_missing",
    });

    expect(report.transportAttemptCounts).toMatchObject({
      completedRequests: 9,
      interruptedRequests: 1,
    });
    expect(report.loadRunDiagnosticsSummary.terminalMetricSources.completedRequests).toBe(
      "point_stream",
    );
  });

  it("uses the streamed completion counter, not http_reqs, when an outcome stayed at zero", () => {
    // Without an export, an outcome counter that stayed at zero has no stream point, so the sum
    // of outcomes is unknown.
    const accumulator = createAccumulator();
    for (const [metric, value] of [
      ["checkout_attempts_started", 10],
      ["checkout_responses_completed", 7],
      ["checkout_reservation_accepted", 7],
      ["http_reqs", 8],
    ] as const) {
      accumulator.observe({ type: "Point", metric, data: { value } });
    }
    const report = accumulator.completionReport({
      status: "failed",
      completedAt,
      summaryExportWarning: "summary_export_missing",
    });

    expect(report.transportAttemptCounts).toMatchObject({
      completedRequests: 7,
      interruptedRequests: 3,
      unstartedRequests: 0,
    });
    expect(report.loadRunDiagnosticsSummary.terminalMetricSources.completedRequests).toBe(
      "point_stream",
    );
  });

  it("lets completed responses prove attempts started when the started counter is unavailable", () => {
    const accumulator = createAccumulator({ buyerCount: 1_000 });
    accumulator.observe({ type: "Point", metric: "http_reqs", data: { value: 750 } });

    const report = accumulator.completionReport({ status: "failed", completedAt });

    expect(report.transportAttemptCounts).toMatchObject({
      startedRequests: 750,
      completedRequests: 750,
      interruptedRequests: 0,
      unstartedRequests: 250,
    });
    expect(report.loadRunDiagnosticsSummary.terminalMetricSources).toMatchObject({
      startedRequests: "point_stream",
      completedRequests: "point_stream",
    });
  });

  it("defines failed requests as unexpected responses plus transport failures", () => {
    const accumulator = createAccumulator({ buyerCount: 1_000 });
    const report = accumulator.completionReport({
      status: "failed",
      completedAt,
      summaryMetrics: {
        attemptsStarted: 1_000,
        responsesCompleted: 750,
        httpRequests: 750,
        acceptedResponses: 250,
        soldOutResponses: 425,
        transportFailures: 25,
        unexpectedResponses: 50,
        httpFailureRate: 0.2,
        timingPhases: {},
      },
    });

    expect(report.httpSummary.failedRequests).toBe(75);
    expect(report.httpSummary.transportFailures).toBe(25);
    expect(report.httpSummary.failureRate).toBe(0.2);
    expect(report.trafficOutcomeSummary).toEqual({
      acceptedResponses: 250,
      soldOutResponses: 425,
      unexpectedResponses: 50,
    });
  });
});

function createAccumulator(options: { buyerCount?: number } = {}): K6RunAccumulator {
  const effectiveRequest =
    options.buyerCount === undefined
      ? request
      : {
          ...request,
          configSnapshot: {
            ...request.configSnapshot,
            trafficConfig: {
              ...request.configSnapshot.trafficConfig,
              buyerCount: options.buyerCount,
            },
          },
        };
  const generated = generateK6Script(effectiveRequest);
  return new K6RunAccumulator({
    runId: request.runId,
    correlationId: request.correlationId,
    plannedRequests: generated.plannedRequests,
    startedAt,
    executionPlan: generated.executionPlan,
  });
}
