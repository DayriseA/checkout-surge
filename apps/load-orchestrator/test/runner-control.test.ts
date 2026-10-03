import {
  automaticRunResetDeadlineSeconds,
  controlServiceTokenHeaderName,
  materializedTrafficCompletionReportSchema,
  runnerControlPath,
  runnerShutdownPath,
  trafficExecutionStartPath,
} from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableExecution } from "../src/application/execution-store.js";
import { K6RunAccumulator } from "../src/application/k6-output-parser.js";
import type { K6Runner } from "../src/application/k6-runner.js";
import { generateK6Script } from "../src/application/k6-script.js";
import {
  RunnerLifecycleService,
  runnerIdleTimeoutMs,
  runnerMaximumLifetimeMs,
} from "../src/application/runner-lifecycle-service.js";
import { TrafficExecutionService } from "../src/application/traffic-execution-service.js";
import { loadLoadOrchestratorConfig } from "../src/runtime/config.js";
import { buildLoadOrchestratorServer } from "../src/server.js";
import {
  createLoadOrchestratorConfig,
  trafficExecutionStartRequestFixture,
} from "./load-orchestrator-test-helper.js";

const bootId = "11111111-1111-4111-8111-111111111111";
const otherBootId = "22222222-2222-4222-8222-222222222222";
const request = trafficExecutionStartRequestFixture();
const identity = { bootId, version: "test-commit" };
const headers = { [controlServiceTokenHeaderName]: "test-token" };

function setup(enabled = true) {
  let execution: DurableExecution | null = null;
  const runner: K6Runner = {
    start: vi.fn(async () => ({ startedAt: new Date(), plannedRequests: 400 })),
    initialize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    abort: vi.fn(async () => "aborted" as const),
    currentRunId: vi.fn(() => null),
    statusSnapshot: vi.fn(async () => ({ state: "unknown" as const })),
  };
  const traffic = new TrafficExecutionService(runner, identity);
  const store = { read: vi.fn(async () => execution) };
  const exit = vi.fn();
  const errors = vi.fn();
  const lifecycle = new RunnerLifecycleService({
    trafficExecutionService: traffic,
    executionStore: store,
    requestExit: exit,
    onError: errors,
  });
  const app = buildLoadOrchestratorServer({
    config: createLoadOrchestratorConfig({ runnerLifecycleEnabled: enabled }),
    logger: createSilentLogger("load-orchestrator"),
    readiness: { checks: async () => [] },
    trafficExecutionService: traffic,
    runnerLifecycleService: lifecycle,
  });
  return {
    app,
    runner,
    traffic,
    lifecycle,
    exit,
    errors,
    store,
    setExecution: (value: DurableExecution | null) => {
      execution = value;
    },
  };
}
function journal(state: DurableExecution["state"]): DurableExecution {
  const base = { request, acceptedAt: new Date().toISOString() };
  if (state === "accepted" || state === "executing" || state === "completed")
    return { ...base, state };
  const executionPlan = generateK6Script(request).executionPlan;
  const completion = materializedTrafficCompletionReportSchema.parse(
    new K6RunAccumulator({
      executionPlan,
      runId: request.runId,
      correlationId: request.correlationId,
      plannedRequests: executionPlan.plannedEmittedAttempts,
      startedAt: new Date(),
    }).completionReport({ status: "failed", completedAt: new Date() }),
  );
  if (state === "completion_pending") return { ...base, state, completion };
  return {
    ...base,
    state,
    completion,
    rejection: { reason: "rejected", httpStatus: 409, rejectedAt: new Date().toISOString() },
  };
}

afterEach(() => vi.useRealTimers());
describe("runner control", () => {
  it("exposes one boot identity and version in idle control and run status", async () => {
    const { app } = setup();
    try {
      expect((await app.inject({ method: "GET", url: runnerControlPath, headers })).json()).toEqual(
        identity,
      );
      expect(
        (
          await app.inject({ method: "GET", url: `/traffic/status/${request.runId}`, headers })
        ).json(),
      ).toMatchObject(identity);
      expect((await app.inject({ method: "GET", url: runnerControlPath })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
  it("rejects mismatched starts and replays before touching the runner, while retaining optional staging", async () => {
    const { app, runner } = setup();
    try {
      for (const expectedBootId of [undefined, bootId]) {
        expect(
          (
            await app.inject({
              method: "POST",
              url: trafficExecutionStartPath,
              headers,
              payload: { ...request, expectedBootId },
            })
          ).statusCode,
        ).toBe(202);
      }
      const response = await app.inject({
        method: "POST",
        url: trafficExecutionStartPath,
        headers,
        payload: { ...request, expectedBootId: otherBootId },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("runner_boot_mismatch");
      expect(runner.start).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
  it.each([
    "completed",
    "completion_rejected",
  ] as const)("fences shutdown by boot and run, and prevents starts once accepted in %s", async (state) => {
    const { app, lifecycle, exit, setExecution } = setup();
    setExecution(journal(state));
    try {
      const send = (runId: string, id: string) =>
        app.inject({
          method: "POST",
          url: runnerShutdownPath,
          headers,
          payload: { runId, bootId: id },
        });
      expect((await send(request.runId, otherBootId)).json().outcome).toBe("ignored_boot_mismatch");
      expect((await send(otherBootId, bootId)).json().outcome).toBe("ignored_run_mismatch");
      expect(exit).not.toHaveBeenCalled();
      expect((await send(request.runId, bootId)).json().outcome).toBe("shutdown_requested");
      const response = await app.inject({
        method: "POST",
        url: trafficExecutionStartPath,
        headers,
        payload: request,
      });
      expect(response.json().code).toBe("runner_stopping");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(exit).toHaveBeenCalledOnce();
    } finally {
      lifecycle.stop();
      await app.close();
    }
  });
  it.each([
    "accepted",
    "executing",
    "completion_pending",
  ] as const)("defers explicit shutdown in %s without closing completion delivery", async (state) => {
    const { app, runner, exit, setExecution } = setup();
    setExecution(journal(state));
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: runnerShutdownPath,
            headers,
            payload: { runId: request.runId, bootId },
          })
        ).json().outcome,
      ).toBe("deferred_busy");
      expect(exit).not.toHaveBeenCalled();
      expect(runner.close).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("defers shutdown while a start is awaiting acceptance", async () => {
    const { app, runner, traffic, lifecycle, exit } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(runner.start).mockImplementation(async () => {
      await gate;
      return { startedAt: new Date(), plannedRequests: 400 };
    });
    const start = traffic.start(request);
    expect((await lifecycle.shutdown({ runId: request.runId, bootId })).outcome).toBe(
      "deferred_busy",
    );
    expect(exit).not.toHaveBeenCalled();
    release();
    await start;
    await app.close();
  });
  it.each([
    null,
    "completed",
  ] as const)("defers shutdown when a complete admission publishes a report during a stale %s journal read", async (initialState) => {
    const { app, runner, traffic, lifecycle, exit, setExecution, store } = setup();
    const stale = initialState ? journal(initialState) : null;
    setExecution(stale);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.read.mockImplementationOnce(async () => {
      await gate;
      return stale;
    });
    const shutdown = lifecycle.shutdown({ runId: request.runId, bootId });
    vi.mocked(runner.start).mockImplementationOnce(async () => {
      setExecution(journal("completion_pending"));
      return { startedAt: new Date(), plannedRequests: 400 };
    });
    await traffic.start(request);
    expect(traffic.hasExecution()).toBe(false);
    release();
    expect((await shutdown).outcome).toBe("deferred_busy");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(exit).not.toHaveBeenCalled();
    expect((await store.read())?.state).toBe("completion_pending");
    await app.close();
  });
  it("defers a previous-run shutdown when a later admission completes during the journal read", async () => {
    const { app, runner, traffic, lifecycle, exit, setExecution, store } = setup();
    const stale = journal("completed");
    setExecution(stale);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.read.mockImplementationOnce(async () => {
      await gate;
      return stale;
    });
    const shutdown = lifecycle.shutdown({ runId: request.runId, bootId });
    const laterRequest = { ...request, runId: otherBootId };
    vi.mocked(runner.start).mockImplementationOnce(async () => {
      setExecution({ ...journal("completed"), request: laterRequest });
      return { startedAt: new Date(), plannedRequests: 400 };
    });
    await traffic.start(laterRequest);
    release();
    expect((await shutdown).outcome).toBe("deferred_busy");
    expect((await lifecycle.shutdown({ runId: request.runId, bootId })).outcome).toBe(
      "ignored_run_mismatch",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(exit).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps shutdown endpoint and timers disabled by default with an explicit version fallback", async () => {
    const config = loadLoadOrchestratorConfig({
      NODE_ENV: "test",
      CONTROL_SERVICE_TOKEN: "test-token",
    });
    expect(config.runnerLifecycleEnabled).toBe(false);
    expect(config.commitSha).toBe("unknown");
    expect(
      loadLoadOrchestratorConfig({
        NODE_ENV: "test",
        CONTROL_SERVICE_TOKEN: "test-token",
        RUNNER_LIFECYCLE_ENABLED: "true",
        COMMIT_SHA: "abc123",
      }),
    ).toMatchObject({ runnerLifecycleEnabled: true, commitSha: "abc123" });
    expect(() =>
      loadLoadOrchestratorConfig({
        NODE_ENV: "test",
        CONTROL_SERVICE_TOKEN: "test-token",
        RUNNER_LIFECYCLE_ENABLED: "1",
      }),
    ).toThrow();
    const { app, exit } = setup(false);
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: runnerShutdownPath,
            headers,
            payload: { runId: request.runId, bootId },
          })
        ).statusCode,
      ).toBe(404);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each([
    "completed",
    "completion_rejected",
  ] as const)("exits three idle minutes after a pending report becomes %s", async (state) => {
    vi.useFakeTimers();
    const { lifecycle, exit, setExecution, app } = setup();
    lifecycle.start();
    setExecution(journal("completion_pending"));
    await vi.advanceTimersByTimeAsync(runnerIdleTimeoutMs);
    expect(exit).not.toHaveBeenCalled();
    setExecution(journal(state));
    await vi.advanceTimersByTimeAsync(runnerIdleTimeoutMs - 1000);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).toHaveBeenCalledOnce();
    lifecycle.stop();
    await app.close();
  });
  it.each([
    "executing",
    "completion_pending",
  ] as const)("requests bounded graceful shutdown at the shared maximum lifetime even in %s", async (state) => {
    vi.useFakeTimers();
    const { lifecycle, exit, setExecution, app } = setup();
    expect(runnerMaximumLifetimeMs).toBe((automaticRunResetDeadlineSeconds + 30) * 1000);
    setExecution(journal(state));
    lifecycle.start();
    await vi.advanceTimersByTimeAsync(runnerMaximumLifetimeMs - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledOnce();
    lifecycle.stop();
    await app.close();
  });
});
