import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { CoreWake } from "../src/core-wake.js";
import { buildGateServer } from "../src/server.js";
import { StoresLifecycle } from "../src/stores-lifecycle.js";
import { coreMachine } from "./core-machine-fixture.js";

function fixture() {
  const events: string[] = [];
  const core = coreMachine({ state: "started" });
  const stores = coreMachine({
    id: "stores-1",
    config: { guest: core.config.guest, metadata: { role: "stores" } },
  });
  const client = (machine: typeof core, label: string) => ({
    listMachines: vi.fn(async () => [machine]),
    getMachine: vi.fn(async () => machine),
    acquireLease: vi.fn(async () => {
      events.push(`${label}:lease`);
      return "nonce";
    }),
    releaseLease: vi.fn(async () => {
      events.push(`${label}:release`);
    }),
    refreshLease: vi.fn(async () => undefined),
    startMachine: vi.fn(async () => {
      events.push(`${label}:start`);
      machine.state = "started";
    }),
    stopMachine: vi.fn(async () => {
      events.push(`${label}:stop`);
      machine.state = "stopping";
    }),
    waitForState: vi.fn(async (_id: string, state: "started" | "stopped") => {
      events.push(`${label}:wait:${state}`);
      machine.state = state;
      return true;
    }),
  });
  const coreClient = client(core, "core");
  const storesClient = client(stores, "stores");
  const lifecycle = new StoresLifecycle({ core: coreClient, stores: storesClient });
  return { core, stores, coreClient, storesClient, lifecycle, events };
}

describe("proof stores lifecycle", () => {
  it("starts stores before core work and retains their lease through the operation", async () => {
    const f = fixture();
    await f.lifecycle.withStarted(async () => {
      f.events.push("core:work");
    });
    expect(f.events).toEqual([
      "stores:lease",
      "stores:start",
      "stores:wait:started",
      "core:work",
      "stores:release",
    ]);
    expect(f.storesClient.refreshLease).toHaveBeenCalledWith("stores-1", "nonce", 900);
  });

  it("blocks core work when stores cannot start", async () => {
    const f = fixture();
    f.storesClient.startMachine.mockRejectedValueOnce(new Error("capacity"));
    const work = vi.fn();
    await expect(f.lifecycle.withStarted(work)).rejects.toThrow("capacity");
    expect(work).not.toHaveBeenCalled();
    expect(f.storesClient.releaseLease).toHaveBeenCalled();
  });

  it("stops core, observes stopped, then stops stores under their lease", async () => {
    const f = fixture();
    f.stores.state = "started";
    await f.lifecycle.stopCoreThenStores(f.core.id);
    expect(f.events).toEqual([
      "core:lease",
      "core:stop",
      "core:wait:stopped",
      "stores:lease",
      "stores:stop",
      "stores:wait:stopped",
      "stores:release",
      "core:release",
    ]);
  });

  it("rejects stale callers and never stops stores after an uncertain core stop", async () => {
    const f = fixture();
    await expect(f.lifecycle.stopCoreThenStores("old-core")).rejects.toThrow("current core");
    expect(f.coreClient.acquireLease).not.toHaveBeenCalled();
    f.coreClient.waitForState.mockRejectedValueOnce(new Error("timeout"));
    await expect(f.lifecycle.stopCoreThenStores(f.core.id)).rejects.toThrow("timeout");
    expect(f.storesClient.stopMachine).not.toHaveBeenCalled();
  });

  it("treats Fly's false wait result as uncertainty rather than a stopped core", async () => {
    const f = fixture();
    f.coreClient.waitForState.mockResolvedValueOnce(false);
    await expect(f.lifecycle.stopCoreThenStores(f.core.id)).rejects.toThrow(
      "did not reach stopped",
    );
    expect(f.storesClient.stopMachine).not.toHaveBeenCalled();
  });

  it("wake repairs stores for an already-started core under the core lease", async () => {
    const f = fixture();
    const wake = new CoreWake({
      machines: f.coreClient,
      recovery: { recreate: vi.fn() },
      readCoreConfig: async () => undefined,
      onStarted: vi.fn(),
      logger: createSilentLogger("gate"),
      withDependencies: (operation) => f.lifecycle.withStarted(operation),
    });
    expect(await wake.wake()).toBe("starting");
    expect(f.events[0]).toBe("core:lease");
    expect(f.storesClient.startMachine).toHaveBeenCalledOnce();
    expect(f.coreClient.startMachine).not.toHaveBeenCalled();
  });

  it("prepares stores before stateless core recovery and retains their lease until recovery ends", async () => {
    const f = fixture();
    f.coreClient.listMachines.mockResolvedValue([]);
    const recreate = vi.fn(async () => {
      f.events.push("core:recreate");
      return "recreated" as const;
    });
    const wake = new CoreWake({
      machines: f.coreClient,
      recovery: { recreate },
      readCoreConfig: async () => f.core.config,
      onStarted: vi.fn(),
      logger: createSilentLogger("gate"),
      withDependencies: (operation) => f.lifecycle.withStarted(operation),
    });
    expect(await wake.wake()).toBe("relocating");
    await vi.waitFor(() => expect(f.storesClient.releaseLease).toHaveBeenCalled());
    expect(f.events).toEqual([
      "stores:lease",
      "stores:start",
      "stores:wait:started",
      "core:recreate",
      "stores:release",
    ]);
  });

  it("authenticates the optional gate endpoint before delegating lifecycle work", async () => {
    const stop = vi.fn(async () => undefined);
    const gate = await buildGateServer({
      status: { current: async () => ({ state: "stopped" }), invalidate: vi.fn() },
      wake: { wake: async () => "starting", recoveryState: () => undefined },
      logger: createSilentLogger("gate"),
      idleShutdown: { token: "proof-token", stop },
    });
    try {
      expect((await gate.inject({ method: "POST", url: "/__gate/idle-stop" })).statusCode).toBe(
        401,
      );
      expect(stop).not.toHaveBeenCalled();
      expect(
        (
          await gate.inject({
            method: "POST",
            url: "/__gate/idle-stop",
            headers: { authorization: "Bearer proof-token", "x-core-machine-id": "core-1" },
          })
        ).statusCode,
      ).toBe(204);
      expect(stop).toHaveBeenCalledWith("core-1");
    } finally {
      await gate.close();
    }
  });
});
