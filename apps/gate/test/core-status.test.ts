import type { FlyMachine } from "@checkout-surge/fly-machines";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { findCoreMachine } from "../src/core-machine.js";
import {
  type CoreStatus,
  CoreStatusCache,
  type ProbeResult,
  readCoreStatus,
} from "../src/core-status.js";
import { coreMachine } from "./core-machine-fixture.js";

const ready = { state: "ready" as const, target: "http://[fdaa::5]:8080" };

function read(machines: FlyMachine[], probeResult: ProbeResult = "ready", previous?: CoreStatus) {
  const probe = vi.fn(async () => probeResult);
  return {
    probe,
    status: readCoreStatus({ machines: { listMachines: async () => machines }, probe, previous }),
  };
}

const startedAt = 1_000_000;
const started = (containerEvents: { type: string; exit_code?: number; timestamp: number }[] = []) =>
  coreMachine({
    state: "started",
    events: [{ type: "start", status: "started", timestamp: startedAt }],
    containers: [{ name: "setup", state: "stopped", events: containerEvents }],
  });

describe("readCoreStatus", () => {
  it("relays to the core's Caddy on its 6PN address once it answers the readiness probe", async () => {
    const { probe, status } = read([started()]);

    await expect(status).resolves.toEqual({ state: "ready", target: "http://[fdaa::5]:8080" });
    expect(probe).toHaveBeenCalledWith("http://[fdaa::5]:8080");
  });

  it("shows the core as booting until its Caddy answers", async () => {
    await expect(read([coreMachine({ state: "starting" })]).status).resolves.toEqual({
      state: "booting",
    });
    await expect(read([started()], "no_answer").status).resolves.toEqual({ state: "booting" });
  });

  it("keeps a ready core that gives no answer, but not one that answers not ready", async () => {
    await expect(read([started()], "no_answer", ready).status).resolves.toEqual(ready);
    await expect(read([started()], "not_ready", ready).status).resolves.toEqual({
      state: "booting",
    });
  });

  it("maps the other Machine states to their pages", async () => {
    const states = await Promise.all(
      ["stopped", "stopping", "replacing", "destroyed"].map(
        async (state) => (await read([coreMachine({ state })]).status).state,
      ),
    );

    expect(states).toEqual(["stopped", "stopped", "updating", "unavailable"]);
    // No core listed: the start button creates one.
    await expect(read([]).status).resolves.toEqual({ state: "stopped" });
  });

  it("among several cores, skips one that cannot serve for the one that can", async () => {
    const find = (machines: FlyMachine[]) =>
      findCoreMachine({ listMachines: async () => machines }).then((machine) => machine?.id);
    const deadButStarted = coreMachine({
      id: "core-old",
      state: "started",
      host_status: "unreachable",
    });
    const recreated = coreMachine({ id: "core-new", created_at: "2026-10-05T10:00:00Z" });
    const failedSetup = coreMachine({
      ...started([{ type: "exited", exit_code: 1, timestamp: startedAt + 5 }]),
      id: "core-newer",
      created_at: "2026-10-06T10:00:00Z",
    });

    await expect(find([deadButStarted, recreated])).resolves.toBe("core-new");
    await expect(find([failedSetup, deadButStarted, recreated])).resolves.toBe("core-new");
    await expect(find([deadButStarted])).resolves.toBe("core-old");
  });

  it("offers the start button for a core on a dead host, so a visitor can recreate it", async () => {
    const onDeadHost = coreMachine({ state: "started", host_status: "unreachable" });

    await expect(read([onDeadHost]).status).resolves.toEqual({ state: "stopped" });
  });

  it("reports a setup that failed since the latest start, not an older failure", async () => {
    const failedNow = read([started([{ type: "exited", exit_code: 1, timestamp: startedAt + 5 }])]);
    const failedBefore = read([
      started([
        { type: "started", timestamp: startedAt + 3 },
        { type: "exited", exit_code: 1, timestamp: startedAt - 60_000 },
      ]),
    ]);

    await expect(failedNow.status).resolves.toEqual({ state: "setup_failed" });
    expect(failedNow.probe).not.toHaveBeenCalled();
    await expect(failedBefore.status).resolves.toMatchObject({ state: "ready" });
  });
});

describe("CoreStatusCache", () => {
  function setup(statuses: CoreStatus[]) {
    let clock = 0;
    const read = vi.fn(async () => statuses.shift() ?? { state: "unavailable" as const });
    const cache = new CoreStatusCache({
      read,
      logger: createSilentLogger("gate"),
      now: () => clock,
    });
    return { cache, read, advance: (ms: number) => (clock += ms) };
  }

  it("keeps a ready status for 10 s and any other status for 2 s", async () => {
    const { cache, read, advance } = setup([{ state: "booting" }, ready, { state: "stopped" }]);

    await expect(cache.current()).resolves.toEqual({ state: "booting" });
    advance(1_999);
    await expect(cache.current()).resolves.toEqual({ state: "booting" });
    advance(1);
    await expect(cache.current()).resolves.toEqual(ready);
    advance(9_999);
    await expect(cache.current()).resolves.toEqual(ready);
    advance(1);
    await expect(cache.current()).resolves.toEqual({ state: "stopped" });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("re-reads after an invalidation, discarding a read already in flight", async () => {
    let finishStaleRead: (status: CoreStatus) => void = () => undefined;
    const { cache, read } = setup([]);
    read.mockImplementationOnce(() => new Promise((resolve) => (finishStaleRead = resolve)));
    read.mockResolvedValueOnce({ state: "booting" });

    const stale = cache.current();
    cache.invalidate();
    finishStaleRead({ state: "stopped" });

    await expect(stale).resolves.toEqual({ state: "stopped" });
    await expect(cache.current()).resolves.toEqual({ state: "booting" });
    await expect(cache.current()).resolves.toEqual({ state: "booting" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps relaying to a ready core while the Machines API fails", async () => {
    const { cache, read, advance } = setup([ready]);
    await cache.current();
    advance(10_000);
    read.mockRejectedValueOnce(new Error("Machines API down"));

    await expect(cache.current()).resolves.toEqual(ready);
    expect(read).toHaveBeenLastCalledWith(ready);
  });

  it("shows the core as unavailable when the Machines API fails", async () => {
    const { cache, read } = setup([]);
    read.mockRejectedValueOnce(new Error("Machines API down"));

    await expect(cache.current()).resolves.toEqual({ state: "unavailable" });
  });
});
