import type { AcceptedRunConfigSnapshot, OrderProcessJob } from "@checkout-surge/contracts";
import { orderProcessBullMqQueueName, orderProcessJobName } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBullMqOrderProcessConsumer } from "../../src/queue/bullmq-order-process-consumer.js";
import { RedisOrderProcessAdmission } from "../../src/queue/redis-order-process-admission.js";

const runId = "55555555-5555-4555-8555-555555555555";
const baseJob: OrderProcessJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test",
  reservationId: "33333333-3333-4333-8333-333333333333",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  runId,
  correlationId: "corr-admission",
  quantity: 1,
  queuedAt: "2026-07-13T00:00:00.000Z",
};

function url() {
  if (!process.env.TEST_REDIS_URL) throw new Error("TEST_REDIS_URL is required");
  return process.env.TEST_REDIS_URL;
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

describe("BullMQ distributed admission", () => {
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

  it("keeps saturated work visible and processes it later without consuming attempts", async () => {
    const reportFailure = vi.fn();
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => (releaseFirst = resolve));
    const deliveries: number[] = [];
    const handle = vi.fn(async (job: OrderProcessJob, delivery: { attemptsMade: number }) => {
      deliveries.push(delivery.attemptsMade);
      if (job.orderId === baseJob.orderId) await firstBlocked;
    });
    const admission = new RedisOrderProcessAdmission({
      redis,
      runConfigReader: { read: async () => snapshot(1) },
      fallbackConcurrency: 10,
      leaseMs: 2000,
      keyPrefix: "test:bull-admission",
    });
    const consumer = createBullMqOrderProcessConsumer({
      connection: { url: url(), maxRetriesPerRequest: null },
      concurrency: 10,
      admission,
      admissionDelayMs: 30,
      handler: { handle },
      logger: createSilentLogger("worker"),
      reportFailure,
    });
    consumers.push(consumer);
    consumer.start();
    const second = {
      ...baseJob,
      orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      publicOrderId: "ord_second",
    };
    await queue.add(orderProcessJobName, baseJob, { jobId: baseJob.orderId, attempts: 4 });
    await queue.add(orderProcessJobName, second, { jobId: second.orderId, attempts: 4 });
    await vi.waitFor(async () => expect(handle).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect((await queue.getJobCounts()).delayed).toBeGreaterThan(0));
    const delayed = await queue.getJob(second.orderId);
    expect(delayed?.attemptsMade).toBe(0);
    releaseFirst?.();
    await vi.waitFor(async () => expect(handle).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(deliveries).toEqual([0, 0]);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("waits for held work on shutdown and removes its admission lease", async () => {
    let releaseHandler: (() => void) | undefined;
    const held = new Promise<void>((resolve) => (releaseHandler = resolve));
    const keyPrefix = "test:shutdown-admission";
    const consumer = createBullMqOrderProcessConsumer({
      connection: { url: url(), maxRetriesPerRequest: null },
      concurrency: 10,
      admission: new RedisOrderProcessAdmission({
        redis,
        runConfigReader: { read: async () => snapshot(1) },
        fallbackConcurrency: 10,
        leaseMs: 2000,
        keyPrefix,
      }),
      handler: { handle: vi.fn(async () => held) },
      logger: createSilentLogger("worker"),
    });
    consumers.push(consumer);
    consumer.start();
    await queue.add(orderProcessJobName, baseJob, { jobId: baseJob.orderId });
    await vi.waitFor(async () => expect(await redis.exists(`${keyPrefix}:run:${runId}`)).toBe(1));
    let closed = false;
    const closing = consumer.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    releaseHandler?.();
    await closing;
    consumers.splice(consumers.indexOf(consumer), 1);
    expect(await redis.exists(`${keyPrefix}:run:${runId}`)).toBe(0);
  });

  it("honors mixed run limits above five while the worker aggregate stays capped", async () => {
    const secondRun = "55555555-5555-4555-8555-555555555556";
    let releaseAll: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => (releaseAll = resolve));
    const active = new Map<string, number>();
    const maxima = new Map<string, number>();
    let aggregate = 0;
    let maxAggregate = 0;
    const handle = vi.fn(async (job: OrderProcessJob) => {
      const id = job.runId ?? "non-run";
      const next = (active.get(id) ?? 0) + 1;
      active.set(id, next);
      maxima.set(id, Math.max(maxima.get(id) ?? 0, next));
      aggregate += 1;
      maxAggregate = Math.max(maxAggregate, aggregate);
      await blocked;
      aggregate -= 1;
      active.set(id, next - 1);
    });
    const admission = new RedisOrderProcessAdmission({
      redis,
      runConfigReader: { read: async (id) => snapshot(id === runId ? 8 : 2) },
      fallbackConcurrency: 10,
      keyPrefix: "test:mixed-admission",
    });
    const consumer = createBullMqOrderProcessConsumer({
      connection: { url: url(), maxRetriesPerRequest: null },
      concurrency: 10,
      admission,
      admissionDelayMs: 30,
      handler: { handle },
      logger: createSilentLogger("worker"),
    });
    consumers.push(consumer);
    consumer.start();
    const jobs = Array.from({ length: 10 }, (_, index) => ({
      ...baseJob,
      orderId: `${index < 8 ? "1" : "2"}${String(index).padStart(7, "0")}-1111-4111-8111-111111111111`,
      publicOrderId: `ord_${index}`,
      runId: index < 8 ? runId : secondRun,
    }));
    await Promise.all(
      jobs.map((job) => queue.add(orderProcessJobName, job, { jobId: job.orderId })),
    );
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(10), { timeout: 5000 });
    expect(maxima.get(runId)).toBe(8);
    expect(maxima.get(secondRun)).toBe(2);
    expect(maxAggregate).toBe(10);
    releaseAll?.();
  });
});
