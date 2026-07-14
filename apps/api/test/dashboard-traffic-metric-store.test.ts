import { dashboardEventsRedisChannel } from "@checkout-surge/contracts";
import { createRedisClient } from "@checkout-surge/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RedisDashboardTrafficMetricStore } from "../src/services/demo-run-service.js";

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
    await store.appendAndPublishIfLive(metricBatch(runA, 10), [metricEvent(runA, 10)]);
    await store.appendAndPublishIfLive(metricBatch(runB, 20), [metricEvent(runB, 20)]);
    const subscriber = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    const messages: string[] = [];
    subscriber.on("message", (_channel, message) => messages.push(message));
    await subscriber.subscribe(dashboardEventsRedisChannel);

    await store.fenceRun(runA);
    await store.clearRun(runA);
    await store.clearRun(runA);

    expect(await store.readRecent(runA)).toEqual([]);
    expect(await store.readRecent(runB)).toHaveLength(1);
    await expect(
      store.appendAndPublishIfLive(metricBatch(runA, 30), [metricEvent(runA, 30)]),
    ).resolves.toBe(false);
    expect(await store.readRecent(runA)).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(messages).toEqual([]);
    await subscriber.unsubscribe(dashboardEventsRedisChannel);
    subscriber.disconnect();
  });

  it("atomically lets either ingestion or reset win without post-clear recreation", async () => {
    const results = await Promise.all([
      store.appendAndPublishIfLive(metricBatch(runA, 10), [metricEvent(runA, 10)]),
      store.clearRun(runA),
    ]);
    expect([true, false]).toContain(results[0]);
    expect(await store.readRecent(runA)).toEqual([]);
    await expect(
      store.appendAndPublishIfLive(metricBatch(runA, 40), [metricEvent(runA, 40)]),
    ).resolves.toBe(false);
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

function metricEvent(runId: string, value: number) {
  return {
    type: "traffic.metric" as const,
    eventId: "77777777-7777-4777-8777-777777777777",
    runId,
    correlationId: `metric-${value}`,
    metricName: "traffic.latency" as const,
    value,
    unit: "ms",
    occurredAt: "2026-07-13T00:00:00.000Z",
  };
}

function requireTestRedisUrl(): string {
  const value = process.env.TEST_REDIS_URL;
  if (!value) throw new Error("TEST_REDIS_URL is required for API projection tests.");
  return value;
}
