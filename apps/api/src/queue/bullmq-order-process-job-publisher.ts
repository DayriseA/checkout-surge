import {
  type OrderProcessJob,
  orderProcessBullMqQueueName,
  orderProcessJobName,
  orderProcessJobSchema,
} from "@checkout-surge/contracts";
import { type ConnectionOptions, Queue } from "bullmq";
import type { OrderProcessJobPublisher } from "../services/order-process-job-publisher.js";
import type { OrderProcessQueueLimitsWriter } from "../services/order-process-queue-limits.js";

export interface BullMqOrderProcessJobPublisher
  extends OrderProcessJobPublisher,
    OrderProcessQueueLimitsWriter {
  abort(): Promise<void>;
  close(): Promise<void>;
}

export interface OrderProcessQueue {
  setGlobalRateLimit(max: number, duration: number): Promise<unknown>;
  setGlobalConcurrency(concurrency: number): Promise<unknown>;
  add(
    name: typeof orderProcessJobName,
    data: OrderProcessJob,
    options: {
      jobId: string;
      attempts: number;
    },
  ): Promise<unknown>;
  close(): Promise<void>;
  disconnect?(): Promise<void>;
}

export function createBullMqOrderProcessJobPublisher(
  connection: ConnectionOptions,
): BullMqOrderProcessJobPublisher {
  const queue = new Queue<OrderProcessJob, void, typeof orderProcessJobName>(
    orderProcessBullMqQueueName,
    { connection },
  );

  return createOrderProcessJobPublisher(queue);
}

export function createOrderProcessJobPublisher(
  queue: OrderProcessQueue,
): BullMqOrderProcessJobPublisher {
  return {
    async setLimits({ concurrency, max, duration }) {
      await queue.setGlobalRateLimit(max, duration);
      await queue.setGlobalConcurrency(concurrency);
    },
    async enqueue(input) {
      const job = orderProcessJobSchema.parse(input);
      await queue.add(orderProcessJobName, job, {
        attempts: 1,
        jobId: job.orderId,
      });
    },
    abort: () => queue.disconnect?.() ?? queue.close(),
    close: () => queue.close(),
  };
}
