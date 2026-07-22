import {
  type BackpressureConfig,
  type OrderProcessJob,
  orderProcessBullMqQueueName,
  orderProcessJobName,
  orderProcessJobSchema,
} from "@checkout-surge/contracts";
import { type ConnectionOptions, Queue } from "bullmq";
import type { OrderProcessJobPublisher } from "../services/order-process-job-publisher.js";

export interface BullMqOrderProcessJobPublisher extends OrderProcessJobPublisher {
  abort(): Promise<void>;
  close(): Promise<void>;
}

export interface OrderProcessQueue {
  add(
    name: typeof orderProcessJobName,
    data: OrderProcessJob,
    options: {
      jobId: string;
      attempts: number;
      backoff: { type: "exponential"; delay: number };
    },
  ): Promise<unknown>;
  close(): Promise<void>;
  disconnect?(): Promise<void>;
}

export interface OrderProcessRetryOptions {
  maxAttempts: number;
  backoffBaseMs: number;
}

const defaultRetryOptions: OrderProcessRetryOptions = {
  maxAttempts: 4,
  backoffBaseMs: 500,
};

export function createBullMqOrderProcessJobPublisher(
  connection: ConnectionOptions,
  retryOptions: OrderProcessRetryOptions = defaultRetryOptions,
): BullMqOrderProcessJobPublisher {
  const queue = new Queue<OrderProcessJob, void, typeof orderProcessJobName>(
    orderProcessBullMqQueueName,
    { connection },
  );

  return createOrderProcessJobPublisher(queue, retryOptions);
}

export function createOrderProcessJobPublisher(
  queue: OrderProcessQueue,
  retryOptions: OrderProcessRetryOptions = defaultRetryOptions,
): BullMqOrderProcessJobPublisher {
  return {
    async enqueue(input, options) {
      const job = orderProcessJobSchema.parse(input);
      if (job.runId && !options?.retryPolicy) {
        throw new Error(`Frozen retry policy is required for order job run ${job.runId}.`);
      }
      const runPolicy: BackpressureConfig["retryPolicy"] | undefined = options?.retryPolicy;
      await queue.add(orderProcessJobName, job, {
        attempts: runPolicy?.maxAttempts ?? retryOptions.maxAttempts,
        backoff: {
          type: "exponential",
          delay: runPolicy?.initialBackoffMs ?? retryOptions.backoffBaseMs,
        },
        jobId: job.orderId,
      });
    },
    abort: () => queue.disconnect?.() ?? queue.close(),
    close: () => queue.close(),
  };
}
