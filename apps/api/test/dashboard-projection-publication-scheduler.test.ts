import type {
  DashboardProjection,
  DashboardProjectionDirtySignal,
} from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardProjectionPublicationScheduler } from "../src/services/dashboard-projection-publication-scheduler.js";

describe("DashboardProjectionPublicationScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces producer dirty signals and publishes by the maximum-latency cadence", async () => {
    vi.useFakeTimers();
    const build = vi.fn(async ({ correlationId }) => projection(correlationId));
    const publish = vi.fn();
    const scheduler = createScheduler({ build, publish });

    for (let index = 0; index < 100; index += 1) {
      scheduler.markDirty(dirtySignal(`corr-${index}`));
    }

    await vi.advanceTimersByTimeAsync(999);
    expect(build).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(build).toHaveBeenCalledWith({
      correlationId: "corr-99",
      signal: expect.any(AbortSignal),
    });
    await scheduler.close();
  });

  it("bypasses the cadence for lifecycle and terminal transitions", async () => {
    vi.useFakeTimers();
    const build = vi.fn(async ({ correlationId, scope }) =>
      projection(correlationId, scope?.runId),
    );
    const scheduler = createScheduler({ build });

    scheduler.markDirty(exactSignal("corr-active"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    expect(build).toHaveBeenLastCalledWith({
      correlationId: "corr-active",
      signal: expect.any(AbortSignal),
      scope: { runId, saleOfferId },
    });

    scheduler.markDirty(exactSignal("corr-terminal"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    expect(build).toHaveBeenLastCalledWith({
      correlationId: "corr-terminal",
      signal: expect.any(AbortSignal),
      scope: { runId, saleOfferId },
    });
    await scheduler.close();
  });

  it("permits one build in flight and coalesces one latest trailing build", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    let inFlight = 0;
    let maximumInFlight = 0;
    const build = vi.fn(async ({ correlationId }) => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      if (build.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      inFlight -= 1;
      return projection(correlationId);
    });
    const scheduler = createScheduler({ build });

    scheduler.markDirty(dirtySignal("corr-first"));
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.markDirty(dirtySignal("corr-middle"));
    scheduler.markDirty(dirtySignal("corr-latest"));
    expect(build).toHaveBeenCalledOnce();

    releaseFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(build).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    expect(maximumInFlight).toBe(1);
    expect(build).toHaveBeenLastCalledWith({
      correlationId: "corr-latest",
      signal: expect.any(AbortSignal),
    });
    await scheduler.close();
  });

  it("retains a quiet dirty scope after failure until a later publication succeeds", async () => {
    vi.useFakeTimers();
    const build = vi
      .fn()
      .mockRejectedValueOnce(new Error("projection unavailable"))
      .mockResolvedValueOnce(projection("corr-final"));
    const publish = vi.fn();
    const scheduler = createScheduler({ build, publish });

    scheduler.markDirty(dirtySignal("corr-final"));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());
    expect(publish).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(build).toHaveBeenCalledTimes(2);
    await scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs a terminal trailing build immediately after an older build settles", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const build = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          await new Promise<DashboardProjection>((resolve) => {
            releaseFirst = () => resolve(projection("corr-first"));
          }),
      )
      .mockResolvedValueOnce(projection("corr-terminal", runId));
    const scheduler = createScheduler({ build });

    scheduler.markDirty(dirtySignal("corr-first"));
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.markDirty(exactSignal("corr-terminal"));
    expect(build).toHaveBeenCalledOnce();

    releaseFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    expect(build).toHaveBeenLastCalledWith({
      correlationId: "corr-terminal",
      signal: expect.any(AbortSignal),
      scope: { runId, saleOfferId },
    });
    await scheduler.close();
  });

  it("bounds pending scopes by dropping the oldest dirty scope", async () => {
    vi.useFakeTimers();
    const logger = createSilentLogger("api");
    const warn = vi.spyOn(logger, "warn");
    const build = vi.fn(async ({ correlationId }) => projection(correlationId));
    const scheduler = new DashboardProjectionPublicationScheduler({
      projectionService: { build } as never,
      publish: vi.fn(),
      logger,
      buildTimeoutMs: 5_000,
      maxPendingScopes: 1,
    });
    const newerRunId = "88888888-8888-4888-8888-888888888888";

    scheduler.markDirty(exactSignal("corr-oldest"));
    scheduler.markDirty(exactSignal("corr-newest", { runId: newerRunId, saleOfferId }));
    await scheduler.flush();

    expect(build).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledWith({
      correlationId: "corr-newest",
      signal: expect.any(AbortSignal),
      scope: { runId: newerRunId, saleOfferId },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ maxPendingScopes: 1 }),
      expect.stringContaining("dropped the oldest dirty scope"),
    );
    await scheduler.close();
  });

  it("retains a timed-out build for a one-second quiet retry", async () => {
    vi.useFakeTimers();
    let firstSignal: AbortSignal | undefined;
    const build = vi
      .fn()
      .mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
        firstSignal = signal;
        return await new Promise<DashboardProjection>(() => undefined);
      })
      .mockResolvedValueOnce(projection("corr-timeout"));
    const publish = vi.fn();
    const scheduler = createScheduler({ build, publish, buildTimeoutMs: 5_000 });

    scheduler.markDirty(dirtySignal("corr-timeout"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(build).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(firstSignal?.aborted).toBe(true);
    expect(publish).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(build).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(build).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });

  it("aborts an in-flight build during close without requeueing or accepting more work", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const build = vi.fn(async (input: { signal: AbortSignal }) => {
      signal = input.signal;
      return await new Promise<DashboardProjection>(() => undefined);
    });
    const scheduler = createScheduler({ build });

    scheduler.markDirty(exactSignal("corr-close"));
    await vi.advanceTimersByTimeAsync(0);
    expect(build).toHaveBeenCalledOnce();

    await expect(scheduler.close()).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
    scheduler.markDirty(dirtySignal("corr-after-close"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(build).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

const runId = "55555555-5555-4555-8555-555555555555";
const saleOfferId = "66666666-6666-4666-8666-666666666666";

function createScheduler(options: {
  build: (input: {
    correlationId: string;
    signal: AbortSignal;
    scope?: { runId: string; saleOfferId: string };
  }) => Promise<DashboardProjection>;
  publish?: (projection: DashboardProjection) => void;
  buildTimeoutMs?: number;
}) {
  return new DashboardProjectionPublicationScheduler({
    projectionService: { build: options.build } as never,
    publish: options.publish ?? vi.fn(),
    logger: createSilentLogger("api"),
    buildTimeoutMs: options.buildTimeoutMs ?? 5_000,
    maxLatencyMs: 1_000,
  });
}

function dirtySignal(correlationId: string): DashboardProjectionDirtySignal {
  return {
    type: "dashboard.projection.dirty",
    correlationId,
  };
}

function exactSignal(
  correlationId: string,
  scope: { runId: string; saleOfferId: string } = { runId, saleOfferId },
): DashboardProjectionDirtySignal {
  return {
    type: "dashboard.projection.dirty",
    correlationId,
    scope,
  };
}

function projection(correlationId: string, scopedRunId?: string): DashboardProjection {
  return {
    schema: "checkout-surge.dashboard-projection",
    version: 1,
    correlationId,
    scopeId: scopedRunId ? `run/${scopedRunId}/sale-offer/${saleOfferId}` : "idle",
    revision: 1,
    scope: null,
    recoveredAt: "2026-07-23T12:00:00.000Z",
    currentRun: null,
    inventory: null,
    recentMetrics: [],
    queue: null,
    erp: null,
    businessOutcome: null,
    consistencyLag: null,
    recentCompletionOutcomes: [],
    transportAttemptCounts: null,
  };
}
