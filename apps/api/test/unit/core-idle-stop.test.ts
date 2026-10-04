import { coreIdleStatusSchema } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { fastify } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerCoreIdleRoutes } from "../../src/routes/core-idle-routes.js";
import type { ApiFastifyInstance } from "../../src/runtime/fastify.js";
import { CoreIdleStop, coreIdleStopAfterMs } from "../../src/services/core-idle-stop.js";

function createIdleStop(options: { runInProgress?: boolean } = {}) {
  const clock = { now: 1_000_000 };
  const runs = { hasNonterminalRun: vi.fn(async () => options.runInProgress ?? false) };
  const stopCore = vi.fn(async () => undefined);
  const idleStop = new CoreIdleStop({
    runs,
    stopCore,
    logger: createSilentLogger("api"),
    now: () => clock.now,
  });
  return { idleStop, runs, stopCore, clock };
}

describe("core idle stop", () => {
  it("stops the core 10 minutes after the last activity, not before", async () => {
    const { idleStop, stopCore, clock } = createIdleStop();
    clock.now += 4 * 60_000;
    idleStop.recordActivity();
    expect(idleStop.status()).toEqual({ state: "awake", sleepsInSeconds: 600 });

    clock.now += coreIdleStopAfterMs - 1_000;
    await idleStop.check();
    expect(idleStop.status()).toEqual({ state: "awake", sleepsInSeconds: 1 });
    expect(stopCore).not.toHaveBeenCalled();

    clock.now += 1_000;
    await idleStop.check();
    expect(stopCore).toHaveBeenCalledTimes(1);
  });

  it("never stops during a nonterminal run, and restarts the countdown when it ends", async () => {
    const { idleStop, runs, stopCore, clock } = createIdleStop({ runInProgress: true });
    clock.now += 2 * coreIdleStopAfterMs;
    await idleStop.check();
    expect(stopCore).not.toHaveBeenCalled();
    expect(idleStop.status()).toEqual({ state: "run_in_progress" });

    runs.hasNonterminalRun.mockResolvedValue(false);
    clock.now += 5_000;
    await idleStop.check();
    expect(stopCore).not.toHaveBeenCalled();
    expect(idleStop.status()).toEqual({ state: "awake", sleepsInSeconds: 595 });
  });
});

describe("core idle routes", () => {
  it("serves the status without counting it, and counts a stay-awake request", async () => {
    const { idleStop, clock } = createIdleStop();
    const app = fastify() as unknown as ApiFastifyInstance;
    registerCoreIdleRoutes(app, { coreIdleShutdown: idleStop });
    clock.now += 3 * 60_000;

    const status = await app.inject({ method: "GET", url: "/core/idle-status" });
    expect(coreIdleStatusSchema.parse(status.json())).toEqual({
      state: "awake",
      sleepsInSeconds: 420,
    });

    const stayAwake = await app.inject({ method: "POST", url: "/core/activity" });
    expect(coreIdleStatusSchema.parse(stayAwake.json())).toEqual({
      state: "awake",
      sleepsInSeconds: 600,
    });
    await app.close();
  });
});
