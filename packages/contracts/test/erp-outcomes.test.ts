import { describe, expect, it } from "vitest";
import {
  erpErrorCodeSchema,
  erpErrorCodeValues,
  erpLookupResultSchema,
  erpOutcomeDispositionSchema,
  erpOutcomeDispositionValues,
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
const canonicalSuccess = {
  status: "succeeded" as const,
  confirmationId: "conf-1",
  httpStatus: 200 as const,
  latencyMs: 25,
  timestamp: "2026-09-20T00:00:00.000Z",
};

describe("ERP outcome vocabulary", () => {
  it("declares the closed shared error-code vocabulary", () => {
    expect(erpErrorCodeValues).toEqual([
      "erp_capacity_exceeded",
      "erp_forced_outage",
      "erp_injected_error",
      "erp_idempotency_conflict",
    ]);
    expect(erpOutcomeDispositionValues).toEqual([
      "succeeded",
      "capacity_rejected",
      "temporarily_unavailable",
      "uncertain_result",
      "technical_failure",
    ]);
  });

  it("maps every recognized code to its disposition and nothing else", () => {
    expect(recognizedErpErrorCodeDispositions).toEqual({
      erp_capacity_exceeded: "capacity_rejected",
      erp_forced_outage: "temporarily_unavailable",
      erp_injected_error: "temporarily_unavailable",
      erp_idempotency_conflict: "technical_failure",
    });
    for (const [code, disposition] of Object.entries(recognizedErpErrorCodeDispositions)) {
      expect(erpErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(erpOutcomeDispositionSchema.safeParse(disposition).success).toBe(true);
    }
  });
});

describe("ERP status lookup contract", () => {
  it("parses a succeeded lookup with the canonical confirmation", () => {
    expect(
      erpLookupResultSchema.parse({ identity, status: "succeeded", result: canonicalSuccess }),
    ).toEqual({ identity, status: "succeeded", result: canonicalSuccess });
  });

  it("reports unknown from the queried key alone, without treating it as evidence of no effect", () => {
    expect(erpLookupResultSchema.parse({ status: "unknown" })).toEqual({ status: "unknown" });
    expect(erpLookupResultSchema.parse({ status: "unknown", idempotencyKey: "idem-1" })).toEqual({
      status: "unknown",
      idempotencyKey: "idem-1",
    });
  });

  it("keeps the immutable identity on terminal results only", () => {
    expect(
      erpLookupResultSchema.safeParse({ status: "succeeded", result: canonicalSuccess }).success,
    ).toBe(false);
    expect(erpLookupResultSchema.safeParse({ status: "unknown", ...identity }).success).toBe(false);
  });
});
