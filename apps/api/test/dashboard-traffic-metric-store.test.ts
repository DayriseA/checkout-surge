import { createRedisClient, dashboardProjectionDirtyRedisChannel } from "@checkout-surge/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RedisDashboardTrafficMetricStore } from "../src/services/dashboard-traffic-metric-store.js";

const runA = "55555555-5555-4555-8555-555555555551";
const runB = "55555555-5555-4555-8555-555555555552";

describe("Redis dashboard traffic metric reset", () => {
  const redis = createRedisClient(requireTestRedisUrl(), {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  const store = new RedisDashboardTrafficMetricStore(redis);

  beforeEach(async () => redis.flushdb());
  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  it("clears one run idempotently without touching another and drops late ingestion", async () => {
    await store.appendIfLive(metricBatch(runA, 10));
    await store.publishDirtyIfLive(runA, dirtySignal(10));
    await store.appendIfLive(metricBatch(runB, 20));
    await store.publishDirtyIfLive(runB, dirtySignal(20));
    const subscriber = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    const messages: string[] = [];
    subscriber.on("message", (_channel, message) => messages.push(message));
    await subscriber.subscribe(dashboardProjectionDirtyRedisChannel);

    await store.fenceRun(runA);
    await store.clearRun(runA);
    await store.clearRun(runA);

    expect(await store.readRecent(runA)).toEqual([]);
    expect(await store.readRecent(runB)).toHaveLength(1);
    await expect(store.appendIfLive(metricBatch(runA, 30))).resolves.toBe(false);
    expect(await store.readRecent(runA)).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(messages).toEqual([]);
    await subscriber.unsubscribe(dashboardProjectionDirtyRedisChannel);
    subscriber.disconnect();
  });

  it("lets either retention or reset win without post-clear recreation", async () => {
    const results = await Promise.all([
      store.appendIfLive(metricBatch(runA, 10)),
      store.clearRun(runA),
    ]);
    expect([true, false]).toContain(results[0]);
    expect(await store.readRecent(runA)).toEqual([]);
    await expect(store.appendIfLive(metricBatch(runA, 40))).resolves.toBe(false);
  });

  it("suppresses publication when reset wins between retention and publication", async () => {
    const subscriber = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    const messages: string[] = [];
    subscriber.on("message", (_channel, message) => messages.push(message));
    await subscriber.subscribe(dashboardProjectionDirtyRedisChannel);
    await expect(store.appendIfLive(metricBatch(runA, 50))).resolves.toBe(true);
    await store.clearRun(runA);
    const publicationResult = await store.publishDirtyIfLive(runA, dirtySignal(50));

    await new Promise((resolve) => setImmediate(resolve));
    expect(publicationResult).toEqual({ outcome: "fenced" });
    expect(await store.readRecent(runA)).toEqual([]);
    expect(messages).toEqual([]);
    await subscriber.unsubscribe(dashboardProjectionDirtyRedisChannel);
    subscriber.disconnect();
  });
});

function metricBatch(runId: string, value: number) {
  return {
    runId,
    correlationId: `metric-${value}`,
    samples: [
      {
        metricName: "traffic.latency" as const,
        value,
        unit: "ms",
        timestamp: "2026-07-13T00:00:00.000Z",
      },
    ],
    observedAt: "2026-07-13T00:00:00.000Z",
  };
}

function dirtySignal(value: number) {
  return {
    type: "dashboard.projection.dirty" as const,
    correlationId: `metric-${value}`,
  };
}

function requireTestRedisUrl(): string {
  const value = process.env.TEST_REDIS_URL;
  if (!value) throw new Error("TEST_REDIS_URL is required for API projection tests.");
  return value;
}
