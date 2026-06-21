import {
  type OrderProcessJob,
  orderProcessBullMqQueueName,
  orderProcessJobName,
  orderProcessJobSchema,
} from "@checkout-surge/contracts";
import { type ConnectionOptions, Queue } from "bullmq";
import type { OrderProcessJobPublisher } from "../services/order-process-job-publisher.js";

export interface BullMqOrderProcessJobPublisher extends OrderProcessJobPublisher {
  close(): Promise<void>;
}

export interface OrderProcessQueue {
  add(
    name: typeof orderProcessJobName,
    data: OrderProcessJob,
    options: { jobId: string },
  ): Promise<unknown>;
  close(): Promise<void>;
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
      await queue.add(orderProcessJobName, job, { jobId: job.orderId });
    },
    close: () => queue.close(),
  };
}
