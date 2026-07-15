import type { DashboardEvent, InventoryStatus, QueueStatus } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardSnapshotPublicationScheduler } from "../src/services/dashboard-snapshot-publication-scheduler.js";

describe("DashboardSnapshotPublicationScheduler", () => {
  it("does no work on the sold-out loser path and coalesces a burst at 500 ms", async () => {
    vi.useFakeTimers();
    const readInventory = vi.fn().mockResolvedValue(
      inventoryFixture({ soldOutCount: 100, soldOutObservedAt: "2026-07-13T12:00:03.000Z" }),
    );
    const publish = vi.fn().mockResolvedValue(undefined);
    const scheduler = new DashboardSnapshotPublicationScheduler({
      readInventory,
      readQueue: vi.fn().mockResolvedValue(queueFixture()),
      publish,
      logger: createSilentLogger("api"),
    });
    for (let index = 0; index < 100; index += 1) scheduler.observeSoldOut(scope(`corr-${index}`));
    expect(readInventory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(499);
    expect(readInventory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await scheduler.flush();
    expect(readInventory).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dashboard.metric.observed",
        metricName: "inventory.sold_out_rejection",
        value: 100,
        occurredAt: "2026-07-13T12:00:03.000Z",
        correlationId: "corr-99",
      }),
    );
    await scheduler.close();
  });

  it("removes reset-run sold-out scopes before they can read or publish", async () => {
    vi.useFakeTimers();
    const readInventory = vi.fn().mockResolvedValue(inventoryFixture());
    const scheduler = new DashboardSnapshotPublicationScheduler({
      readInventory,
      readQueue: vi.fn().mockResolvedValue(queueFixture()),
      publish: vi.fn().mockResolvedValue(undefined),
      logger: createSilentLogger("api"),
    });
    scheduler.observeSoldOut(scope("corr-reset"));
    scheduler.clearRun(runId);
    await vi.advanceTimersByTimeAsync(500);
    await scheduler.flush();
    expect(readInventory).not.toHaveBeenCalled();
    await scheduler.close();
  });

  it("keeps sold-out run scopes isolated even when they share a sale offer", async () => {
    vi.useFakeTimers();
    const readInventory = vi.fn().mockResolvedValue(inventoryFixture());
    const scheduler = new DashboardSnapshotPublicationScheduler({
      readInventory,
      readQueue: vi.fn().mockResolvedValue(queueFixture()),
      publish: vi.fn().mockResolvedValue(undefined),
      logger: createSilentLogger("api"),
    });
    scheduler.observeSoldOut(scope("corr-first"));
    scheduler.observeSoldOut({
      ...scope("corr-second"),
      runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    await vi.advanceTimersByTimeAsync(500);
    await scheduler.flush();
    expect(readInventory).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });
  it("coalesces dirty scopes and publishes source-timestamped scalar observations", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const readInventory = vi.fn().mockResolvedValue(inventoryFixture());
    const readQueue = vi.fn().mockResolvedValue(queueFixture());
    const scheduler = new DashboardSnapshotPublicationScheduler({
      readInventory,
      readQueue,
      publish,
      logger: createSilentLogger("api"),
    });

    scheduler.scheduleInventory(scope("corr-first"));
    scheduler.scheduleInventory(scope("corr-latest"));
    scheduler.scheduleQueue({ runId: runId, correlationId: "corr-first" });
    scheduler.scheduleQueue({ runId: runId, correlationId: "corr-latest" });
    await scheduler.flush();

    expect(readInventory).toHaveBeenCalledOnce();
    expect(readQueue).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dashboard.metric.observed",
        metricName: "inventory.remaining",
        runId,
        correlationId: "corr-latest",
        occurredAt: inventoryFixture().lastUpdatedAt,
      }),
    );
    await scheduler.close();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dashboard.metric.observed",
        metricName: "queue.depth",
        runId,
        correlationId: "corr-latest",
        occurredAt: queueFixture().updatedAt,
        value: queueFixture().depth,
      }),
    );
  });

  it("retains a dirty signal observed during a single in-flight publication", async () => {
    let releaseFirst: (() => void) | undefined;
    const publish = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (releaseFirst = resolve)))
      .mockResolvedValue(undefined);
    const scheduler = new DashboardSnapshotPublicationScheduler({
      readInventory: vi.fn().mockResolvedValue(inventoryFixture()),
      readQueue: vi.fn().mockResolvedValue(queueFixture()),
      publish,
      logger: createSilentLogger("api"),
    });

    scheduler.scheduleInventory(scope("corr-first"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    scheduler.scheduleInventory(scope("corr-during-flight"));
    releaseFirst?.();
    await scheduler.flush();

    expect(publish).toHaveBeenCalledTimes(4);
    expect(publish.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ correlationId: "corr-during-flight" }),
    );
    await scheduler.close();
  });

  it("retains a sold-out observation during an in-flight sold-out publication", async () => {
    vi.useFakeTimers();
    let releaseFirst: (() => void) | undefined;
    let inFlight = 0;
    let maximumInFlight = 0;
    const publish = vi
      .fn()
      .mockImplementationOnce(async () => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await new Promise<void>((resolve) => (releaseFirst = resolve));
        inFlight -= 1;
      })
      .mockImplementation(async () => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        inFlight -= 1;
      });
    const readInventory = vi
      .fn()
      .mockResolvedValueOnce(
        inventoryFixture({ soldOutCount: 1, soldOutObservedAt: "2026-07-13T12:00:03.000Z" }),
      )
      .mockResolvedValueOnce(
        inventoryFixture({ soldOutCount: 2, soldOutObservedAt: "2026-07-13T12:00:04.000Z" }),
      );
    const scheduler = new DashboardSnapshotPublicationScheduler({
      readInventory,
      readQueue: vi.fn().mockResolvedValue(queueFixture()),
      publish,
      logger: createSilentLogger("api"),
    });

    scheduler.observeSoldOut(scope("corr-first"));
    await vi.advanceTimersByTimeAsync(500);
    await vi.runOnlyPendingTimersAsync();
    expect(publish).toHaveBeenCalledOnce();
    scheduler.observeSoldOut(scope("corr-during-flight"));
    await vi.advanceTimersByTimeAsync(500);
    expect(publish).toHaveBeenCalledOnce();

    releaseFirst?.();
    await scheduler.flush();

    expect(readInventory).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(4);
    expect(maximumInFlight).toBe(1);
    expect(publish.mock.calls[3]?.[0]).toEqual(
      expect.objectContaining({
        correlationId: "corr-during-flight",
        occurredAt: "2026-07-13T12:00:04.000Z",
        metricName: "inventory.sold_out_rejection",
        value: 2,
      }),
    );
    await scheduler.close();
  });

  it("refreshes one coherent queue snapshot per interval until a final drained snapshot", async () => {
    vi.useFakeTimers();
    const readQueue = vi
      .fn()
      .mockResolvedValueOnce(queueFixture({ depth: 2 }))
      .mockResolvedValueOnce(queueFixture({ depth: 0, active: 1 }))
      .mockResolvedValueOnce(queueFixture({ depth: 0, active: 0, failed: 1 }));
    const publish = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler({ readQueue, publish });

    scheduler.scheduleQueue({ runId, correlationId: "corr-queue" });
    await scheduler.flush();
    expect(readQueue).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2_000);
    await scheduler.flush();
    expect(readQueue).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    await scheduler.flush();
    expect(readQueue).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        type: "dashboard.metric.observed",
        metricName: "queue.depth",
        value: 0,
      }),
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await scheduler.flush();
    expect(readQueue).toHaveBeenCalledTimes(3);
    await scheduler.close();
  });

  it("keeps one queue timer and never overlaps refresh publication", async () => {
    vi.useFakeTimers();
    let releaseFirst: (() => void) | undefined;
    let inFlight = 0;
    let maximumInFlight = 0;
    const publish = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      if (publish.mock.calls.length === 1) {
        await new Promise<void>((resolve) => (releaseFirst = resolve));
      }
      inFlight -= 1;
    });
    const scheduler = createScheduler({ publish });

    scheduler.scheduleQueue({ runId, correlationId: "corr-first" });
    const firstFlush = scheduler.flush();
    await Promise.resolve();
    scheduler.scheduleQueue({ runId, correlationId: "corr-latest" });
    releaseFirst?.();
    await firstFlush;

    expect(publish).toHaveBeenCalledTimes(2);
    expect(maximumInFlight).toBe(1);
    expect(publish.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ correlationId: "corr-latest" }),
    );

    await vi.advanceTimersByTimeAsync(2_000);
    await scheduler.flush();
    expect(publish).toHaveBeenCalledTimes(3);
    expect(maximumInFlight).toBe(1);
    await scheduler.close();
  });

  it("cancels a pending queue refresh on close and does not reschedule while draining", async () => {
    vi.useFakeTimers();
    const readQueue = vi.fn().mockResolvedValue(queueFixture({ depth: 1 }));
    const scheduler = createScheduler({ readQueue });

    scheduler.scheduleQueue({ runId, correlationId: "corr-queue" });
    await scheduler.flush();
    await scheduler.close();
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.scheduleQueue({ runId, correlationId: "corr-after-close" });
    await scheduler.flush();

    expect(readQueue).toHaveBeenCalledOnce();
  });

  it("contains inspection and transport failures and closes without accepting new work", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("publish unavailable"));
    const scheduler = new DashboardSnapshotPublicationScheduler({
      readInventory: vi.fn().mockRejectedValue(new Error("inventory unavailable")),
      readQueue: vi.fn().mockResolvedValue(queueFixture()),
      publish,
      logger: createSilentLogger("api"),
    });

    scheduler.scheduleInventory(scope("corr-inventory"));
    scheduler.scheduleQueue({ correlationId: "corr-queue" });
    await expect(scheduler.close()).resolves.toBeUndefined();
    scheduler.scheduleQueue({ correlationId: "corr-after-close" });
    await scheduler.flush();

    expect(publish).toHaveBeenCalledOnce();
  });

  it("abandons later captured scopes when the close deadline expires", async () => {
    vi.useFakeTimers();
    let rejectFirst: (() => void) | undefined;
    const publish = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = () => reject(new Error("late dashboard failure"));
        }),
    );
    const scheduler = new DashboardSnapshotPublicationScheduler({
      readInventory: vi.fn().mockResolvedValue(inventoryFixture()),
      readQueue: vi.fn().mockResolvedValue(queueFixture()),
      publish,
      logger: createSilentLogger("api"),
      closeTimeoutMs: 25,
    });
    scheduler.scheduleInventory(scope("corr-hung"));
    scheduler.scheduleInventory({
      ...scope("corr-later"),
      saleOfferId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const closing = scheduler.close();
    await vi.advanceTimersByTimeAsync(25);
    await expect(closing).resolves.toBeUndefined();
    rejectFirst?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(publish).toHaveBeenCalledOnce();
  });

  it("flushes and awaits a pending sold-out observation on normal close", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const publish = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
      .mockResolvedValue(undefined);
    const scheduler = new DashboardSnapshotPublicationScheduler({
      readInventory: vi.fn().mockResolvedValue(inventoryFixture()),
      readQueue: vi.fn().mockResolvedValue(queueFixture()),
      publish,
      logger: createSilentLogger("api"),
    });
    scheduler.observeSoldOut(scope("corr-close"));
    let closed = false;
    const closing = scheduler.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(publish).toHaveBeenCalledOnce();
    expect(closed).toBe(false);
    release?.();
    await closing;
    expect(closed).toBe(true);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("logs and drops the oldest pending sold-out scope at the configured bound", async () => {
    vi.useFakeTimers();
    const logger = createSilentLogger("api");
    const warn = vi.spyOn(logger, "warn");
    const publish = vi.fn().mockResolvedValue(undefined);
    const scheduler = new DashboardSnapshotPublicationScheduler({
      readInventory: vi.fn().mockResolvedValue(inventoryFixture()),
      readQueue: vi.fn().mockResolvedValue(queueFixture()),
      publish,
      logger,
      maxPendingScopes: 1,
    });
    scheduler.observeSoldOut(scope("corr-oldest"));
    scheduler.observeSoldOut({
      ...scope("corr-newest"),
      runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    await scheduler.flush();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ maxPendingScopes: 1 }),
      expect.stringContaining("dropped the oldest scope"),
    );
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ correlationId: "corr-newest" }));
    await scheduler.close();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const saleOfferId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const runId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function scope(correlationId: string) {
  return { saleOfferId, runId, correlationId };
}

function inventoryFixture(
  options: { soldOutCount?: number; soldOutObservedAt?: string | null } = {},
): InventoryStatus {
  return {
    saleOfferId,
    allocatedStock: 10,
    remainingStock: 9,
    reservedStock: 1,
    pendingPersistenceCount: 0,
    expiredReservationCount: 0,
    oldestPendingPersistenceAgeSeconds: 0,
    reservationThroughput: {
      windowSeconds: 60,
      successfulReservationCount: 1,
      rate: 1 / 60,
      unit: "reservations_per_second",
      measuredAt: "2026-07-13T12:00:01.000Z",
    },
    soldOutPressure: {
      rejectionCount: options.soldOutCount ?? 0,
      latestObservedAt: options.soldOutObservedAt ?? null,
    },
    lastUpdatedAt: "2026-07-13T12:00:00.000Z",
  };
}

function queueFixture(
  options: { depth?: number; active?: number; failed?: number } = {},
): QueueStatus {
  const depth = options.depth ?? 1;
  const active = options.active ?? 0;
  const failed = options.failed ?? 0;
  return {
    name: "orders:process",
    connectivity: "reachable",
    depth,
    counts: { waiting: depth, prioritized: 0, paused: 0, delayed: 0, active, failed },
    oldestWaitingAgeSeconds: 0,
    retryPressure: {
      inspectedJobCount: depth + active,
      inspectionLimit: 100,
      retryingJobCount: 0,
      retryAttemptCount: 0,
      inspectionTruncated: false,
    },
    failedJobs: { totalCount: failed, recent: [], inspectionLimit: 20, inspectionTruncated: false },
    updatedAt: "2026-07-13T12:00:02.000Z",
  };
}

function createScheduler(
  options: {
    readQueue?: () => Promise<QueueStatus>;
    publish?: (event: DashboardEvent) => Promise<unknown>;
  } = {},
) {
  return new DashboardSnapshotPublicationScheduler({
    readInventory: vi.fn().mockResolvedValue(inventoryFixture()),
    readQueue: options.readQueue ?? vi.fn().mockResolvedValue(queueFixture()),
    publish: options.publish ?? vi.fn().mockResolvedValue(undefined),
    logger: createSilentLogger("api"),
    queueRefreshIntervalMs: 2_000,
  });
}
