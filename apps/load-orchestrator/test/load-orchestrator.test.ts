import { type spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  controlServiceTokenHeaderName,
  type HealthStatus,
  healthResponseSchema,
  type LoadMetricIngestRequest,
  loadRunIdHeaderName,
  type ReadinessCheck,
  type TrafficCompletionReport,
  type TrafficExecutionStartRequest,
  trafficExecutionStartPath,
  trafficExecutionStartResponseSchema,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { HttpLoadApiClient, type LoadApiClient } from "../src/application/api-client.js";
import { K6RunAccumulator, parseK6JsonLine } from "../src/application/k6-output-parser.js";
import { type K6Runner, SpawnK6Runner } from "../src/application/k6-runner.js";
import { generateK6Script } from "../src/application/k6-script.js";
import { TrafficExecutionService } from "../src/application/traffic-execution-service.js";
import type { LoadOrchestratorConfig } from "../src/runtime/config.js";
import { createLoadOrchestratorReadiness } from "../src/runtime/readiness.js";
import { buildLoadOrchestratorServer } from "../src/server.js";

const timestamp = "2026-06-20T12:00:00.000Z";
const completionTimestamp = "2026-06-20T12:00:05.000Z";
const runnableK6Binary = resolveRunnableK6Binary();
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
    expect(script.contents).toContain("const expectedCheckoutStatuses = http.expectedStatuses(202, 409);");
    expect(script.contents).toContain("responseCallback: expectedCheckoutStatuses");
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

  it("emits a parseable k6 module using the expected public k6 APIs", async () => {
    const script = generateK6Script(startRequest);
    const workDir = await mkdtemp(path.join(tmpdir(), "checkout-surge-k6-script-check-"));
    const scriptPath = path.join(workDir, "scenario.mjs");

    try {
      await writeFile(scriptPath, script.contents, "utf8");
      const checkResult = spawnSync(process.execPath, ["--check", scriptPath], {
        encoding: "utf8",
      });

      if (checkResult.status !== 0) {
        throw new Error(
          `Generated k6 script failed Node syntax validation.\nstdout:\n${checkResult.stdout}\nstderr:\n${checkResult.stderr}`,
        );
      }

      expect(script.contents).toContain('import http from "k6/http";');
      expect(script.contents).toContain('import { check } from "k6";');
      expect(script.contents).toContain('import exec from "k6/execution";');
      expect(script.contents).toContain('import { Counter } from "k6/metrics";');
      expect(script.contents).toContain("http.expectedStatuses(202, 409)");
      expect(script.contents).toContain("exec.scenario.iterationInTest");
      expect(script.contents).toContain('new Counter("checkout_reservation_accepted")');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  const itWithK6 = runnableK6Binary ? it : it.skip;
  itWithK6("is accepted by k6 inspect when a k6 binary is available", async () => {
    if (!runnableK6Binary) {
      throw new Error("Expected runnable k6 binary for this compatibility check.");
    }

    const script = generateK6Script(startRequest);
    const workDir = await mkdtemp(path.join(tmpdir(), "checkout-surge-k6-inspect-"));
    const scriptPath = path.join(workDir, "scenario.js");

    try {
      await writeFile(scriptPath, script.contents, "utf8");
      const inspectResult = spawnSync(runnableK6Binary, ["inspect", scriptPath], {
        encoding: "utf8",
      });

      if (inspectResult.status !== 0) {
        throw new Error(
          `Generated k6 script failed k6 inspect.\nstdout:\n${inspectResult.stdout}\nstderr:\n${inspectResult.stderr}`,
        );
      }

      expect(inspectResult.status).toBe(0);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
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
      completedAt: new Date(completionTimestamp),
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
      completedAt: new Date(completionTimestamp),
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

  it("does not count clean sold-out responses as failed HTTP summary outcomes", () => {
    const accumulator = new K6RunAccumulator({
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: 2,
      startedAt: new Date(timestamp),
    });

    [
      { type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_req_failed", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "checkout_sold_out", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_req_failed", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "checkout_sold_out", data: { value: 1, time: timestamp } },
    ].forEach((point) => {
      accumulator.observe(point);
    });

    const report = accumulator.completionReport({
      status: "succeeded",
      exitCode: 0,
      completedAt: new Date(completionTimestamp),
    });

    expect(report.httpSummary).toMatchObject({
      plannedRequests: 2,
      emittedRequests: 2,
      failedRequests: 0,
      acceptedResponses: 0,
      soldOutResponses: 2,
      unexpectedResponses: 0,
      failureRate: 0,
    });
    expect(report.apiRequestLifecycleSummary).toMatchObject({
      completedRequests: 2,
      failedRequests: 0,
    });
    expect(report.trafficDeliverySummary.trafficDeliveryStatus).toBe("complete");
  });

  it("counts unexpected checkout responses as failed HTTP summary outcomes", () => {
    const accumulator = new K6RunAccumulator({
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: 1,
      startedAt: new Date(timestamp),
    });

    [
      { type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_req_failed", data: { value: 0, time: timestamp } },
      {
        type: "Point",
        metric: "checkout_unexpected_response",
        data: { value: 1, time: timestamp },
      },
    ].forEach((point) => {
      accumulator.observe(point);
    });

    const report = accumulator.completionReport({
      status: "succeeded",
      exitCode: 0,
      completedAt: new Date(completionTimestamp),
    });

    expect(report.httpSummary).toMatchObject({
      plannedRequests: 1,
      emittedRequests: 1,
      failedRequests: 1,
      soldOutResponses: 0,
      unexpectedResponses: 1,
      failureRate: 1,
    });
    expect(report.apiRequestLifecycleSummary).toMatchObject({
      completedRequests: 1,
      failedRequests: 1,
    });
    expect(report.trafficDeliverySummary).toMatchObject({
      trafficDeliveryStatus: "failed",
      notes: ["unexpected_checkout_responses_observed"],
    });
  });
});

describe("SpawnK6Runner completion reporting", () => {
  it("writes a temporary script, streams parsed metric batches, reports success, and cleans up", async () => {
    const k6Process = createK6ProcessFixture();
    const metricBatches: LoadMetricIngestRequest[] = [];
    const completionReports: TrafficCompletionReport[] = [];
    const apiClient: LoadApiClient = {
      sendMetrics: vi.fn(async (batch) => {
        metricBatches.push(batch);
      }),
      sendCompletion: vi.fn(async (report) => {
        completionReports.push(report);
      }),
    };
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      apiClient,
      logger: createSilentLogger("load-orchestrator"),
      now: createClock([timestamp, completionTimestamp]),
      spawnProcess: k6Process.spawnProcess,
    });

    const start = await runner.start(startRequest);
    const spawnCall = getSingleSpawnCall(k6Process);
    const workDir = path.dirname(spawnCall.scriptPath);
    const script = await readFile(spawnCall.scriptPath, "utf8");

    writeK6JsonLines(k6Process.stdout, [
      { type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_req_duration", data: { value: 42, time: timestamp } },
      { type: "Point", metric: "http_req_failed", data: { value: 0, time: timestamp } },
      {
        type: "Point",
        metric: "checkout_reservation_accepted",
        data: { value: 1, time: timestamp },
      },
    ]);
    await waitForReadline();
    k6Process.child.emit("close", 0);

    const report = await waitForCompletionReport(completionReports, 1);
    await waitForCondition(() => pathMissing(workDir), "k6 temp directory cleanup");

    expect(start).toEqual({ startedAt: new Date(timestamp), plannedRequests: 400 });
    expect(spawnCall.binary).toBe("k6");
    expect(spawnCall.args).toEqual(["run", "--quiet", "--out", "json=-", spawnCall.scriptPath]);
    expect(spawnCall.options).toEqual({ stdio: ["ignore", "pipe", "pipe"] });
    expect(script).toContain('export const options = {"scenarios":{"checkout":');
    expect(script).toContain(startRequest.runId);
    expect(apiClient.sendMetrics).toHaveBeenCalledTimes(1);
    expect(metricBatches).toEqual([
      {
        runId: startRequest.runId,
        correlationId: startRequest.correlationId,
        samples: [
          {
            metricName: "traffic.scheduled_request_rate",
            value: 1,
            unit: "requests",
            timestamp,
          },
          { metricName: "traffic.latency", value: 42, unit: "ms", timestamp },
          { metricName: "traffic.failure_rate", value: 0, unit: "ratio", timestamp },
        ],
        observedAt: expect.any(String),
      },
    ]);
    expect(apiClient.sendCompletion).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      runId: startRequest.runId,
      status: "succeeded",
      exitCode: 0,
      completedAt: completionTimestamp,
      correlationId: startRequest.correlationId,
      httpSummary: {
        plannedRequests: 400,
        emittedRequests: 1,
        failedRequests: 0,
        acceptedResponses: 1,
        unexpectedResponses: 0,
        p95LatencyMs: 42,
        failureRate: 0,
      },
      trafficDeliverySummary: {
        plannedRequests: 400,
        emittedRequests: 1,
        trafficDeliveryStatus: "failed",
      },
    });
  });

  it("reports non-zero k6 exits as failed completions and cleans up", async () => {
    const k6Process = createK6ProcessFixture();
    const metricBatches: LoadMetricIngestRequest[] = [];
    const completionReports: TrafficCompletionReport[] = [];
    const apiClient: LoadApiClient = {
      sendMetrics: vi.fn(async (batch) => {
        metricBatches.push(batch);
      }),
      sendCompletion: vi.fn(async (report) => {
        completionReports.push(report);
      }),
    };
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      apiClient,
      logger: createSilentLogger("load-orchestrator"),
      now: createClock([timestamp, completionTimestamp]),
      spawnProcess: k6Process.spawnProcess,
    });

    await runner.start(startRequest);
    const spawnCall = getSingleSpawnCall(k6Process);
    const workDir = path.dirname(spawnCall.scriptPath);

    writeK6JsonLines(k6Process.stdout, [
      { type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_req_failed", data: { value: 1, time: timestamp } },
      {
        type: "Point",
        metric: "checkout_unexpected_response",
        data: { value: 1, time: timestamp },
      },
      { type: "Point", metric: "dropped_iterations", data: { value: 1, time: timestamp } },
    ]);
    await waitForReadline();
    k6Process.child.emit("close", 23);

    const report = await waitForCompletionReport(completionReports, 1);
    await waitForCondition(() => pathMissing(workDir), "k6 temp directory cleanup");

    expect(apiClient.sendMetrics).toHaveBeenCalledTimes(1);
    expect(metricBatches[0]?.samples.map((sample) => sample.metricName)).toEqual([
      "traffic.scheduled_request_rate",
      "traffic.failure_rate",
    ]);
    expect(apiClient.sendCompletion).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      runId: startRequest.runId,
      status: "failed",
      exitCode: 23,
      errorMessage: "k6 exited with code 23.",
      completedAt: completionTimestamp,
      httpSummary: {
        plannedRequests: 400,
        emittedRequests: 1,
        failedRequests: 1,
        unexpectedResponses: 1,
        failureRate: 1,
      },
      trafficDeliverySummary: {
        plannedRequests: 400,
        emittedRequests: 1,
        droppedIterations: 1,
        trafficDeliveryStatus: "failed",
        notes: ["unexpected_checkout_responses_observed", "k6_dropped_iterations_observed"],
      },
    });
  });

  it("reports spawn errors once even when close follows error and cleans up", async () => {
    const k6Process = createK6ProcessFixture();
    const completionReports: TrafficCompletionReport[] = [];
    const apiClient: LoadApiClient = {
      sendMetrics: vi.fn(async () => undefined),
      sendCompletion: vi.fn(async (report) => {
        completionReports.push(report);
      }),
    };
    const runner = new SpawnK6Runner({
      k6Binary: "/missing/k6",
      apiClient,
      logger: createSilentLogger("load-orchestrator"),
      now: createClock([timestamp, completionTimestamp]),
      spawnProcess: k6Process.spawnProcess,
    });

    await runner.start(startRequest);
    const spawnCall = getSingleSpawnCall(k6Process);
    const workDir = path.dirname(spawnCall.scriptPath);

    k6Process.child.emit("error", new Error("spawn /missing/k6 ENOENT"));
    k6Process.child.emit("close", -2);

    const report = await waitForCompletionReport(completionReports, 1);
    await waitForCondition(() => pathMissing(workDir), "k6 temp directory cleanup");
    await waitForReadline();

    expect(apiClient.sendMetrics).not.toHaveBeenCalled();
    expect(apiClient.sendCompletion).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      runId: startRequest.runId,
      status: "failed",
      errorMessage: "spawn /missing/k6 ENOENT",
      completedAt: completionTimestamp,
      httpSummary: {
        plannedRequests: 400,
        emittedRequests: 0,
        failedRequests: 0,
      },
      trafficDeliverySummary: {
        plannedRequests: 400,
        emittedRequests: 0,
        trafficDeliveryStatus: "failed",
      },
    });
    expect(report).not.toHaveProperty("exitCode");
  });

  it("retries completion delivery when the API fails once", async () => {
    const k6Process = createK6ProcessFixture();
    const reports: TrafficCompletionReport[] = [];
    const retryDelays: number[] = [];
    let completionAccepted: () => void = () => undefined;
    const completionAcceptedPromise = new Promise<void>((resolve) => {
      completionAccepted = resolve;
    });
    const apiClient: LoadApiClient = {
      sendMetrics: vi.fn(async () => undefined),
      sendCompletion: vi.fn(async (report) => {
        reports.push(report);
        if (reports.length === 1) {
          throw new Error("API temporarily unavailable");
        }

        completionAccepted();
      }),
    };
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      apiClient,
      logger: createSilentLogger("load-orchestrator"),
      now: () => new Date(timestamp),
      spawnProcess: k6Process.spawnProcess,
      completionRetry: {
        maxAttempts: 2,
        initialBackoffMs: 25,
        sleep: async (delayMs) => {
          retryDelays.push(delayMs);
        },
      },
    });

    await runner.start(startRequest);
    k6Process.stdout.write(
      `${JSON.stringify({
        type: "Point",
        metric: "http_reqs",
        data: { value: 1, time: timestamp },
      })}\n`,
    );
    await waitForReadline();
    k6Process.child.emit("close", 0);
    await completionAcceptedPromise;

    expect(apiClient.sendCompletion).toHaveBeenCalledTimes(2);
    expect(retryDelays).toEqual([25]);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toBe(reports[0]);
    expect(reports[1]).toMatchObject({
      runId: startRequest.runId,
      status: "succeeded",
      exitCode: 0,
      httpSummary: {
        plannedRequests: 400,
        emittedRequests: 1,
      },
      trafficDeliverySummary: {
        trafficDeliveryStatus: "failed",
      },
    });
  });
});

describe("load-orchestrator API client", () => {
  it("sends metric and completion correlation IDs in internal API headers", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpLoadApiClient({
      apiBaseUrl: "http://api.test",
      controlServiceToken: "test-token",
    });
    const completionReport = new K6RunAccumulator({
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: 1,
      startedAt: new Date(timestamp),
    }).completionReport({
      status: "succeeded",
      exitCode: 0,
      completedAt: new Date("2026-06-20T12:00:05.000Z"),
    });

    try {
      await client.sendMetrics({
        runId: startRequest.runId,
        correlationId: startRequest.correlationId,
        samples: [
          {
            metricName: "traffic.latency",
            value: 42,
            unit: "ms",
            timestamp,
          },
        ],
        observedAt: timestamp,
      });
      await client.sendCompletion(completionReport);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        headers: expect.objectContaining({
          [correlationIdHeaderName]: startRequest.correlationId,
        }),
      });
      expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
        headers: expect.objectContaining({
          [correlationIdHeaderName]: startRequest.correlationId,
        }),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("load-orchestrator readiness", () => {
  it("marks the API readiness dependency ok when the configured API target is reachable", async () => {
    const fetchApi = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(apiHealthPayload("ok")));
    const readiness = createLoadOrchestratorReadiness(
      createConfig({ apiBaseUrl: "http://api.test/" }),
      {
        fetch: fetchApi,
      },
    );

    const checks = await readiness.checks();

    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(fetchApi.mock.calls[0]?.[0]).toBe("http://api.test/health/ready");
    expect(fetchApi.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(readinessCheck(checks, "api_readiness_reachable")).toMatchObject({ status: "ok" });
  });

  it("marks the API readiness dependency unavailable when the API target is unreachable", async () => {
    const fetchApi = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("getaddrinfo ENOTFOUND api"));
    const readiness = createLoadOrchestratorReadiness(
      createConfig({ apiBaseUrl: "http://api.test" }),
      {
        fetch: fetchApi,
      },
    );

    const checks = await readiness.checks();

    expect(readinessCheck(checks, "api_readiness_reachable")).toMatchObject({
      status: "unavailable",
      message: "getaddrinfo ENOTFOUND api",
    });
  });

  it("marks the API readiness dependency unavailable when the API readiness request times out", async () => {
    vi.useFakeTimers();
    const fetchApi = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const readiness = createLoadOrchestratorReadiness(
      createConfig({ apiBaseUrl: "http://api.test" }),
      {
        apiReadinessTimeoutMs: 25,
        fetch: fetchApi,
      },
    );

    try {
      const checksPromise = readiness.checks();
      await vi.advanceTimersByTimeAsync(25);
      const checks = await checksPromise;

      expect(readinessCheck(checks, "api_readiness_reachable")).toMatchObject({
        status: "unavailable",
        message: "API readiness check timed out after 25ms.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the API readiness dependency unavailable when the API is not ready", async () => {
    const fetchApi = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(apiHealthPayload("unavailable"), 503));
    const readiness = createLoadOrchestratorReadiness(
      createConfig({ apiBaseUrl: "http://api.test" }),
      {
        fetch: fetchApi,
      },
    );

    const checks = await readiness.checks();

    expect(readinessCheck(checks, "api_readiness_reachable")).toMatchObject({
      status: "unavailable",
      message: "API readiness returned HTTP 503.",
    });
  });
});

describe("load-orchestrator HTTP boundary", () => {
  it("exposes readiness and protects traffic starts with the shared control token", async () => {
    const runner: K6Runner = {
      start: vi.fn(async () => ({ startedAt: new Date(timestamp), plannedRequests: 400 })),
    };
    const server = buildLoadOrchestratorServer({
      config: createConfig(),
      logger: createSilentLogger("load-orchestrator"),
      readiness: {
        checks: async () => [
          { name: "api_readiness_reachable", status: "ok" },
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
      expect(accepted.headers[correlationIdHeaderName]).toBe(startRequest.correlationId);
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

function createConfig(overrides: Partial<LoadOrchestratorConfig> = {}): LoadOrchestratorConfig {
  return {
    host: "127.0.0.1",
    port: 4200,
    apiBaseUrl: "http://localhost:4000",
    buyEndpointPath: "/buy",
    k6Binary: "k6",
    controlServiceToken: "test-token",
    ...overrides,
  };
}

function readinessCheck(checks: ReadinessCheck[], name: string): ReadinessCheck {
  const check = checks.find((entry) => entry.name === name);
  if (!check) {
    throw new Error(`Expected readiness check ${name}.`);
  }

  return check;
}

function apiHealthPayload(status: HealthStatus) {
  return {
    service: "api",
    status,
    timestamp,
    uptimeSeconds: 1,
    checks: [],
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createK6ProcessFixture(): {
  child: ReturnType<typeof spawn>;
  stdout: PassThrough;
  stderr: PassThrough;
  spawnProcess: typeof spawn;
} {
  const child = new EventEmitter() as ReturnType<typeof spawn>;
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  Object.assign(child, { stdout, stderr });

  return {
    child,
    stdout,
    stderr,
    spawnProcess: vi.fn(() => child) as unknown as typeof spawn,
  };
}

function resolveRunnableK6Binary(): string | null {
  const candidate = process.env.K6_BINARY?.trim() || "k6";
  if (candidate.includes("/") || candidate.includes("\\")) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      return null;
    }
  }

  const result = spawnSync(candidate, ["version"], { stdio: "ignore" });
  return result.status === 0 ? candidate : null;
}

function createClock(isoTimestamps: string[]): () => Date {
  let index = 0;
  return () => {
    const value = isoTimestamps[Math.min(index, isoTimestamps.length - 1)] ?? timestamp;
    index += 1;
    return new Date(value);
  };
}

function writeK6JsonLines(stdout: PassThrough, points: unknown[]): void {
  stdout.write(`${points.map((point) => JSON.stringify(point)).join("\n")}\n`);
}

function getSingleSpawnCall(k6Process: ReturnType<typeof createK6ProcessFixture>): {
  binary: string;
  args: string[];
  options: unknown;
  scriptPath: string;
} {
  const call = vi.mocked(k6Process.spawnProcess).mock.calls[0];
  if (!call) {
    throw new Error("Expected k6 process to be spawned.");
  }

  const binary = call[0];
  const args = call[1];
  if (typeof binary !== "string" || !Array.isArray(args)) {
    throw new Error("Expected k6 spawn call to use string binary and argument list.");
  }

  const scriptPath = args.at(-1);
  if (typeof scriptPath !== "string") {
    throw new Error("Expected k6 spawn call to include the generated script path.");
  }

  return { binary, args: [...args], options: call[2], scriptPath };
}

async function waitForCompletionReport(
  reports: TrafficCompletionReport[],
  count: number,
): Promise<TrafficCompletionReport> {
  await waitForCondition(
    () => reports.length >= count,
    `traffic completion report ${count} to be sent`,
  );

  const report = reports[count - 1];
  if (!report) {
    throw new Error(`Expected traffic completion report ${count}.`);
  }

  return report;
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

async function pathMissing(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return false;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return true;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function waitForReadline(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
