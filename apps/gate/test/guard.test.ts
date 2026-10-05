import { type FlyMachine, FlyMachinesApiError, type FlyVolume } from "@checkout-surge/fly-machines";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import type { ProbeResult } from "../src/core-status.js";
import { defaultGuardThresholds, Guard } from "../src/guard.js";
import { coreMachine } from "./core-machine-fixture.js";

const minute = 60_000;
const hour = 60 * minute;
const now = Date.parse("2026-10-05T12:00:00Z");
const longAgo = "2026-10-01T00:00:00Z";
const justNow = new Date(now - minute).toISOString();

function core(overrides: Partial<FlyMachine> & { startedMsAgo?: number } = {}): FlyMachine {
  const { startedMsAgo, ...machine } = overrides;
  return coreMachine({
    created_at: longAgo,
    config: {
      guest: { cpu_kind: "performance", cpus: 4, memory_mb: 8192 },
      metadata: { role: "core" },
      mounts: [{ volume: `vol_${machine.id ?? "core-1"}`, path: "/persistent" }],
    },
    ...(startedMsAgo === undefined
      ? {}
      : {
          state: "started",
          events: [{ type: "start", status: "started", timestamp: now - startedMsAgo }],
        }),
    ...machine,
  });
}

function runner(overrides: Partial<FlyMachine> & { startedMsAgo?: number } = {}): FlyMachine {
  return core({
    id: "runner-1",
    config: {
      guest: { cpu_kind: "performance", cpus: 4, memory_mb: 8192 },
      metadata: { role: "runner" },
    },
    ...overrides,
  });
}

const failedSetup = {
  containers: [
    { name: "setup", state: "stopped", events: [{ type: "exited", exit_code: 1, timestamp: now }] },
  ],
};

function volume(overrides: Partial<FlyVolume>): FlyVolume {
  return {
    id: "vol_x",
    name: "core_data",
    region: "cdg",
    state: "created",
    attached_machine_id: null,
    created_at: longAgo,
    ...overrides,
  };
}

function fakeApp(machines: FlyMachine[], volumes: FlyVolume[] = []) {
  return {
    listMachines: vi.fn(async () => machines),
    listVolumes: vi.fn(async () => volumes),
    // Read again before acting: unchanged since the listing unless a test says otherwise.
    getMachine: vi.fn(async (id: string) => {
      const machine = machines.find((listed) => listed.id === id);
      if (!machine) throw new FlyMachinesApiError("GET", `/machines/${id}`, 404, "not found");
      return machine;
    }),
    acquireLease: vi.fn(async (id: string) => `nonce-${id}`),
    releaseLease: vi.fn(async () => undefined),
    stopMachine: vi.fn(async () => undefined),
    destroyMachine: vi.fn(async () => undefined),
    deleteVolume: vi.fn(async () => undefined),
  };
}

function setup(options: {
  core?: ReturnType<typeof fakeApp>;
  runner?: ReturnType<typeof fakeApp>;
  probes?: ProbeResult[];
  dryRun?: boolean;
}) {
  let clock = now;
  const probes = [...(options.probes ?? [])];
  const probe = vi.fn(async () => probes.shift() ?? "ready");
  const coreApp = options.core ?? fakeApp([core()]);
  const runnerApp = options.runner ?? fakeApp([runner()]);
  const guard = new Guard({
    core: coreApp,
    runner: runnerApp,
    probe,
    thresholds: defaultGuardThresholds,
    dryRun: options.dryRun ?? false,
    logger: createSilentLogger("gate"),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { guard, core: coreApp, runner: runnerApp, probe, elapsed: () => clock - now };
}

describe("Guard", () => {
  it("leaves a stopped core and runner, and an awake core within its limits, alone", async () => {
    const {
      guard,
      core: coreApp,
      runner: runnerApp,
      probe,
    } = setup({
      core: fakeApp([core({ startedMsAgo: hour })], [volume({ attached_machine_id: "core-1" })]),
    });

    await expect(guard.run()).resolves.toBe(true);

    expect(probe).toHaveBeenCalledOnce();
    for (const app of [coreApp, runnerApp]) {
      expect(app.stopMachine).not.toHaveBeenCalled();
      expect(app.destroyMachine).not.toHaveBeenCalled();
      expect(app.deleteVolume).not.toHaveBeenCalled();
    }
  });

  it("stops a core awake for more than 3 hours, under its lease", async () => {
    const { guard, core: coreApp } = setup({
      core: fakeApp([core({ startedMsAgo: 3 * hour + minute })]),
    });

    await guard.run();

    expect(coreApp.acquireLease).toHaveBeenCalledWith("core-1", 60, "guard");
    expect(coreApp.stopMachine).toHaveBeenCalledWith("core-1", "nonce-core-1");
    expect(coreApp.releaseLease).toHaveBeenCalledWith("core-1", "nonce-core-1");
  });

  it("stops a core whose setup failed on its first run, without probing it", async () => {
    const {
      guard,
      core: coreApp,
      probe,
    } = setup({
      core: fakeApp([core({ startedMsAgo: minute, ...failedSetup })]),
    });

    await guard.run();

    expect(probe).not.toHaveBeenCalled();
    expect(coreApp.stopMachine).toHaveBeenCalledWith("core-1", "nonce-core-1");
  });

  it("stops a core that never answers across three probes, two minutes apart", async () => {
    const {
      guard,
      core: coreApp,
      probe,
      elapsed,
    } = setup({
      core: fakeApp([core({ startedMsAgo: hour })]),
      probes: ["no_answer", "no_answer", "not_ready"],
    });

    await guard.run();

    expect(probe).toHaveBeenCalledTimes(3);
    expect(probe).toHaveBeenCalledWith("http://[fdaa::5]:8080");
    expect(elapsed()).toBe(4 * minute);
    expect(coreApp.stopMachine).toHaveBeenCalledWith("core-1", "nonce-core-1");
  });

  it("keeps a saturated core that answers a later probe", async () => {
    const {
      guard,
      core: coreApp,
      probe,
    } = setup({
      core: fakeApp([core({ startedMsAgo: hour })]),
      probes: ["no_answer", "ready"],
    });

    await guard.run();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(coreApp.stopMachine).not.toHaveBeenCalled();
  });

  it("does not probe a core within its startup grace period", async () => {
    const {
      guard,
      core: coreApp,
      probe,
    } = setup({
      core: fakeApp([core({ startedMsAgo: 5 * minute })]),
      probes: ["no_answer"],
    });

    await guard.run();

    expect(probe).not.toHaveBeenCalled();
    expect(coreApp.stopMachine).not.toHaveBeenCalled();
  });

  it("does not stop a core woken again while it was being probed", async () => {
    const silent = core({ startedMsAgo: hour });
    const woken = core({ startedMsAgo: 0 });
    const coreApp = fakeApp([woken]);
    coreApp.listMachines.mockResolvedValueOnce([silent]);
    const { guard } = setup({
      core: coreApp,
      probes: ["no_answer", "no_answer", "no_answer"],
    });

    await guard.run();

    expect(coreApp.listMachines).toHaveBeenCalledTimes(2);
    expect(coreApp.stopMachine).not.toHaveBeenCalled();
  });

  it("keeps the core that can serve, not the newest, and removes a leftover with its volume", async () => {
    const kept = core({ id: "core-old" });
    const leftover = core({
      id: "core-new",
      created_at: "2026-10-05T10:00:00Z",
      startedMsAgo: hour,
    });
    const { guard, core: coreApp } = setup({
      core: fakeApp([kept, leftover]),
      probes: ["no_answer", "no_answer", "no_answer"],
    });

    await guard.run();

    expect(coreApp.destroyMachine).toHaveBeenCalledOnce();
    expect(coreApp.destroyMachine).toHaveBeenCalledWith("core-new", "nonce-core-new");
    expect(coreApp.deleteVolume).toHaveBeenCalledWith("vol_core-new");
  });

  it("destroys a leftover core on a host that is down without a lease, a 404 counting as done", async () => {
    const dead = core({ id: "core-dead", host_status: "unreachable", state: "started" });
    const coreApp = fakeApp([dead, core({ id: "core-2", created_at: "2026-10-05T10:00:00Z" })]);
    coreApp.destroyMachine.mockRejectedValueOnce(
      new FlyMachinesApiError("DELETE", "/machines/core-dead", 404, "not found"),
    );
    const { guard } = setup({ core: coreApp });

    await expect(guard.run()).resolves.toBe(true);

    expect(coreApp.acquireLease).not.toHaveBeenCalled();
    expect(coreApp.destroyMachine).toHaveBeenCalledWith("core-dead", undefined);
    expect(coreApp.deleteVolume).toHaveBeenCalledWith("vol_core-dead");
  });

  it("does not stop a core restarted between the listing and the lease", async () => {
    const coreApp = fakeApp([core({ startedMsAgo: 3 * hour + minute })]);
    coreApp.getMachine.mockResolvedValueOnce(core({ startedMsAgo: 0 }));
    const { guard } = setup({ core: coreApp });

    await expect(guard.run()).resolves.toBe(true);

    expect(coreApp.stopMachine).not.toHaveBeenCalled();
    expect(coreApp.releaseLease).toHaveBeenCalledWith("core-1", "nonce-core-1");
  });

  it("does not destroy a leftover core whose host came back since the listing", async () => {
    const dead = core({ id: "core-dead", host_status: "unreachable", state: "started" });
    const coreApp = fakeApp([dead, core({ id: "core-2", created_at: "2026-10-05T10:00:00Z" })]);
    coreApp.getMachine.mockResolvedValueOnce({ ...dead, host_status: "ok" });
    const { guard } = setup({ core: coreApp });

    await expect(guard.run()).resolves.toBe(true);

    expect(coreApp.acquireLease).not.toHaveBeenCalled();
    expect(coreApp.destroyMachine).not.toHaveBeenCalled();
    expect(coreApp.deleteVolume).not.toHaveBeenCalled();
  });

  it("leaves a leftover whose lease is held, such as the old core during a recovery", async () => {
    const coreApp = fakeApp([
      core(),
      core({ id: "core-2", created_at: justNow, state: "starting" }),
    ]);
    coreApp.acquireLease.mockRejectedValueOnce(
      new FlyMachinesApiError("POST", "/machines/core-1/lease", 409, "lease held"),
    );
    const { guard } = setup({ core: coreApp });

    await expect(guard.run()).resolves.toBe(true);

    expect(coreApp.destroyMachine).not.toHaveBeenCalled();
  });

  it("destroys a Machine without the app's role after the grace period, unless its host is down", async () => {
    const roleless = (id: string, overrides: Partial<FlyMachine> = {}) =>
      coreMachine({
        id,
        created_at: longAgo,
        config: { guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 } },
        ...overrides,
      });
    const coreApp = fakeApp([
      core(),
      roleless("stray"),
      roleless("young", { created_at: justNow }),
      roleless("dead-host", { host_status: "unreachable" }),
    ]);
    const { guard } = setup({ core: coreApp });

    await guard.run();

    expect(coreApp.destroyMachine).toHaveBeenCalledOnce();
    expect(coreApp.destroyMachine).toHaveBeenCalledWith("stray", "nonce-stray");
  });

  it("deletes a detached core volume after the grace period", async () => {
    const coreApp = fakeApp(
      [core()],
      [
        volume({ id: "vol_core-1", attached_machine_id: "core-1" }),
        volume({ id: "vol_orphan" }),
        volume({ id: "vol_of_destroyed", attached_machine_id: "gone" }),
        volume({ id: "vol_recovery", created_at: justNow }),
        volume({ id: "vol_deleting", state: "pending_destroy" }),
      ],
    );
    const { guard } = setup({ core: coreApp });

    await guard.run();

    expect(coreApp.deleteVolume.mock.calls).toEqual([["vol_orphan"], ["vol_of_destroyed"]]);
  });

  it("keeps the newest runner, destroys the older ones and stops one started too long ago", async () => {
    const runnerApp = fakeApp([
      runner({ id: "runner-old" }),
      runner({ id: "runner-new", created_at: "2026-10-04T00:00:00Z", startedMsAgo: 21 * minute }),
    ]);
    const { guard } = setup({ runner: runnerApp });

    await guard.run();

    expect(runnerApp.destroyMachine).toHaveBeenCalledWith("runner-old", "nonce-runner-old");
    expect(runnerApp.stopMachine).toHaveBeenCalledWith("runner-new", "nonce-runner-new");
  });

  it("leaves a runner started within its maximum lifetime", async () => {
    const runnerApp = fakeApp([runner({ startedMsAgo: 15 * minute })]);
    const { guard } = setup({ runner: runnerApp });

    await guard.run();

    expect(runnerApp.stopMachine).not.toHaveBeenCalled();
  });

  it("takes no action in a dry run", async () => {
    const coreApp = fakeApp([core({ startedMsAgo: 4 * hour })], [volume({ id: "vol_orphan" })]);
    const { guard } = setup({ core: coreApp, dryRun: true });

    await guard.run();

    expect(coreApp.acquireLease).not.toHaveBeenCalled();
    expect(coreApp.deleteVolume).not.toHaveBeenCalled();
  });

  it("still checks the runner app when the core app cannot be read, and reports the failure", async () => {
    const coreApp = fakeApp([core()]);
    coreApp.listMachines.mockRejectedValueOnce(new Error("Machines API down"));
    const runnerApp = fakeApp([runner({ startedMsAgo: hour })]);
    const { guard } = setup({ core: coreApp, runner: runnerApp });

    await expect(guard.run()).resolves.toBe(false);

    expect(runnerApp.stopMachine).toHaveBeenCalledOnce();
  });
});
