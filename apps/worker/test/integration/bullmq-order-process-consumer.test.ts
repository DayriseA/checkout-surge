import {
  type NotificationRecordJob,
  notificationRecordBullMqQueueName,
  notificationRecordJobName,
  type OrderProcessJob,
  orderProcessBullMqQueueName,
  orderProcessJobName,
} from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderProcessJobHandler } from "../../src/application/order-process-job-handler.js";
import { createOrderRecoveryScanner } from "../../src/application/order-recovery-scanner.js";
import {
  createBullMqNotificationRecordConsumer,
  notificationRecordQueueNotReadyMessage,
} from "../../src/queue/bullmq-notification-record-consumer.js";
import { createBullMqNotificationRecordPublisher } from "../../src/queue/bullmq-notification-record-publisher.js";
import {
  deadLetterFailureMarker,
  orderProcessQueueNotReadyMessage,
} from "../../src/queue/bullmq-order-process-consumer.js";
import { createOrderProcessJobPublisher } from "../../src/queue/bullmq-order-process-job-publisher.js";
import type { NotificationRecordConsumer } from "../../src/queue/notification-record-consumer.js";
import type { OrderProcessConsumer } from "../../src/queue/order-process-consumer.js";
import { createBullMqOrderProcessConsumer } from "./order-process-consumer-test-helper.js";

const job: OrderProcessJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test",
  reservationId: "33333333-3333-4333-8333-333333333333",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  correlationId: "corr-worker-test",
  quantity: 1,
  queuedAt: "2026-06-21T00:00:00.000Z",
  processingGeneration: 0,
};
const notificationJob: NotificationRecordJob = {
  orderId: job.orderId,
  saleOfferId: job.saleOfferId,
  correlationId: job.correlationId,
  recipientPlaceholder: "simulated-buyer:ord_test",
  confirmedAt: "2026-06-21T00:00:02.000Z",
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
      deliveryId: job.orderId,
      processingGeneration: 0,
    });
  });

  it("passes BullMQ retry delivery metadata across real attempts", async () => {
    const handledTwice = deferred<void>();
    const deliveries: Array<{
      attemptNumber: number;
      attemptsMade: number;
      maxAttempts?: number;
      deliveryId?: string;
    }> = [];
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
      {
        attemptNumber: 1,
        attemptsMade: 0,
        maxAttempts: 2,
        deliveryId: job.orderId,
        processingGeneration: 0,
      },
      {
        attemptNumber: 2,
        attemptsMade: 1,
        maxAttempts: 2,
        deliveryId: job.orderId,
        processingGeneration: 0,
      },
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

  it("retains a poison DLQ disposition for scanner reconciliation after handoff failure", async () => {
    const poisonHandoff = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const handled = vi.fn();
    consumer = createBullMqOrderProcessConsumer({
      connection: { url: testRedisUrl(), maxRetriesPerRequest: null },
      concurrency: 1,
      handler: { handle: handled },
      logger: createSilentLogger("worker"),
      recovery: { recordRecoverable: vi.fn(), recordDeadLetter: poisonHandoff },
    });
    consumer.start();
    await queue.add(
      "wrong-name" as typeof orderProcessJobName,
      { ...job, orderId: "invalid" },
      {
        attempts: 2,
        jobId: "poison-dlq-job",
      },
    );

    await vi.waitFor(
      async () => {
        expect(await queue.getJob("poison-dlq-job")).toBeDefined();
        expect(await (await queue.getJob("poison-dlq-job"))?.getState()).toBe("failed");
      },
      { timeout: 10_000, interval: 25 },
    );
    const failed = await queue.getJob("poison-dlq-job");
    expect(failed?.failedReason).toContain(deadLetterFailureMarker);
    expect(handled).not.toHaveBeenCalled();

    const publisher = createOrderProcessJobPublisher(queue);
    const recordDeadLetter = vi.fn().mockResolvedValue(undefined);
    const scanner = createOrderRecoveryScanner({
      handler: { handle: vi.fn() },
      persistence: {
        recordRecoverable: vi.fn(),
        findRecoverable: vi.fn().mockResolvedValue([]),
        claimForPublication: vi.fn().mockResolvedValue(null),
        markPublicationFailed: vi.fn(),
        markResolved: vi.fn(),
        reconcileTerminal: vi.fn().mockResolvedValue(0),
        resolveDispatchedCall: vi.fn().mockResolvedValue(true),
        defer: vi.fn().mockResolvedValue(true),
        readControlRecord: vi.fn().mockResolvedValue(null),
        markEscalated: vi.fn(),
        recordDeadLetter,
      },
      publisher,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1000,
      batchSize: 10,
      failedJobReader: publisher,
    });
    await scanner.scanOnce();
    await scanner.scanOnce();
    expect(recordDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "poison-dlq-job", jobName: "wrong-name" }),
    );
    await publisher.close();
  });

  it("re-enqueues exhausted work through a durable claim and confirms one recovery delivery", async () => {
    const handled = deferred<OrderProcessJob>();
    const confirmationCalls = vi.fn();
    consumer = createBullMqOrderProcessConsumer({
      connection: { url: testRedisUrl(), maxRetriesPerRequest: null },
      concurrency: 1,
      handler: {
        handle: async (payload) => {
          confirmationCalls(payload.orderId);
          handled.resolve(payload);
        },
      },
      logger: createSilentLogger("worker"),
    });
    const scanner = createOrderRecoveryScanner({
      handler: { handle: vi.fn() },
      persistence: {
        recordRecoverable: vi.fn(),
        findRecoverable: vi.fn().mockResolvedValue([
          {
            recoveryKey: `order:${job.orderId}`,
            job,
            reason: "erp_local_persistence_unavailable",
            attempts: 0,
            createdAt: new Date(),
          },
        ]),
        claimForPublication: vi.fn().mockResolvedValue({
          attempt: 1,
          processingGeneration: 1,
          jobId: `recovery-${job.orderId}-1`,
        }),
        markPublicationFailed: vi.fn(),
        markResolved: vi.fn(),
        reconcileTerminal: vi.fn().mockResolvedValue(0),
        resolveDispatchedCall: vi.fn().mockResolvedValue(true),
        defer: vi.fn().mockResolvedValue(true),
        readControlRecord: vi.fn().mockResolvedValue(null),
        markEscalated: vi.fn(),
        recordDeadLetter: vi.fn(),
      },
      publisher: createOrderProcessJobPublisher(queue),
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1000,
      batchSize: 10,
      failedJobReader: { findFailedOrderJobs: async () => [] },
    });
    await scanner.scanOnce();
    expect(await queue.getJob(`recovery-${job.orderId}-1`)).toBeDefined();
    consumer.start();
    await expect(handled.promise).resolves.toEqual({ ...job, processingGeneration: 1 });
    expect(confirmationCalls).toHaveBeenCalledOnce();
  });

  it("restores a pre-ERP persistence outage through recovery without an ERP side effect", async () => {
    let databaseRestored = false;
    const confirmationCalls = vi.fn();
    const recoveryRecords = vi.fn();
    const recoveryPersistence = {
      recordRecoverable: recoveryRecords,
      recordDeadLetter: vi.fn(),
      findRecoverable: vi.fn().mockResolvedValue([
        {
          recoveryKey: `order:${job.orderId}`,
          job,
          reason: "order_processing_persistence_unavailable",
          attempts: 0,
          createdAt: new Date(),
        },
      ]),
      claimForPublication: vi.fn().mockResolvedValue({
        attempt: 1,
        processingGeneration: 1,
        jobId: `recovery-${job.orderId}-1`,
      }),
      markPublicationFailed: vi.fn(),
      markResolved: vi.fn(),
      reconcileTerminal: vi.fn().mockResolvedValue(0),
      markEscalated: vi.fn(),
      resolveDispatchedCall: vi.fn().mockResolvedValue(true),
      defer: vi.fn().mockResolvedValue(true),
      readControlRecord: vi.fn().mockResolvedValue(null),
    };
    const handler = createOrderProcessJobHandler({
      confirmation: {
        confirm: async () => {
          confirmationCalls();
        },
      },
      persistence: {
        transitionToProcessing: async () => {
          if (!databaseRestored) throw new Error("database unavailable");
          return {
            changed: true,
            status: "processing",
          };
        },
        transitionToConfirmed: vi.fn().mockResolvedValue({ changed: false, status: "confirmed" }),
        transitionToFailed: vi.fn().mockResolvedValue({ changed: false, status: "failed" }),
      },
      logger: createSilentLogger("worker"),
      recovery: { handoff: recoveryRecords, resolve: async () => undefined },
      publishBusinessOutcomeUpdate: async () => undefined,
      notificationRecordPublisher: { publishForConfirmedOrder: async () => undefined },
    });
    consumer = createBullMqOrderProcessConsumer({
      connection: { url: testRedisUrl(), maxRetriesPerRequest: null },
      concurrency: 1,
      handler,
      logger: createSilentLogger("worker"),
      recovery: recoveryPersistence,
    });
    consumer.start();
    await queue.add(orderProcessJobName, job, { attempts: 2, jobId: job.orderId });
    await vi.waitFor(async () => expect(await queue.getJob(job.orderId)).toBeDefined(), {
      timeout: 10_000,
      interval: 25,
    });
    await vi.waitFor(
      async () => {
        expect(await (await queue.getJob(job.orderId))?.getState()).toBe("failed");
      },
      {
        timeout: 10_000,
        interval: 25,
      },
    );
    expect(confirmationCalls).not.toHaveBeenCalled();
    expect(recoveryRecords).toHaveBeenCalled();

    databaseRestored = true;
    const scanner = createOrderRecoveryScanner({
      persistence: recoveryPersistence,
      handler: { handle: vi.fn() },
      publisher: createOrderProcessJobPublisher(queue),
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1000,
      batchSize: 10,
      failedJobReader: { findFailedOrderJobs: async () => [] },
    });
    await scanner.scanOnce();
    await vi.waitFor(
      async () => {
        expect(await queue.getJob(`recovery-${job.orderId}-1`)).toBeDefined();
        expect(await (await queue.getJob(`recovery-${job.orderId}-1`))?.getState()).toBe(
          "completed",
        );
      },
      { timeout: 10_000, interval: 25 },
    );
    expect(confirmationCalls).toHaveBeenCalledOnce();
  });

  it("dead-letters invalid payloads without invoking the handler", async () => {
    const handle = vi.fn();
    const recordDeadLetter = vi.fn().mockResolvedValue(undefined);
    consumer = createBullMqOrderProcessConsumer({
      connection: { url: testRedisUrl(), maxRetriesPerRequest: null },
      concurrency: 1,
      handler: { handle },
      logger: createSilentLogger("worker"),
      recovery: { recordRecoverable: vi.fn(), recordDeadLetter },
    });

    consumer.start();
    await queue.add(orderProcessJobName, { ...job, orderId: "invalid" } as OrderProcessJob, {
      jobId: "invalid-job",
    });

    await vi.waitFor(async () => {
      expect(await (await queue.getJob("invalid-job"))?.getState()).toBe("completed");
    });
    expect(recordDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "invalid-job", reason: "invalid_job_payload" }),
    );
    expect(handle).not.toHaveBeenCalled();
  });
});

describe("BullMQ notification-recording boundary", () => {
  let producerRedis: Redis;
  let queue: Queue<NotificationRecordJob, void, typeof notificationRecordJobName>;
  let consumer: NotificationRecordConsumer | null;

  beforeEach(async () => {
    producerRedis = new Redis(testRedisUrl(), { maxRetriesPerRequest: 3 });
    await producerRedis.flushdb();
    queue = new Queue(notificationRecordBullMqQueueName, {
      connection: { url: testRedisUrl(), maxRetriesPerRequest: 3 },
    });
    consumer = null;
  });

  afterEach(async () => {
    await consumer?.close();
    await queue.close();
    await producerRedis.quit();
  });

  it("consumes and validates a notification job from the physical BullMQ queue", async () => {
    const handled = deferred<NotificationRecordJob>();
    consumer = createBullMqNotificationRecordConsumer({
      connection: { url: testRedisUrl(), maxRetriesPerRequest: null },
      concurrency: 1,
      handler: { handle: async (payload) => handled.resolve(payload) },
      logger: createSilentLogger("worker"),
    });

    consumer.start();
    await queue.add(notificationRecordJobName, notificationJob, { jobId: notificationJob.orderId });

    await expect(handled.promise).resolves.toEqual(notificationJob);
    await expect(consumer.checkConnectivity()).resolves.toBeUndefined();
  });

  it("removes terminal failures so the deterministic job ID can be processed again", async () => {
    const deterministicJobId = `${job.orderId}-email`;
    const secondDeliveryHandled = deferred<NotificationRecordJob>();
    let shouldFail = true;
    const publisher = createBullMqNotificationRecordPublisher({
      connection: { url: testRedisUrl(), maxRetriesPerRequest: null },
      attempts: 1,
    });
    consumer = createBullMqNotificationRecordConsumer({
      connection: { url: testRedisUrl(), maxRetriesPerRequest: null },
      concurrency: 1,
      handler: {
        handle: async (payload) => {
          if (shouldFail) {
            throw new Error("temporary notification persistence failure");
          }
          secondDeliveryHandled.resolve(payload);
        },
      },
      logger: createSilentLogger("worker"),
    });

    try {
      consumer.start();
      await publisher.publishForConfirmedOrder(job, notificationJob.confirmedAt);

      await vi.waitFor(async () => expect(await queue.getJob(deterministicJobId)).toBeUndefined());

      shouldFail = false;
      await publisher.publishForConfirmedOrder(job, notificationJob.confirmedAt);
      await expect(secondDeliveryHandled.promise).resolves.toEqual(notificationJob);
      await vi.waitFor(async () => {
        const completedJob = await queue.getJob(deterministicJobId);
        await expect(completedJob?.getState()).resolves.toBe("completed");
      });
    } finally {
      await publisher.close();
    }
  });

  it("reports notification queue connectivity before readiness", async () => {
    consumer = createBullMqNotificationRecordConsumer({
      connection: { url: testRedisUrl(), maxRetriesPerRequest: null },
      concurrency: 1,
      handler: { handle: vi.fn() },
      logger: createSilentLogger("worker"),
    });

    await expect(consumer.checkConnectivity()).rejects.toThrow(
      notificationRecordQueueNotReadyMessage,
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
