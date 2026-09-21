import { describe, expect, it } from "vitest";
import {
  conservativeDurationEstimatorIdentity,
  enginePolicyIdentitySchema,
  estimateAdmissionRejectionDetailsSchema,
  estimatedDemoOccupancyCeilingSeconds,
  estimatePreviewSchema,
  estimatorBottleneckSchema,
  estimatorInputSchema,
  estimatorResultSchema,
  largestAllowedErpLatencyMs,
  previewDemoRunRequestSchema,
  startDemoRunRequestSchema,
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
  it("validates the shared estimator identity, pacing bottleneck and deployment latency ceiling", () => {
    expect(enginePolicyIdentitySchema.parse(conservativeDurationEstimatorIdentity)).toEqual({
      name: "conservative-duration-estimator",
      version: 1,
    });
    expect(estimatorBottleneckSchema.parse("adaptive_pacing")).toBe("adaptive_pacing");
    expect(
      estimatorInputSchema.safeParse({ ...input, declaredErpLatencyMs: largestAllowedErpLatencyMs })
        .success,
    ).toBe(true);
    expect(
      estimatorInputSchema.safeParse({
        ...input,
        declaredErpLatencyMs: largestAllowedErpLatencyMs + 1,
      }).success,
    ).toBe(false);
    expect(
      estimatorResultSchema.parse({ ...estimable, decision: "admitted", reasons: [] }).reasons,
    ).toEqual([]);
  });
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

  it("shares strict preview/start intent and rejects browser estimate authority", () => {
    const request = { presetSlug: "public-custom" };
    for (const schema of [previewDemoRunRequestSchema, startDemoRunRequestSchema]) {
      expect(schema.parse(request)).toEqual(request);
      expect(
        schema.safeParse({ ...request, conservativeDurationSeconds: 0, decision: "admitted" })
          .success,
      ).toBe(false);
    }
    const preview = { result: { ...estimable, decision: "admitted" } };
    expect(estimatePreviewSchema.parse(preview)).toEqual(preview);
    expect(estimatePreviewSchema.safeParse({ ...preview, fingerprint: "obsolete" }).success).toBe(
      false,
    );
  });

  it("validates finite and unestimable admission rejection details", () => {
    const { explanatoryDurationSeconds: _explanatory, ...base } = estimable;
    const finite = {
      ...base,
      conservativeDurationSeconds: 601,
      reason: "over_ceiling",
      reasons: ["Reduce stock."],
    };
    expect(estimateAdmissionRejectionDetailsSchema.parse(finite)).toEqual(finite);
    expect(
      estimateAdmissionRejectionDetailsSchema.safeParse({
        ...finite,
        conservativeDurationSeconds: 600,
      }).success,
    ).toBe(false);
    const { conservativeDurationSeconds: _duration, ...withoutDuration } = finite;
    const unestimable = {
      ...withoutDuration,
      reason: "unestimable",
      bottleneck: "unestimable",
      unestimableReason: "declared_permanent_outage",
    };
    expect(estimateAdmissionRejectionDetailsSchema.parse(unestimable)).toEqual(unestimable);
    expect(
      estimateAdmissionRejectionDetailsSchema.safeParse({
        ...unestimable,
        conservativeDurationSeconds: 0,
      }).success,
    ).toBe(false);
    expect(
      estimateAdmissionRejectionDetailsSchema.safeParse({
        ...unestimable,
        unestimableReason: undefined,
      }).success,
    ).toBe(false);
  });
});
