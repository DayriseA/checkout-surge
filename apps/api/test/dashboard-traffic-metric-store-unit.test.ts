import type { CheckoutSurgeRedis } from "@checkout-surge/db";
import { describe, expect, it, vi } from "vitest";
import { RedisDashboardTrafficMetricStore } from "../src/services/dashboard-traffic-metric-store.js";

describe("RedisDashboardTrafficMetricStore", () => {
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
    const store = new RedisDashboardTrafficMetricStore({
      eval: vi.fn(async () => ["failed", "ERR forced publish failure"]),
    } as unknown as CheckoutSurgeRedis);

    await expect(store.publishDirtyIfLive(runId, dirtySignal("failed-outcome"))).resolves.toEqual({
      outcome: "failed",
      error: expect.objectContaining({ message: "ERR forced publish failure" }),
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
    batchId: "77777777-7777-4777-8777-777777777777",
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
