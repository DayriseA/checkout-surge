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
    subscriber.on("message", (_channel, message) => {
      if (message.includes('"correlationId":"metric-30"')) messages.push(message);
    });
    await subscriber.subscribe(dashboardProjectionDirtyRedisChannel);

    await store.fenceRun(runA);
    await store.clearRun(runA);
    await store.clearRun(runA);

    expect(await store.readRecent(runA)).toEqual([]);
    expect(await store.readRecent(runB)).toHaveLength(1);
    const lateBatch = metricBatch(runA, 30);
    await expect(store.appendIfLive(lateBatch)).resolves.toBe("fenced");
    expect(
      await redis.sismember(`demo-run:${runA}:traffic-metric-batches`, lateBatch.batchId),
    ).toBe(0);
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
    expect(["appended", "fenced"]).toContain(results[0]);
    expect(await store.readRecent(runA)).toEqual([]);
    await expect(store.appendIfLive(metricBatch(runA, 40))).resolves.toBe("fenced");
  });

  it("suppresses publication when reset wins between retention and publication", async () => {
    const subscriber = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    const messages: string[] = [];
    subscriber.on("message", (_channel, message) => {
      if (message.includes('"correlationId":"metric-50"')) messages.push(message);
    });
    await subscriber.subscribe(dashboardProjectionDirtyRedisChannel);
    await expect(store.appendIfLive(metricBatch(runA, 50))).resolves.toBe("appended");
    await store.clearRun(runA);
    const publicationResult = await store.publishDirtyIfLive(runA, dirtySignal(50));

    await new Promise((resolve) => setImmediate(resolve));
    expect(publicationResult).toEqual({ outcome: "fenced" });
    expect(await store.readRecent(runA)).toEqual([]);
    expect(messages).toEqual([]);
    await subscriber.unsubscribe(dashboardProjectionDirtyRedisChannel);
    subscriber.disconnect();
  });

  it("recovers pinned surge evidence without collapsing recent arrival windows", async () => {
    await store.appendIfLive({
      batchId: "77777777-7777-4777-8777-777777777101",
      runId: runA,
      correlationId: "surge",
      samples: [
        {
          metricName: "traffic.request_arrival_rate",
          value: 1_000,
          unit: "requests_per_second",
          timestamp: "2026-07-13T00:00:00.000Z",
        },
        {
          metricName: "traffic.attempts_dispatched",
          value: 100,
          unit: "requests",
          timestamp: "2026-07-13T00:00:00.500Z",
        },
        {
          metricName: "traffic.attempts_dispatched",
          value: 1_000,
          unit: "requests",
          timestamp: "2026-07-13T00:00:00.500Z",
        },
      ],
      observedAt: "2026-07-13T00:00:00.500Z",
    });
    await store.appendIfLive({
      batchId: "77777777-7777-4777-8777-777777777102",
      runId: runA,
      correlationId: "slow-completions",
      samples: Array.from({ length: 100 }, (_, index) => ({
        metricName: ["traffic.response_completion_rate", "traffic.latency", "traffic.failure_rate"][
          index % 3
        ] as "traffic.response_completion_rate" | "traffic.latency" | "traffic.failure_rate",
        value: index % 3 === 2 ? 0.1 : index,
        unit: index % 3 === 0 ? "requests_per_second" : index % 3 === 1 ? "ms" : "ratio",
        timestamp: new Date(Date.UTC(2026, 6, 13, 0, 0, index + 1)).toISOString(),
      })),
      observedAt: "2026-07-13T00:01:40.000Z",
    });

    const restoredSurge = await store.readRecent(runA);
    expect(restoredSurge).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metricName: "traffic.request_arrival_rate",
          value: 1_000,
        }),
        expect.objectContaining({
          metricName: "traffic.attempts_dispatched",
          value: 1_000,
        }),
      ]),
    );
    expect(
      restoredSurge
        .filter((sample) => sample.metricName === "traffic.attempts_dispatched")
        .map((sample) => sample.value),
    ).toEqual([1_000]);

    await store.appendIfLive({
      batchId: "77777777-7777-4777-8777-777777777103",
      runId: runA,
      correlationId: "later-arrivals",
      samples: [20, 25, 30].map((value, index) => ({
        metricName: "traffic.request_arrival_rate" as const,
        value,
        unit: "requests_per_second",
        timestamp: new Date(Date.UTC(2026, 6, 13, 0, 2, index)).toISOString(),
      })),
      observedAt: "2026-07-13T00:02:02.000Z",
    });
    await store.appendIfLive({
      batchId: "77777777-7777-4777-8777-777777777104",
      runId: runA,
      correlationId: "later-churn",
      samples: Array.from({ length: 15 }, (_, index) => ({
        metricName: "traffic.response_completion_rate" as const,
        value: index,
        unit: "requests_per_second",
        timestamp: new Date(Date.UTC(2026, 6, 13, 0, 3, index)).toISOString(),
      })),
      observedAt: "2026-07-13T00:03:14.000Z",
    });

    const recovered = await store.readRecent(runA);
    expect(
      recovered
        .filter((sample) => sample.metricName === "traffic.request_arrival_rate")
        .map((sample) => sample.value),
    ).toEqual([20, 25, 30]);
    expect(
      recovered.filter((sample) => sample.metricName === "traffic.attempts_dispatched").at(-1)
        ?.value,
    ).toBe(1_000);
    expect(recovered).toHaveLength(21);

    await store.clearRun(runA);
    await expect(store.appendIfLive(metricBatch(runA, 30))).resolves.toBe("fenced");
    expect(await store.readRecent(runA)).toEqual([]);
    expect(await store.hasRunState(runA)).toBe(false);
  });

  it("stores a retried batch once while accepting identical samples under a new batch ID", async () => {
    const first = metricBatch(runA, 60);
    const second = { ...first, batchId: "77777777-7777-4777-8777-777777777061" };

    await expect(store.appendIfLive(first)).resolves.toBe("appended");
    await expect(store.appendIfLive(first)).resolves.toBe("duplicate");
    expect(await store.readRecent(runA)).toHaveLength(1);
    await expect(store.appendIfLive(second)).resolves.toBe("appended");
    expect(await store.readRecent(runA)).toHaveLength(2);
    expect(await redis.ttl(`demo-run:${runA}:traffic-metric-batches`)).toBeGreaterThan(0);
    await redis.del(`demo-run:${runA}:traffic-metrics`, `demo-run:${runA}:traffic-metrics-pinned`);
    expect(await store.hasRunState(runA)).toBe(true);

    await store.clearRun(runA);
    expect(await redis.exists(`demo-run:${runA}:traffic-metric-batches`)).toBe(0);
  });
});

function metricBatch(runId: string, value: number) {
  return {
    batchId: `77777777-7777-4777-8777-${value.toString().padStart(12, "0")}`,
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
