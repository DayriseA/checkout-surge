import { describe, expect, it } from "vitest";
import {
  erpCallReferenceSchema,
  erpDispatchMinimumWindowMs,
  erpDispatchRateLimit,
  erpDispatchSafetyMargin,
  idleErpDispatchLimits,
  processingGenerationSchema,
} from "../src/index.js";

const dispatchedAt = "2026-09-19T00:00:00.000Z";

describe("processing control contracts", () => {
  it.each([
    10,
    100,
    250,
    idleErpDispatchLimits.maxTps,
  ])("uses the smallest native burst with a sliding-second bound at %i TPS", (declared) => {
    const { max, duration } = erpDispatchRateLimit(declared);
    const effectiveRate = declared * (1 - erpDispatchSafetyMargin);
    expect(duration).toBeGreaterThanOrEqual(erpDispatchMinimumWindowMs);
    expect((max * 1_000) / duration).toBeLessThanOrEqual(effectiveRate);
    expect(Math.ceil(((max - 1) * 1_000) / effectiveRate)).toBeLessThan(erpDispatchMinimumWindowMs);
    // The leading window can contribute max - 1 late arrivals after its first
    // arrival has left the sliding second; subsequent first arrivals are duration apart.
    expect((Math.floor(1_000 / duration) + 2) * max - 1).toBeLessThanOrEqual(declared);
  });

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
});
