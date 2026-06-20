import { afterEach, describe, expect, it, vi } from "vitest";
import { getDashboardBackendSnapshot } from "../src/app/lib/api.js";

describe("dashboard backend API reads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns unavailable snapshots when backend reads fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("backend offline");
      }),
    );

    const snapshot = await getDashboardBackendSnapshot();

    expect(snapshot.liveness).toMatchObject({
      status: "unavailable",
      reason: "backend offline",
    });
    expect(snapshot.readiness).toMatchObject({
      status: "unavailable",
      reason: "backend offline",
    });
    expect(snapshot.recovery).toMatchObject({
      status: "unavailable",
      reason: "backend offline",
    });
  });
});
