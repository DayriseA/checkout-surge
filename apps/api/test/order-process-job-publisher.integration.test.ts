import type { OrderProcessJob } from "@checkout-surge/contracts";
import { orderProcessBullMqQueueName, type orderProcessJobName } from "@checkout-surge/contracts";
import { Queue } from "bullmq";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBullMqOrderProcessJobPublisher } from "../src/queue/bullmq-order-process-job-publisher.js";

const runA = "55555555-5555-4555-8555-555555555551";
const runB = "55555555-5555-4555-8555-555555555552";
const base: OrderProcessJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_a",
  reservationId: "33333333-3333-4333-8333-333333333333",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  runId: runA,
  correlationId: "corr-a",
  quantity: 1,
  queuedAt: "2026-07-13T00:00:00.000Z",
  processingGeneration: 0,
};

function url() {
  if (!process.env.TEST_REDIS_URL) throw new Error("TEST_REDIS_URL is required");
  return process.env.TEST_REDIS_URL;
}

describe("single-attempt BullMQ wake-ups", () => {
  let queue: Queue<OrderProcessJob, void, typeof orderProcessJobName>;
  beforeEach(async () => {
    queue = new Queue(orderProcessBullMqQueueName, { connection: { url: url() } });
    await queue.obliterate({ force: true });
  });
  afterEach(async () => {
    await queue.close();
  });

  it("stores one delivery per generation and deterministic IDs", async () => {
    const publisher = createBullMqOrderProcessJobPublisher(
      { url: url() },
      { maxAttempts: 99, backoffBaseMs: 9999 },
    );
    const second = {
      ...base,
      orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      publicOrderId: "ord_b",
      runId: runB,
    };
    await publisher.enqueue(base, {
      retryPolicy: { maxAttempts: 6, initialBackoffMs: 750 },
    });
    await publisher.enqueue(second, {
      retryPolicy: { maxAttempts: 3, initialBackoffMs: 0 },
    });
    await publisher.enqueue(base, {
      retryPolicy: { maxAttempts: 6, initialBackoffMs: 750 },
    });
    const firstStored = await queue.getJob(base.orderId);
    const secondStored = await queue.getJob(second.orderId);
    expect(firstStored?.opts).toMatchObject({
      attempts: 1,
      backoff: { type: "exponential", delay: 9999 },
    });
    expect(secondStored?.opts).toMatchObject({
      attempts: 1,
      backoff: { type: "exponential", delay: 9999 },
    });
    expect(await queue.getJobCounts("waiting")).toMatchObject({ waiting: 2 });
    await publisher.close();
  });
});
