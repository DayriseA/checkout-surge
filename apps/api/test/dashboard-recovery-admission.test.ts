import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import {
  DashboardRecoveryAdmissionService,
  type DashboardRecoveryBudgetStore,
  RedisDashboardRecoveryBudgetStore,
} from "../src/services/dashboard-recovery-admission.js";

describe("dashboard recovery admission", () => {
  it("guards local concurrency and releases permits idempotently", async () => {
    const store: DashboardRecoveryBudgetStore = { admit: async () => "allowed" };
    const service = createService(store, 1);
    const first = await service.admit("visitor:first");
    expect(first.outcome).toBe("admitted");
    expect((await service.admit("visitor:second")).outcome).toBe("at_capacity");
    if (first.outcome === "admitted") {
      first.release();
      first.release();
    }
    expect((await service.admit("visitor:second")).outcome).toBe("admitted");
  });

  it("fails closed on shared-store errors and maps either budget denial", async () => {
    expect((await createService({ admit: async () => "source" }, 2).admit("source")).outcome).toBe(
      "rate_limited",
    );
    expect((await createService({ admit: async () => "global" }, 2).admit("source")).outcome).toBe(
      "rate_limited",
    );
    expect(
      (
        await createService(
          {
            admit: async () => {
              throw new Error("redis down");
            },
          },
          2,
        ).admit("source")
      ).outcome,
    ).toBe("unavailable");
  });

  it("uses bounded hashed fixed-window keys, TTL, and rolls windows deterministically", async () => {
    const calls: unknown[][] = [];
    const store = new RedisDashboardRecoveryBudgetStore(() => ({
      eval: async (...args: unknown[]) => {
        calls.push(args);
        return "allowed";
      },
      disconnect: () => undefined,
    }));
    const sourceKey = "visitor:raw-sensitive-id";
    for (const now of [new Date(61_000), new Date(121_000)]) {
      await store.admit({ sourceKey, globalMax: 10, perSourceMax: 2, windowSeconds: 60, now });
    }
    expect(String(calls[0]?.[3])).toContain("{1}");
    expect(String(calls[1]?.[3])).toContain("{2}");
    expect(String(calls[0]?.[3])).not.toContain(sourceKey);
    expect(String(calls[0]?.[3])).toMatch(/source:[0-9a-f]{64}$/);
    expect(calls[0]?.slice(-3)).toEqual([10, 2, 120]);
  });

  it("uses one atomic eval so concurrent attempts cannot exceed the shared budget", async () => {
    let global = 0;
    const store = new RedisDashboardRecoveryBudgetStore(() => ({
      eval: async (...args: unknown[]) => {
        const globalMax = Number(args.at(-3));
        if (global >= globalMax) return "global";
        global += 1;
        return "allowed";
      },
      disconnect: () => undefined,
    }));
    const attempts = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        store.admit({
          sourceKey: `visitor:${index}`,
          globalMax: 2,
          perSourceMax: 2,
          windowSeconds: 60,
          now: new Date(0),
        }),
      ),
    );
    expect(attempts.filter((outcome) => outcome === "allowed")).toHaveLength(2);
    expect(attempts.filter((outcome) => outcome === "global")).toHaveLength(2);
  });

  it("disconnects a never-settling limiter operation when admission is abandoned", async () => {
    const disconnect = vi.fn();
    const store = new RedisDashboardRecoveryBudgetStore(() => ({
      eval: async () => await new Promise<never>(() => undefined),
      disconnect,
    }));
    const controller = new AbortController();
    const admission = store.admit({
      sourceKey: "visitor:abandoned",
      globalMax: 2,
      perSourceMax: 2,
      windowSeconds: 60,
      now: new Date(0),
      signal: controller.signal,
    });

    controller.abort(new Error("client disconnected"));

    await expect(admission).rejects.toThrow("client disconnected");
    expect(disconnect).toHaveBeenCalled();
  });
});

function createService(store: DashboardRecoveryBudgetStore, maxConcurrent: number) {
  return new DashboardRecoveryAdmissionService({
    store,
    maxConcurrent,
    globalMax: 10,
    perSourceMax: 2,
    windowSeconds: 60,
    logger: createSilentLogger("api"),
  });
}
