import { type FlyMachine, FlyMachinesApiError } from "@checkout-surge/fly-machines";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { CoreWake } from "../src/core-wake.js";
import { coreMachine } from "./core-machine-fixture.js";

function setup(options: { listed?: FlyMachine; underLease?: FlyMachine } = {}) {
  const listed = options.listed ?? coreMachine();
  const machines = {
    listMachines: vi.fn(async () => [listed]),
    getMachine: vi.fn(async () => options.underLease ?? listed),
    acquireLease: vi.fn(async () => "nonce-1"),
    releaseLease: vi.fn(async () => undefined),
    startMachine: vi.fn(async () => undefined),
    waitForState: vi.fn(async () => true),
  };
  const onStarted = vi.fn();
  const wake = new CoreWake({ machines, onStarted, logger: createSilentLogger("gate") });
  return { wake, machines, onStarted };
}

describe("CoreWake", () => {
  it("starts a stopped core under its lease, then releases the lease", async () => {
    const { wake, machines, onStarted } = setup();

    await expect(wake.wake()).resolves.toBe("starting");

    expect(machines.acquireLease).toHaveBeenCalledWith("core-1", 60, "gate wake");
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
      new FlyMachinesApiError("POST", "/machines/core-1/start", 500, "internal error"),
    );

    await expect(wake.wake()).resolves.toBe("unavailable");
    expect(onStarted).not.toHaveBeenCalled();
    expect(machines.releaseLease).toHaveBeenCalledOnce();
  });
});
