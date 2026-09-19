import { describe, expect, it } from "vitest";
import {
  erpErrorCodeSchema,
  erpErrorCodeValues,
  erpLookupResultSchema,
  erpLookupStatusSchema,
  erpLookupStatusValues,
  erpOutcomeDispositionSchema,
  erpOutcomeDispositionValues,
  erpPermanentRejectionCodeSchema,
  recognizedErpErrorCodeDispositions,
} from "../src/index.js";

const identity = {
  orderId: "1f0a92a7-46fb-4cf7-a3d5-6c5ea01b6f11",
  publicOrderId: "public-1",
  reservationId: "2b6f7b8e-9b0f-4a9a-9d5c-7b1d3c9a2f12",
  saleOfferId: "3c8a1c2d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
  idempotencyKey: "idem-1",
  quantity: 1,
};

describe("ERP outcome vocabulary", () => {
  it("declares the closed shared error-code vocabulary", () => {
    expect(erpErrorCodeValues).toEqual([
      "erp_capacity_exceeded",
      "erp_forced_outage",
      "erp_injected_error",
      "erp_idempotency_conflict",
    ]);
    expect(erpErrorCodeSchema.options).toEqual(erpErrorCodeValues);
    expect(erpLookupStatusValues).toEqual(["succeeded", "rejected", "unknown"]);
    expect(erpOutcomeDispositionValues).toEqual([
      "succeeded",
      "capacity_rejected",
      "temporarily_unavailable",
      "uncertain_result",
      "permanent_rejection",
      "intervention_required",
    ]);
    expect(erpOutcomeDispositionSchema.safeParse("business_rejection").success).toBe(false);
  });

  it("maps every recognized code to its disposition and nothing else", () => {
    expect(recognizedErpErrorCodeDispositions).toEqual({
      erp_capacity_exceeded: "capacity_rejected",
      erp_forced_outage: "temporarily_unavailable",
      erp_injected_error: "temporarily_unavailable",
      erp_idempotency_conflict: "intervention_required",
    });
    for (const [code, disposition] of Object.entries(recognizedErpErrorCodeDispositions)) {
      expect(erpErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(erpOutcomeDispositionSchema.safeParse(disposition).success).toBe(true);
    }
  });

  it("declares an empty permanent-rejection vocabulary", () => {
    expect(erpPermanentRejectionCodeSchema.options).toEqual([]);
  });

  it.each([
    "insufficient_funds",
    "idempotency_conflict",
    "unknown_code",
    "erp_capacity_exceeded",
    "erp_forced_outage",
    "erp_injected_error",
    "erp_idempotency_conflict",
    "invalid_request",
    "internal_error",
  ])("never classifies %s as a business rejection", (code) => {
    expect(erpPermanentRejectionCodeSchema.safeParse(code).success).toBe(false);
    expect(
      erpLookupResultSchema.safeParse({ identity, status: "rejected", errorCode: code }).success,
    ).toBe(false);
  });
});

describe("ERP status lookup contract", () => {
  it("parses a succeeded lookup with the canonical confirmation", () => {
    expect(
      erpLookupResultSchema.parse({ identity, status: "succeeded", confirmationId: "conf-1" }),
    ).toEqual({ identity, status: "succeeded", confirmationId: "conf-1" });
  });

  it("reports unknown from the queried key alone, without treating it as evidence of no effect", () => {
    expect(erpLookupResultSchema.parse({ status: "unknown" })).toEqual({ status: "unknown" });
    expect(erpLookupResultSchema.parse({ status: "unknown", idempotencyKey: "idem-1" })).toEqual({
      status: "unknown",
      idempotencyKey: "idem-1",
    });
    expect(erpLookupStatusSchema.safeParse("no_record").success).toBe(false);
  });

  it("keeps the immutable identity on terminal results only", () => {
    expect(
      erpLookupResultSchema.safeParse({ status: "succeeded", confirmationId: "conf-1" }).success,
    ).toBe(false);
    expect(erpLookupResultSchema.safeParse({ status: "unknown", ...identity }).success).toBe(false);
  });
});
