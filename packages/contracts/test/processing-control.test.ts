import { describe, expect, it } from "vitest";
import {
  enginePolicyIdentitySchema,
  erpCallReferenceSchema,
  erpProfileAnchorSchema,
  erpProfileSchema,
  processingGenerationSchema,
} from "../src/index.js";

const dispatchedAt = "2026-09-19T00:00:00.000Z";

describe("processing control contracts", () => {
  it("identifies an ERP call separately from order and delivery identity", () => {
    const reference = {
      erpCallId: "9a1c0e64-2e82-4a7b-9c1d-3f4a5b6c7d8e",
      orderId: "1f0a92a7-46fb-4cf7-a3d5-6c5ea01b6f11",
      idempotencyKey: "idem-1",
      processingGeneration: 0,
      dispatchedAt,
    };
    expect(erpCallReferenceSchema.parse(reference)).toEqual(reference);
    expect(processingGenerationSchema.parse(3)).toBe(3);
    expect(
      erpCallReferenceSchema.safeParse({ ...reference, processingGeneration: -1 }).success,
    ).toBe(false);
  });

  it("requires a versioned engine-policy identity", () => {
    expect(enginePolicyIdentitySchema.parse({ name: "adaptive-erp-engine", version: 1 })).toEqual({
      name: "adaptive-erp-engine",
      version: 1,
    });
    expect(enginePolicyIdentitySchema.safeParse({ name: "adaptive-erp-engine" }).success).toBe(
      false,
    );
    expect(
      enginePolicyIdentitySchema.safeParse({ name: "adaptive-erp-engine", version: 0 }).success,
    ).toBe(false);
  });
});

describe("ERP profile contract", () => {
  const baseConfig = { latencyMs: 100, maxTps: 200, errorRate: 0, forcedOutage: false };

  it("parses an ordered finite profile with recovery to base", () => {
    const profile = {
      identity: { profileId: "capacity-drop-recovery", version: 1 },
      baseConfig,
      segments: [
        { offsetSeconds: 30, durationSeconds: 60, override: { maxTps: 5 } },
        {
          offsetSeconds: 120,
          durationSeconds: 30,
          override: { latencyMs: 500, forcedOutage: true },
        },
      ],
      recoveryToBase: true as const,
    };
    expect(erpProfileSchema.parse(profile)).toEqual(profile);
  });

  it("requires at least one finite segment and a positive duration", () => {
    const profile = {
      identity: { profileId: "finite-outage-recovery", version: 1 },
      baseConfig,
      segments: [{ offsetSeconds: 30, durationSeconds: 0, override: { forcedOutage: true } }],
      recoveryToBase: true as const,
    };
    expect(erpProfileSchema.safeParse({ ...profile, segments: [] }).success).toBe(false);
    expect(erpProfileSchema.safeParse(profile).success).toBe(false);
  });

  it("rejects segments that are not ordered by increasing offset", () => {
    const profile = {
      identity: { profileId: "unordered", version: 1 },
      baseConfig,
      segments: [
        { offsetSeconds: 60, durationSeconds: 30, override: { maxTps: 5 } },
        { offsetSeconds: 30, durationSeconds: 30, override: { maxTps: 10 } },
      ],
      recoveryToBase: true as const,
    };
    expect(erpProfileSchema.safeParse(profile).success).toBe(false);
  });

  it("anchors the timeline at acceptance time plus the start delay", () => {
    const anchor = { acceptedAt: dispatchedAt, startDelaySeconds: 30 };
    expect(erpProfileAnchorSchema.parse(anchor)).toEqual(anchor);
    expect(erpProfileAnchorSchema.safeParse({ ...anchor, startDelaySeconds: -1 }).success).toBe(
      false,
    );
  });
});
