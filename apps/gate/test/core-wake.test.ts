import { type FlyMachine, FlyMachinesApiError } from "@checkout-surge/fly-machines";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { CoreWake } from "../src/core-wake.js";
import { coreMachine } from "./core-machine-fixture.js";

const noCapacity = () =>
  new FlyMachinesApiError(
    "POST",
    "/machines/core-1/start",
    409,
    '{"error":"insufficient memory available to fulfill request"}',
  );

/** What the Machines API client's own request timeout aborts a call with. */
const startTimeout = () =>
  new DOMException("The operation was aborted due to timeout", "TimeoutError");

const deployedConfig = {
  guest: { cpu_kind: "performance", cpus: 4, memory_mb: 8192 },
  metadata: { role: "core" },
};

function setup(
  options: { listed?: FlyMachine; underLease?: FlyMachine; deployedConfig?: boolean } = {},
) {
  const listed = options.listed ?? coreMachine();
  const sleeps: number[] = [];
  const machines = {
    listMachines: vi.fn(async () => [listed]),
    getMachine: vi.fn(async () => options.underLease ?? listed),
    acquireLease: vi.fn(async () => "nonce-1"),
    releaseLease: vi.fn(async () => undefined),
    startMachine: vi.fn(async () => undefined),
    waitForState: vi.fn(async () => true),
  };
  let finishRecovery: (outcome: "recreated" | "no_capacity") => void = () => undefined;
  const recovery = {
    recreate: vi.fn(
      () => new Promise<"recreated" | "no_capacity">((resolve) => (finishRecovery = resolve)),
    ),
  };
  const onStarted = vi.fn();
  const wake = new CoreWake({
    machines,
    recovery,
    readCoreConfig: async () => (options.deployedConfig === false ? undefined : deployedConfig),
    onStarted,
    logger: createSilentLogger("gate"),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return {
    wake,
    machines,
    recovery,
    onStarted,
    sleeps,
    finishRecovery: async (outcome: "recreated" | "no_capacity") => {
      finishRecovery(outcome);
      await vi.waitFor(() => expect(machines.releaseLease).toHaveBeenCalled());
    },
  };
}

describe("CoreWake", () => {
  it("starts a stopped core under its lease, then releases the lease", async () => {
    const { wake, machines, onStarted } = setup();

    await expect(wake.wake()).resolves.toBe("starting");

    expect(machines.acquireLease).toHaveBeenCalledWith("core-1", 180, "gate wake");
    expect(machines.startMachine).toHaveBeenCalledWith("core-1", "nonce-1");
    expect(onStarted).toHaveBeenCalledOnce();
    expect(machines.releaseLease).toHaveBeenCalledWith("core-1", "nonce-1");
  });

  it("shows the update in progress when a deploy holds the lease", async () => {
    const { wake, machines } = setup();
    machines.acquireLease.mockRejectedValueOnce(
      new FlyMachinesApiError("POST", "/machines/core-1/lease", 409, "lease currently held"),
    );

    await expect(wake.wake()).resolves.toBe("updating");
    expect(machines.startMachine).not.toHaveBeenCalled();
  });

  it("leaves a core that is already up or starting alone", async () => {
    for (const state of ["started", "starting"]) {
      const { wake, machines } = setup({ listed: coreMachine({ state }) });

      await expect(wake.wake()).resolves.toBe("starting");
      expect(machines.acquireLease).not.toHaveBeenCalled();
    }
    const { wake, machines } = setup({ underLease: coreMachine({ state: "starting" }) });
    await expect(wake.wake()).resolves.toBe("starting");
    expect(machines.startMachine).not.toHaveBeenCalled();
  });

  it("waits for a core that is still stopping before starting it", async () => {
    const { wake, machines } = setup({ listed: coreMachine({ state: "stopping" }) });

    await expect(wake.wake()).resolves.toBe("starting");
    expect(machines.waitForState).toHaveBeenCalledWith("core-1", "stopped", {
      timeoutSeconds: 30,
    });
    expect(machines.startMachine).toHaveBeenCalledOnce();
  });

  it("joins visitors who press the button together into one start", async () => {
    const { wake, machines } = setup();

    await expect(Promise.all([wake.wake(), wake.wake()])).resolves.toEqual([
      "starting",
      "starting",
    ]);
    expect(machines.startMachine).toHaveBeenCalledOnce();
  });

  it("reports a failed start as unavailable and still releases the lease", async () => {
    const { wake, machines, onStarted } = setup();
    machines.startMachine.mockRejectedValueOnce(
      new FlyMachinesApiError("POST", "/machines/core-1/start", 422, "invalid config"),
    );

    await expect(wake.wake()).resolves.toBe("unavailable");
    expect(onStarted).not.toHaveBeenCalled();
    expect(machines.releaseLease).toHaveBeenCalledOnce();
  });

  it("shows the starting page when a start that timed out took effect, without starting again", async () => {
    const { wake, machines, onStarted } = setup();
    machines.startMachine.mockRejectedValueOnce(startTimeout());
    machines.getMachine
      .mockResolvedValueOnce(coreMachine())
      .mockResolvedValueOnce(coreMachine({ state: "starting" }));

    await expect(wake.wake()).resolves.toBe("starting");

    expect(machines.startMachine).toHaveBeenCalledOnce();
    expect(onStarted).toHaveBeenCalledOnce();
    expect(machines.releaseLease).toHaveBeenCalledWith("core-1", "nonce-1");
  });

  it("reports a start that timed out as unavailable when the core did not start or cannot be read", async () => {
    const rereads = [
      async () => coreMachine({ state: "stopped" }),
      async (): Promise<FlyMachine> => {
        throw new Error("Machines API down");
      },
    ];
    for (const reread of rereads) {
      const { wake, machines, onStarted } = setup();
      machines.startMachine.mockRejectedValueOnce(startTimeout());
      machines.getMachine.mockResolvedValueOnce(coreMachine()).mockImplementationOnce(reread);

      await expect(wake.wake()).resolves.toBe("unavailable");

      expect(machines.startMachine).toHaveBeenCalledOnce();
      expect(onStarted).not.toHaveBeenCalled();
      expect(machines.releaseLease).toHaveBeenCalledOnce();
    }
  });
});

describe("CoreWake recovery", () => {
  it("retries a transient start failure with back-off, then starts in place", async () => {
    const { wake, machines, recovery, sleeps } = setup();
    machines.startMachine.mockRejectedValueOnce(
      new FlyMachinesApiError("POST", "/machines/core-1/start", 503, "unavailable"),
    );

    await expect(wake.wake()).resolves.toBe("starting");

    expect(machines.startMachine).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1_000]);
    expect(recovery.recreate).not.toHaveBeenCalled();
  });

  it("recreates the core after three capacity failures, holding the lease until it ends", async () => {
    const { wake, machines, recovery, onStarted, sleeps, finishRecovery } = setup();
    machines.startMachine.mockRejectedValue(noCapacity());

    await expect(wake.wake()).resolves.toBe("relocating");

    expect(machines.startMachine).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1_000, 3_000]);
    expect(recovery.recreate).toHaveBeenCalledWith(coreMachine(), deployedConfig, "nonce-1");
    expect(wake.recoveryState()).toBe("relocating");
    await expect(wake.wake()).resolves.toBe("relocating");
    expect(recovery.recreate).toHaveBeenCalledOnce();
    expect(machines.releaseLease).not.toHaveBeenCalled();

    await finishRecovery("recreated");

    expect(wake.recoveryState()).toBeUndefined();
    expect(machines.releaseLease).toHaveBeenCalledWith("core-1", "nonce-1");
    expect(onStarted).toHaveBeenCalledOnce();
  });

  it("recreates the core at once, under its lease, when an operator requested a fresh core", async () => {
    const machine = coreMachine({
      config: { ...coreMachine().config, metadata: { role: "core", recreate: "requested" } },
    });
    const { wake, machines, recovery } = setup({ listed: machine });

    await expect(wake.wake()).resolves.toBe("relocating");

    expect(machines.startMachine).not.toHaveBeenCalled();
    expect(recovery.recreate).toHaveBeenCalledWith(machine, deployedConfig, "nonce-1");
    // The fresh install was asked for: no provider failure to report.
    expect(wake.recoveryState()).toBe("refreshing");
    await expect(wake.wake()).resolves.toBe("relocating");
    expect(recovery.recreate).toHaveBeenCalledOnce();
  });

  it("shows the relocating page when the deploy marked the core because its host had no room", async () => {
    const machine = coreMachine({
      config: {
        ...coreMachine().config,
        metadata: { role: "core", recreate: "requested", recreate_reason: "capacity" },
      },
    });
    const { wake, machines, recovery } = setup({ listed: machine });

    await expect(wake.wake()).resolves.toBe("relocating");

    expect(machines.startMachine).not.toHaveBeenCalled();
    expect(recovery.recreate).toHaveBeenCalledWith(machine, deployedConfig, "nonce-1");
    expect(wake.recoveryState()).toBe("relocating");
  });

  it("recreates a core whose host is down at once, without taking its lease", async () => {
    // Fly reports only a partial config on a host that is down.
    const partial = { metadata: { role: "core" } } as unknown as FlyMachine["config"];
    const machine = coreMachine({ state: "started", host_status: "unknown", config: partial });
    const { wake, machines, recovery } = setup({ listed: machine });

    await expect(wake.wake()).resolves.toBe("relocating");

    expect(machines.acquireLease).not.toHaveBeenCalled();
    expect(recovery.recreate).toHaveBeenCalledWith(machine, deployedConfig, undefined);
  });

  it("creates a core when none is listed, without a lease or an old core to retire", async () => {
    const { wake, machines, recovery } = setup();
    machines.listMachines.mockResolvedValue([]);

    await expect(Promise.all([wake.wake(), wake.wake()])).resolves.toEqual([
      "relocating",
      "relocating",
    ]);

    expect(machines.acquireLease).not.toHaveBeenCalled();
    expect(recovery.recreate).toHaveBeenCalledExactlyOnceWith(undefined, deployedConfig, undefined);
  });

  it("shows the unavailable page when no core is listed and no deployed config exists", async () => {
    const { wake, machines, recovery } = setup({ deployedConfig: false });
    machines.listMachines.mockResolvedValue([]);

    await expect(wake.wake()).resolves.toBe("unavailable");
    expect(recovery.recreate).not.toHaveBeenCalled();
  });

  it("never creates a core when the Machines API cannot list them", async () => {
    const { wake, machines, recovery } = setup();
    machines.listMachines.mockRejectedValue(new Error("Machines API down"));

    await expect(wake.wake()).resolves.toBe("unavailable");
    expect(recovery.recreate).not.toHaveBeenCalled();
  });

  it("cannot recreate the core without the deployed core config", async () => {
    const { wake, machines, recovery } = setup({ deployedConfig: false });
    machines.startMachine.mockRejectedValue(noCapacity());

    await expect(wake.wake()).resolves.toBe("unavailable");

    expect(recovery.recreate).not.toHaveBeenCalled();
    expect(wake.recoveryState()).toBeUndefined();
    expect(machines.releaseLease).toHaveBeenCalledWith("core-1", "nonce-1");
  });

  it("keeps showing that Europe has no capacity until a visitor tries again", async () => {
    const { wake, machines, recovery, finishRecovery } = setup();
    machines.startMachine.mockRejectedValue(noCapacity());
    await wake.wake();

    await finishRecovery("no_capacity");

    expect(wake.recoveryState()).toBe("no_capacity");
    await wake.wake();
    expect(recovery.recreate).toHaveBeenCalledTimes(2);
    expect(wake.recoveryState()).toBe("relocating");
  });

  it("never recreates the core on a conflict", async () => {
    const { wake, machines, recovery } = setup();
    machines.startMachine.mockRejectedValueOnce(
      new FlyMachinesApiError("POST", "/machines/core-1/start", 409, '{"error":"lease held"}'),
    );

    await expect(wake.wake()).resolves.toBe("unavailable");

    expect(machines.startMachine).toHaveBeenCalledOnce();
    expect(recovery.recreate).not.toHaveBeenCalled();
  });
});
