import { describe, expect, it } from "vitest";
import { getErpCircuitBreakerSnapshotTtlSeconds } from "../../src/redis-erp-resilience.js";

describe("ERP circuit breaker snapshot TTL", () => {
  it("retains dashboard history and rounds reset-aware retention up safely", () => {
    expect(getErpCircuitBreakerSnapshotTtlSeconds({ resetTimeoutMs: 10_000 })).toBe(86_400);
    expect(getErpCircuitBreakerSnapshotTtlSeconds({ resetTimeoutMs: 43_200_001 })).toBe(86_402);
    expect(getErpCircuitBreakerSnapshotTtlSeconds({ resetTimeoutMs: 172_800_001 })).toBe(345_602);
  });

  it("saturates huge integer timeouts at a Redis-compatible safe TTL", () => {
    expect(
      getErpCircuitBreakerSnapshotTtlSeconds({ resetTimeoutMs: Number.MAX_SAFE_INTEGER }),
    ).toBe(Math.floor(Number.MAX_SAFE_INTEGER / 1_000));
  });
});
