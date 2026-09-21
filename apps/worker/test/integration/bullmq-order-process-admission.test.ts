import type { OrderProcessJob } from "@checkout-surge/contracts";
import {
  erpDispatchRateLimit,
  orderProcessBullMqQueueName,
  orderProcessJobName,
} from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlidingWindowTpsLimiter } from "../../../mock-erp/src/application/tps-limiter.js";
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

  it.each([
    10, 100, 250,
  ])("spaces native dispatch within the sliding window at %i TPS", async (maxTps) => {
    const rateLimit = erpDispatchRateLimit(maxTps);
    await queue.setGlobalRateLimit(rateLimit.max, rateLimit.duration);
    await queue.setGlobalConcurrency(5);
    const limiter = new SlidingWindowTpsLimiter();
    const arrivals: number[] = [];
    let rejected = 0;
    const consumer = createBullMqOrderProcessConsumer({
      connection: { url: url(), maxRetriesPerRequest: null },
      concurrency: 10,
      handler: {
        handle: async () => {
          arrivals.push(performance.now());
          if (!limiter.acquire("catalog", maxTps)) rejected += 1;
        },
      },
      logger: createSilentLogger("worker"),
    });
    consumers.push(consumer);
    await queue.addBulk(
      Array.from({ length: maxTps * 2 }, (_, index) => ({
        name: orderProcessJobName,
        data: baseJob,
        opts: { jobId: `spacing-${index}`, attempts: 1 },
      })),
    );
    consumer.start();
    await vi.waitFor(() => expect(arrivals).toHaveLength(maxTps * 2), { timeout: 10_000 });
    expect(rejected).toBe(0);
    const elapsed = (arrivals.at(-1) ?? 0) - (arrivals[0] ?? 0);
    const observedTps = ((arrivals.length - 1) * 1_000) / elapsed;
    console.info({ declaredTps: maxTps, ...rateLimit, observedTps, rejected });
    // Floor confirmed against isolated Redis measurements; allows container scheduling overhead.
    expect(observedTps).toBeGreaterThanOrEqual(maxTps * 0.8);
  });

  it("a replacement consumer retains global rate and concurrency limits without configuring a worker limiter", async () => {
    const rateLimit = erpDispatchRateLimit(10);
    await queue.setGlobalRateLimit(rateLimit.max, rateLimit.duration);
    await queue.setGlobalConcurrency(1);
    let inFlight = 0;
    let peak = 0;
    const starts: number[] = [];
    const makeConsumer = () =>
      createBullMqOrderProcessConsumer({
        connection: { url: url(), maxRetriesPerRequest: null },
        concurrency: 10,
        handler: {
          handle: async () => {
            starts.push(Date.now());
            peak = Math.max(peak, ++inFlight);
            if (starts.length <= 2) await new Promise((resolve) => setTimeout(resolve, 150));
            inFlight -= 1;
          },
        },
        logger: createSilentLogger("worker"),
      });
    const first = makeConsumer();
    first.start();
    await queue.add(orderProcessJobName, baseJob, { jobId: "before-restart" });
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    await first.close();
    const restarted = makeConsumer();
    consumers.push(restarted);
    restarted.start();
    await queue.addBulk(
      Array.from({ length: 4 }, (_, index) => ({
        name: orderProcessJobName,
        data: baseJob,
        opts: { jobId: `after-restart-${index}` },
      })),
    );
    await vi.waitFor(async () => expect((await queue.getJobCounts()).completed).toBe(5), {
      timeout: 3_000,
    });
    expect(peak).toBe(1);
    for (let index = 1; index < starts.length; index += 1) {
      expect((starts[index] ?? 0) - (starts[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        index <= 2 ? 140 : 100,
      );
    }
    expect(await queue.getGlobalRateLimit()).toEqual(erpDispatchRateLimit(10));
  });

  it("pauses future deliveries without RateLimitError and immediately resumes the configured rate", async () => {
    const rateLimit = erpDispatchRateLimit(10);
    await queue.setGlobalRateLimit(rateLimit.max, rateLimit.duration);
    await queue.setGlobalConcurrency(1);
    const starts: number[] = [];
    const consumer = createBullMqOrderProcessConsumer({
      connection: { url: url(), maxRetriesPerRequest: null },
      concurrency: 10,
      handler: {
        handle: async () => {
          starts.push(Date.now());
          if (starts.length === 1) await queue.rateLimit(1_000);
        },
      },
      logger: createSilentLogger("worker"),
    });
    consumers.push(consumer);
    await queue.addBulk(
      Array.from({ length: 12 }, (_, index) => ({
        name: orderProcessJobName,
        data: baseJob,
        opts: { jobId: `pause-${index}`, attempts: 1 },
      })),
    );
    consumer.start();
    await vi.waitFor(async () => expect((await queue.getJobCounts()).completed).toBe(1));
    const pausedCounts = await queue.getJobCounts();
    expect(pausedCounts.waiting).toBe(11);
    expect(pausedCounts.delayed).toBe(0);
    await vi.waitFor(async () => expect((await queue.getJobCounts()).completed).toBe(12), {
      timeout: 5_000,
    });
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(1_000);
    const resumedAt = starts[1] ?? 0;
    expect(starts.slice(1).filter((at) => at - resumedAt < 1_000).length).toBeGreaterThanOrEqual(8);
    expect((await queue.getJobCounts()).failed).toBe(0);
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
