import type { AcceptedRunConfigSnapshot, OrderProcessJob } from "@checkout-surge/contracts";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RedisOrderProcessAdmission } from "../../src/queue/redis-order-process-admission.js";

const runA = "55555555-5555-4555-8555-555555555551";
const runB = "55555555-5555-4555-8555-555555555552";
const baseJob: OrderProcessJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test",
  reservationId: "33333333-3333-4333-8333-333333333333",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  correlationId: "corr-admission",
  quantity: 1,
  queuedAt: "2026-07-13T00:00:00.000Z",
};

function redisUrl() {
  if (!process.env.TEST_REDIS_URL) throw new Error("TEST_REDIS_URL is required");
  return process.env.TEST_REDIS_URL;
}

function snapshot(limit: number): AcceptedRunConfigSnapshot {
  return {
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
      orderProcessConcurrency: limit,
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
      drainTimeoutSeconds: 1,
      pendingPersistenceRetryAfterSeconds: 1,
      circuitBreakerFailureThreshold: 1,
      circuitBreakerResetTimeoutMs: 1,
    },
  };
}

describe("Redis order admission", () => {
  let redis: Redis;
  const adapters: RedisOrderProcessAdmission[] = [];

  beforeEach(async () => {
    redis = new Redis(redisUrl());
    await redis.flushdb();
  });
  afterEach(async () => {
    await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
    redis.disconnect();
  });

  function adapter(fallbackConcurrency = 1, leaseMs = 300) {
    const value = new RedisOrderProcessAdmission({
      redis,
      fallbackConcurrency,
      leaseMs,
      runConfigReader: {
        read: async (id) => (id === runA ? snapshot(1) : id === runB ? snapshot(2) : null),
      },
      keyPrefix: "test:admission",
    });
    adapters.push(value);
    return value;
  }

  it("shares atomic run limits across adapters while isolating runs and non-run work", async () => {
    const first = adapter();
    const second = adapter();
    const held = await first.tryAcquire({ ...baseJob, runId: runA });
    expect(held).not.toBeNull();
    expect(await second.tryAcquire({ ...baseJob, runId: runA })).toBeNull();
    expect(await second.tryAcquire({ ...baseJob, runId: runB })).not.toBeNull();
    expect(await second.tryAcquire(baseJob)).not.toBeNull();
    expect((await redis.keys("test:admission:*")).sort()).toEqual([
      "test:admission:non-run",
      `test:admission:run:${runA}`,
      `test:admission:run:${runB}`,
    ]);
  });

  it("reclaims expired owners and release is owner-checked, idempotent, and cleans idle keys", async () => {
    const admission = adapter();
    const key = `test:admission:run:${runA}`;
    await redis.zadd(key, Date.now() - 1000, "crashed-owner");
    const lease = await admission.tryAcquire({ ...baseJob, runId: runA });
    expect(lease).not.toBeNull();
    await redis.zadd(key, Date.now() + 10_000, "other-owner");
    await lease?.release();
    await lease?.release();
    expect(await redis.zrange(key, 0, -1)).toEqual(["other-owner"]);
    await redis.zrem(key, "other-owner");
    await admission.close();
  });

  it("renews held leases, closes them cleanly, and rejects missing run snapshots", async () => {
    const admission = adapter(1, 180);
    const key = `test:admission:run:${runA}`;
    await admission.tryAcquire({ ...baseJob, runId: runA });
    const before = Number(await redis.zscore(key, (await redis.zrange(key, 0, 0))[0] ?? ""));
    await new Promise((resolve) => setTimeout(resolve, 140));
    const after = Number(await redis.zscore(key, (await redis.zrange(key, 0, 0))[0] ?? ""));
    expect(after).toBeGreaterThan(before);
    await expect(
      admission.tryAcquire({ ...baseJob, runId: "55555555-5555-4555-8555-555555555559" }),
    ).rejects.toThrow("snapshot was not found");
    await admission.close();
    expect(await redis.exists(key)).toBe(0);
  });
});
