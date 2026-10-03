import type { FlyMachine } from "@checkout-surge/fly-machines";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { FlyRunnerHost } from "../../src/services/fly-runner-host.js";

const runId = "55555555-5555-4555-8555-555555555555";
const bootId = "11111111-1111-4111-8111-111111111111";
const apiBaseUrl = "http://[fdaa::2]:4000";
const size = { cpuKind: "performance", cpus: 4, memoryMb: 8192 };

function runnerMachine(overrides: Partial<FlyMachine> = {}): FlyMachine {
  return {
    id: "runner-1",
    state: "stopped",
    region: "cdg",
    instance_id: "v1",
    config: {
      image: "registry.fly.io/runner:load-orchestrator-abc",
      guest: { cpu_kind: "performance", cpus: 4, memory_mb: 8192 },
      env: { PORT: "4200", API_BASE_URL: apiBaseUrl },
      metadata: { role: "runner" },
    },
    ...overrides,
  };
}

function setup(
  options: {
    machine?: FlyMachine;
    /** The Machine as read again under the lease, when a deploy changed it after the listing. */
    machineUnderLease?: FlyMachine;
    shutdownOutcomes?: ReadonlyArray<
      "deferred_busy" | "shutdown_requested" | "ignored_boot_mismatch"
    >;
    shutdownFails?: boolean;
    stopsAfterShutdown?: boolean;
  } = {},
) {
  let clock = 0;
  const machines = {
    listMachines: vi.fn(async () => [
      runnerMachine({
        id: "unrelated",
        config: { ...runnerMachine().config, metadata: { role: "probe" } },
      }),
      options.machine ?? runnerMachine(),
    ]),
    getMachine: vi.fn(async () => options.machineUnderLease ?? options.machine ?? runnerMachine()),
    acquireLease: vi.fn(async () => "nonce-1"),
    releaseLease: vi.fn(async () => undefined),
    updateMachine: vi.fn(async () => runnerMachine({ instance_id: "v2" })),
    startMachine: vi.fn(async () => undefined),
    stopMachine: vi.fn(async () => undefined),
    waitForState: vi.fn(
      async (_id: string, state: string, wait: { timeoutSeconds: number }) =>
        state !== "stopped" || wait.timeoutSeconds !== 30 || (options.stopsAfterShutdown ?? true),
    ),
  };
  const outcomes = [...(options.shutdownOutcomes ?? ["shutdown_requested"])];
  const control = {
    readIdentity: vi.fn(async () => ({ bootId, version: "abc" })),
    shutdown: vi.fn(async () => {
      if (options.shutdownFails) throw new Error("connection refused");
      return outcomes.shift() ?? "deferred_busy";
    }),
  };
  const host = new FlyRunnerHost({
    machines,
    control,
    size,
    apiBaseUrl,
    logger: createSilentLogger("api"),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { host, machines, control };
}

describe("FlyRunnerHost start", () => {
  it("starts the stopped runner under its lease when its config already fits the run", async () => {
    const { host, machines } = setup();

    await expect(host.start(runId)).resolves.toEqual({ machineId: "runner-1" });

    expect(machines.acquireLease).toHaveBeenCalledWith("runner-1", 300, "runner start");
    expect(machines.updateMachine).not.toHaveBeenCalled();
    expect(machines.startMachine).toHaveBeenCalledWith("runner-1", "nonce-1");
    expect(machines.waitForState).toHaveBeenCalledWith("runner-1", "started", {
      timeoutSeconds: 60,
    });
    expect(machines.releaseLease).toHaveBeenCalledWith("runner-1", "nonce-1");
  });

  it("updates the size and API address from the full config, then waits before starting", async () => {
    const machine = runnerMachine();
    machine.config.guest.cpus = 2;
    machine.config.env = { PORT: "4200", API_BASE_URL: "http://old-core:4000" };
    const { host, machines } = setup({ machine });

    await host.start(runId);

    expect(machines.updateMachine).toHaveBeenCalledWith(
      "runner-1",
      {
        image: "registry.fly.io/runner:load-orchestrator-abc",
        guest: { cpu_kind: "performance", cpus: 4, memory_mb: 8192 },
        env: { PORT: "4200", API_BASE_URL: apiBaseUrl },
        metadata: { role: "runner" },
      },
      "nonce-1",
    );
    expect(machines.waitForState).toHaveBeenNthCalledWith(1, "runner-1", "stopped", {
      timeoutSeconds: 60,
      instanceId: "v2",
    });
    expect(machines.updateMachine.mock.invocationCallOrder[0]).toBeLessThan(
      machines.startMachine.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("updates from the config read under the lease, not the one listed before it", async () => {
    const deployed = runnerMachine();
    deployed.config.image = "registry.fly.io/runner:load-orchestrator-new";
    deployed.config.env = { PORT: "4200", COMMIT_SHA: "new" };
    const { host, machines } = setup({ machineUnderLease: deployed });

    await host.start(runId);

    expect(machines.getMachine).toHaveBeenCalledWith("runner-1");
    expect(machines.acquireLease.mock.invocationCallOrder[0]).toBeLessThan(
      machines.getMachine.mock.invocationCallOrder[0] ?? 0,
    );
    expect(machines.updateMachine).toHaveBeenCalledWith(
      "runner-1",
      expect.objectContaining({
        image: "registry.fly.io/runner:load-orchestrator-new",
        env: { PORT: "4200", COMMIT_SHA: "new", API_BASE_URL: apiBaseUrl },
      }),
      "nonce-1",
    );
  });

  it("shuts down a runner still running from an earlier boot before starting a fresh one", async () => {
    const { host, machines, control } = setup({
      machine: runnerMachine({ state: "started" }),
      shutdownOutcomes: ["ignored_boot_mismatch"],
    });

    await host.start(runId);

    expect(control.shutdown).toHaveBeenCalledWith({ runId, bootId });
    expect(machines.stopMachine).toHaveBeenCalledWith("runner-1", "nonce-1");
    expect(machines.stopMachine.mock.invocationCallOrder[0]).toBeLessThan(
      machines.startMachine.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("releases the lease when the start fails", async () => {
    const { host, machines } = setup();
    machines.startMachine.mockRejectedValueOnce(new Error("insufficient resources"));

    await expect(host.start(runId)).rejects.toThrow("insufficient resources");
    expect(machines.releaseLease).toHaveBeenCalledWith("runner-1", "nonce-1");
  });
});

describe("FlyRunnerHost stop", () => {
  const started = () => runnerMachine({ state: "started" });

  it("does nothing for an already stopped runner", async () => {
    const { host, control } = setup();

    await host.stop({ runId, bootId });

    expect(control.shutdown).not.toHaveBeenCalled();
  });

  it("retries a busy runner, then confirms its own exit without a Fly stop", async () => {
    const { host, machines, control } = setup({
      machine: started(),
      shutdownOutcomes: ["deferred_busy", "deferred_busy", "shutdown_requested"],
    });

    await host.stop({ runId, bootId });

    expect(control.shutdown).toHaveBeenCalledTimes(3);
    expect(machines.waitForState).toHaveBeenCalledWith("runner-1", "stopped", {
      timeoutSeconds: 30,
    });
    expect(machines.stopMachine).not.toHaveBeenCalled();
  });

  it("leaves a runner that serves another boot running", async () => {
    const { host, machines } = setup({
      machine: started(),
      shutdownOutcomes: ["ignored_boot_mismatch"],
    });

    await host.stop({ runId, bootId });

    expect(machines.stopMachine).not.toHaveBeenCalled();
  });

  it.each([
    ["unreachable", { shutdownFails: true }],
    ["busy past the retry window", { shutdownOutcomes: [] }],
    ["still running after its shutdown", { stopsAfterShutdown: false }],
  ] as const)("stops a runner through Fly when it is %s", async (_case, options) => {
    const { host, machines } = setup({ machine: started(), ...options });

    await host.stop({ runId, bootId });

    expect(machines.stopMachine).toHaveBeenCalledWith("runner-1", "nonce-1");
    expect(machines.waitForState).toHaveBeenLastCalledWith("runner-1", "stopped", {
      timeoutSeconds: 60,
    });
  });
});
