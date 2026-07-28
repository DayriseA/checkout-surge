import {
  type DemoPresetContract,
  type PublicRuntimePolicy,
  saveDemoPresetRequestSchema,
  startDemoRunRequestSchema,
} from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import {
  configFromDraft,
  draftFromPreset,
  draftFromRuntimePolicy,
  parseInteger,
  parseNumber,
  policyFromDraft,
} from "../src/app/lib/admin-drafts.js";

describe("admin drafts", () => {
  it.each([
    "buyer-spike",
    "constant-arrival-rate",
  ] as const)("round-trips %s traffic and preserves hidden configuration", (mode) => {
    const preset = presetFixture(mode);
    const rebuilt = configFromDraft(draftFromPreset(preset), preset);
    expect(rebuilt).toEqual({
      trafficConfig: preset.trafficConfig,
      inventoryConfig: preset.inventoryConfig,
      erpConfig: preset.erpConfig,
      backpressureConfig: preset.backpressureConfig,
    });
    expect(rebuilt.trafficConfig.quantityPerAttempt).toBe(7);
    expect(rebuilt.backpressureConfig.retryPolicy).toEqual({
      maxAttempts: 9,
      initialBackoffMs: 321,
    });
    expect(rebuilt.backpressureConfig.queueName).toBe("orders:process");
  });

  it("uses numeric fallbacks without accepting partial or non-finite values", () => {
    expect(parseInteger("2.5", 7)).toBe(7);
    expect(parseInteger("12", 7)).toBe(12);
    expect(parseNumber("Infinity", 0.25)).toBe(0.25);
    expect(parseNumber("0.2", 0)).toBe(0.2);
  });

  it("merges editable runtime policy fields without losing deployment hard caps", () => {
    const policy = policyFixture();
    const draft = draftFromRuntimePolicy(policy);
    draft.maxBuyers = "4321";
    draft.allowConstantArrivalRate = false;
    const next = policyFromDraft(draft, policy);
    expect(next.publicCustomLimits.maxBuyers).toBe(4321);
    expect(next.publicCustomLimits.allowedTrafficModes).toEqual(["buyer-spike"]);
    expect(policy.deploymentHardCaps).toEqual({
      maxBuyers: 100_000,
      maxTotalRequests: 100_000,
      maxRequestsPerSecond: 10_000,
      maxTrafficDurationSeconds: 300,
      maxTrafficStartDelaySeconds: 30,
      maxPreAllocatedVus: 10_000,
      maxVus: 10_000,
    });
  });

  it("builds contract-valid start and save payload configuration", () => {
    const preset = presetFixture("constant-arrival-rate");
    const draft = draftFromPreset(preset);
    const configOverride = configFromDraft(draft, preset);
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
});

function presetFixture(mode: "buyer-spike" | "constant-arrival-rate"): DemoPresetContract {
  const base = {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "custom",
    visibility: "admin" as const,
    isEditable: true,
    isCustom: true,
    display: { name: "Custom", description: "Fixture", sortOrder: 10, outcomeFocus: [] },
    inventoryConfig: { startingStock: 250, quantityPerCheckout: 2, reservationHoldMinutes: 15 },
    erpConfig: {
      latencyMs: 80,
      maxTps: 100,
      errorRate: 0.1,
      forcedOutage: false,
      requestTimeoutMs: 2000,
    },
    backpressureConfig: {
      queueName: "orders:process" as const,
      physicalQueueName: "orders-process" as const,
      orderProcessConcurrency: 5,
      retryPolicy: { maxAttempts: 9, initialBackoffMs: 321 },
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
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
