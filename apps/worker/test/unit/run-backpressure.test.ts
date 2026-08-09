import type { AcceptedRunConfigSnapshot, OrderProcessJob } from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { describe, expect, it, vi } from "vitest";
import { ErpCircuitBreaker } from "../../src/application/erp-circuit-breaker.js";
import type { OrderProcessDeliveryMetadata } from "../../src/application/order-process-job-handler.js";
import { RunScopedBackpressureOrderConfirmation } from "../../src/application/run-backpressure.js";

const job: OrderProcessJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test_1",
  reservationId: "33333333-3333-4333-8333-333333333333",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  runId: "44444444-4444-4444-8444-444444444444",
  correlationId: "corr-worker-backpressure-test",
  quantity: 1,
  queuedAt: "2026-06-21T00:00:00.000Z",
};
const delivery: OrderProcessDeliveryMetadata = {
  attemptNumber: 1,
  attemptsMade: 0,
  maxAttempts: 4,
};
const runId = "44444444-4444-4444-8444-444444444444";

describe("run-scoped order confirmation backpressure", () => {
  it("leaves concurrency admission to the queue boundary", async () => {
    const releases: Array<() => void> = [];
    let activeConfirmations = 0;
    let maxActiveConfirmations = 0;
    const inner = {
      confirm: vi.fn(async () => {
        activeConfirmations += 1;
        maxActiveConfirmations = Math.max(maxActiveConfirmations, activeConfirmations);
        await new Promise<void>((resolve) => releases.push(resolve));
        activeConfirmations -= 1;
      }),
    };
    const runConfigReader = {
      read: vi.fn().mockResolvedValue(
        runConfigSnapshot({
          orderProcessConcurrency: 1,
        }),
      ),
    };
    const confirmation = new RunScopedBackpressureOrderConfirmation({
      inner,
      runConfigReader,
    });

    const first = confirmation.confirm(job, delivery);
    await vi.waitFor(() => expect(inner.confirm).toHaveBeenCalledTimes(1));
    const second = confirmation.confirm(
      {
        ...job,
        orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        publicOrderId: "ord_test_2",
      },
      delivery,
    );

    await vi.waitFor(() => expect(inner.confirm).toHaveBeenCalledTimes(2));
    expect(maxActiveConfirmations).toBe(2);

    releases[0]?.();
    releases[1]?.();
    await Promise.all([first, second]);
  });

  it("isolates run breakers, reuses matching configuration, and uses fallback only without a snapshot", async () => {
    const fallback = { confirm: vi.fn().mockResolvedValue(undefined) };
    const created: Array<{ runId: string; threshold: number; confirm: ReturnType<typeof vi.fn> }> =
      [];
    const snapshots = new Map<string, AcceptedRunConfigSnapshot>([
      [runId, runConfigSnapshot()],
      [
        "55555555-5555-4555-8555-555555555555",
        runConfigSnapshot({
          circuitBreakerFailureThreshold: 2,
        }),
      ],
    ]);
    const confirmation = new RunScopedBackpressureOrderConfirmation({
      inner: fallback,
      runConfigReader: { read: vi.fn(async (runId) => snapshots.get(runId) ?? null) },
      circuitBreakerFactory: (snapshot, runId) => {
        const entry = {
          runId,
          threshold: snapshot.backpressureConfig.circuitBreakerFailureThreshold,
          confirm: vi.fn().mockResolvedValue(undefined),
        };
        created.push(entry);
        return entry;
      },
    });

    await confirmation.confirm(job, delivery);
    await confirmation.confirm(job, delivery);
    await confirmation.confirm({ ...job, runId: "55555555-5555-4555-8555-555555555555" }, delivery);
    expect(created.map(({ runId, threshold }) => ({ runId, threshold }))).toEqual([
      { runId: job.runId, threshold: 5 },
      { runId: "55555555-5555-4555-8555-555555555555", threshold: 2 },
    ]);
    expect(created[0]?.confirm).toHaveBeenCalledTimes(2);

    snapshots.set(
      runId,
      runConfigSnapshot({
        circuitBreakerResetTimeoutMs: 20_000,
      }),
    );
    await confirmation.confirm(job, delivery);
    expect(created).toHaveLength(3);

    await confirmation.confirm({ ...job, runId: undefined }, delivery);
    await confirmation.confirm({ ...job, runId: "66666666-6666-4666-8666-666666666666" }, delivery);
    expect(fallback.confirm).toHaveBeenCalledTimes(2);
  });

  it("uses independent real breakers and snapshot thresholds instead of fallback configuration", async () => {
    let nowMs = Date.parse("2026-06-21T00:00:00.000Z");
    const dependencyFailure = new Error("temporary dependency failure");
    const runA = runId;
    const runB = "55555555-5555-4555-8555-555555555555";
    const delegate = vi.fn(async (currentJob: OrderProcessJob) => {
      if (currentJob.runId === runA) throw dependencyFailure;
    });
    const breakers = new Map<string, ErpCircuitBreaker>();
    const fallbackDelegate = vi.fn().mockRejectedValue(dependencyFailure);
    const fallback = new ErpCircuitBreaker({
      confirmation: { confirm: fallbackDelegate },
      failureThreshold: 5,
      resetTimeoutMs: 50_000,
      isCountedFailure: () => true,
      now: () => new Date(nowMs),
    });
    const snapshots = new Map([
      [
        runA,
        runConfigSnapshot({
          circuitBreakerFailureThreshold: 2,
          circuitBreakerResetTimeoutMs: 1_000,
        }),
      ],
      [
        runB,
        runConfigSnapshot({
          circuitBreakerFailureThreshold: 3,
          circuitBreakerResetTimeoutMs: 2_000,
        }),
      ],
    ]);
    const confirmation = new RunScopedBackpressureOrderConfirmation({
      inner: fallback,
      runConfigReader: { read: async (id) => snapshots.get(id) ?? null },
      circuitBreakerFactory: (snapshot, id) => {
        const breaker = new ErpCircuitBreaker({
          confirmation: { confirm: delegate },
          failureThreshold: snapshot.backpressureConfig.circuitBreakerFailureThreshold,
          resetTimeoutMs: snapshot.backpressureConfig.circuitBreakerResetTimeoutMs,
          isCountedFailure: () => true,
          now: () => new Date(nowMs),
        });
        breakers.set(id, breaker);
        return breaker;
      },
      now: () => new Date(nowMs),
    });

    await expect(confirmation.confirm(job, delivery)).rejects.toBe(dependencyFailure);
    await expect(confirmation.confirm(job, delivery)).rejects.toBe(dependencyFailure);
    expect(breakers.get(runA)?.snapshot()).toMatchObject({
      state: "open",
      failureThreshold: 2,
      resetTimeoutMs: 1_000,
      nextAttemptAt: "2026-06-21T00:00:01.000Z",
    });
    await expect(confirmation.confirm({ ...job, runId: runB }, delivery)).resolves.toBeUndefined();
    expect(breakers.get(runB)?.snapshot()).toMatchObject({
      state: "closed",
      consecutiveFailureCount: 0,
    });

    await expect(confirmation.confirm({ ...job, runId: undefined }, delivery)).rejects.toBe(
      dependencyFailure,
    );
    expect(fallback.snapshot()).toMatchObject({
      state: "closed",
      consecutiveFailureCount: 1,
      failureThreshold: 5,
    });
    await expect(confirmation.confirm(job, delivery)).rejects.toMatchObject({
      name: "ErpCircuitOpenError",
      retryAfterMs: 1_000,
    });
    expect(delegate).toHaveBeenCalledTimes(3);
    nowMs += 1_000;
    await expect(confirmation.confirm(job, delivery)).rejects.toBe(dependencyFailure);
    expect(breakers.get(runA)?.snapshot()).toMatchObject({
      state: "open",
      nextAttemptAt: "2026-06-21T00:00:02.000Z",
    });
  });

  it("reads run configuration at most once and falls back for absent scope or snapshot", async () => {
    const read = vi.fn(async (requestedRunId: string) =>
      requestedRunId === runId ? runConfigSnapshot() : null,
    );
    const fallback = { confirm: vi.fn().mockResolvedValue(undefined) };
    const runConfirmation = { confirm: vi.fn().mockResolvedValue(undefined) };
    const onMissingRunSnapshot = vi.fn().mockRejectedValue(new Error("reporting unavailable"));
    const confirmation = new RunScopedBackpressureOrderConfirmation({
      inner: fallback,
      runConfigReader: { read },
      circuitBreakerFactory: () => runConfirmation,
      onMissingRunSnapshot,
    });
    await confirmation.confirm(job, delivery);
    expect(read).toHaveBeenCalledTimes(1);
    expect(runConfirmation.confirm).toHaveBeenCalledOnce();
    expect(onMissingRunSnapshot).not.toHaveBeenCalled();
    await confirmation.confirm({ ...job, runId: "66666666-6666-4666-8666-666666666666" }, delivery);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onMissingRunSnapshot).toHaveBeenCalledOnce();
    expect(onMissingRunSnapshot).toHaveBeenCalledWith("66666666-6666-4666-8666-666666666666");
    const { runId: _runId, ...catalogJob } = job;
    await confirmation.confirm(catalogJob, delivery);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onMissingRunSnapshot).toHaveBeenCalledOnce();
    expect(fallback.confirm).toHaveBeenCalledTimes(2);
  });

  it("retains entries across semaphore waits and reset admission, then lazily evicts expired idle entries", async () => {
    let nowMs = 0;
    const releases: Array<() => void> = [];
    const factory = vi.fn(() => ({
      confirm: () => new Promise<void>((resolve) => releases.push(resolve)),
    }));
    const confirmation = new RunScopedBackpressureOrderConfirmation({
      inner: { confirm: vi.fn() },
      runConfigReader: {
        read: async () =>
          runConfigSnapshot({
            orderProcessConcurrency: 1,
            circuitBreakerResetTimeoutMs: 100,
          }),
      },
      circuitBreakerFactory: factory,
      breakerRetentionMs: 10,
      now: () => new Date(nowMs),
    });
    const first = confirmation.confirm(job, delivery);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = confirmation.confirm(
      { ...job, orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      delivery,
    );
    nowMs = 1_000;
    const other = confirmation.confirm(
      { ...job, runId: "55555555-5555-4555-8555-555555555555" },
      delivery,
    );
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()?.();
    releases.shift()?.();
    await Promise.all([first, second, other]);
    nowMs = 1_150;
    const retainedForResetAdmission = confirmation.confirm(job, delivery);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(factory).toHaveBeenCalledTimes(2);
    releases.shift()?.();
    await retainedForResetAdmission;
    nowMs = 1_350;
    const third = confirmation.confirm(
      { ...job, runId: "66666666-6666-4666-8666-666666666666" },
      delivery,
    );
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(factory).toHaveBeenCalledTimes(3);
    releases.shift()?.();
    await third;
    const recreated = confirmation.confirm(job, delivery);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(factory).toHaveBeenCalledTimes(4);
    releases.shift()?.();
    await recreated;
  });
});

function runConfigSnapshot(
  backpressureOverrides: Partial<AcceptedRunConfigSnapshot["backpressureConfig"]> = {},
): AcceptedRunConfigSnapshot {
  const snapshot = previewRunConfigSnapshotFixture();

  return {
    ...snapshot,
    backpressureConfig: {
      ...snapshot.backpressureConfig,
      ...backpressureOverrides,
    },
  };
}
