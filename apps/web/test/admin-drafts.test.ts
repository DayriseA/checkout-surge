import {
  type DemoPresetContract,
  type PublicRuntimePolicy,
  saveDemoPresetRequestSchema,
  startDemoRunRequestSchema,
} from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import {
  buildEffectiveRunConfig,
  buildErpChaosFromDraft,
  buildPolicyFromDraft,
  buildSortOrder,
  draftFromConfigSnapshot,
  draftFromPreset,
  draftFromRuntimePolicy,
  isPresetDraftDirty,
} from "../src/app/lib/admin-drafts.js";

describe("admin drafts", () => {
  it.each([
    "buyer-spike",
    "constant-arrival-rate",
  ] as const)("round-trips %s traffic and preserves hidden configuration", (mode) => {
    const preset = presetFixture(mode);
    const rebuilt = buildEffectiveRunConfig(draftFromPreset(preset), preset).values;
    expect(rebuilt).toBeDefined();
    if (!rebuilt) throw new Error("Expected valid fixture config.");
    expect(rebuilt).toEqual({
      trafficConfig: preset.trafficConfig,
      inventoryConfig: preset.inventoryConfig,
      erpConfig: preset.erpConfig,
      backpressureConfig: preset.backpressureConfig,
    });
    expect(rebuilt.trafficConfig.quantityPerAttempt).toBe(7);
    expect(rebuilt.backpressureConfig.queueName).toBe("orders:process");
  });

  it("rejects blank, fractional, and non-finite numeric drafts without fallbacks", () => {
    expect(buildSortOrder("").fieldErrors.sortOrder?.code).toBe("required");
    expect(buildSortOrder("2.5").fieldErrors.sortOrder?.code).toBe("not_an_integer");
    expect(buildSortOrder("Infinity").fieldErrors.sortOrder?.code).toBe("not_a_number");
    expect(buildSortOrder("0").values).toBe(0);
  });

  it("keeps inactive traffic drafts untouched and validates only the selected mode", () => {
    const preset = presetFixture("buyer-spike");
    const draft = draftFromPreset(preset);
    draft.ratePerSecond = "Infinity";
    draft.preAllocatedVus = "2.5";
    draft.buyerCount = "";
    const invalid = buildEffectiveRunConfig(draft, preset);
    expect(invalid.fieldErrors.buyerCount?.code).toBe("required");
    expect(invalid.fieldErrors.ratePerSecond).toBeUndefined();
    expect(draft.ratePerSecond).toBe("Infinity");
    expect(draft.buyerCount).toBe("");
  });

  it.each([
    ["Infinity", "not_a_number"],
    ["2.5", "not_an_integer"],
    ["5001", "above_max"],
  ] as const)("classifies ERP latency %s as %s", (latencyMs, code) => {
    const result = buildErpChaosFromDraft(
      { latencyMs, maxTps: "1", errorRate: "0", forcedOutage: false },
      { maxLatencyMs: 5000, minMaxTps: 1, maxErrorRate: 0.5, allowForcedOutage: true },
    );
    expect(result.fieldErrors.latencyMs?.code).toBe(code);
  });

  it("accepts valid zero where the ERP contract permits it", () => {
    const result = buildErpChaosFromDraft(
      { latencyMs: "0", maxTps: "1", errorRate: "0", forcedOutage: false },
      { maxLatencyMs: 5000, minMaxTps: 1, maxErrorRate: 0.5, allowForcedOutage: true },
    );
    expect(result.values).toMatchObject({ latencyMs: 0, maxTps: 1, errorRate: 0 });
  });

  it("round-trips admin error-rate percentages to stored ratios", () => {
    const preset = presetFixture("buyer-spike");
    preset.erpConfig.errorRate = 0.25;
    const draft = draftFromPreset(preset);
    expect(draft.erpErrorRate).toBe("25");
    const built = buildEffectiveRunConfig({ ...draft, erpErrorRate: "25" }, preset);
    if (!built.values) throw new Error("Expected valid run config.");
    expect(built.values?.erpConfig.errorRate).toBe(0.25);
    expect(draftFromConfigSnapshot(built.values).erpErrorRate).toBe("25");
  });

  it("prefers effective ERP bounds unless the contract requires a whole number", () => {
    const caps = {
      maxLatencyMs: 5000,
      minMaxTps: 1,
      maxErrorRate: 0.5,
      allowForcedOutage: true,
    };

    expect(
      buildErpChaosFromDraft(
        { latencyMs: "0", maxTps: "0", errorRate: "0", forcedOutage: false },
        caps,
      ).fieldErrors.maxTps,
    ).toEqual({ code: "below_min", message: "Maximum TPS must be at least 1." });
    expect(
      buildErpChaosFromDraft(
        { latencyMs: "0", maxTps: "0.5", errorRate: "0", forcedOutage: false },
        caps,
      ).fieldErrors.maxTps,
    ).toEqual({ code: "not_an_integer", message: "Maximum TPS must be a whole number." });
  });

  it("maps canonical intrinsic bounds while keeping sourced caps separate", () => {
    const preset = presetFixture("buyer-spike");
    const draft = draftFromPreset(preset);
    draft.buyerCount = "0";
    expect(buildEffectiveRunConfig(draft, preset).fieldErrors.buyerCount?.code).toBe("below_min");

    draft.buyerCount = "1";
    draft.startingStock = "0";
    draft.erpErrorRate = "1";
    expect(buildEffectiveRunConfig(draft, preset).values).toBeDefined();

    draft.orderProcessConcurrency = "11";
    expect(buildEffectiveRunConfig(draft, preset).fieldErrors.orderProcessConcurrency?.code).toBe(
      "above_max",
    );

    draft.orderProcessConcurrency = "10";
    draft.buyerCount = "1001";
    const policy = policyFixture();
    policy.deploymentHardCaps.maxBuyers = 1000;
    expect(buildEffectiveRunConfig(draft, preset, policy).fieldErrors.buyerCount?.code).toBe(
      "above_max",
    );

    expect(
      buildErpChaosFromDraft(
        { latencyMs: "0", maxTps: "4", errorRate: "0", forcedOutage: false },
        { maxLatencyMs: 5000, minMaxTps: 5, maxErrorRate: 0.5, allowForcedOutage: true },
      ).fieldErrors.maxTps?.code,
    ).toBe("below_min");
  });

  it("reports both controls in VU relationship failures", () => {
    const preset = presetFixture("constant-arrival-rate");
    const draft = draftFromPreset(preset);
    draft.preAllocatedVus = "51";
    draft.maxVus = "50";
    expect(buildEffectiveRunConfig(draft, preset).formErrors).toEqual([
      {
        message: "Maximum VUs must be greater than or equal to preallocated VUs.",
        fields: ["preAllocatedVus", "maxVus"],
      },
    ]);
  });

  it.each([
    {
      mode: "buyer-spike" as const,
      mutate: (draft: ReturnType<typeof draftFromPreset>) => {
        draft.buyerCount = "50000";
        draft.duplicateEachBuyerAttempt = true;
      },
      fields: ["buyerCount", "duplicateEachBuyerAttempt"],
      computedTotal: 100_000,
    },
    {
      mode: "constant-arrival-rate" as const,
      mutate: (draft: ReturnType<typeof draftFromPreset>) => {
        draft.ratePerSecond = "1000";
        draft.durationSeconds = "91";
      },
      fields: ["ratePerSecond", "durationSeconds"],
      computedTotal: 91_000,
    },
  ])("uses canonical deployment totals for $mode", ({ mode, mutate, fields, computedTotal }) => {
    const preset = presetFixture(mode);
    const draft = draftFromPreset(preset);
    const policy = policyFixture();
    policy.deploymentHardCaps.maxTotalRequests = 90_000;
    mutate(draft);
    expect(buildEffectiveRunConfig(draft, preset, policy).formErrors).toContainEqual({
      message: `This configuration creates ${computedTotal.toLocaleString("en-US")} requests; the permitted maximum is 90,000 requests.`,
      fields,
    });
  });

  it("groups a displayed 100000 cap while preserving the exact draft and payload number", () => {
    const preset = presetFixture("buyer-spike");
    const draft = draftFromPreset(preset);
    const policy = policyFixture();
    draft.buyerCount = "100000";
    draft.duplicateEachBuyerAttempt = true;

    expect(buildEffectiveRunConfig(draft, preset, policy).formErrors).toContainEqual({
      message:
        "This configuration creates 200,000 requests; the permitted maximum is 100,000 requests.",
      fields: ["buyerCount", "duplicateEachBuyerAttempt"],
    });
    expect(draft.buyerCount).toBe("100000");

    draft.duplicateEachBuyerAttempt = false;
    const valid = buildEffectiveRunConfig(draft, preset, policy);
    expect(valid.values?.trafficConfig).toMatchObject({ buyerCount: 100000 });
  });

  it("preserves the lowered server occupancy ceiling while saving editable policy fields", () => {
    const policy = policyFixture();
    policy.estimatedDemoOccupancyCeilingSeconds = 123.456;
    policy.publicCustomDefaults.erpConfig.forcedOutage = true;
    policy.publicCustomLimits.allowForcedOutage = true;
    const draft = draftFromRuntimePolicy(policy);
    draft.maxBuyers = "4321";
    draft.allowConstantArrivalRate = false;
    const next = buildPolicyFromDraft(draft, policy).values;
    expect(next).toBeDefined();
    if (!next) throw new Error("Expected valid fixture policy.");
    expect(next.estimatedDemoOccupancyCeilingSeconds).toBe(123.456);
    expect(next.publicCustomLimits.maxBuyers).toBe(4321);
    expect(next.publicCustomLimits.allowedTrafficModes).toEqual(["buyer-spike"]);
    expect(next.publicCustomDefaults.erpConfig.forcedOutage).toBe(true);
    expect(next.publicCustomLimits.allowForcedOutage).toBe(true);
    expect(policy.deploymentHardCaps).toEqual({
      estimatedDemoOccupancyCeilingSeconds: 600,
      maxBuyers: 100_000,
      maxTotalRequests: 100_000,
      maxRequestsPerSecond: 10_000,
      maxTrafficDurationSeconds: 300,
      maxTrafficStartDelaySeconds: 30,
      maxPreAllocatedVus: 10_000,
      maxVus: 10_000,
    });
  });

  it.each([
    {
      mutate: (draft: ReturnType<typeof draftFromRuntimePolicy>) => {
        draft.buyerCount = "1001";
        draft.maxBuyers = "1000";
      },
      fields: ["buyerCount", "maxBuyers"],
    },
    {
      mutate: (draft: ReturnType<typeof draftFromRuntimePolicy>) => {
        draft.mode = "constant-arrival-rate";
        draft.maxVus = "51";
        draft.maxPublicVus = "50";
      },
      fields: ["maxVus", "maxPublicVus"],
    },
    {
      mutate: (draft: ReturnType<typeof draftFromRuntimePolicy>) => {
        draft.erpMaxTps = "101";
        draft.maxErpMaxTps = "100";
      },
      fields: ["erpMaxTps", "minErpMaxTps", "maxErpMaxTps"],
    },
    {
      mutate: (draft: ReturnType<typeof draftFromRuntimePolicy>) => {
        draft.minErpMaxTps = "101";
        draft.maxErpMaxTps = "100";
      },
      fields: ["minErpMaxTps", "maxErpMaxTps"],
    },
    {
      mutate: (draft: ReturnType<typeof draftFromRuntimePolicy>) => {
        draft.buyerCount = "1001";
        draft.maxTotalRequests = "1000";
      },
      fields: ["buyerCount", "duplicateEachBuyerAttempt", "maxTotalRequests"],
    },
    {
      mutate: (draft: ReturnType<typeof draftFromRuntimePolicy>) => {
        draft.allowBuyerSpike = false;
      },
      fields: ["mode", "allowBuyerSpike"],
    },
  ])("targets every editable side of policy relationships", ({ mutate, fields }) => {
    const policy = policyFixture();
    const draft = draftFromRuntimePolicy(policy);
    mutate(draft);
    expect(buildPolicyFromDraft(draft, policy).formErrors).toContainEqual(
      expect.objectContaining({ fields }),
    );
  });

  it("classifies policy fractional input and accepts its hard-cap boundary", () => {
    const policy = policyFixture();
    const draft = draftFromRuntimePolicy(policy);
    draft.maxBuyers = "2.5";
    expect(buildPolicyFromDraft(draft, policy).fieldErrors.maxBuyers?.code).toBe("not_an_integer");
    draft.maxBuyers = String(policy.deploymentHardCaps.maxBuyers);
    expect(buildPolicyFromDraft(draft, policy).fieldErrors.maxBuyers).toBeUndefined();
  });

  it("builds contract-valid start and save payload configuration", () => {
    const preset = presetFixture("constant-arrival-rate");
    const draft = draftFromPreset(preset);
    draft.ratePerSecond = "75";
    draft.startingStock = "300";
    const configOverride = buildEffectiveRunConfig(draft, preset).values;
    expect(configOverride).toEqual({
      trafficConfig: {
        ...preset.trafficConfig,
        ratePerSecond: 75,
      },
      inventoryConfig: {
        ...preset.inventoryConfig,
        startingStock: 300,
      },
      erpConfig: preset.erpConfig,
      backpressureConfig: preset.backpressureConfig,
    });
    expect(
      startDemoRunRequestSchema.safeParse({ presetSlug: preset.slug, configOverride }).success,
    ).toBe(true);
    expect(
      saveDemoPresetRequestSchema.safeParse({
        slug: preset.slug,
        display: preset.display,
        ...configOverride,
      }).success,
    ).toBe(true);
  });

  it("canonicalizes draft values before comparing them with the persisted preset", () => {
    const preset = presetFixture("buyer-spike");
    const draft = draftFromPreset(preset);
    draft.buyerCount = "01000";
    draft.erpErrorRate = "10";
    draft.sortOrder = "010";
    expect(isPresetDraftDirty(draft, preset)).toBe(false);

    draft.startingStock = "251";
    expect(isPresetDraftDirty(draft, preset)).toBe(true);
    draft.startingStock = "";
    expect(isPresetDraftDirty(draft, preset)).toBe(true);
  });
});

function presetFixture(mode: "buyer-spike" | "constant-arrival-rate"): DemoPresetContract {
  const base = {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "custom",
    visibility: "admin" as const,
    isEditable: true,
    isCustom: true,
    display: { name: "Custom", description: "Fixture", sortOrder: 10, outcomeFocus: [] },
    inventoryConfig: { startingStock: 250 },
    erpConfig: {
      latencyMs: 80,
      maxTps: 100,
      errorRate: 0.1,
      forcedOutage: false,
    },
    backpressureConfig: {
      queueName: "orders:process" as const,
      physicalQueueName: "orders-process" as const,
      orderProcessConcurrency: 5,
    },
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
  return {
    ...base,
    trafficConfig:
      mode === "buyer-spike"
        ? {
            mode,
            buyerCount: 1000,
            duplicateEachBuyerAttempt: true,
            startDelaySeconds: 2,
            maxDurationSeconds: 10,
            quantityPerAttempt: 7,
          }
        : {
            mode,
            ratePerSecond: 50,
            durationSeconds: 20,
            startDelaySeconds: 2,
            quantityPerAttempt: 7,
            k6Vus: { preAllocatedVus: 10, maxVus: 50 },
          },
  };
}

function policyFixture(): PublicRuntimePolicy {
  const preset = presetFixture("buyer-spike");
  return {
    estimatedDemoOccupancyCeilingSeconds: 600,
    isPublicRunBudgetEnforced: true,
    publicRunBudget: { windowSeconds: 300, perVisitorMaxStarts: 2, globalMaxStarts: 6 },
    publicCustomDefaults: preset,
    publicCustomLimits: {
      maxTotalRequests: 10_000,
      maxBuyers: 10_000,
      maxRequestsPerSecond: 1000,
      maxTrafficDurationSeconds: 120,
      maxTrafficStartDelaySeconds: 10,
      maxPreAllocatedVus: 1000,
      maxVus: 1000,
      maxStartingStock: 1000,
      maxErpLatencyMs: 2000,
      minErpMaxTps: 1,
      maxErpMaxTps: 100,
      maxErpErrorRate: 0.25,
      allowForcedOutage: false,
      allowedTrafficModes: ["buyer-spike", "constant-arrival-rate"],
    },
    deploymentHardCaps: {
      estimatedDemoOccupancyCeilingSeconds: 600,
      maxBuyers: 100_000,
      maxTotalRequests: 100_000,
      maxRequestsPerSecond: 10_000,
      maxTrafficDurationSeconds: 300,
      maxTrafficStartDelaySeconds: 30,
      maxPreAllocatedVus: 10_000,
      maxVus: 10_000,
    },
  };
}
