import type { CheckoutSurgeRedis } from "@checkout-surge/db";
import { describe, expect, it, vi } from "vitest";
import {
  maximumPendingMetricBatches,
  RedisDashboardTrafficMetricStore,
} from "../src/services/demo-run-service.js";

describe("RedisDashboardTrafficMetricStore command bound", () => {
  it("uses one Redis command for a full batch and keeps concurrent batches single-flight", async () => {
    let releaseFirst: (() => void) | undefined;
    let active = 0;
    let maximumActive = 0;
    const evalCommand = vi.fn().mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (evalCommand.mock.calls.length === 1) {
        await new Promise<void>((resolve) => (releaseFirst = resolve));
      }
      active -= 1;
      return 1;
    });
    const redis = { eval: evalCommand } as unknown as CheckoutSurgeRedis;
    const store = new RedisDashboardTrafficMetricStore(redis);
    const first = store.appendAndPublishIfLive(batch("first"), events("first"));
    const second = store.appendAndPublishIfLive(batch("second"), events("second"));
    await Promise.resolve();
    expect(evalCommand).toHaveBeenCalledOnce();
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(evalCommand).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
    expect(evalCommand.mock.calls[0]?.[5]).toBe("100");
  });

  it("drops the newest batch when the single-flight queue reaches ten batches", async () => {
    let release: (() => void) | undefined;
    const evalCommand = vi.fn().mockImplementationOnce(
      () => new Promise<number>((resolve) => (release = () => resolve(1))),
    );
    evalCommand.mockResolvedValue(1);
    const store = new RedisDashboardTrafficMetricStore({
      eval: evalCommand,
    } as unknown as CheckoutSurgeRedis);
    const accepted = Array.from({ length: maximumPendingMetricBatches }, (_, index) =>
      store.appendAndPublishIfLive(batch(`accepted-${index}`), events(`accepted-${index}`)),
    );
    await expect(
      store.appendAndPublishIfLive(batch("overflow"), events("overflow")),
    ).resolves.toBe(false);
    release?.();
    await expect(Promise.all(accepted)).resolves.toEqual(
      Array.from({ length: maximumPendingMetricBatches }, () => true),
    );
    expect(evalCommand).toHaveBeenCalledTimes(maximumPendingMetricBatches);
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

function events(correlationId: string) {
  return batch(correlationId).samples.map((sample, index) => ({
    type: "traffic.metric" as const,
    eventId: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`,
    runId,
    correlationId,
    metricName: sample.metricName,
    value: sample.value,
    unit: sample.unit,
    occurredAt: sample.timestamp,
  }));
}
