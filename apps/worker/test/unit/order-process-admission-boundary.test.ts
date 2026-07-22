import type { AcceptedRunConfigSnapshot, OrderProcessJob } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { DelayedError, type Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { ProcessLocalOrderProcessAdmission } from "../../src/application/order-process-admission.js";
import { processJob } from "../../src/queue/bullmq-order-process-consumer.js";

const data: OrderProcessJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test",
  reservationId: "33333333-3333-4333-8333-333333333333",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  correlationId: "corr-admission",
  quantity: 1,
  queuedAt: "2026-07-13T00:00:00.000Z",
};

function bullJob(overrides: Record<string, unknown> = {}) {
  return {
    id: data.orderId,
    name: "order.process",
    data,
    attemptsMade: 2,
    opts: { attempts: 7 },
    moveToDelayed: vi.fn(),
    ...overrides,
  } as unknown as Job<OrderProcessJob, void, "order.process">;
}

function snapshot(orderProcessConcurrency: number): AcceptedRunConfigSnapshot {
  return {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 1,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 1,
      quantityPerAttempt: 1,
    },
    inventoryConfig: { startingStock: 1, quantityPerCheckout: 1, reservationHoldMinutes: 1 },
    erpConfig: { latencyMs: 0, maxTps: 1, errorRate: 0, forcedOutage: false, requestTimeoutMs: 1 },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency,
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 10 },
      drainTimeoutSeconds: 1,
      pendingPersistenceRetryAfterSeconds: 1,
      circuitBreakerFailureThreshold: 1,
      circuitBreakerResetTimeoutMs: 1,
    },
  };
}

describe("process-local order admission", () => {
  it("isolates run limits, bounds catalog work, and releases permits idempotently", async () => {
    const firstRun = "55555555-5555-4555-8555-555555555551";
    const secondRun = "55555555-5555-4555-8555-555555555552";
    const admission = new ProcessLocalOrderProcessAdmission({
      fallbackConcurrency: 1,
      runConfigReader: {
        read: async (runId) =>
          runId === firstRun ? snapshot(1) : runId === secondRun ? snapshot(2) : null,
      },
    });

    const firstPermit = await admission.tryAcquire({ ...data, runId: firstRun });
    expect(firstPermit).not.toBeNull();
    expect(await admission.tryAcquire({ ...data, runId: firstRun })).toBeNull();
    expect(await admission.tryAcquire({ ...data, runId: secondRun })).not.toBeNull();
    expect(await admission.tryAcquire(data)).not.toBeNull();
    expect(await admission.tryAcquire(data)).toBeNull();

    await firstPermit?.release();
    await firstPermit?.release();
    expect(await admission.tryAcquire({ ...data, runId: firstRun })).not.toBeNull();
    await admission.close();
  });

  it("rejects a missing frozen snapshot and clears held permits on close", async () => {
    const pendingRunId = "55555555-5555-4555-8555-555555555554";
    let resolveRead: ((value: AcceptedRunConfigSnapshot) => void) | undefined;
    const pendingSnapshot = new Promise<AcceptedRunConfigSnapshot>((resolve) => {
      resolveRead = resolve;
    });
    const admission = new ProcessLocalOrderProcessAdmission({
      fallbackConcurrency: 1,
      runConfigReader: {
        read: async (runId) => {
          if (runId === pendingRunId) return pendingSnapshot;
          return null;
        },
      },
    });
    const runJob = { ...data, runId: "55555555-5555-4555-8555-555555555553" };

    await expect(admission.tryAcquire(runJob)).rejects.toThrow("snapshot was not found");
    const inFlightAcquire = admission.tryAcquire({
      ...data,
      runId: pendingRunId,
    });
    await admission.close();
    resolveRead?.(snapshot(1));

    await expect(inFlightAcquire).resolves.toBeNull();
    await expect(admission.tryAcquire(data)).resolves.toBeNull();
  });
});

describe("order process admission boundary", () => {
  it("acquires before handling and releases in finally without masking handler errors", async () => {
    const order: string[] = [];
    const original = new Error("handler failed");
    const release = vi.fn(async () => {
      order.push("release");
      throw new Error("release failed");
    });
    const handler = {
      handle: vi.fn(async () => {
        order.push("handle");
        throw original;
      }),
    };
    const admission = {
      tryAcquire: vi.fn(async () => {
        order.push("acquire");
        return { release };
      }),
      close: vi.fn(),
    };
    await expect(
      processJob(bullJob(), "lock-token", {
        connection: {},
        concurrency: 10,
        handler,
        recovery: {
          recordRecoverable: async () => undefined,
          recordDeadLetter: async () => undefined,
        },
        admission,
        logger: createSilentLogger("worker"),
      }),
    ).rejects.toBe(original);
    expect(order).toEqual(["acquire", "handle", "release"]);
  });

  it("defers saturated work with its BullMQ token and preserves delivery metadata", async () => {
    const job = bullJob();
    const handler = { handle: vi.fn() };
    const recovery = { recordRecoverable: vi.fn(), recordDeadLetter: vi.fn() };
    await expect(
      processJob(job, "lock-token", {
        connection: {},
        concurrency: 10,
        handler,
        recovery,
        admission: { tryAcquire: vi.fn().mockResolvedValue(null), close: vi.fn() },
        admissionDelayMs: 1,
        logger: createSilentLogger("worker"),
      }),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "lock-token");
    expect(handler.handle).not.toHaveBeenCalled();
    expect(recovery.recordRecoverable).not.toHaveBeenCalled();
    expect(recovery.recordDeadLetter).not.toHaveBeenCalled();
    expect(job.attemptsMade).toBe(2);
    expect(job.opts.attempts).toBe(7);
  });
});
