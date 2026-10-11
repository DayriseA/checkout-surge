import { describe, expect, it } from "vitest";
import { comparisonWorkloads } from "../../src/services/comparison-workloads.js";

describe("fixed comparison workloads", () => {
  it("keeps each pair matched and returns independent immutable acceptance snapshots", () => {
    const workloads = comparisonWorkloads();
    expect(workloads.map((stage) => stage.executionMode)).toEqual([
      "demo",
      "without_redis",
      "demo",
      "without_order_queue",
    ]);
    expect(workloads[0].snapshot).toEqual(workloads[1].snapshot);
    expect(workloads[2].snapshot).toEqual(workloads[3].snapshot);
    expect(workloads[0].snapshot.trafficConfig).toMatchObject({
      mode: "constant-arrival-rate",
      ratePerSecond: 1000,
      durationSeconds: 10,
      k6Vus: { preAllocatedVus: 10000, maxVus: 10000 },
    });
    expect(workloads[2].snapshot).toMatchObject({
      trafficConfig: { mode: "buyer-spike", buyerCount: 5000, maxDurationSeconds: 80 },
      inventoryConfig: { startingStock: 500 },
      erpConfig: { latencyMs: 100, maxTps: 20 },
    });
    workloads[0].snapshot.inventoryConfig.startingStock = 42;
    expect(workloads[1].snapshot.inventoryConfig.startingStock).toBe(1);
    expect(comparisonWorkloads()[0].snapshot.inventoryConfig.startingStock).toBe(1);
  });
});
