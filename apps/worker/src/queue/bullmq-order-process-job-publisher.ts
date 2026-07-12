import {
  type OrderProcessJob,
  orderProcessBullMqQueueName,
  orderProcessJobName,
  orderProcessJobSchema,
} from "@checkout-surge/contracts";
import { type ConnectionOptions, Queue } from "bullmq";
import type { OrderDispatchPublisher } from "../application/order-dispatch-scanner.js";

export interface WorkerOrderProcessJobPublisher extends OrderDispatchPublisher {
  close(): Promise<void>;
}

interface OrderProcessQueue {
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

export function createBullMqOrderProcessJobPublisher(
  connection: ConnectionOptions,
  retryOptions: { maxAttempts: number; backoffBaseMs: number } = {
    maxAttempts: 4,
    backoffBaseMs: 500,
  },
): WorkerOrderProcessJobPublisher {
  const queue = new Queue<OrderProcessJob, void, typeof orderProcessJobName>(
    orderProcessBullMqQueueName,
    { connection },
  );

  return createOrderProcessJobPublisher(queue, retryOptions);
}

export function createOrderProcessJobPublisher(
  queue: OrderProcessQueue,
  retryOptions: { maxAttempts: number; backoffBaseMs: number } = {
    maxAttempts: 4,
    backoffBaseMs: 500,
  },
): WorkerOrderProcessJobPublisher {
  return {
    async enqueue(input) {
      const job = orderProcessJobSchema.parse(input);
      await queue.add(orderProcessJobName, job, {
        attempts: retryOptions.maxAttempts,
        backoff: { type: "exponential", delay: retryOptions.backoffBaseMs },
        jobId: job.orderId,
      });
    },
    close: () => queue.close(),
  };
}
