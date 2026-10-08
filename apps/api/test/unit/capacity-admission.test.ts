import { readFileSync } from "node:fs";
import type { AcceptedRunConfigSnapshot, TrafficConfig } from "@checkout-surge/contracts";
import { buildSeedPresets } from "@checkout-surge/db";
import { describe, expect, it, vi } from "vitest";
import { loadApiConfig } from "../../src/runtime/config.js";
import {
  assessCapacity,
  type DeploymentCapacity,
  requireCapacityAdmission,
  withResolvedConstantArrivalVus,
} from "../../src/services/capacity-admission.js";

const baseEnv = {
  NODE_ENV: "test" as const,
  DATABASE_URL: "postgresql://localhost/test",
  REDIS_URL: "redis://localhost:6379",
  CONTROL_SERVICE_TOKEN: "deployment-token",
  PUBLIC_CLIENT_COOKIE_SECRET: "test-public-cookie-secret",
};

function repoFile(path: string): string {
  return readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");
}

/** The deployed values, read from the files that set them. */
function flyCapacity(): DeploymentCapacity {
  const machine = JSON.parse(repoFile("infra/fly/core/machine.json")) as {
    containers: { name: string; env: Record<string, string> }[];
  };
  const apiEnv = machine.containers.find((container) => container.name === "api")?.env ?? {};
  const capacityEnv = Object.entries(apiEnv).filter(([name]) => name.startsWith("CAPACITY_"));
  expect(capacityEnv).toHaveLength(6);
  return loadApiConfig({ ...baseEnv, ...Object.fromEntries(capacityEnv) }).deploymentCapacity;
}

function localCapacity(): DeploymentCapacity {
  const composeDefaults = Object.fromEntries(
    [...repoFile("docker-compose.yml").matchAll(/^\s+(CAPACITY_\w+): \$\{\1:-([^}]+)\}$/gm)].map(
      ([, name, value]) => [name, value],
    ),
  );
  expect(Object.keys(composeDefaults)).toHaveLength(6);
  return loadApiConfig({ ...baseEnv, ...composeDefaults }).deploymentCapacity;
}

const fly = flyCapacity();
const local = localCapacity();

/** Every suggested cutoff admitted: the service decides that with the estimate and the limits. */
function assess(snapshot: AcceptedRunConfigSnapshot, capacity: DeploymentCapacity) {
  return assessCapacity(snapshot, capacity, () => true);
}

function constantArrival(rate: number, durationSeconds: number, startingStock: number) {
  return snapshot(
    {
      mode: "constant-arrival-rate",
      ratePerSecond: rate,
      durationSeconds,
      startDelaySeconds: 0,
      quantityPerAttempt: 1,
    },
    startingStock,
  );
}

function buyerSpike(buyers: number, cutoffSeconds: number, startingStock: number) {
  return snapshot(
    {
      mode: "buyer-spike",
      buyerCount: buyers,
      maxDurationSeconds: cutoffSeconds,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      quantityPerAttempt: 1,
    },
    startingStock,
  );
}

function snapshot(trafficConfig: TrafficConfig, startingStock: number): AcceptedRunConfigSnapshot {
  return {
    trafficConfig,
    inventoryConfig: { startingStock },
    erpConfig: { latencyMs: 0, maxTps: 1000, errorRate: 0, forcedOutage: false },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 10,
    },
  };
}

describe("capacity-aware admission model", () => {
  it("reads both deployments' values from their configuration files", () => {
    expect(fly).toEqual({
      constantArrivalSoldOutPerSecond: 3_500,
      constantArrivalAcceptedPerSecond: 240,
      constantArrivalAcceptedOrderCost: 7,
      buyerSpikeSoldOutPerSecond: 2_600,
      buyerSpikeAcceptedPerSecond: 240,
      vuLatencyBudgetSeconds: 3,
    });
    // The Compose defaults are the API's own defaults.
    expect(local).toEqual(loadApiConfig(baseEnv).deploymentCapacity);
    expect(local).toMatchObject({
      constantArrivalSoldOutPerSecond: 3_000,
      constantArrivalAcceptedOrderCost: 15,
    });
  });

  it.each([
    ["fly", fly, 2_800, 3_500],
    ["local", local, 2_400, 3_000],
  ])("classifies a sold-out constant-arrival run at its boundaries (%s)", (_, capacity, completeAt, limitAt) => {
    const verdictAt = (rate: number) => assess(constantArrival(rate, 10, 0), capacity).verdict;
    expect(verdictAt(completeAt)).toBe("expected_to_complete");
    expect(verdictAt(completeAt + 1)).toBe("at_the_limit");
    expect(verdictAt(limitAt)).toBe("at_the_limit");
    expect(verdictAt(limitAt + 1)).toBe("expected_to_fail");
  });

  it.each([
    // Fly: each accepted order costs 6 more sold-out answers, spread over 10 s.
    ["fly", fly, 2_200],
    ["local", local, 1_000],
  ])("charges the stock the run can sell to the API (%s)", (_, capacity, largestCompletingRate) => {
    const verdictAt = (rate: number) => assess(constantArrival(rate, 10, 1_000), capacity).verdict;
    expect(verdictAt(largestCompletingRate)).toBe("expected_to_complete");
    expect(verdictAt(largestCompletingRate + 1)).toBe("at_the_limit");
  });

  it("spreads the orders' cost over at most the measured 10 s, and over shorter runs entirely", () => {
    const verdictAt = (rate: number, durationSeconds: number) =>
      assess(constantArrival(rate, durationSeconds, 1_000), fly).verdict;
    expect(verdictAt(2_200, 30)).toBe("expected_to_complete");
    expect(verdictAt(2_201, 30)).toBe("at_the_limit");
    // 5 s: 1,000 orders × 6 / 5 s = 1,200 more answers per second.
    expect(verdictAt(1_600, 5)).toBe("expected_to_complete");
    expect(verdictAt(1_601, 5)).toBe("at_the_limit");
  });

  it("fails a run whose orders the database pool cannot answer before k6 stops waiting", () => {
    // Without the API cost, only the pool decides: 240 orders/s × (10 s + 30 s graceful stop).
    const poolOnly = { ...fly, constantArrivalAcceptedOrderCost: 1 };
    expect(assess(constantArrival(1_000, 10, 9_600), poolOnly)).toMatchObject({
      verdict: "expected_to_complete",
      poolOrderLimit: 9_600,
    });
    expect(assess(constantArrival(1_000, 10, 9_601), poolOnly).verdict).toBe("expected_to_fail");
  });

  it.each([
    ["fly", fly, 124_800, 156_000],
    ["local", local, 55_200, 69_000],
  ])("judges a sold-out buyer spike against at most k6's 60 s timeout (%s)", (_, capacity, completeAt, limitAt) => {
    const verdictAt = (buyers: number, cutoffSeconds: number) =>
      assess(buyerSpike(buyers, cutoffSeconds, 0), capacity).verdict;
    expect(verdictAt(completeAt, 120)).toBe("expected_to_complete");
    expect(verdictAt(completeAt + 1, 120)).toBe("at_the_limit");
    expect(verdictAt(limitAt, 120)).toBe("at_the_limit");
    expect(verdictAt(limitAt + 1, 120)).toBe("expected_to_fail");
    // A shorter cutoff is the window instead.
    expect(verdictAt(completeAt / 2, 30)).toBe("expected_to_complete");
    expect(verdictAt(completeAt / 2 + 1, 30)).toBe("at_the_limit");
  });

  it("serves a spike's accepted orders at the pool's pace", () => {
    // Fly, stock 1,000: 1,000 / 240 + 9,000 / 2,600 ≈ 7.63 s for 10,000 buyers.
    const assessment = assess(buyerSpike(10_000, 10, 1_000), fly);
    expect(assessment).toMatchObject({ verdict: "expected_to_complete", windowSeconds: 10 });
    expect(assessment).not.toHaveProperty("fit");
    expect(assess(buyerSpike(10_000, 9, 1_000), fly).verdict).toBe("at_the_limit");
  });

  it("reports the largest settings that would complete", () => {
    expect(assess(constantArrival(2_000, 10, 2_000), fly)).toMatchObject({
      verdict: "at_the_limit",
      acceptedOrders: 2_000,
      loadPerSecond: 3_200,
      fit: { ratePerSecond: 1_600, startingStock: 1_333 },
    });
    // The orders alone exceed the completion share: no stock below 1,000 fixes the rate.
    expect(assess(constantArrival(3_000, 10, 1_000), fly)).toMatchObject({
      verdict: "expected_to_fail",
      fit: { ratePerSecond: 2_200, startingStock: null },
    });
    expect(assess(buyerSpike(10_000, 9, 1_000), fly)).toMatchObject({
      fit: { buyerCount: 8_886, startingStock: 886, maxDurationSeconds: 10 },
    });
    // Past k6's 60 s timeout, no cutoff helps.
    expect(assess(buyerSpike(10_000, 120, 10_000), local)).toMatchObject({
      verdict: "expected_to_fail",
      fit: { maxDurationSeconds: null },
    });
    // A cutoff the run would not be admitted with is no suggestion; it is checked once.
    const admitsCutoff = vi.fn(() => false);
    expect(assessCapacity(buyerSpike(10_000, 9, 1_000), fly, admitsCutoff)).toMatchObject({
      fit: { buyerCount: 8_886, startingStock: 886, maxDurationSeconds: null },
    });
    expect(admitsCutoff.mock.calls).toEqual([[10]]);
  });

  it("classifies every public preset as expected to complete on both deployments", () => {
    const publicPresets = buildSeedPresets().filter((preset) => preset.visibility === "public");
    expect(publicPresets.length).toBeGreaterThan(0);
    for (const capacity of [fly, local]) {
      for (const preset of publicPresets) {
        expect([preset.slug, assess(preset, capacity).verdict]).toEqual([
          preset.slug,
          "expected_to_complete",
        ]);
      }
    }
  });

  it("refuses only runs not expected to complete", () => {
    expect(() =>
      requireCapacityAdmission(assess(constantArrival(2_800, 10, 0), fly)),
    ).not.toThrow();
    expect(() => requireCapacityAdmission(assess(constantArrival(2_801, 10, 0), fly))).toThrow(
      expect.objectContaining({ code: "estimated_capacity_rejected" }),
    );
  });
});

describe("default constant-arrival VUs", () => {
  const caps = { maxPreAllocatedVus: 10_000, maxVus: 10_000 };

  it("pre-allocates the rate times the latency budget, within the deployment's VU caps", () => {
    const vusFor = (rate: number, budget: number, vuCaps = caps) => {
      const traffic = withResolvedConstantArrivalVus(
        constantArrival(rate, 10, 0),
        budget,
        vuCaps,
      ).trafficConfig;
      return traffic.mode === "constant-arrival-rate" ? traffic.k6Vus : undefined;
    };
    expect(vusFor(500, 3)).toEqual({ preAllocatedVus: 1_500, maxVus: 1_500 });
    expect(vusFor(333, 2.5)).toEqual({ preAllocatedVus: 833, maxVus: 833 });
    expect(vusFor(5_000, 3)).toEqual({ preAllocatedVus: 10_000, maxVus: 10_000 });
    expect(vusFor(5_000, 3, { maxPreAllocatedVus: 8_000, maxVus: 9_000 })).toEqual({
      preAllocatedVus: 8_000,
      maxVus: 8_000,
    });
  });

  it("keeps explicit VUs and buyer spikes as they are", () => {
    const explicit = constantArrival(500, 10, 0);
    if (explicit.trafficConfig.mode === "constant-arrival-rate") {
      explicit.trafficConfig.k6Vus = { preAllocatedVus: 10, maxVus: 20 };
    }
    expect(withResolvedConstantArrivalVus(explicit, 3, caps)).toBe(explicit);
    const spike = buyerSpike(1_000, 30, 500);
    expect(withResolvedConstantArrivalVus(spike, 3, caps)).toBe(spike);
  });
});
