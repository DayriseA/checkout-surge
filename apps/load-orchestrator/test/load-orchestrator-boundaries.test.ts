import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  controlServiceTokenHeaderName,
  type HealthStatus,
  healthResponseSchema,
  type ReadinessCheck,
  trafficExecutionAbortPath,
  trafficExecutionAbortResponseSchema,
  trafficExecutionStartPath,
  trafficExecutionStartResponseSchema,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { HttpLoadApiClient, MetricBatcher } from "../src/application/api-client.js";
import { K6RunAccumulator } from "../src/application/k6-output-parser.js";
import {
  ExecutionSlotConflictError,
  type K6Runner,
  TrafficTerminationUnconfirmedError,
} from "../src/application/k6-runner.js";
import { generateK6Script } from "../src/application/k6-script.js";
import { TrafficExecutionService } from "../src/application/traffic-execution-service.js";
import { checkK6Executable, createLoadOrchestratorReadiness } from "../src/runtime/readiness.js";
import { buildLoadOrchestratorServer } from "../src/server.js";
import {
  createLoadOrchestratorConfig as createConfig,
  trafficExecutionStartRequestFixture,
  waitForCondition,
} from "./load-orchestrator-test-helper.js";

const timestamp = "2026-06-20T12:00:00.000Z";
const completionTimestamp = "2026-06-20T12:00:05.000Z";
const startRequest = trafficExecutionStartRequestFixture();

describe("load-orchestrator API client", () => {
  it("waits for an active metric flush to quiesce when discarding cancellation data", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sendMetrics = vi.fn(async () => gate);
    const batcher = new MetricBatcher({
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      client: { sendMetrics },
      maxBatchSize: 1,
    });
    const add = batcher.add({
      metricName: "traffic.latency",
      value: 1,
      unit: "ms",
      timestamp,
    });
    await waitForCondition(() => sendMetrics.mock.calls.length === 1, "active metric flush");
    let discarded = false;
    const discard = batcher.discard().then(() => {
      discarded = true;
    });
    await Promise.resolve();
    expect(discarded).toBe(false);
    release();
    await Promise.all([add, discard]);
    expect(discarded).toBe(true);
  });
  it("rejects a mismatched successful completion acknowledgement", async () => {
    const client = new HttpLoadApiClient({
      apiBaseUrl: "http://api.test",
      controlServiceToken: "test-token",
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              runId: "66666666-6666-4666-8666-666666666666",
              acknowledged: true,
              correlationId: startRequest.correlationId,
            }),
            { status: 202 },
          ),
      ),
    });
    const executionPlan = generateK6Script(startRequest).executionPlan;
    const report = new K6RunAccumulator({
      executionPlan,
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: executionPlan.plannedEmittedAttempts,
      startedAt: new Date(timestamp),
    }).completionReport({ status: "succeeded", completedAt: new Date(completionTimestamp) });
    await expect(client.sendCompletion(report)).rejects.toThrow("did not match");
  });

  it("bounds a hung ingestion request and preserves the abort as the cause", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const client = new HttpLoadApiClient({
      apiBaseUrl: "http://api.test",
      controlServiceToken: "test-token",
      requestTimeoutMs: 5,
      fetch: vi.fn((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    });
    try {
      const request = client.sendMetrics({
        runId: startRequest.runId,
        correlationId: startRequest.correlationId,
        samples: [{ metricName: "traffic.latency", value: 1, unit: "ms", timestamp }],
        observedAt: timestamp,
      });
      const rejection = expect(request).rejects.toMatchObject({
        message: "API load ingestion request failed.",
        cause: expect.objectContaining({ message: expect.stringContaining("timed out") }),
      });
      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends metric and completion correlation IDs in internal API headers", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { runId?: string; correlationId?: string };
      return new Response(
        JSON.stringify(
          body.runId
            ? { runId: body.runId, acknowledged: true, correlationId: body.correlationId }
            : {},
        ),
        { status: 202 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpLoadApiClient({
      apiBaseUrl: "http://api.test",
      controlServiceToken: "test-token",
    });
    const executionPlan = generateK6Script(startRequest).executionPlan;
    const completionReport = new K6RunAccumulator({
      executionPlan,
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: executionPlan.plannedEmittedAttempts,
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
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(fetchMock.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(fetchMock.mock.calls[0]?.[1]?.signal).not.toBe(fetchMock.mock.calls[1]?.[1]?.signal);
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

  it("clears request deadline timers after both success and fetch failure", async () => {
    vi.useFakeTimers();
    try {
      const success = new HttpLoadApiClient({
        apiBaseUrl: "http://api.test",
        controlServiceToken: "test-token",
        fetch: vi.fn(async () => new Response("{}", { status: 202 })),
      });
      await success.sendMetrics({
        runId: startRequest.runId,
        correlationId: startRequest.correlationId,
        samples: [{ metricName: "traffic.latency", value: 1, unit: "ms", timestamp }],
        observedAt: timestamp,
      });
      expect(vi.getTimerCount()).toBe(0);

      const failure = new HttpLoadApiClient({
        apiBaseUrl: "http://api.test",
        controlServiceToken: "test-token",
        fetch: vi.fn(async () => {
          throw new Error("network unavailable");
        }),
      });
      await expect(
        failure.sendMetrics({
          runId: startRequest.runId,
          correlationId: startRequest.correlationId,
          samples: [{ metricName: "traffic.latency", value: 1, unit: "ms", timestamp }],
          observedAt: timestamp,
        }),
      ).rejects.toThrow("API load ingestion request failed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("load-orchestrator readiness", () => {
  it.each([
    { event: ["close", 0, null], ok: true },
    { event: ["close", 2, null], ok: false },
    { event: ["close", null, "SIGTERM"], ok: false },
    { event: ["error", new Error("ENOENT")], ok: false },
  ])("settles direct executable probes for $event", async ({ event, ok }) => {
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    Object.assign(child, { kill: vi.fn() });
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const resultPromise = checkK6Executable("k6", ["version"], 100, spawnProcess);
    child.emit(event[0] as string, ...event.slice(1));
    expect(await resultPromise).toMatchObject({ ok });
    expect(spawnProcess).toHaveBeenCalledWith("k6", ["version"], { stdio: "ignore", shell: false });
  });

  it("kills a timed-out executable probe once and ignores a late close", async () => {
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    const kill = vi.fn();
    Object.assign(child, { kill });
    const resultPromise = checkK6Executable(
      "k6",
      ["version"],
      1,
      vi.fn(() => child) as unknown as typeof spawn,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    child.emit("close", null, "SIGKILL");
    expect(await resultPromise).toMatchObject({
      ok: false,
      message: expect.stringContaining("timed out"),
    });
    child.emit("close", 0);
    expect(kill).toHaveBeenCalledTimes(1);
  });
  it("degrades synchronous executable spawn failures", async () => {
    await expect(
      checkK6Executable("k6", ["version"], 10, (() => {
        throw new Error("spawn failed");
      }) as typeof spawn),
    ).resolves.toMatchObject({ ok: false, message: "Configured k6 binary could not be executed." });
  });
  it("executes both PATH and explicit k6 values with the version argv", async () => {
    for (const binary of ["k6", "C:\\tools\\k6.exe"]) {
      const checkExecutable = vi.fn(async () => ({ ok: true }));
      const readiness = createLoadOrchestratorReadiness(createConfig({ k6Binary: binary }), {
        fetch: vi.fn(async () => jsonResponse(apiHealthPayload("ok"))),
        checkExecutable,
      });
      expect(readinessCheck(await readiness.checks(), "k6_binary_executable").status).toBe("ok");
      expect(checkExecutable).toHaveBeenCalledWith(binary, ["version"], 3000);
    }
  });

  it("degrades a rejected injected executable checker instead of rejecting readiness", async () => {
    const readiness = createLoadOrchestratorReadiness(createConfig(), {
      fetch: vi.fn(async () => jsonResponse(apiHealthPayload("ok"))),
      checkExecutable: vi.fn(async () => {
        throw new Error("checker failed");
      }),
    });
    await expect(readiness.checks()).resolves.toContainEqual({
      name: "k6_binary_executable",
      status: "unavailable",
      message: "Configured k6 binary could not be checked.",
    });
  });

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
      statusSnapshot: vi.fn(async () => ({ state: "unknown" as const })),
      currentRunId: vi.fn(() => startRequest.runId),
      abort: vi.fn(async () => "aborted" as const),
      initialize: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const server = buildLoadOrchestratorServer({
      config: createConfig(),
      logger: createSilentLogger("load-orchestrator"),
      readiness: {
        checks: async () => [
          { name: "api_readiness_reachable", status: "ok" },
          { name: "preset_traffic_start_enabled", status: "ok" },
          { name: "k6_binary_executable", status: "unavailable" },
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
      vi.mocked(runner.statusSnapshot).mockResolvedValueOnce({
        state: "executing",
        acceptedAt: timestamp,
      });
      const statusUnauthorized = await server.inject({
        method: "GET",
        url: `/traffic/status/${startRequest.runId}`,
      });
      const status = await server.inject({
        method: "GET",
        url: `/traffic/status/${startRequest.runId}`,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
      });
      const abortUnauthorized = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
      });
      const abortWrongToken = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
        headers: { [controlServiceTokenHeaderName]: "wrong-token" },
        payload: {},
      });
      const abortMalformed = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
        payload: { reason: "x".repeat(501) },
      });
      const abortMismatch = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
        payload: { runId: "66666666-6666-4666-8666-666666666666" },
      });
      const aborted = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
        headers: {
          [controlServiceTokenHeaderName]: "test-token",
          [correlationIdHeaderName]: "abort-correlation",
        },
        payload: { runId: startRequest.runId, reason: "operator reset" },
      });
      vi.mocked(runner.abort).mockRejectedValueOnce(new TrafficTerminationUnconfirmedError());
      const unconfirmed = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
        payload: { runId: startRequest.runId },
      });
      vi.mocked(runner.abort).mockRejectedValueOnce(new Error("cancellation journal unavailable"));
      const cancellationJournalFailure = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
        payload: { runId: startRequest.runId },
      });
      vi.mocked(runner.currentRunId).mockReturnValueOnce(null);
      const noCurrent = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
      });
      vi.mocked(runner.currentRunId).mockReturnValueOnce(null);
      const noCurrentEmpty = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
        payload: {},
      });
      vi.mocked(runner.start).mockRejectedValueOnce(
        new ExecutionSlotConflictError(startRequest.runId),
      );
      const startDuringCancellation = await server.inject({
        method: "POST",
        url: trafficExecutionStartPath,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
        payload: startRequest,
      });

      expect(ready.statusCode).toBe(503);
      expect(healthResponseSchema.parse(ready.json()).status).toBe("unavailable");
      expect(unauthorized.statusCode).toBe(401);
      expect(accepted.statusCode).toBe(202);
      expect(statusUnauthorized.statusCode).toBe(401);
      expect(status.statusCode).toBe(200);
      expect(abortUnauthorized.statusCode).toBe(401);
      expect(abortWrongToken.statusCode).toBe(401);
      expect(abortMalformed.statusCode).toBe(400);
      expect(abortMismatch.statusCode).toBe(409);
      expect(unconfirmed.statusCode).toBe(503);
      expect(cancellationJournalFailure.statusCode).toBe(500);
      expect(cancellationJournalFailure.json()).toMatchObject({ code: "internal_error" });
      expect(cancellationJournalFailure.body).not.toContain("cancellation journal unavailable");
      expect(status.json()).toMatchObject({
        runId: startRequest.runId,
        state: "executing",
        acceptedAt: timestamp,
      });
      expect(accepted.headers[correlationIdHeaderName]).toBe(startRequest.correlationId);
      expect(trafficExecutionStartResponseSchema.parse(accepted.json())).toMatchObject({
        runId: startRequest.runId,
        status: "active",
        correlationId: startRequest.correlationId,
      });
      expect(runner.start).toHaveBeenCalledWith(startRequest);
      expect(trafficExecutionAbortResponseSchema.parse(aborted.json())).toMatchObject({
        outcome: "current_run_aborted",
        abortedRunId: startRequest.runId,
        correlationId: "abort-correlation",
      });
      expect(trafficExecutionAbortResponseSchema.parse(noCurrent.json()).outcome).toBe(
        "no_current_run",
      );
      expect(trafficExecutionAbortResponseSchema.parse(noCurrentEmpty.json()).outcome).toBe(
        "no_current_run",
      );
      expect(startDuringCancellation.statusCode).toBe(409);
      expect(runner.abort).toHaveBeenCalledWith(startRequest.runId, {
        reason: "operator reset",
        correlationId: "abort-correlation",
      });
    } finally {
      await server.close();
    }
  });
});

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
