import type { CheckoutSurgeRedis } from "@checkout-surge/db";
import { describe, expect, it, vi } from "vitest";
import {
  maximumPendingMetricBatches,
  RedisDashboardTrafficMetricStore,
  type TrafficMetricPublishResult,
} from "../src/services/demo-run-service.js";

describe("RedisDashboardTrafficMetricStore command bound", () => {
  it("uses two Redis commands for a retained batch and keeps concurrent batches single-flight", async () => {
    let releaseFirst: (() => void) | undefined;
    let active = 0;
    let maximumActive = 0;
    const evalCommand = vi.fn().mockImplementation(async (...args: unknown[]) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (evalCommand.mock.calls.length === 1) {
        await new Promise<void>((resolve) => (releaseFirst = resolve));
      }
      active -= 1;
      return successfulRedisResult(args);
    });
    const redis = { eval: evalCommand } as unknown as CheckoutSurgeRedis;
    const store = new RedisDashboardTrafficMetricStore(redis);
    const first = store.appendAndPublishIfLive(batch("first"), publish(events("first")));
    const second = store.appendAndPublishIfLive(batch("second"), publish(events("second")));
    await Promise.resolve();
    expect(evalCommand).toHaveBeenCalledOnce();
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(evalCommand).toHaveBeenCalledTimes(4);
    expect(maximumActive).toBe(1);
    expect(evalCommand.mock.calls[0]?.[1]).toBe(2);
    expect(evalCommand.mock.calls[0]).toHaveLength(104);
    expect(evalCommand.mock.calls[1]?.[1]).toBe(2);
    expect(evalCommand.mock.calls[1]).toHaveLength(104);
  });

  it("drops the newest batch when the single-flight queue reaches ten batches", async () => {
    let release: (() => void) | undefined;
    const evalCommand = vi
      .fn()
      .mockImplementationOnce(() => new Promise<number>((resolve) => (release = () => resolve(1))));
    evalCommand.mockImplementation((...args: unknown[]) => successfulRedisResult(args));
    const store = new RedisDashboardTrafficMetricStore({
      eval: evalCommand,
    } as unknown as CheckoutSurgeRedis);
    const accepted = Array.from({ length: maximumPendingMetricBatches }, (_, index) =>
      store.appendAndPublishIfLive(
        batch(`accepted-${index}`),
        publish(events(`accepted-${index}`)),
      ),
    );
    await expect(
      store.appendAndPublishIfLive(batch("overflow"), publish(events("overflow"))),
    ).resolves.toBe("at_capacity");
    release?.();
    await expect(Promise.all(accepted)).resolves.toEqual(
      Array.from({ length: maximumPendingMetricBatches }, () => "accepted"),
    );
    expect(evalCommand).toHaveBeenCalledTimes(maximumPendingMetricBatches * 2);
  });

  it("propagates retention failure but continues later queued batches after publication rejection", async () => {
    const retentionFailure = new Error("retention unavailable");
    const publicationFailure = new Error("pubsub unavailable");
    const evalCommand = vi
      .fn()
      .mockRejectedValueOnce(retentionFailure)
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(publicationFailure)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(["attempted", ...Array.from({ length: 100 }, () => "")]);
    const store = new RedisDashboardTrafficMetricStore({
      eval: evalCommand,
    } as unknown as CheckoutSurgeRedis);
    const publishAfterRetentionFailure = vi.fn(publish(events("unused")));
    const publishFailure = vi.fn(
      async (publishIfLive: (payloads: string[]) => Promise<TrafficMetricPublishResult>) => {
        await publishIfLive(serializedEvents("publication-failure"));
      },
    );

    await expect(
      store.appendAndPublishIfLive(batch("retention-failure"), publishAfterRetentionFailure),
    ).rejects.toBe(retentionFailure);
    await expect(
      store.appendAndPublishIfLive(batch("publication-failure"), publishFailure),
    ).rejects.toBe(publicationFailure);
    await expect(
      store.appendAndPublishIfLive(batch("later-success"), publish(events("later-success"))),
    ).resolves.toBe("accepted");

    expect(publishAfterRetentionFailure).not.toHaveBeenCalled();
    expect(publishFailure).toHaveBeenCalledOnce();
    expect(evalCommand).toHaveBeenCalledTimes(5);
  });

  it("maps a failed publish by payload index while later payloads remain attempted", async () => {
    const evalCommand = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(["attempted", "", "ERR forced publish failure", ""]);
    const store = new RedisDashboardTrafficMetricStore({
      eval: evalCommand,
    } as unknown as CheckoutSurgeRedis);
    let publicationResult: TrafficMetricPublishResult | undefined;

    await store.appendAndPublishIfLive(batch("indexed-outcomes"), async (publishIfLive) => {
      publicationResult = await publishIfLive(serializedEvents("indexed-outcomes").slice(0, 3));
    });

    expect(publicationResult).toEqual({
      outcome: "attempted",
      failures: [
        { index: 1, error: expect.objectContaining({ message: "ERR forced publish failure" }) },
      ],
    });
    expect(evalCommand.mock.calls[1]).toHaveLength(7);
    expect(evalCommand.mock.calls[1]?.[0]).toContain('redis.pcall("PUBLISH"');
  });

  it("suppresses publication when reset wins between retention and publication", async () => {
    let fenced = false;
    const evalCommand = vi.fn(async (script: string, ...args: unknown[]) => {
      if (script.includes("RPUSH")) return fenced ? 0 : 1;
      return fenced ? ["fenced"] : successfulRedisResult([script, ...args]);
    });
    const transaction = {
      set: vi.fn(),
      del: vi.fn(),
      exec: vi.fn(async () => {
        fenced = true;
        return [];
      }),
    };
    transaction.set.mockReturnValue(transaction);
    transaction.del.mockReturnValue(transaction);
    const store = new RedisDashboardTrafficMetricStore({
      eval: evalCommand,
      multi: () => transaction,
    } as unknown as CheckoutSurgeRedis);
    let publicationResult: unknown;

    await expect(
      store.appendAndPublishIfLive(batch("reset-between-phases"), async (publishIfLive) => {
        await store.clearRun(runId);
        publicationResult = await publishIfLive(serializedEvents("reset-between-phases"));
      }),
    ).resolves.toBe("accepted");

    expect(publicationResult).toEqual({ outcome: "fenced" });
    expect(transaction.exec).toHaveBeenCalledOnce();
    expect(evalCommand).toHaveBeenCalledTimes(2);
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
  return batch(correlationId).samples.map((sample) => ({
    type: "dashboard.metric.observed" as const,
    runId,
    correlationId,
    metricName: sample.metricName,
    value: sample.value,
    unit: sample.unit,
    occurredAt: sample.timestamp,
    observedAt: sample.timestamp,
  }));
}

function serializedEvents(correlationId: string): string[] {
  return events(correlationId).map((event) => JSON.stringify(event));
}

function publish(eventBatch: ReturnType<typeof events>) {
  return async (publishIfLive: (payloads: string[]) => Promise<TrafficMetricPublishResult>) => {
    await publishIfLive(eventBatch.map((event) => JSON.stringify(event)));
  };
}

function successfulRedisResult(args: unknown[]): number | string[] {
  const script = args[0];
  if (typeof script !== "string" || !script.includes("redis.pcall")) return 1;
  return ["attempted", ...Array.from({ length: args.length - 4 }, () => "")];
}
