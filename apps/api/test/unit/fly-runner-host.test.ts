import {
  type FlyMachine,
  type FlyMachineConfig,
  FlyMachinesApiError,
} from "@checkout-surge/fly-machines";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { FlyRunnerHost } from "../../src/services/fly-runner-host.js";
import { RunnerCapacityUnavailableError } from "../../src/services/runner-host.js";

const runId = "55555555-5555-4555-8555-555555555555";
const bootId = "11111111-1111-4111-8111-111111111111";
const apiBaseUrl = "http://[fdaa::2]:4000";
const size = { cpuKind: "performance", cpus: 4, memoryMb: 8192 };
const noDeadline = Number.POSITIVE_INFINITY;
const noCapacity = () =>
  new FlyMachinesApiError(
    "POST",
    "/machines/runner-1/start",
    409,
    '{"error":"insufficient CPUs available"}',
  );

// The config the deploy script last sent; a recreated runner is built from it, with the run's
// size and API address.
const deployedConfig = {
  image: "registry.fly.io/runner:load-orchestrator-deployed",
  guest: { cpu_kind: "performance", cpus: 2, memory_mb: 4096 },
  env: { PORT: "4200", COMMIT_SHA: "deployed" },
  metadata: { role: "runner" },
};
const recreatedConfig = {
  ...deployedConfig,
  guest: { cpu_kind: "performance", cpus: 4, memory_mb: 8192 },
  env: { PORT: "4200", COMMIT_SHA: "deployed", API_BASE_URL: apiBaseUrl },
};

function runnerMachine(overrides: Partial<FlyMachine> = {}): FlyMachine {
  return {
    id: "runner-1",
    state: "stopped",
    region: "cdg",
    instance_id: "v1",
    private_ip: "fdaa::2",
    created_at: "2026-10-03T10:00:00Z",
    host_status: "ok",
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
  const sleeps: number[] = [];
  // Fly keeps an update unless a test makes it revert.
  let updated: FlyMachine | undefined;
  const machines = {
    listMachines: vi.fn(async () => [
      runnerMachine({
        id: "unrelated",
        config: { ...runnerMachine().config, metadata: { role: "probe" } },
      }),
      options.machine ?? runnerMachine(),
    ]),
    getMachine: vi.fn(
      async () => updated ?? options.machineUnderLease ?? options.machine ?? runnerMachine(),
    ),
    acquireLease: vi.fn(async () => "nonce-1"),
    releaseLease: vi.fn(async () => undefined),
    updateMachine: vi.fn(async (_id: string, config: FlyMachineConfig) => {
      updated = runnerMachine({ instance_id: "v2", config });
      return updated;
    }),
    createMachine: vi.fn(async () => runnerMachine({ id: "runner-2", region: "ams" })),
    destroyMachine: vi.fn(async () => undefined),
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
    coreRegion: "cdg",
    readDeployedConfig: async () => structuredClone(deployedConfig),
    logger: createSilentLogger("api"),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  const hooks = { onRelocating: vi.fn(async () => undefined) };
  const advanceClock = (ms: number) => {
    clock += ms;
  };
  return { host, machines, control, hooks, sleeps, advanceClock };
}

describe("FlyRunnerHost start", () => {
  it("starts the stopped runner under its lease when its config already fits the run", async () => {
    const { host, machines } = setup();

    await expect(
      host.start(runId, { onRelocating: async () => undefined }, noDeadline),
    ).resolves.toEqual({
      machineId: "runner-1",
      region: "cdg",
    });

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

    await host.start(runId, { onRelocating: async () => undefined }, noDeadline);

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

    await host.start(runId, { onRelocating: async () => undefined }, noDeadline);

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

    await host.start(runId, { onRelocating: async () => undefined }, noDeadline);

    expect(control.shutdown).toHaveBeenCalledWith({ runId, bootId });
    expect(machines.stopMachine).toHaveBeenCalledWith("runner-1", "nonce-1");
    expect(machines.stopMachine.mock.invocationCallOrder[0]).toBeLessThan(
      machines.startMachine.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("releases the lease when the start fails", async () => {
    const { host, machines } = setup();
    machines.startMachine.mockRejectedValueOnce(new Error("insufficient resources"));

    await expect(
      host.start(runId, { onRelocating: async () => undefined }, noDeadline),
    ).rejects.toThrow("insufficient resources");
    expect(machines.releaseLease).toHaveBeenCalledWith("runner-1", "nonce-1");
  });
});

describe("FlyRunnerHost capacity recovery", () => {
  it("retries a transient start failure with back-off, then starts in place", async () => {
    const { host, machines, hooks, sleeps } = setup();
    machines.startMachine.mockRejectedValueOnce(
      new FlyMachinesApiError("POST", "/machines/runner-1/start", 503, "unavailable"),
    );

    await expect(host.start(runId, hooks, noDeadline)).resolves.toEqual({
      machineId: "runner-1",
      region: "cdg",
    });

    expect(machines.startMachine).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1_000]);
    expect(hooks.onRelocating).not.toHaveBeenCalled();
    expect(machines.createMachine).not.toHaveBeenCalled();
  });

  it("recreates the runner in the core's region, then Europe, after three capacity failures", async () => {
    const { host, machines, hooks, sleeps } = setup();
    machines.startMachine.mockRejectedValue(noCapacity());

    await expect(host.start(runId, hooks, noDeadline)).resolves.toEqual({
      machineId: "runner-2",
      region: "ams",
    });

    expect(machines.startMachine).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1_000, 3_000]);
    expect(hooks.onRelocating).toHaveBeenCalledOnce();
    expect(machines.createMachine).toHaveBeenCalledWith(recreatedConfig, "cdg,eu");
    expect(machines.waitForState).toHaveBeenLastCalledWith("runner-2", "started", {
      timeoutSeconds: 60,
    });
    expect(machines.destroyMachine).toHaveBeenCalledWith("runner-1", "nonce-1");
  });

  describe("when the runner's host refuses the run's settings", () => {
    // The deployed runner config has no API address, so a start updates it first.
    const deployedRunner = (overrides: Partial<FlyMachine> = {}) =>
      runnerMachine({
        config: { ...runnerMachine().config, env: { PORT: "4200" } },
        ...overrides,
      });

    it("recreates the runner at once when the update is refused for capacity", async () => {
      const { host, machines, hooks } = setup({ machine: deployedRunner() });
      machines.updateMachine.mockRejectedValueOnce(
        new FlyMachinesApiError(
          "POST",
          "/machines/runner-1",
          409,
          '{"error":"aborted: could not reserve resource for machine: insufficient CPUs available to fulfill request on the current host"}',
        ),
      );

      await expect(host.start(runId, hooks, noDeadline)).resolves.toEqual({
        machineId: "runner-2",
        region: "ams",
      });

      expect(machines.startMachine).not.toHaveBeenCalled();
      expect(hooks.onRelocating).toHaveBeenCalledOnce();
      expect(machines.createMachine).toHaveBeenCalledWith(recreatedConfig, "cdg,eu");
      expect(machines.destroyMachine).toHaveBeenCalledWith("runner-1", "nonce-1");
      expect(machines.createMachine.mock.invocationCallOrder[0]).toBeLessThan(
        machines.destroyMachine.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it("recreates the runner when its host accepts the update, then reverts it", async () => {
      const { host, machines, hooks } = setup({ machine: deployedRunner() });
      machines.getMachine.mockResolvedValueOnce(deployedRunner()).mockResolvedValueOnce(
        deployedRunner({
          events: [
            { type: "revert", status: "stopped" },
            { type: "update", status: "replacing" },
          ],
        }),
      );
      machines.waitForState.mockResolvedValueOnce(false);

      await expect(host.start(runId, hooks, noDeadline)).resolves.toMatchObject({
        machineId: "runner-2",
      });

      expect(machines.waitForState).toHaveBeenNthCalledWith(1, "runner-1", "stopped", {
        timeoutSeconds: 60,
        instanceId: "v2",
      });
      expect(machines.startMachine).not.toHaveBeenCalled();
      expect(machines.createMachine).toHaveBeenCalledWith(recreatedConfig, "cdg,eu");
      expect(machines.destroyMachine).toHaveBeenCalledWith("runner-1", "nonce-1");
    });

    it("recreates the runner when the wait succeeds but the update did not stick", async () => {
      const { host, machines, hooks } = setup({ machine: deployedRunner() });
      machines.getMachine
        .mockResolvedValueOnce(deployedRunner())
        .mockResolvedValueOnce(deployedRunner());

      await expect(host.start(runId, hooks, noDeadline)).resolves.toMatchObject({
        machineId: "runner-2",
      });

      expect(machines.updateMachine).toHaveBeenCalledOnce();
      expect(machines.startMachine).not.toHaveBeenCalled();
      expect(hooks.onRelocating).toHaveBeenCalledOnce();
      expect(machines.createMachine).toHaveBeenCalledWith(recreatedConfig, "cdg,eu");
      expect(machines.destroyMachine).toHaveBeenCalledWith("runner-1", "nonce-1");
    });

    it("never recreates the runner when the update fails transiently", async () => {
      const { host, machines, hooks } = setup({ machine: deployedRunner() });
      machines.updateMachine.mockRejectedValueOnce(
        new FlyMachinesApiError("POST", "/machines/runner-1", 503, "unavailable"),
      );

      await expect(host.start(runId, hooks, noDeadline)).rejects.toMatchObject({ status: 503 });

      expect(machines.startMachine).not.toHaveBeenCalled();
      expect(hooks.onRelocating).not.toHaveBeenCalled();
      expect(machines.createMachine).not.toHaveBeenCalled();
      expect(machines.destroyMachine).not.toHaveBeenCalled();
    });
  });

  it("recreates the runner at once from the deployed config, without a lease, when its host is not ok", async () => {
    const { host, machines, hooks } = setup({
      // A partial config, as Fly reports a Machine on a host that is not ok.
      machine: runnerMachine({
        host_status: "unreachable",
        config: { metadata: { role: "runner" } } as unknown as FlyMachine["config"],
      }),
    });
    machines.destroyMachine.mockRejectedValueOnce(
      new FlyMachinesApiError("DELETE", "/machines/runner-1?force=true", 404, "not found"),
    );

    await expect(host.start(runId, hooks, noDeadline)).resolves.toMatchObject({
      machineId: "runner-2",
    });

    expect(machines.acquireLease).not.toHaveBeenCalled();
    expect(machines.startMachine).not.toHaveBeenCalled();
    expect(machines.createMachine).toHaveBeenCalledWith(recreatedConfig, "cdg,eu");
    expect(machines.destroyMachine).toHaveBeenCalledWith("runner-1", undefined);
  });

  it("recreates a runner left outside the core's region, so it follows a relocated core", async () => {
    const { host, machines, hooks } = setup({ machine: runnerMachine({ region: "ams" }) });

    await expect(host.start(runId, hooks, noDeadline)).resolves.toMatchObject({
      machineId: "runner-2",
    });

    expect(machines.startMachine).not.toHaveBeenCalled();
    expect(hooks.onRelocating).toHaveBeenCalledOnce();
    expect(machines.createMachine).toHaveBeenCalledWith(recreatedConfig, "cdg,eu");
    expect(machines.destroyMachine).toHaveBeenCalledWith("runner-1", "nonce-1");
  });

  it("stops a live runner outside the core's region before replacing it", async () => {
    const { host, machines, control, hooks } = setup({
      machine: runnerMachine({ state: "started", region: "ams" }),
    });

    await host.start(runId, hooks, noDeadline);

    expect(control.shutdown).toHaveBeenCalledWith({ runId, bootId });
    expect(machines.waitForState).toHaveBeenCalledWith("runner-1", "stopped", {
      timeoutSeconds: 30,
    });
    expect(machines.waitForState.mock.invocationCallOrder[0]).toBeLessThan(
      machines.createMachine.mock.invocationCallOrder[0] ?? 0,
    );
    expect(machines.destroyMachine).toHaveBeenCalledWith("runner-1", "nonce-1");
  });

  it("never recreates the runner on a conflict", async () => {
    const { host, machines, hooks } = setup();
    machines.startMachine.mockRejectedValueOnce(
      new FlyMachinesApiError("POST", "/machines/runner-1/start", 409, '{"error":"lease held"}'),
    );

    await expect(host.start(runId, hooks, noDeadline)).rejects.toMatchObject({ status: 409 });

    expect(machines.startMachine).toHaveBeenCalledOnce();
    expect(machines.createMachine).not.toHaveBeenCalled();
  });

  it("keeps the old runner and reports no capacity when Europe has none either", async () => {
    const { host, machines, hooks } = setup();
    machines.startMachine.mockRejectedValue(noCapacity());
    machines.createMachine.mockRejectedValueOnce(
      new FlyMachinesApiError(
        "POST",
        "/machines",
        422,
        '{"error":"no capacity","status":"insufficient_capacity"}',
      ),
    );

    await expect(host.start(runId, hooks, noDeadline)).rejects.toBeInstanceOf(
      RunnerCapacityUnavailableError,
    );

    expect(machines.destroyMachine).not.toHaveBeenCalled();
  });

  it("destroys a recreated runner that does not start, and keeps the old one", async () => {
    const { host, machines, hooks } = setup();
    machines.startMachine.mockRejectedValue(noCapacity());
    machines.waitForState.mockResolvedValueOnce(false);

    await expect(host.start(runId, hooks, noDeadline)).rejects.toThrow("did not reach started");

    expect(machines.destroyMachine).toHaveBeenCalledExactlyOnceWith("runner-2");
  });
});

describe("FlyRunnerHost start deadline", () => {
  it("fails as a capacity failure when the deadline falls while retrying a full host", async () => {
    const { host, machines, hooks, sleeps } = setup();
    machines.startMachine.mockRejectedValue(noCapacity());

    await expect(host.start(runId, hooks, 2_000)).rejects.toBeInstanceOf(
      RunnerCapacityUnavailableError,
    );

    // The second back-off would end past the deadline, so no third attempt and no recreation.
    expect(machines.startMachine).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1_000]);
    expect(hooks.onRelocating).not.toHaveBeenCalled();
    expect(machines.createMachine).not.toHaveBeenCalled();
    expect(machines.releaseLease).toHaveBeenCalledWith("runner-1", "nonce-1");
  });

  it("ends a recreation's wait at the deadline, destroys the new runner and keeps the old one", async () => {
    const { host, machines, hooks } = setup({ machine: runnerMachine({ region: "ams" }) });
    machines.waitForState.mockResolvedValueOnce(false);

    await expect(host.start(runId, hooks, 20_000)).rejects.toThrow("did not reach started");

    expect(machines.waitForState).toHaveBeenCalledWith("runner-2", "started", {
      timeoutSeconds: 20,
    });
    expect(machines.destroyMachine).toHaveBeenCalledExactlyOnceWith("runner-2");
  });

  it("fails as a capacity failure when the deadline cuts a relocation after a full host", async () => {
    const { host, machines, hooks, advanceClock } = setup({
      machine: runnerMachine({
        config: { ...runnerMachine().config, env: { PORT: "4200" } },
      }),
    });
    machines.updateMachine.mockRejectedValueOnce(noCapacity());
    machines.waitForState.mockImplementationOnce(async () => {
      advanceClock(20_000);
      return false;
    });

    await expect(host.start(runId, hooks, 20_000)).rejects.toBeInstanceOf(
      RunnerCapacityUnavailableError,
    );

    expect(machines.createMachine).toHaveBeenCalledOnce();
    expect(machines.destroyMachine).toHaveBeenCalledExactlyOnceWith("runner-2");
  });

  it("does not start in place once the update has used up the deadline", async () => {
    const { host, machines, hooks, advanceClock } = setup({
      machine: runnerMachine({
        config: { ...runnerMachine().config, env: { PORT: "4200" } },
      }),
    });
    // The update sticks, but its wait for `stopped` ends at the deadline.
    machines.waitForState.mockImplementationOnce(async () => {
      advanceClock(20_000);
      return true;
    });

    await expect(host.start(runId, hooks, 20_000)).rejects.toThrow("before its deadline");

    expect(machines.updateMachine).toHaveBeenCalledOnce();
    expect(machines.startMachine).not.toHaveBeenCalled();
    expect(machines.createMachine).not.toHaveBeenCalled();
  });

  it("starts nothing once the deadline has passed", async () => {
    const { host, machines, hooks } = setup({ machine: runnerMachine({ region: "ams" }) });

    await expect(host.start(runId, hooks, 0)).rejects.toThrow("before its deadline");

    expect(hooks.onRelocating).not.toHaveBeenCalled();
    expect(machines.createMachine).not.toHaveBeenCalled();
    expect(machines.startMachine).not.toHaveBeenCalled();
  });
});

describe("FlyRunnerHost loss", () => {
  it("counts a runner on an unreachable host as lost and does not try to stop it", async () => {
    const { host, machines, control } = setup({
      machine: runnerMachine({ state: "started", host_status: "unreachable" }),
    });

    await expect(host.isLost()).resolves.toBe(true);
    await host.stop({ runId, bootId });

    expect(machines.acquireLease).not.toHaveBeenCalled();
    expect(control.shutdown).not.toHaveBeenCalled();
    expect(machines.stopMachine).not.toHaveBeenCalled();
  });
});

describe("FlyRunnerHost runner lookup", () => {
  it("uses the newest runner Machine when several exist", async () => {
    const { host, machines } = setup();
    machines.listMachines.mockResolvedValueOnce([
      runnerMachine({ state: "stopped" }),
      runnerMachine({ id: "runner-2", state: "started", created_at: "2026-10-04T10:00:00Z" }),
    ]);

    await expect(host.isStopped()).resolves.toBe(false);
  });
});

describe("FlyRunnerHost recreate", () => {
  it("replaces the stopped runner and leaves the new one stopped", async () => {
    const { host, machines } = setup();

    await expect(host.recreate()).resolves.toEqual({ machineId: "runner-2", region: "ams" });

    expect(machines.createMachine).toHaveBeenCalledWith(recreatedConfig, "cdg,eu");
    expect(machines.destroyMachine).toHaveBeenCalledWith("runner-1", "nonce-1");
    expect(machines.stopMachine).toHaveBeenCalledWith("runner-2");
    expect(machines.waitForState).toHaveBeenLastCalledWith("runner-2", "stopped", {
      timeoutSeconds: 60,
    });
  });

  it("refuses to replace a running runner", async () => {
    const { host, machines } = setup({ machine: runnerMachine({ state: "started" }) });

    await expect(host.recreate()).rejects.toMatchObject({ statusCode: 409 });
    expect(machines.createMachine).not.toHaveBeenCalled();
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
