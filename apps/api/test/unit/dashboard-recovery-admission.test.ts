import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it } from "vitest";
import { DashboardRecoveryAdmissionService } from "../../src/services/dashboard-recovery-admission.js";

describe("dashboard recovery admission", () => {
  it("guards local concurrency and releases permits idempotently", async () => {
    const service = createService({ maxConcurrent: 1 });
    const first = await service.admit("visitor:first");
    expect(first.outcome).toBe("admitted");
    expect((await service.admit("visitor:second")).outcome).toBe("at_capacity");
    if (first.outcome === "admitted") {
      first.release();
      first.release();
    }
    expect((await service.admit("visitor:second")).outcome).toBe("admitted");
  });

  it("enforces the per-source request budget", async () => {
    const service = createService({ perSourceMax: 2 });

    await admitAndRelease(service, "visitor:one");
    await admitAndRelease(service, "visitor:one");

    expect((await service.admit("visitor:one")).outcome).toBe("rate_limited");
    expect((await service.admit("visitor:two")).outcome).toBe("admitted");
  });

  it("bounds source accounting by the global budget and resets it on a later window", async () => {
    let now = new Date(61_000);
    const service = createService({
      globalMax: 2,
      perSourceMax: 2,
      now: () => now,
    });

    await admitAndRelease(service, "visitor:one");
    await admitAndRelease(service, "visitor:two");
    expect((await service.admit("visitor:three")).outcome).toBe("rate_limited");

    now = new Date(121_000);
    expect((await service.admit("visitor:three")).outcome).toBe("admitted");
  });

  it("does not roll the active budget backward when the clock moves to an earlier window", async () => {
    let now = new Date(121_000);
    const service = createService({ perSourceMax: 1, now: () => now });

    await admitAndRelease(service, "visitor:one");
    now = new Date(61_000);

    expect((await service.admit("visitor:one")).outcome).toBe("rate_limited");
  });

  it("rejects an already-aborted request without consuming admission capacity or budget", async () => {
    const service = createService({ maxConcurrent: 1, globalMax: 1, perSourceMax: 1 });
    const controller = new AbortController();
    controller.abort(new Error("client disconnected"));

    await expect(service.admit("visitor:one", controller.signal)).rejects.toThrow(
      "client disconnected",
    );
    expect((await service.admit("visitor:one")).outcome).toBe("admitted");
  });
});

function createService(
  overrides: Partial<ConstructorParameters<typeof DashboardRecoveryAdmissionService>[0]> = {},
) {
  return new DashboardRecoveryAdmissionService({
    maxConcurrent: 3,
    globalMax: 10,
    perSourceMax: 2,
    windowSeconds: 60,
    logger: createSilentLogger("api"),
    ...overrides,
  });
}

async function admitAndRelease(service: DashboardRecoveryAdmissionService, sourceKey: string) {
  const admission = await service.admit(sourceKey);
  expect(admission.outcome).toBe("admitted");
  if (admission.outcome === "admitted") admission.release();
}
