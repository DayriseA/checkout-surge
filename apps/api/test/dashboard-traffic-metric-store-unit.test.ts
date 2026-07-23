import type { CheckoutSurgeRedis } from "@checkout-surge/db";
import { describe, expect, it, vi } from "vitest";
import {
  RedisDashboardTrafficMetricStore,
  type TrafficMetricPublishResult,
} from "../src/services/dashboard-traffic-metric-store.js";

describe("RedisDashboardTrafficMetricStore", () => {
  it("atomically appends a retained batch with a reset fence and bounded history", async () => {
    const evalCommand = vi.fn(async (..._args: unknown[]) => 1);
    const store = new RedisDashboardTrafficMetricStore({
      eval: evalCommand,
    } as unknown as CheckoutSurgeRedis);

    await expect(store.appendIfLive(batch("retained"))).resolves.toBe(true);

    expect(evalCommand).toHaveBeenCalledOnce();
    expect(evalCommand.mock.calls[0]?.[0]).toContain('redis.call("LTRIM", KEYS[1], -50, -1)');
    expect(evalCommand.mock.calls[0]?.[1]).toBe(2);
    expect(evalCommand.mock.calls[0]).toHaveLength(104);
  });

  it("reports a fenced append without retaining samples", async () => {
    const store = new RedisDashboardTrafficMetricStore({
      eval: vi.fn(async () => 0),
    } as unknown as CheckoutSurgeRedis);

    await expect(store.appendIfLive(batch("fenced"))).resolves.toBe(false);
  });

  it("propagates retention failures", async () => {
    const retentionError = new Error("retention unavailable");
    const store = new RedisDashboardTrafficMetricStore({
      eval: vi.fn(async () => {
        throw retentionError;
      }),
    } as unknown as CheckoutSurgeRedis);

    await expect(store.appendIfLive(batch("retention-failure"))).rejects.toBe(retentionError);
  });

  it("maps a failed publish by payload index while later payloads remain attempted", async () => {
    const evalCommand = vi.fn(async (..._args: unknown[]) => [
      "attempted",
      "",
      "ERR forced publish failure",
      "",
    ]);
    const store = new RedisDashboardTrafficMetricStore({
      eval: evalCommand,
    } as unknown as CheckoutSurgeRedis);

    await expect(
      store.publishIfLive(runId, serializedEvents("indexed-outcomes").slice(0, 3)),
    ).resolves.toEqual({
      outcome: "attempted",
      failures: [
        { index: 1, error: expect.objectContaining({ message: "ERR forced publish failure" }) },
      ],
    });
    expect(evalCommand.mock.calls[0]).toHaveLength(7);
    expect(evalCommand.mock.calls[0]?.[0]).toContain('redis.pcall("PUBLISH"');
  });

  it.each([
    null,
    [],
    ["attempted"],
    ["unexpected", ""],
    ["attempted", 1],
  ])("rejects malformed Redis publication results %#", async (result) => {
    const store = new RedisDashboardTrafficMetricStore({
      eval: vi.fn(async () => result),
    } as unknown as CheckoutSurgeRedis);

    await expect(store.publishIfLive(runId, ["event"])).rejects.toThrow(
      "Redis returned an invalid traffic metric publication result.",
    );
  });

  it("suppresses publication when the run is fenced", async () => {
    const store = new RedisDashboardTrafficMetricStore({
      eval: vi.fn(async () => ["fenced"]),
    } as unknown as CheckoutSurgeRedis);

    await expect(store.publishIfLive(runId, ["event"])).resolves.toEqual({ outcome: "fenced" });
  });

  it("does not issue Redis work for an empty publication", async () => {
    const evalCommand = vi.fn();
    const store = new RedisDashboardTrafficMetricStore({
      eval: evalCommand,
    } as unknown as CheckoutSurgeRedis);

    const result: TrafficMetricPublishResult = await store.publishIfLive(runId, []);

    expect(result).toEqual({ outcome: "attempted", failures: [] });
    expect(evalCommand).not.toHaveBeenCalled();
  });
});

const runId = "55555555-5555-4555-8555-555555555551";
const observedAt = "2026-07-13T00:00:00.000Z";

function batch(correlationId: string) {
  return {
    runId,
    correlationId,
    samples: Array.from({ length: 100 }, (_, value) => ({
      metricName: "traffic.latency" as const,
      value,
      unit: "ms",
      timestamp: observedAt,
    })),
    observedAt,
  };
}

function serializedEvents(correlationId: string): string[] {
  return batch(correlationId).samples.map((sample) =>
    JSON.stringify({
      type: "dashboard.metric.observed",
      runId,
      correlationId,
      metricName: sample.metricName,
      value: sample.value,
      unit: sample.unit,
      occurredAt: sample.timestamp,
      observedAt: sample.timestamp,
    }),
  );
}
