import {
  controlServiceTokenHeaderName,
  healthResponseSchema,
  loadRunIdHeaderName,
  type TrafficExecutionStartRequest,
  trafficExecutionStartPath,
  trafficExecutionStartResponseSchema,
} from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { K6RunAccumulator, parseK6JsonLine } from "../src/application/k6-output-parser.js";
import type { K6Runner } from "../src/application/k6-runner.js";
import { generateK6Script } from "../src/application/k6-script.js";
import { TrafficExecutionService } from "../src/application/traffic-execution-service.js";
import { buildLoadOrchestratorServer } from "../src/server.js";

const timestamp = "2026-06-20T12:00:00.000Z";
const startRequest: TrafficExecutionStartRequest = {
  runId: "55555555-5555-4555-8555-555555555555",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  apiBaseUrl: "http://localhost:4000",
  buyEndpointPath: "/buy",
  correlationId: "corr-load-test",
  configSnapshot: {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 200,
      duplicateEachBuyerAttempt: true,
      startDelaySeconds: 1,
      maxDurationSeconds: 5,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 200,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 50,
      maxTps: 200,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 2000,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 5,
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
    },
  },
};

describe("load-orchestrator k6 mapping", () => {
  it("generates a contract-driven buyer-spike script without shell interpolation", () => {
    const script = generateK6Script(startRequest);

    expect(script.plannedRequests).toBe(400);
    expect(script.contents).toContain('"executor":"per-vu-iterations"');
    expect(script.contents).toContain('"vus":200');
    expect(script.contents).toContain('"iterations":2');
    expect(script.contents).toContain("http.post");
    expect(script.contents).toContain("run:");
    expect(script.contents).toContain(":buyer:");
    expect(script.contents).toContain(`"${loadRunIdHeaderName}": config.runId`);
  });

  it("generates a steady-arrival scenario with k6 VU controls", () => {
    const script = generateK6Script({
      ...startRequest,
      configSnapshot: {
        ...startRequest.configSnapshot,
        trafficConfig: {
          mode: "steady-arrival-rate",
          ratePerSecond: 20,
          startDelaySeconds: 2,
          durationSeconds: 10,
          quantityPerAttempt: 1,
          k6Vus: { preAllocatedVus: 10, maxVus: 50 },
        },
      },
    });

    expect(script.plannedRequests).toBe(200);
    expect(script.contents).toContain('"executor":"constant-arrival-rate"');
    expect(script.contents).toContain('"rate":20');
    expect(script.contents).toContain('"preAllocatedVUs":10');
    expect(script.contents).toContain('"maxVUs":50');
  });

  it("parses k6 JSON points into stable dashboard metrics and traffic summaries", () => {
    const accumulator = new K6RunAccumulator({
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: 2,
      startedAt: new Date(timestamp),
    });
    const lines = [
      JSON.stringify({ type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } }),
      JSON.stringify({
        type: "Point",
        metric: "http_req_duration",
        data: { value: 42, time: timestamp },
      }),
      JSON.stringify({
        type: "Point",
        metric: "http_req_failed",
        data: { value: 0, time: timestamp },
      }),
      JSON.stringify({
        type: "Point",
        metric: "checkout_reservation_accepted",
        data: { value: 1, time: timestamp },
      }),
      JSON.stringify({
        type: "Point",
        metric: "checkout_sold_out",
        data: { value: 1, time: timestamp },
      }),
    ];
    const samples = lines
      .map((line) => parseK6JsonLine(line))
      .map((point) => (point ? accumulator.observe(point) : null))
      .filter((sample) => sample !== null);

    const report = accumulator.completionReport({
      status: "succeeded",
      exitCode: 0,
      completedAt: new Date("2026-06-20T12:00:05.000Z"),
    });

    expect(samples.map((sample) => sample.metricName)).toEqual([
      "traffic.scheduled_request_rate",
      "traffic.latency",
      "traffic.failure_rate",
    ]);
    expect(report.httpSummary).toMatchObject({
      plannedRequests: 2,
      emittedRequests: 1,
      acceptedResponses: 1,
      soldOutResponses: 1,
      unexpectedResponses: 0,
      p95LatencyMs: 42,
    });
    expect(report.trafficDeliverySummary.trafficDeliveryStatus).toBe("failed");
  });

  it("reports successful k6 execution as traffic success without terminal demo-run state", () => {
    const accumulator = new K6RunAccumulator({
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: 1,
      startedAt: new Date(timestamp),
    });

    const point = parseK6JsonLine(
      JSON.stringify({ type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } }),
    );
    if (!point) {
      throw new Error("Expected k6 point fixture to parse.");
    }

    accumulator.observe(point);
    const report = accumulator.completionReport({
      status: "succeeded",
      exitCode: 0,
      completedAt: new Date("2026-06-20T12:00:05.000Z"),
    });

    expect(report).toMatchObject({
      runId: startRequest.runId,
      status: "succeeded",
      exitCode: 0,
      trafficDeliverySummary: { trafficDeliveryStatus: "complete" },
    });
    expect(report).not.toHaveProperty("demoRunStatus");
    expect(report).not.toHaveProperty("finalizedAt");
  });
});

describe("load-orchestrator HTTP boundary", () => {
  it("exposes readiness and protects traffic starts with the shared control token", async () => {
    const runner: K6Runner = {
      start: vi.fn(async () => ({ startedAt: new Date(timestamp), plannedRequests: 400 })),
    };
    const server = buildLoadOrchestratorServer({
      config: {
        host: "127.0.0.1",
        port: 4200,
        apiBaseUrl: "http://localhost:4000",
        buyEndpointPath: "/buy",
        k6Binary: "k6",
        controlServiceToken: "test-token",
      },
      logger: createSilentLogger("load-orchestrator"),
      readiness: {
        checks: async () => [
          { name: "api_base_url_configured", status: "ok" },
          { name: "preset_traffic_start_enabled", status: "ok" },
          { name: "k6_binary_executable", status: "degraded" },
        ],
      },
      trafficExecutionService: new TrafficExecutionService(runner),
      startedAt: new Date(timestamp),
    });

    try {
      const ready = await server.inject({ method: "GET", url: "/health/ready" });
      const unauthorized = await server.inject({
        method: "POST",
        url: trafficExecutionStartPath,
        payload: startRequest,
      });
      const accepted = await server.inject({
        method: "POST",
        url: trafficExecutionStartPath,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
        payload: startRequest,
      });

      expect(healthResponseSchema.parse(ready.json()).status).toBe("degraded");
      expect(unauthorized.statusCode).toBe(401);
      expect(accepted.statusCode).toBe(202);
      expect(trafficExecutionStartResponseSchema.parse(accepted.json())).toMatchObject({
        runId: startRequest.runId,
        status: "active",
        correlationId: startRequest.correlationId,
      });
      expect(runner.start).toHaveBeenCalledWith(startRequest);
    } finally {
      await server.close();
    }
  });
});
