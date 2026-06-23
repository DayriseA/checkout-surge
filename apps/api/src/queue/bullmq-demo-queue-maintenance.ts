import {
  notificationRecordBullMqQueueName,
  notificationRecordQueueName,
  orderProcessBullMqQueueName,
  orderProcessQueueName,
} from "@checkout-surge/contracts";
import { type ConnectionOptions, Queue } from "bullmq";
import type {
  DemoQueueMaintenance,
  QueueCleanupSummary,
} from "../services/demo-maintenance-service.js";

const cleanedJobGraceMs = 0;
const cleanedJobLimit = 10_000;

export function createBullMqDemoQueueMaintenance(
  connection: ConnectionOptions,
): DemoQueueMaintenance & { close(): Promise<void> } {
  const queues = [
    {
      semanticName: orderProcessQueueName,
      queue: new Queue(orderProcessBullMqQueueName, { connection }),
    },
    {
      semanticName: notificationRecordQueueName,
      queue: new Queue(notificationRecordBullMqQueueName, { connection }),
    },
  ];

  return {
    async cleanResetOwnedQueues(): Promise<QueueCleanupSummary> {
      let cleanedJobCount = 0;

      for (const entry of queues) {
        await entry.queue.drain(true);
        for (const status of ["completed", "failed"] as const) {
          cleanedJobCount += (await entry.queue.clean(cleanedJobGraceMs, cleanedJobLimit, status))
            .length;
        }
      }

      return {
        cleanedQueueCount: queues.length,
        cleanedJobCount,
      };
    },
    async close() {
      await Promise.all(queues.map((entry) => entry.queue.close()));
    },
  };
}
