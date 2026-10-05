import { type FlyMachine, FlyMachinesApiError } from "@checkout-surge/fly-machines";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { CoreRecovery } from "../src/core-recovery.js";
import type { ProbeResult } from "../src/core-status.js";
import { coreMachine } from "./core-machine-fixture.js";

const guest = { cpu_kind: "performance", cpus: 4, memory_mb: 8192 };
const oldCore = coreMachine({
  config: {
    guest: { ...guest, cpus: 2 },
    image: "core:old",
    metadata: { role: "core", recreate: "requested" },
    mounts: [{ volume: "vol_old", path: "/persistent", name: "core_data", size_gb: 3 }],
  },
});
/** The config the deploy script wrote into the gate, not the old Machine's. */
const deployed = {
  guest,
  image: "core:new",
  metadata: { role: "core" },
  mounts: [{ volume: "vol_deployed", path: "/persistent", name: "core_data", size_gb: 3 }],
};
const startedAt = 1_000_000;

function newCore(overrides: Partial<FlyMachine> = {}): FlyMachine {
  return coreMachine({
    id: "core-2",
    state: "started",
    region: "ams",
    private_ip: "fdaa::9",
    events: [{ type: "start", status: "started", timestamp: startedAt }],
    ...overrides,
  });
}

function setup(options: { probes?: ProbeResult[] } = {}) {
  let clock = 0;
  const probes = [...(options.probes ?? ["no_answer", "ready"])];
  const machines = {
    refreshLease: vi.fn(async () => undefined),
    createVolume: vi.fn(async () => ({ id: "vol_new", name: "core_data", region: "ams" })),
    deleteVolume: vi.fn(async () => undefined),
    createMachine: vi.fn(async () => newCore({ state: "created" })),
    getMachine: vi.fn(async () => newCore()),
    destroyMachine: vi.fn(async () => undefined),
  };
  const probe = vi.fn(async () => probes.shift() ?? "no_answer");
  const recovery = new CoreRecovery({
    machines,
    probe,
    logger: createSilentLogger("gate"),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { recovery, machines, probe };
}

const capacity = (path: string, status: number, body: object) =>
  new FlyMachinesApiError("POST", path, status, JSON.stringify(body));

describe("CoreRecovery", () => {
  it("creates a fresh core from the deployed config, then retires the old one once it is healthy", async () => {
    const { recovery, machines, probe } = setup();

    await expect(recovery.recreate(oldCore, deployed, "nonce-1")).resolves.toBe("recreated");

    expect(machines.refreshLease).toHaveBeenCalledWith("core-1", "nonce-1", 600);
    expect(machines.createVolume).toHaveBeenCalledWith({
      name: "core_data",
      region: "cdg,eu",
      size_gb: 3,
      compute: guest,
    });
    expect(machines.createMachine).toHaveBeenCalledWith(
      {
        guest,
        image: "core:new",
        metadata: { role: "core" },
        mounts: [{ volume: "vol_new", path: "/persistent", name: "core_data", size_gb: 3 }],
      },
      "ams",
    );
    expect(probe).toHaveBeenLastCalledWith("http://[fdaa::9]:8080");
    expect(probe).toHaveBeenCalledTimes(2);
    expect(machines.destroyMachine).toHaveBeenCalledExactlyOnceWith("core-1", "nonce-1");
    expect(machines.deleteVolume).toHaveBeenCalledExactlyOnceWith("vol_old");
    expect(machines.getMachine.mock.invocationCallOrder.at(-1)).toBeLessThan(
      machines.destroyMachine.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("replaces a core whose host is down without its lease, a 404 destroy counting as done", async () => {
    const { recovery, machines } = setup();
    const down = coreMachine({
      state: "started",
      host_status: "unreachable",
      config: { metadata: { role: "core" } } as unknown as FlyMachine["config"],
    });
    machines.destroyMachine.mockRejectedValueOnce(
      new FlyMachinesApiError("DELETE", "/machines/core-1", 404, "not found"),
    );

    await expect(recovery.recreate(down, deployed, undefined)).resolves.toBe("recreated");

    expect(machines.refreshLease).not.toHaveBeenCalled();
    expect(machines.createMachine).toHaveBeenCalledWith(
      expect.objectContaining({ image: "core:new" }),
      "ams",
    );
    expect(machines.destroyMachine).toHaveBeenCalledExactlyOnceWith("core-1", undefined);
    expect(machines.deleteVolume).not.toHaveBeenCalled();
  });

  it("creates a core with no old one to retire", async () => {
    const { recovery, machines } = setup();

    await expect(recovery.recreate(undefined, deployed, undefined)).resolves.toBe("recreated");

    expect(machines.refreshLease).not.toHaveBeenCalled();
    expect(machines.createMachine).toHaveBeenCalledOnce();
    expect(machines.destroyMachine).not.toHaveBeenCalled();
    expect(machines.deleteVolume).not.toHaveBeenCalled();
  });

  it("does not wait for the old volume's deletion", async () => {
    const { recovery, machines } = setup();
    machines.deleteVolume.mockReturnValueOnce(new Promise(() => undefined));

    await expect(recovery.recreate(oldCore, deployed, "nonce-1")).resolves.toBe("recreated");
    expect(machines.deleteVolume).toHaveBeenCalledExactlyOnceWith("vol_old");
  });

  it("keeps the old core when Europe has no room for a new volume", async () => {
    const { recovery, machines } = setup();
    machines.createVolume.mockRejectedValueOnce(
      capacity("/volumes", 412, { error: "no room", status: "volume_placement_capacity" }),
    );

    await expect(recovery.recreate(oldCore, deployed, "nonce-1")).resolves.toBe("no_capacity");

    expect(machines.createMachine).not.toHaveBeenCalled();
    expect(machines.destroyMachine).not.toHaveBeenCalled();
  });

  it("deletes the new volume when the Machine cannot be created", async () => {
    const { recovery, machines } = setup();
    machines.createMachine.mockRejectedValueOnce(
      capacity("/machines", 422, { error: "no capacity", status: "insufficient_capacity" }),
    );

    await expect(recovery.recreate(oldCore, deployed, "nonce-1")).resolves.toBe("no_capacity");

    expect(machines.deleteVolume).toHaveBeenCalledExactlyOnceWith("vol_new");
    expect(machines.destroyMachine).not.toHaveBeenCalled();
  });

  it.each([
    [
      "its setup failed",
      newCore({
        containers: [
          {
            name: "setup",
            state: "stopped",
            events: [{ type: "exited", exit_code: 1, timestamp: startedAt + 5 }],
          },
        ],
      }),
    ],
    ["it never answers", newCore()],
  ])("removes a new core that is not healthy because %s, and keeps the old one", async (_case, machine) => {
    const { recovery, machines } = setup({ probes: [] });
    machines.getMachine.mockResolvedValue(machine);

    await expect(recovery.recreate(oldCore, deployed, "nonce-1")).rejects.toThrow();

    expect(machines.destroyMachine).toHaveBeenCalledExactlyOnceWith("core-2");
    expect(machines.deleteVolume).toHaveBeenCalledExactlyOnceWith("vol_new");
  });

  it("keeps the volume of an unhealthy new core that could not be destroyed", async () => {
    const { recovery, machines } = setup({ probes: [] });
    machines.destroyMachine.mockRejectedValueOnce(new Error("Machines API down"));

    await expect(recovery.recreate(oldCore, deployed, "nonce-1")).rejects.toThrow();

    expect(machines.destroyMachine).toHaveBeenCalledExactlyOnceWith("core-2");
    expect(machines.deleteVolume).not.toHaveBeenCalled();
  });
});
