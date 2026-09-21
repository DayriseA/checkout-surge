import {
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
