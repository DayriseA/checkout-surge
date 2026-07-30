import type { CheckoutSurgeRedis } from "@checkout-surge/db";
import { describe, expect, it, vi } from "vitest";
import { RedisDashboardTrafficMetricStore } from "../src/services/dashboard-traffic-metric-store.js";

describe("RedisDashboardTrafficMetricStore", () => {
  it("atomically appends a retained batch with a reset fence and bounded history", async () => {
    const evalCommand = vi.fn(async (..._args: unknown[]) => 1);
    const store = new RedisDashboardTrafficMetricStore({
      eval: evalCommand,
    } as unknown as CheckoutSurgeRedis);

    await expect(store.appendIfLive(batch("retained"))).resolves.toBe(true);

    expect(evalCommand).toHaveBeenCalledOnce();
    expect(evalCommand.mock.calls[0]?.[0]).toContain('redis.call("LTRIM", KEYS[1], -50, -1)');
    expect(evalCommand.mock.calls[0]?.[0]).toContain('redis.call("HSET", KEYS[3]');
    expect(evalCommand.mock.calls[0]?.[1]).toBe(3);
    expect(evalCommand.mock.calls[0]).toHaveLength(105);
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

  it("reports a failed aggregate dirty publication", async () => {
    const evalCommand = vi.fn(async (..._args: unknown[]) => [
      "failed",
      "ERR forced publish failure",
    ]);
    const store = new RedisDashboardTrafficMetricStore({
      eval: evalCommand,
    } as unknown as CheckoutSurgeRedis);

    await expect(store.publishDirtyIfLive(runId, dirtySignal("failed-outcome"))).resolves.toEqual({
      outcome: "failed",
      error: expect.objectContaining({ message: "ERR forced publish failure" }),
    });
    expect(evalCommand.mock.calls[0]).toHaveLength(5);
    expect(evalCommand.mock.calls[0]?.[0]).toContain('redis.pcall("PUBLISH"');
  });

  it.each([
    null,
    [],
    ["published", ""],
    ["unexpected"],
    ["failed", 1],
  ])("rejects malformed Redis publication results %#", async (result) => {
    const store = new RedisDashboardTrafficMetricStore({
      eval: vi.fn(async () => result),
    } as unknown as CheckoutSurgeRedis);

    await expect(store.publishDirtyIfLive(runId, dirtySignal("malformed"))).rejects.toThrow(
      "Redis returned an invalid traffic metric publication result.",
    );
  });

  it("suppresses publication when the run is fenced", async () => {
    const store = new RedisDashboardTrafficMetricStore({
      eval: vi.fn(async () => ["fenced"]),
    } as unknown as CheckoutSurgeRedis);

    await expect(store.publishDirtyIfLive(runId, dirtySignal("fenced"))).resolves.toEqual({
      outcome: "fenced",
    });
  });

  it("reports a successful single publication without indexed outcomes", async () => {
    const store = new RedisDashboardTrafficMetricStore({
      eval: vi.fn(async () => ["published"]),
    } as unknown as CheckoutSurgeRedis);

    await expect(store.publishDirtyIfLive(runId, dirtySignal("published"))).resolves.toEqual({
      outcome: "published",
    });
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

function dirtySignal(correlationId: string) {
  return {
    type: "dashboard.projection.dirty" as const,
    correlationId,
  };
}
