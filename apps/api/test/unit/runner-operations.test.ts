import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import type { RunnerHost } from "../../src/services/runner-host.js";
import { RunnerOperations } from "../../src/services/runner-operations.js";

const runId = "55555555-5555-4555-8555-555555555555";
const bootId = "11111111-1111-4111-8111-111111111111";

function setup(
  options: {
    apiVersion?: string;
    runnerVersion?: string;
    acceptUnknownVersion?: boolean;
    readyAfterChecks?: number;
    host?: Partial<RunnerHost>;
  } = {},
) {
  let clock = 0;
  let readinessChecks = 0;
  const host = {
    start: vi.fn(async () => ({ machineId: "runner-1" })),
    stop: vi.fn(async () => undefined),
    isStopped: vi.fn(async () => false),
    ...options.host,
  };
  const control = {
    isReady: vi.fn(async () => {
      readinessChecks += 1;
      return readinessChecks > (options.readyAfterChecks ?? 0);
    }),
    readIdentity: vi.fn(async () => ({ bootId, version: options.runnerVersion ?? "abc123" })),
  };
  const aborter = {
    abortCurrent: vi.fn(async () => ({ outcome: "current_run_aborted" as const })),
  };
  const operations = new RunnerOperations({
    host,
    control,
    aborter,
    apiVersion: options.apiVersion ?? "abc123",
    acceptUnknownVersion: options.acceptUnknownVersion ?? false,
    logger: createSilentLogger("api"),
    readyTimeoutMs: 10_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { operations, host, control, aborter };
}

describe("RunnerOperations boot", () => {
  it("starts the runner, waits until it is ready, and returns its boot", async () => {
    const { operations, host, control } = setup({ readyAfterChecks: 3 });

    await expect(operations.bootForRun(runId)).resolves.toEqual({
      machineId: "runner-1",
      bootId,
    });
    expect(host.start).toHaveBeenCalledWith(runId);
    expect(control.isReady).toHaveBeenCalledTimes(4);
    expect(host.stop).not.toHaveBeenCalled();
  });

  it("refuses a runner on another commit and stops it through its boot", async () => {
    const { operations, host } = setup({ runnerVersion: "def456" });

    await expect(operations.bootForRun(runId)).rejects.toMatchObject({
      code: "runner_version_mismatch",
      details: { apiVersion: "abc123", runnerVersion: "def456" },
    });
    expect(host.stop).toHaveBeenCalledWith({ runId, bootId });
  });

  it("never matches unknown versions unless the topology accepts them", async () => {
    const strict = setup({ apiVersion: "unknown", runnerVersion: "unknown" });
    await expect(strict.operations.bootForRun(runId)).rejects.toMatchObject({
      code: "runner_version_mismatch",
    });

    const local = setup({
      apiVersion: "unknown",
      runnerVersion: "unknown",
      acceptUnknownVersion: true,
    });
    await expect(local.operations.bootForRun(runId)).resolves.toMatchObject({ bootId });
  });

  it("reports a runner that never becomes ready as unavailable and stops it", async () => {
    const { operations, host } = setup({ readyAfterChecks: Number.POSITIVE_INFINITY });

    await expect(operations.bootForRun(runId)).rejects.toMatchObject({
      statusCode: 503,
      code: "load_orchestrator_unavailable",
    });
    expect(host.stop).toHaveBeenCalledWith({ runId, bootId: null });
  });

  it("finishes a pending stop before the next boot", async () => {
    let finishStop!: () => void;
    const { operations, host } = setup({
      host: {
        stop: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishStop = resolve;
            }),
        ),
      },
    });

    operations.releaseAfterRun({ runId, bootId });
    const boot = operations.bootForRun("66666666-6666-4666-8666-666666666666");
    await vi.waitFor(() => expect(host.stop).toHaveBeenCalled());
    expect(host.start).not.toHaveBeenCalled();

    finishStop();
    await boot;
    expect(host.start).toHaveBeenCalled();
  });
});

describe("RunnerOperations release", () => {
  const nextRunId = "66666666-6666-4666-8666-666666666666";

  it("stops the runner of the latest booted run", async () => {
    const { operations, host } = setup();
    await operations.bootForRun(runId);

    operations.releaseAfterRun({ runId, bootId });

    await vi.waitFor(() => expect(host.stop).toHaveBeenCalledWith({ runId, bootId }));
  });

  it("skips a release that arrives after a later run booted, even for an unreachable runner", async () => {
    const { operations, host } = setup({
      host: { stop: vi.fn(async () => Promise.reject(new Error("runner unreachable"))) },
    });
    await operations.bootForRun(runId);
    await operations.bootForRun(nextRunId);

    operations.releaseAfterRun({ runId, bootId });
    await operations.abortCurrent({ runId: nextRunId, reason: "probe", correlationId: "corr" });

    expect(host.stop).not.toHaveBeenCalled();
  });
});

describe("RunnerOperations abort", () => {
  it("confirms an abort on a stopped runner without calling it", async () => {
    const { operations, aborter } = setup({ host: { isStopped: async () => true } });

    await expect(
      operations.abortCurrent({ runId, reason: "admin_reset", correlationId: "corr" }),
    ).resolves.toEqual({ outcome: "no_current_run" });
    expect(aborter.abortCurrent).not.toHaveBeenCalled();
  });

  it("asks a running runner to abort", async () => {
    const { operations, aborter } = setup();

    await expect(
      operations.abortCurrent({ runId, reason: "admin_reset", correlationId: "corr" }),
    ).resolves.toEqual({ outcome: "current_run_aborted" });
    expect(aborter.abortCurrent).toHaveBeenCalled();
  });
});
