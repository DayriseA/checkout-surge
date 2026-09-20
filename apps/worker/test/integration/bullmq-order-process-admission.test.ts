import type { OrderProcessJob } from "@checkout-surge/contracts";
import { orderProcessBullMqQueueName, orderProcessJobName } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBullMqOrderProcessConsumer } from "./order-process-consumer-test-helper.js";

const baseJob: OrderProcessJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test",
  reservationId: "33333333-3333-4333-8333-333333333333",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  correlationId: "corr-admission",
  quantity: 1,
  queuedAt: "2026-07-13T00:00:00.000Z",
  processingGeneration: 0,
};

function url() {
  if (!process.env.TEST_REDIS_URL) throw new Error("TEST_REDIS_URL is required");
  return process.env.TEST_REDIS_URL;
}

describe("BullMQ order-process execution boundary", () => {
  let redis: Redis;
  let queue: Queue<OrderProcessJob, void, typeof orderProcessJobName>;
  const consumers: Array<ReturnType<typeof createBullMqOrderProcessConsumer>> = [];

  beforeEach(async () => {
    redis = new Redis(url());
    await redis.flushdb();
    queue = new Queue(orderProcessBullMqQueueName, { connection: { url: url() } });
  });

  afterEach(async () => {
    await Promise.all(consumers.splice(0).map((consumer) => consumer.close()));
    await queue.close();
    redis.disconnect();
  });

  it("runs claimed handlers directly without BullMQ delay or a queue-level admission loop", async () => {
    const handler = { handle: vi.fn().mockResolvedValue(undefined) };
    const consumer = createBullMqOrderProcessConsumer({
      connection: { url: url(), maxRetriesPerRequest: null },
      concurrency: 10,
      handler,
      logger: createSilentLogger("worker"),
    });
    consumers.push(consumer);
    consumer.start();
    await queue.add(orderProcessJobName, baseJob, { jobId: baseJob.orderId, attempts: 1 });

    await vi.waitFor(() => expect(handler.handle).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect((await queue.getJobCounts()).completed).toBe(1));
    expect((await queue.getJobCounts()).delayed).toBe(0);
  });

  it("waits for active work during shutdown without leaving a worker connection open", async () => {
    let finish!: () => void;
    const active = new Promise<void>((resolve) => (finish = resolve));
    const handler = { handle: vi.fn(async () => active) };
    const consumer = createBullMqOrderProcessConsumer({
      connection: { url: url(), maxRetriesPerRequest: null },
      concurrency: 10,
      handler,
      logger: createSilentLogger("worker"),
    });
    consumers.push(consumer);
    consumer.start();
    await queue.add(orderProcessJobName, baseJob, { jobId: baseJob.orderId, attempts: 1 });
    await vi.waitFor(() => expect(handler.handle).toHaveBeenCalledOnce());

    let closed = false;
    const closing = consumer.close().then(() => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(closed).toBe(false);
    finish();
    await closing;
    consumers.splice(consumers.indexOf(consumer), 1);
    expect(consumer.isRunning()).toBe(false);
  });
});
