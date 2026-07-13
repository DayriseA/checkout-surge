import type { CheckoutSurgeDatabase } from "@checkout-surge/db";
import { describe, expect, it, vi } from "vitest";
import { PostgresRunRetryPolicyResolver } from "../src/queue/postgres-run-retry-policy-resolver.js";

const snapshot = {
  trafficConfig: {
    mode: "buyer-spike",
    buyerCount: 1,
    duplicateEachBuyerAttempt: false,
    startDelaySeconds: 0,
    maxDurationSeconds: 1,
    quantityPerAttempt: 1,
  },
  inventoryConfig: { startingStock: 1, quantityPerCheckout: 1, reservationHoldMinutes: 1 },
  erpConfig: { latencyMs: 0, maxTps: 1, errorRate: 0, forcedOutage: false, requestTimeoutMs: 1 },
  backpressureConfig: {
    queueName: "orders:process",
    physicalQueueName: "orders-process",
    orderProcessConcurrency: 1,
    retryPolicy: { maxAttempts: 6, initialBackoffMs: 750 },
    drainTimeoutSeconds: 1,
    pendingPersistenceRetryAfterSeconds: 1,
    circuitBreakerFailureThreshold: 1,
    circuitBreakerResetTimeoutMs: 1,
  },
};

function databaseReturning(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return {
    db: { select: vi.fn(() => ({ from })) } as unknown as CheckoutSurgeDatabase,
    limit,
  };
}

describe("PostgresRunRetryPolicyResolver", () => {
  it("returns the exact frozen policy and null for a missing run", async () => {
    const found = databaseReturning([{ configSnapshot: snapshot }]);
    await expect(new PostgresRunRetryPolicyResolver(found.db).resolve("run-id")).resolves.toEqual({
      maxAttempts: 6,
      initialBackoffMs: 750,
    });
    const missing = databaseReturning([]);
    await expect(
      new PostgresRunRetryPolicyResolver(missing.db).resolve("run-id"),
    ).resolves.toBeNull();
  });

  it("rejects a malformed accepted snapshot", async () => {
    const malformed = databaseReturning([{ configSnapshot: { invalid: true } }]);
    await expect(
      new PostgresRunRetryPolicyResolver(malformed.db).resolve("run-id"),
    ).rejects.toThrow();
  });
});
