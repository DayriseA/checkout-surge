import {
  type OrderProcessJob,
  orderProcessBullMqQueueName,
  orderProcessJobName,
} from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBullMqOrderProcessConsumer,
  type OrderProcessJobFailureReport,
  orderProcessQueueNotReadyMessage,
} from "../../src/queue/bullmq-order-process-consumer.js";
import type { OrderProcessConsumer } from "../../src/queue/order-process-consumer.js";

const job: OrderProcessJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test",
  reservationId: "33333333-3333-4333-8333-333333333333",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  correlationId: "corr-worker-test",
  quantity: 1,
  queuedAt: "2026-06-21T00:00:00.000Z",
};

function testRedisUrl(): string {
  const redisUrl = process.env.TEST_REDIS_URL;
  if (!redisUrl) {
    throw new Error("TEST_REDIS_URL is required for worker integration tests.");
  }
  return redisUrl;
}

describe("BullMQ order-processing boundary", () => {
  let producerRedis: Redis;
  let queue: Queue<OrderProcessJob, void, typeof orderProcessJobName>;
  let consumer: OrderProcessConsumer | null;

  beforeEach(async () => {
    producerRedis = new Redis(testRedisUrl(), { maxRetriesPerRequest: 3 });
    await producerRedis.flushdb();
    queue = new Queue(orderProcessBullMqQueueName, {
      connection: { url: testRedisUrl(), maxRetriesPerRequest: 3 },
    });
    consumer = null;
  });

  afterEach(async () => {
    await consumer?.close();
    await queue.close();
    await producerRedis.quit();
  });

  it("consumes and validates a job from the physical BullMQ queue", async () => {
    const handled = deferred<OrderProcessJob>();
    consumer = createBullMqOrderProcessConsumer({
      connection: { url: testRedisUrl(), maxRetriesPerRequest: null },
      concurrency: 1,
      handler: { handle: async (payload) => handled.resolve(payload) },
      logger: createSilentLogger("worker"),
    });

    consumer.start();
    await queue.add(orderProcessJobName, job, { jobId: job.orderId });

    await expect(handled.promise).resolves.toEqual(job);
    expect(consumer.isRunning()).toBe(true);
  });

  it("passes one-based delivery attempt metadata to the handler", async () => {
    const handled = deferred<{
      payload: OrderProcessJob;
      attemptNumber: number;
      attemptsMade: number;
    }>();
    consumer = createBullMqOrderProcessConsumer({
      connection: { url: testRedisUrl(), maxRetriesPerRequest: null },
      concurrency: 1,
      handler: {
        handle: async (payload, delivery) => handled.resolve({ payload, ...delivery }),
      },
      logger: createSilentLogger("worker"),
    });

    consumer.start();
    await queue.add(orderProcessJobName, job, { jobId: job.orderId });

    await expect(handled.promise).resolves.toEqual({
      payload: job,
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 1,
    });
  });

  it("passes BullMQ retry delivery metadata across real attempts", async () => {
    const handledTwice = deferred<void>();
    const deliveries: Array<{ attemptNumber: number; attemptsMade: number; maxAttempts?: number }> =
      [];
    consumer = createBullMqOrderProcessConsumer({
      connection: { url: testRedisUrl(), maxRetriesPerRequest: null },
      concurrency: 1,
      handler: {
        handle: async (_payload, delivery) => {
          deliveries.push(delivery);
          if (deliveries.length === 1) {
            throw new Error("test-only first delivery failure");
          }
          handledTwice.resolve();
        },
      },
      logger: createSilentLogger("worker"),
    });

    consumer.start();
    const queuedJob = await queue.add(orderProcessJobName, job, {
      attempts: 2,
      jobId: job.orderId,
    });

    await handledTwice.promise;
    await vi.waitFor(async () => expect(await queuedJob.getState()).toBe("completed"), {
      timeout: 10_000,
      interval: 25,
    });
    expect(deliveries).toEqual([
      { attemptNumber: 1, attemptsMade: 0, maxAttempts: 2 },
      { attemptNumber: 2, attemptsMade: 1, maxAttempts: 2 },
    ]);
    expect((await queue.getJob(job.orderId))?.attemptsMade).toBe(2);
  });

  it("reports queue connectivity immediately across pre-ready, ready, and closed states", async () => {
    const handled = deferred<OrderProcessJob>();
    consumer = createBullMqOrderProcessConsumer({
      connection: { url: testRedisUrl(), maxRetriesPerRequest: null },
      concurrency: 1,
      handler: { handle: async (payload) => handled.resolve(payload) },
      logger: createSilentLogger("worker"),
    });
    const trackedConsumer = consumer;

    await expect(trackedConsumer.checkConnectivity()).rejects.toThrow(
      orderProcessQueueNotReadyMessage,
    );

    trackedConsumer.start();
    await queue.add(orderProcessJobName, job, { jobId: job.orderId });
    await expect(handled.promise).resolves.toEqual(job);
    await expect(trackedConsumer.checkConnectivity()).resolves.toBeUndefined();

    await trackedConsumer.close();
    consumer = null;
    await expect(trackedConsumer.checkConnectivity()).rejects.toThrow(
      orderProcessQueueNotReadyMessage,
    );
  });

  it("fails invalid payloads and reports basic job metadata", async () => {
    const failed = deferred<OrderProcessJobFailureReport>();
    const handle = vi.fn();
    consumer = createBullMqOrderProcessConsumer({
      connection: { url: testRedisUrl(), maxRetriesPerRequest: null },
      concurrency: 1,
      handler: { handle },
      logger: createSilentLogger("worker"),
      reportFailure: failed.resolve,
    });

    consumer.start();
    await queue.add(orderProcessJobName, { ...job, orderId: "invalid" } as OrderProcessJob, {
      jobId: "invalid-job",
    });

    const report = await failed.promise;
    expect(report).toMatchObject({
      jobId: "invalid-job",
      jobName: orderProcessJobName,
      attemptNumber: 1,
      attemptsMade: 1,
    });
    expect(report.error.name).toBe("ZodError");
    expect(handle).not.toHaveBeenCalled();
  });

  it("isolates a throwing failure reporter and continues consuming jobs", async () => {
    const reporterCalled = deferred<void>();
    const nextJobHandled = deferred<OrderProcessJob>();
    const logger = createSilentLogger("worker");
    const errorLog = vi.spyOn(logger, "error");
    consumer = createBullMqOrderProcessConsumer({
      connection: { url: testRedisUrl(), maxRetriesPerRequest: null },
      concurrency: 1,
      handler: {
        handle: async (payload) => {
          nextJobHandled.resolve(payload);
        },
      },
      logger,
      reportFailure: () => {
        reporterCalled.resolve(undefined);
        throw new Error("Reporter unavailable");
      },
    });

    consumer.start();
    await queue.add(orderProcessJobName, { ...job, orderId: "invalid" } as OrderProcessJob, {
      jobId: "reporter-error-job",
    });
    await reporterCalled.promise;
    await queue.add(orderProcessJobName, {
      ...job,
      orderId: "44444444-4444-4444-8444-444444444444",
    });

    await expect(nextJobHandled.promise).resolves.toMatchObject({
      orderId: "44444444-4444-4444-8444-444444444444",
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Order-processing failure reporter threw an error.",
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
