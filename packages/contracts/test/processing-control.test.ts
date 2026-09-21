import { describe, expect, it } from "vitest";
import {
  adaptiveErpAdmissionEnginePolicyIdentity,
  enginePolicyIdentitySchema,
  erpCallReferenceSchema,
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

  it("defines the single adaptive admission identity once and schema-valid", () => {
    expect(enginePolicyIdentitySchema.parse(adaptiveErpAdmissionEnginePolicyIdentity)).toEqual(
      adaptiveErpAdmissionEnginePolicyIdentity,
    );
  });
});
