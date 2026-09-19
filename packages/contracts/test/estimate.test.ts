import { describe, expect, it } from "vitest";
import {
  acceptedEstimateSnapshotSchema,
  estimatedDemoOccupancyCeilingSeconds,
  estimateObservationSchema,
  estimatePreviewSchema,
  estimateStaleRejectionSchema,
  estimatorInputSchema,
  estimatorResultSchema,
} from "../src/index.js";

const input = {
  trafficConfig: {
    mode: "constant-arrival-rate" as const,
    ratePerSecond: 25,
    durationSeconds: 60,
    startDelaySeconds: 0,
    quantityPerAttempt: 1,
  },
  inventoryConfig: { startingStock: 888, quantityPerCheckout: 1, reservationHoldMinutes: 15 },
  effectiveWorkerConcurrency: 5,
  declaredErpCapacityPerSecond: 10,
  declaredErpLatencyMs: 250,
  declaredErpForcedOutage: false,
  errorRateAssumption: 0,
};

const estimable = {
  explanatoryDurationSeconds: 148.8,
  conservativeDurationSeconds: 210,
  bottleneck: "erp_capacity" as const,
  assumptions: [
    { code: "erp_overhead_floor", detail: "Latency includes a nonzero overhead floor." },
  ],
  estimatorIdentity: { name: "conservative-envelope", version: 1 },
  policyIdentity: { name: "adaptive-erp-engine", version: 1 },
  effectiveCeilingSeconds: 600,
};

describe("duration estimator contracts", () => {
  it("keeps the provisional inclusive 600-second occupancy ceiling", () => {
    expect(estimatedDemoOccupancyCeilingSeconds).toBe(600);
  });

  it("distinguishes healthy and permanently-outage declared inputs", () => {
    expect(estimatorInputSchema.parse(input)).toEqual(input);
    const outageInput = { ...input, declaredErpForcedOutage: true };
    expect(estimatorInputSchema.parse(outageInput)).toEqual(outageInput);
    expect(estimatorInputSchema.parse({ ...input, declaredErpForcedOutage: undefined })).toEqual(
      input,
    );
    expect(estimatorInputSchema.parse({ ...input, declaredErpForcedOutage: true })).not.toEqual(
      estimatorInputSchema.parse(input),
    );
  });

  it("applies the default error-rate assumption", () => {
    expect(estimatorInputSchema.parse({ ...input, errorRateAssumption: undefined })).toEqual(input);
  });

  it("admits at the inclusive ceiling and rejects just above it", () => {
    expect(
      estimatorResultSchema.parse({
        ...estimable,
        conservativeDurationSeconds: 600,
        decision: "admitted",
      }),
    ).toEqual({
      ...estimable,
      conservativeDurationSeconds: 600,
      decision: "admitted",
    });
    expect(
      estimatorResultSchema.parse({
        ...estimable,
        conservativeDurationSeconds: 601,
        decision: "rejected",
      }).decision,
    ).toBe("rejected");
  });

  it("refuses contradictory decision, duration, and ceiling states", () => {
    expect(
      estimatorResultSchema.safeParse({
        ...estimable,
        conservativeDurationSeconds: 601,
        decision: "admitted",
      }).success,
    ).toBe(false);
    expect(
      estimatorResultSchema.safeParse({
        ...estimable,
        conservativeDurationSeconds: 600,
        decision: "rejected",
      }).success,
    ).toBe(false);
    expect(
      estimatorResultSchema.safeParse({
        ...estimable,
        bottleneck: "unestimable",
        decision: "admitted",
      }).success,
    ).toBe(false);
    expect(
      estimatorResultSchema.safeParse({
        bottleneck: "erp_capacity" as const,
        assumptions: estimable.assumptions,
        estimatorIdentity: estimable.estimatorIdentity,
        policyIdentity: estimable.policyIdentity,
        effectiveCeilingSeconds: estimable.effectiveCeilingSeconds,
        decision: "admitted" as const,
      }).success,
    ).toBe(false);
  });

  it("represents unestimable scenarios as rejected without fabricated durations", () => {
    const unestimable = {
      bottleneck: "unestimable" as const,
      assumptions: [],
      estimatorIdentity: { name: "conservative-envelope", version: 1 },
      policyIdentity: { name: "adaptive-erp-engine", version: 1 },
      effectiveCeilingSeconds: 600,
      decision: "rejected" as const,
      unestimableReason: "declared_permanent_outage" as const,
    };
    expect(estimatorResultSchema.parse(unestimable)).toEqual(unestimable);
    expect(
      estimatorResultSchema.parse({ ...unestimable, unestimableReason: "unsupported_scenario" })
        .unestimableReason,
    ).toBe("unsupported_scenario");
    expect(
      estimatorResultSchema.safeParse({
        ...unestimable,
        conservativeDurationSeconds: 210,
      }).success,
    ).toBe(false);
    expect(
      estimatorResultSchema.safeParse({ ...unestimable, bottleneck: "erp_capacity" }).success,
    ).toBe(false);
    expect(estimatorResultSchema.safeParse({ ...unestimable, decision: "admitted" }).success).toBe(
      false,
    );
    expect(
      estimatorResultSchema.safeParse({
        ...estimable,
        bottleneck: "unestimable",
        decision: "rejected",
      }).success,
    ).toBe(false);
  });

  it("parses the structured estimate_stale rejection carrying a fresh preview", () => {
    const rejection = {
      code: "estimate_stale" as const,
      message: "The scenario changed since the displayed preview.",
      presentedFingerprint: "sha-256:abc123",
      freshPreview: {
        fingerprint: "sha-256:def456",
        result: { ...estimable, conservativeDurationSeconds: 600, decision: "admitted" as const },
      },
    };
    expect(estimateStaleRejectionSchema.parse(rejection)).toEqual(rejection);
    expect(estimatePreviewSchema.parse(rejection.freshPreview)).toEqual(rejection.freshPreview);
    expect(
      estimateStaleRejectionSchema.safeParse({ ...rejection, code: "other_reason" }).success,
    ).toBe(false);
  });

  it("accepts only within-ceiling snapshots and parses over-budget observations", () => {
    const snapshot = {
      fingerprint: "sha-256:abc123",
      policyIdentity: { name: "adaptive-erp-engine", version: 1 },
      estimatorIdentity: { name: "conservative-envelope", version: 1 },
      effectiveCeilingSeconds: 600,
      conservativeDurationSeconds: 600,
      acceptedAt: "2026-09-19T00:00:00.000Z",
    };
    expect(acceptedEstimateSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      acceptedEstimateSnapshotSchema.safeParse({
        ...snapshot,
        conservativeDurationSeconds: 601,
      }).success,
    ).toBe(false);
    const observation = {
      kind: "over_accepted_estimate" as const,
      observedAt: "2026-09-19T00:05:00.000Z",
      thresholdSeconds: 210,
      observedSeconds: 300,
    };
    expect(estimateObservationSchema.parse(observation)).toEqual(observation);
    expect(
      estimateObservationSchema.safeParse({ ...observation, kind: "under_budget" }).success,
    ).toBe(false);
  });
});
