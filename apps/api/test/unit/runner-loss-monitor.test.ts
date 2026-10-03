import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { type MonitoredRun, RunnerLossMonitor } from "../../src/services/runner-loss-monitor.js";
import type { RunnerCondition } from "../../src/services/runner-operations.js";

const run: MonitoredRun = {
  runId: "55555555-5555-4555-8555-555555555555",
  bootId: "11111111-1111-4111-8111-111111111111",
};

function setup(conditions: RunnerCondition[], monitoredRun: MonitoredRun | null = run) {
  let clock = 0;
  const runner = {
    checkRunner: vi.fn(async () => conditions.shift() ?? "alive"),
    stopUnreachable: vi.fn(async () => undefined),
  };
  const lostRuns = { failLostRun: vi.fn(async () => undefined) };
  const monitor = new RunnerLossMonitor({
    runs: { readMonitoredRun: async () => monitoredRun },
    runner,
    lostRuns,
    logger: createSilentLogger("api"),
    now: () => clock,
  });
  return {
    monitor,
    runner,
    lostRuns,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("RunnerLossMonitor", () => {
  it("does nothing without a run whose traffic is dispatched", async () => {
    const { monitor, runner } = setup([], null);

    await monitor.check();

    expect(runner.checkRunner).not.toHaveBeenCalled();
  });

  it("leaves a run whose runner still serves its boot", async () => {
    const { monitor, runner, lostRuns } = setup(["alive"]);

    await monitor.check();

    expect(runner.checkRunner).toHaveBeenCalledWith(run);
    expect(lostRuns.failLostRun).not.toHaveBeenCalled();
  });

  it("fails the run at once when its runner is lost", async () => {
    const { monitor, lostRuns, runner } = setup(["lost"]);

    await monitor.check();

    expect(lostRuns.failLostRun).toHaveBeenCalledExactlyOnceWith(run.runId);
    expect(runner.stopUnreachable).not.toHaveBeenCalled();
  });

  it("stops a runner unreachable for a minute, then fails the run once it is stopped", async () => {
    const { monitor, runner, lostRuns, advance } = setup([
      "unreachable",
      "unreachable",
      "unreachable",
      "lost",
    ]);

    await monitor.check();
    advance(59_999);
    await monitor.check();
    expect(runner.stopUnreachable).not.toHaveBeenCalled();

    advance(1);
    await monitor.check();

    expect(runner.stopUnreachable).toHaveBeenCalledExactlyOnceWith(run);
    expect(lostRuns.failLostRun).toHaveBeenCalledExactlyOnceWith(run.runId);
  });

  it("restarts the unreachable window when the runner answers again", async () => {
    const { monitor, runner, advance } = setup(["unreachable", "alive", "unreachable"]);

    await monitor.check();
    advance(50_000);
    await monitor.check();
    advance(50_000);
    await monitor.check();

    expect(runner.stopUnreachable).not.toHaveBeenCalled();
  });
});
