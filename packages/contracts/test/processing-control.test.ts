import { describe, expect, it } from "vitest";
import { SlidingWindowTpsLimiter } from "../../../apps/mock-erp/src/application/tps-limiter.js";
import {
  catalogErpDispatchLimits,
  enginePolicyIdentitySchema,
  erpCallReferenceSchema,
  erpDispatchEnginePolicyIdentity,
  erpDispatchMinimumWindowMs,
  erpDispatchRateLimit,
  erpDispatchSafetyMargin,
  processingGenerationSchema,
} from "../src/index.js";

const dispatchedAt = "2026-09-19T00:00:00.000Z";

describe("processing control contracts", () => {
  it.each([
    10,
    100,
    250,
    catalogErpDispatchLimits.maxTps,
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

  it("includes late arrivals from the leading native window in the sliding-second bound", () => {
    const { max, duration } = erpDispatchRateLimit(250);
    const arrivals = [0, ...Array<number>(max - 1).fill(duration - 1)];
    for (let start = duration; start <= 1_012; start += duration) {
      arrivals.push(...Array<number>(max).fill(start));
    }
    let now = 0;
    const limiter = new SlidingWindowTpsLimiter({ nowMs: () => now });
    let windowStart = 0;
    let nativeCount = 0;
    for (const at of arrivals) {
      if (at - windowStart >= duration) {
        windowStart = at;
        nativeCount = 0;
      }
      expect(++nativeCount).toBeLessThanOrEqual(max);
      now = at;
      expect(limiter.acquire("run", 250)).toBe(true);
    }
    const slidingCount = arrivals.filter((at) => now - at < 1_000).length;
    expect(slidingCount).toBe(234);
    expect(slidingCount).toBe((Math.floor(1_000 / duration) + 2) * max - 1);
  });

  it("accepts exactly the mock capacity and expires arrivals at exactly one second", () => {
    let now = 0;
    const limiter = new SlidingWindowTpsLimiter({ nowMs: () => now });
    expect(Array.from({ length: 10 }, () => limiter.acquire("catalog", 10))).toEqual(
      Array(10).fill(true),
    );
    expect(limiter.acquire("catalog", 10)).toBe(false);
    now = 1_000;
    expect(limiter.acquire("catalog", 10)).toBe(true);
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

  it("defines the single declared-capacity dispatch identity once and schema-valid", () => {
    expect(enginePolicyIdentitySchema.parse(erpDispatchEnginePolicyIdentity)).toEqual(
      erpDispatchEnginePolicyIdentity,
    );
  });
});
