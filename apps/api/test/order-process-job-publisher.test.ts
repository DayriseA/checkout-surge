import { orderProcessJobName } from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createOrderProcessJobPublisher,
  type OrderProcessQueue,
} from "../src/queue/bullmq-order-process-job-publisher.js";

const job = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test",
  reservationId: "33333333-3333-4333-8333-333333333333",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  correlationId: "corr-publisher-test",
  quantity: 1,
  queuedAt: "2026-06-21T00:00:00.000Z",
};

describe("order-processing job publisher", () => {
  it("validates and publishes with the order ID as the idempotent BullMQ job ID", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const resolve = vi.fn();
    const publisher = createOrderProcessJobPublisher(
      { add, close } as OrderProcessQueue,
      undefined,
      { resolve },
    );

    await publisher.enqueue(job);
    await publisher.close();

    expect(add).toHaveBeenCalledWith(orderProcessJobName, job, {
      attempts: 4,
      backoff: { type: "exponential", delay: 500 },
      jobId: job.orderId,
    });
    expect(close).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("uses explicit retry options when supplied", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const publisher = createOrderProcessJobPublisher(
      { add, close: vi.fn().mockResolvedValue(undefined) } as OrderProcessQueue,
      { maxAttempts: 7, backoffBaseMs: 250 },
      { resolve: vi.fn() },
    );

    await publisher.enqueue(job);

    expect(add).toHaveBeenCalledWith(orderProcessJobName, job, {
      attempts: 7,
      backoff: { type: "exponential", delay: 250 },
      jobId: job.orderId,
    });
  });

  it("rejects invalid jobs before publishing", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const publisher = createOrderProcessJobPublisher(
      { add, close: vi.fn().mockResolvedValue(undefined) } as OrderProcessQueue,
      undefined,
      { resolve: vi.fn() },
    );

    await expect(publisher.enqueue({ ...job, orderId: "invalid" })).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });

  it("uses the frozen run retry policy and rejects a missing run", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const resolve = vi.fn().mockResolvedValue({ maxAttempts: 6, initialBackoffMs: 0 });
    const publisher = createOrderProcessJobPublisher(
      { add, close: vi.fn() } as OrderProcessQueue,
      { maxAttempts: 9, backoffBaseMs: 999 },
      { resolve },
    );
    const runJob = { ...job, runId: "55555555-5555-4555-8555-555555555555" };
    await publisher.enqueue(runJob);
    expect(add).toHaveBeenCalledWith(orderProcessJobName, runJob, {
      attempts: 6,
      backoff: { type: "exponential", delay: 0 },
      jobId: job.orderId,
    });

    resolve.mockResolvedValueOnce(null);
    await expect(publisher.enqueue(runJob)).rejects.toThrow("snapshot was not found");

    resolve.mockRejectedValueOnce(new Error("malformed accepted snapshot"));
    await expect(publisher.enqueue(runJob)).rejects.toThrow("malformed accepted snapshot");
  });
});
