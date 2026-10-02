import {
  type NotificationRecordJob,
  notificationRecordBullMqQueueName,
  notificationRecordJobName,
  type OrderProcessJob,
} from "@checkout-surge/contracts";
import { type ConnectionOptions, Queue } from "bullmq";
import type { GeneratedRunPublicationFence } from "../application/generated-run-publication-fence.js";
import type { NotificationRecordPublisher } from "../application/order-process-job-handler.js";

export function createBullMqNotificationRecordPublisher(options: {
  connection: ConnectionOptions;
  attempts?: number;
  publicationFence?: GeneratedRunPublicationFence;
}): NotificationRecordPublisher & { close(): Promise<void> } {
  const queue = new Queue<NotificationRecordJob, void, typeof notificationRecordJobName>(
    notificationRecordBullMqQueueName,
    { connection: options.connection },
  );
  return createNotificationRecordPublisher(queue, options);
}

interface NotificationRecordQueue {
  add(
    name: typeof notificationRecordJobName,
    data: NotificationRecordJob,
    options: {
      attempts: number;
      backoff: { type: "exponential"; delay: number };
      jobId: string;
      removeOnComplete: number;
      removeOnFail: boolean;
    },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export function createNotificationRecordPublisher(
  queue: NotificationRecordQueue,
  options: { attempts?: number; publicationFence?: GeneratedRunPublicationFence } = {},
): NotificationRecordPublisher & { close(): Promise<void> } {
  return {
    async publishForConfirmedOrder(job: OrderProcessJob, confirmedAt: string): Promise<void> {
      const payload: NotificationRecordJob = {
        orderId: job.orderId,
        saleOfferId: job.saleOfferId,
        correlationId: job.correlationId,
        runId: job.runId,
        recipientPlaceholder: `simulated-buyer:${job.publicOrderId}`,
        confirmedAt,
      };

      const add = async () => {
        await queue.add(notificationRecordJobName, payload, {
          attempts: options.attempts ?? 3,
          backoff: { type: "exponential", delay: 250 },
          jobId: `${job.orderId}-email`,
          removeOnComplete: 1000,
          removeOnFail: true,
        });
      };

      if (!options.publicationFence) {
        throw new Error(
          "Generated-run notification publication requires a PostgreSQL publication fence.",
        );
      }
      await options.publicationFence.publish({
        runId: job.runId,
        saleOfferId: job.saleOfferId,
        operation: add,
      });
    },
    close: () => queue.close(),
  };
}
