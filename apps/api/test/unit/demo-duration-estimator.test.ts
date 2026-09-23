import {
  type AcceptedRunConfigSnapshot,
  conservativeDurationEstimatorIdentity,
  type EstimatorInput,
  erpDispatchEnginePolicyIdentity,
  estimatorInputSchema,
  estimatorResultSchema,
} from "@checkout-surge/contracts";
import { acceptanceScenarioFixtures } from "@checkout-surge/contracts/testing";
import { describe, expect, it, vi } from "vitest";
import { estimatorInputFromSnapshot as fromConfig } from "../../src/services/demo-duration-admission-service.js";
import {
  conservativeDurationEstimatorConstants as constants,
  effectiveEstimatorWorkerConcurrency,
  estimateDemoDuration,
} from "../../src/services/demo-duration-estimator.js";

// Capture the actual seed definitions without connecting to PostgreSQL or Redis.
const { seededPresets } = vi.hoisted(() => ({
  seededPresets: [] as (AcceptedRunConfigSnapshot & { slug: string; visibility: string })[],
}));
vi.mock("../../../../packages/db/src/scripts/env.js", () => ({
  requireEnv: () => "unused",
  optionalIntegerEnv: (_name: string, fallback: number) => fallback,
  optionalNumberEnv: (_name: string, fallback: number) => fallback,
}));
vi.mock("../../../../packages/db/src/client.js", () => ({
  createDatabaseConnection: () => ({
    close: async () => {},
    db: {
      transaction: async (run: (tx: unknown) => Promise<void>) =>
        run({
          insert: () => ({
            values: (value: (typeof seededPresets)[number]) => {
              if (value.slug && value.trafficConfig) seededPresets.push(value);
              return { onConflictDoUpdate: async () => {}, onConflictDoNothing: async () => {} };
            },
          }),
        }),
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ id: "unused", allocatedStock: 1000 }] }),
        }),
      }),
    },
  }),
}));
vi.mock("../../../../packages/db/src/redis.js", () => ({
  createRedisClient: () => ({ connect: async () => {}, disconnect: () => {} }),
}));
vi.mock("../../../../packages/db/src/redis-inventory.js", () => ({
  initializeInventory: async () => {},
}));

function input(overrides: Partial<EstimatorInput> = {}): EstimatorInput {
  return estimatorInputSchema.parse({
    trafficConfig: { mode: "constant-arrival-rate", ratePerSecond: 10, durationSeconds: 10 },
    inventoryConfig: { startingStock: 60 },
    effectiveWorkerConcurrency: 5,
    declaredErpCapacityPerSecond: 5,
    declaredErpLatencyMs: 200,
    ...overrides,
  });
}

function estimate(value: EstimatorInput, ceiling = 600) {
  const before = structuredClone(value);
  const result = estimateDemoDuration(value, ceiling);
  expect(value).toEqual(before);
  expect(estimatorResultSchema.parse(result)).toEqual(result);
  expect(result.estimatorIdentity).toEqual(conservativeDurationEstimatorIdentity);
  expect(result.policyIdentity).toEqual(erpDispatchEnginePolicyIdentity);
  return result;
}

describe("pure conservative duration estimator", () => {
  it("admits the real acceptance fixtures and every seeded preset", async () => {
    await import("../../../../packages/db/src/scripts/seed.js");
    expect(seededPresets.filter((preset) => preset.visibility === "public")).toHaveLength(7);
    for (const preset of seededPresets) {
      const result = estimate(fromConfig(preset));
      expect(result.decision, preset.slug).toBe("admitted");
      if (preset.slug === "slow-erp-5k") expect(result.bottleneck).toBe("erp_capacity");
      if (preset.slug === "laggy-erp-5k") expect(result.bottleneck).toBe("erp_latency");
      if (preset.slug === "admin-failure-path") {
        expect(preset.inventoryConfig.startingStock).toBe(200);
        expect(result.conservativeDurationSeconds).toBeCloseTo(179.25, 8);
        expect(result.conservativeDurationSeconds).toBeLessThan(200);
      }
    }
    for (const fixture of acceptanceScenarioFixtures()) {
      const config =
        fixture.config ?? seededPresets.find((preset) => preset.slug === fixture.presetSlug);
      expect(config, fixture.name).toBeDefined();
      if (!config) throw new Error(`Missing configuration: ${fixture.name}`);
      expect(estimate(fromConfig(config)).decision, fixture.name).toBe("admitted");
    }
    const incident = acceptanceScenarioFixtures()[0]?.config;
    const reference = acceptanceScenarioFixtures().find(
      (fixture) => fixture.name === "concurrency-saturation-reference",
    )?.config;
    if (!incident || !reference) throw new Error("Missing sanity references");
    // Capacity-only references remain historical; the refitted full-job rate
    // makes the calibration run's sequential base 148 s before settlement.
    expect(60 + incident.inventoryConfig.startingStock / incident.erpConfig.maxTps).toBe(148.8);
    expect(120 + reference.inventoryConfig.startingStock / reference.erpConfig.maxTps).toBe(124);
    expect(estimate(fromConfig(incident)).explanatoryDurationSeconds).toBe(88.8);
    const referenceInput = fromConfig(reference);
    const referenceRate = Math.min(
      referenceInput.declaredErpCapacityPerSecond,
      referenceInput.effectiveWorkerConcurrency /
        ((referenceInput.declaredErpLatencyMs + constants.latencyOverheadFloorMs) / 1000),
    );
    expect(120 + reference.inventoryConfig.startingStock / referenceRate).toBe(148);
    expect(estimate(referenceInput).explanatoryDurationSeconds).toBe(120);
  });

  it("covers task 17b’s five measured finalization times", async () => {
    await import("../../../../packages/db/src/scripts/seed.js");
    const reference = acceptanceScenarioFixtures().find(
      (fixture) => fixture.name === "concurrency-saturation-reference",
    )?.config;
    if (!reference) throw new Error("Missing calibration reference");
    const incident = acceptanceScenarioFixtures()[0]?.config;
    if (!incident) throw new Error("Missing incident");
    const spike = input({
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 300,
        duplicateEachBuyerAttempt: true,
        maxDurationSeconds: 10,
        startDelaySeconds: 0,
        quantityPerAttempt: 1,
      },
      inventoryConfig: { startingStock: 300 },
      declaredErpCapacityPerSecond: 100,
      declaredErpLatencyMs: 50,
      effectiveWorkerConcurrency: 10,
    });
    for (const [scenario, observed, expected] of [
      [input(), 15.252, 37.631578947368425],
      [fromConfig(incident), 96.693, 168.4736842105263],
      [spike, 8.075, 30.4],
      [
        input({
          declaredErpCapacityPerSecond: 10,
          declaredErpLatencyMs: 100,
          errorRateAssumption: 0.2,
        }),
        20.894,
        68.61842105263158,
      ],
      [fromConfig(reference), 30.319, 163],
    ] as const) {
      const result = estimate(scenario);
      expect(result.conservativeDurationSeconds).toBeCloseTo(expected, 8);
      expect(result.conservativeDurationSeconds).toBeGreaterThan(observed);
      expect(result.decision).toBe("admitted");
    }
  });

  it("counts unique intents, ignores duplicate HTTP attempts, and truncates stock by request quantity", () => {
    const spike = input({
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 3,
        duplicateEachBuyerAttempt: false,
        maxDurationSeconds: 1,
        startDelaySeconds: 0,
        quantityPerAttempt: 3,
      },
      inventoryConfig: { startingStock: 11 },
      declaredErpCapacityPerSecond: 1,
    });
    expect(estimate(spike).conservativeDurationSeconds).toBeCloseTo(16 + 3 / 0.95, 8);
    if (spike.trafficConfig.mode !== "buyer-spike") throw new Error("Expected spike");
    expect(
      estimate({
        ...spike,
        trafficConfig: { ...spike.trafficConfig, duplicateEachBuyerAttempt: true },
      }),
    ).toEqual(estimate(spike));
    expect(
      estimate({ ...spike, inventoryConfig: { ...spike.inventoryConfig, startingStock: 8 } })
        .conservativeDurationSeconds,
    ).toBeCloseTo(16 + 2 / 0.95, 8);
    const constant = input({
      ...spike,
      trafficConfig: {
        mode: "constant-arrival-rate",
        ratePerSecond: 2,
        durationSeconds: 1,
        startDelaySeconds: 0,
        quantityPerAttempt: 3,
      },
    });
    expect(estimate(constant).conservativeDurationSeconds).toBeCloseTo(16 + 2 / 0.95, 8); // only two intents
    expect(
      estimate({ ...spike, inventoryConfig: { ...spike.inventoryConfig, startingStock: 2 } })
        .conservativeDurationSeconds,
    ).toBe(16);
  });

  it("retains traffic, start delay and settlement for zero work; supports zero latency and the maximum supported p", () => {
    const empty = input({
      inventoryConfig: { startingStock: 0 },
      declaredErpLatencyMs: 0,
      errorRateAssumption: 0.3,
    });
    empty.trafficConfig.startDelaySeconds = 7;
    expect(estimate(empty)).toMatchObject({
      conservativeDurationSeconds: 32,
      explanatoryDurationSeconds: 17,
      bottleneck: "traffic_dispatch",
    });
    expect(estimate(input({ declaredErpLatencyMs: 0 })).conservativeDurationSeconds).toBeCloseTo(
      25 + 60 / 4.75,
      8,
    );
    expect(estimate(input({ errorRateAssumption: 0.3 })).unestimableReason).toBeUndefined();
    expect(effectiveEstimatorWorkerConcurrency(5)).toBe(5);
    expect(effectiveEstimatorWorkerConcurrency(20)).toBe(10);
    expect(
      estimate(input()).assumptions.some(
        (assumption) => assumption.code === "effective_concurrency",
      ),
    ).toBe(true);
  });

  it("attributes traffic, capacity, concurrency, latency limits with actionable rejection guidance", () => {
    for (const [overrides, bottleneck, guidance] of [
      [{}, "erp_capacity", "Increase declared ERP capacity"],
      [
        {
          effectiveWorkerConcurrency: 1,
          declaredErpCapacityPerSecond: 100,
          declaredErpLatencyMs: 950,
        },
        "worker_concurrency",
        "Increase per-run concurrency",
      ],
      [
        {
          effectiveWorkerConcurrency: 1,
          declaredErpCapacityPerSecond: 100,
          declaredErpLatencyMs: 1000,
        },
        "erp_latency",
        "Lower declared ERP latency",
      ],
      [
        { inventoryConfig: { startingStock: 0 } },
        "traffic_dispatch",
        "Shorten the traffic duration",
      ],
    ] as const) {
      expect(estimate(input(overrides), 1)).toMatchObject({
        decision: "rejected",
        bottleneck,
        reasons: [expect.stringContaining(guidance)],
      });
    }
    expect(
      estimate(
        input({
          declaredErpCapacityPerSecond: 1,
          inventoryConfig: {
            startingStock: 1000,
          },
          trafficConfig: {
            mode: "constant-arrival-rate",
            ratePerSecond: 100,
            durationSeconds: 10,
            quantityPerAttempt: 1,
            startDelaySeconds: 0,
          },
        }),
      ),
    ).toMatchObject({
      decision: "rejected",
      bottleneck: "erp_capacity",
      conservativeDurationSeconds: 25 + 1000 / 0.95,
      reasons: [expect.stringContaining("Increase declared ERP capacity")],
    });
  });

  it.each([
    600, 300,
  ])("compares unrounded durations below, at and above the %s second ceiling", (ceiling) => {
    for (const offset of [-0.000001, 0, 0.000001]) {
      const result = estimate(
        input({
          inventoryConfig: {
            startingStock: 200,
          },
          trafficConfig: {
            ...input().trafficConfig,
            mode: "constant-arrival-rate",
            ratePerSecond: 20,
            durationSeconds: 10,
          },
          effectiveWorkerConcurrency: 1,
          declaredErpCapacityPerSecond: 100,
          declaredErpLatencyMs:
            ((ceiling + offset - 25) / 200) * 1000 - constants.latencyOverheadFloorMs,
        }),
        ceiling,
      );
      expect(result.conservativeDurationSeconds).toBeCloseTo(ceiling + offset, 10);
      expect(result.decision).toBe(offset > 0 ? "rejected" : "admitted");
    }
  });

  it("applies injected allowances instead of the built-in defaults", () => {
    const value = input();
    const base = estimate(value);
    const withLongerSettlement = estimateDemoDuration(value, 600, {
      ...constants,
      settlementOverheadSeconds: constants.settlementOverheadSeconds + 30,
    });
    expect(withLongerSettlement.conservativeDurationSeconds).toBeCloseTo(
      (base.conservativeDurationSeconds ?? 0) + 30,
      10,
    );
  });

  it("rejects unsupported scenarios before zero work without duration figures", () => {
    for (const startingStock of [0, 60]) {
      for (const [declaredErpForcedOutage, errorRateAssumption, reason] of [
        [true, 0, "declared_permanent_outage"],
        [true, 1, "declared_permanent_outage"],
        [false, 0.300001, "error_rate_above_policy_maximum"],
        [false, 1, "error_rate_above_policy_maximum"],
      ] as const) {
        const result = estimate(
          input({
            inventoryConfig: { startingStock },
            declaredErpForcedOutage,
            errorRateAssumption,
          }),
        );
        expect(result).toMatchObject({
          decision: "rejected",
          bottleneck: "unestimable",
          unestimableReason: reason,
        });
        expect(result).not.toHaveProperty("conservativeDurationSeconds");
        expect(result).not.toHaveProperty("explanatoryDurationSeconds");
        expect(result.reasons?.[0]).toMatch(/Disable|Lower/);
      }
    }
  });
});
