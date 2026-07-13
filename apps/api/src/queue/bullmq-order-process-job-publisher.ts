import {
  type OrderProcessJob,
  orderProcessBullMqQueueName,
  orderProcessJobName,
  orderProcessJobSchema,
} from "@checkout-surge/contracts";
import { type ConnectionOptions, Queue } from "bullmq";
import type { OrderProcessJobPublisher } from "../services/order-process-job-publisher.js";
import type { RunRetryPolicyResolver } from "../services/run-retry-policy-resolver.js";

export interface BullMqOrderProcessJobPublisher extends OrderProcessJobPublisher {
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
  runRetryPolicyResolver: RunRetryPolicyResolver,
): BullMqOrderProcessJobPublisher {
  const queue = new Queue<OrderProcessJob, void, typeof orderProcessJobName>(
    orderProcessBullMqQueueName,
    { connection },
  );

  return createOrderProcessJobPublisher(queue, retryOptions, runRetryPolicyResolver);
}

export function createOrderProcessJobPublisher(
  queue: OrderProcessQueue,
  retryOptions: OrderProcessRetryOptions = defaultRetryOptions,
  runRetryPolicyResolver: RunRetryPolicyResolver,
): BullMqOrderProcessJobPublisher {
  return {
    async enqueue(input) {
      const job = orderProcessJobSchema.parse(input);
      const runPolicy = job.runId ? await runRetryPolicyResolver.resolve(job.runId) : undefined;
      if (job.runId && !runPolicy) {
        throw new Error(`Accepted run snapshot was not found for order job run ${job.runId}.`);
      }
      await queue.add(orderProcessJobName, job, {
        attempts: runPolicy?.maxAttempts ?? retryOptions.maxAttempts,
        backoff: {
          type: "exponential",
          delay: runPolicy?.initialBackoffMs ?? retryOptions.backoffBaseMs,
        },
        jobId: job.orderId,
      });
    },
    close: () => queue.close(),
  };
}
