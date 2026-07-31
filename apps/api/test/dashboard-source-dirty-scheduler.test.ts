import {
  type DashboardProjectionDirtySignal,
  dashboardLiveUpdateExpectedIntervalMs,
  type QueueStatus,
} from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardSourceDirtyScheduler } from "../src/services/dashboard-source-dirty-scheduler.js";

describe("DashboardSourceDirtyScheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces inventory work by scope into one internal dirty signal", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler({ publish });
    const request = {
      runId: "11111111-1111-4111-8111-111111111111",
      saleOfferId: "22222222-2222-4222-8222-222222222222",
      correlationId: "corr-inventory",
    };

    scheduler.scheduleInventory(request);
    scheduler.scheduleInventory(request);
    await scheduler.flush();

    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith({
      type: "dashboard.projection.dirty",
      correlationId: "corr-inventory",
    });
    await scheduler.close();
  });

  it("coalesces sold-out observations for the configured window", async () => {
    vi.useFakeTimers();
    const publish = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler({ publish, soldOutWindowMs: 50 });
    const request = {
      saleOfferId: "22222222-2222-4222-8222-222222222222",
      correlationId: "corr-sold-out",
    };

    scheduler.observeSoldOut(request);
    scheduler.observeSoldOut(request);
    await vi.advanceTimersByTimeAsync(49);
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    await scheduler.close();
  });

  it("keeps queue projection publication alive while work drains", async () => {
    vi.useFakeTimers();
    const readQueue = vi
      .fn()
      .mockResolvedValueOnce(queueStatus(2))
      .mockResolvedValueOnce(queueStatus(0));
    const publish = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler({ readQueue, publish, queueRefreshIntervalMs: 50 });

    scheduler.scheduleQueue({ correlationId: "corr-queue" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    expect(readQueue).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });

  it("uses the shared live-update cadence by default", async () => {
    vi.useFakeTimers();
    const publish = vi.fn().mockResolvedValue(undefined);
    const readQueue = vi
      .fn()
      .mockResolvedValueOnce(queueStatus(1))
      .mockResolvedValueOnce(queueStatus(0));
    const scheduler = createScheduler({ readQueue, publish });

    scheduler.scheduleQueue({ correlationId: "corr-shared-cadence" });
    await scheduler.flush();
    expect(publish).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(dashboardLiveUpdateExpectedIntervalMs - 1);
    expect(publish).toHaveBeenCalledOnce();
    expect(readQueue).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await scheduler.flush();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(readQueue).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });

  it("retains dirtiness received during an in-flight publish and remains single-flight", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    const publish = vi.fn(async (_signal: DashboardProjectionDirtySignal) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (publish.mock.calls.length === 1) {
        markFirstStarted();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      active -= 1;
    });
    const scheduler = createScheduler({ publish });

    scheduler.scheduleInventory({
      saleOfferId: "11111111-1111-4111-8111-111111111111",
      correlationId: "corr-first",
    });
    await firstStarted;
    scheduler.scheduleInventory({
      saleOfferId: "22222222-2222-4222-8222-222222222222",
      correlationId: "corr-during",
    });
    releaseFirst();
    await scheduler.flush();

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.map(([signal]) => signal.correlationId)).toEqual([
      "corr-first",
      "corr-during",
    ]);
    expect(maximumActive).toBe(1);
    await scheduler.close();
  });

  it("clearRun cancels pending sold-out dirtiness and the run queue refresh", async () => {
    vi.useFakeTimers();
    const runId = "11111111-1111-4111-8111-111111111111";
    const readQueue = vi.fn().mockResolvedValue(queueStatus(2));
    const publish = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler({
      readQueue,
      publish,
      queueRefreshIntervalMs: 50,
      soldOutWindowMs: 50,
    });

    scheduler.scheduleQueue({ runId, correlationId: "corr-queue" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    scheduler.observeSoldOut({
      runId,
      saleOfferId: "22222222-2222-4222-8222-222222222222",
      correlationId: "corr-sold-out",
    });

    scheduler.clearRun(runId);
    await vi.advanceTimersByTimeAsync(500);

    expect(readQueue).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    await scheduler.close();
  });

  it("uses one non-overlapping queue refresh timer through a slow drain", async () => {
    vi.useFakeTimers();
    let releaseSecond!: () => void;
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    const readQueue = vi
      .fn()
      .mockResolvedValueOnce(queueStatus(2))
      .mockResolvedValueOnce(queueStatus(1))
      .mockResolvedValueOnce(queueStatus(0));
    const publish = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (publish.mock.calls.length === 2) {
        markSecondStarted();
        await new Promise<void>((resolve) => {
          releaseSecond = resolve;
        });
      }
      active -= 1;
    });
    const scheduler = createScheduler({ readQueue, publish, queueRefreshIntervalMs: 50 });

    scheduler.scheduleQueue({ correlationId: "corr-queue" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(50);
    await secondStarted;
    await vi.advanceTimersByTimeAsync(500);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    releaseSecond();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(3));
    expect(maximumActive).toBe(1);
    await scheduler.close();
  });

  it("isolates publication and queue-read failures and does not launch work after close", async () => {
    vi.useFakeTimers();
    const logger = createSilentLogger("api");
    const error = vi.spyOn(logger, "error");
    const publish = vi.fn().mockRejectedValue(new Error("publication unavailable"));
    const readQueue = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const scheduler = createScheduler({ logger, publish, readQueue, queueRefreshIntervalMs: 50 });

    scheduler.scheduleInventory({
      saleOfferId: "11111111-1111-4111-8111-111111111111",
      correlationId: "corr-inventory",
    });
    scheduler.scheduleQueue({ correlationId: "corr-queue" });
    await expect(scheduler.flush()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);

    await scheduler.close();
    scheduler.scheduleQueue({ correlationId: "corr-after-close" });
    await vi.advanceTimersByTimeAsync(500);
    expect(readQueue).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds scopes and stops admission and timers on close", async () => {
    vi.useFakeTimers();
    const logger = createSilentLogger("api");
    const warn = vi.spyOn(logger, "warn");
    const publish = vi.fn().mockResolvedValue(undefined);
    const scheduler = new DashboardSourceDirtyScheduler({
      readQueue: async () => queueStatus(0),
      publish,
      logger,
      maxPendingScopes: 1,
    });

    scheduler.scheduleInventory({
      saleOfferId: "11111111-1111-4111-8111-111111111111",
      correlationId: "corr-old",
    });
    scheduler.scheduleInventory({
      saleOfferId: "22222222-2222-4222-8222-222222222222",
      correlationId: "corr-new",
    });
    await scheduler.close();
    scheduler.scheduleQueue({ correlationId: "corr-after-close" });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ maxPendingScopes: 1 }),
      expect.stringContaining("dropped the oldest scope"),
    );
    expect(publish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function createScheduler(
  overrides: Partial<ConstructorParameters<typeof DashboardSourceDirtyScheduler>[0]> = {},
) {
  return new DashboardSourceDirtyScheduler({
    readQueue: async () => queueStatus(0),
    publish: async () => undefined,
    logger: createSilentLogger("api"),
    ...overrides,
  });
}

function queueStatus(depth: number): QueueStatus {
  return {
    name: "orders:process",
    connectivity: "reachable",
    depth,
    counts: {
      waiting: depth,
      prioritized: 0,
      paused: 0,
      delayed: 0,
      active: 0,
      failed: 0,
    },
    oldestWaitingAgeSeconds: null,
    retryPressure: {
      inspectedJobCount: depth,
      inspectionLimit: 100,
      retryingJobCount: 0,
      retryAttemptCount: 0,
      inspectionTruncated: false,
    },
    failedJobs: {
      totalCount: 0,
      recent: [],
      inspectionLimit: 20,
      inspectionTruncated: false,
    },
    updatedAt: "2026-07-23T12:00:00.000Z",
  };
}
