import type { OrderProcessJob } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { DelayedError, type Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
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
