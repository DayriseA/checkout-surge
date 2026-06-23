import {
  type NotificationRecordJob,
  notificationRecordBullMqQueueName,
  notificationRecordJobName,
  type OrderProcessJob,
} from "@checkout-surge/contracts";
import { type ConnectionOptions, Queue } from "bullmq";
import type { NotificationRecordPublisher } from "../application/order-process-job-handler.js";

export function createBullMqNotificationRecordPublisher(options: {
  connection: ConnectionOptions;
  attempts?: number;
}): NotificationRecordPublisher & { close(): Promise<void> } {
  const queue = new Queue<NotificationRecordJob, void, typeof notificationRecordJobName>(
    notificationRecordBullMqQueueName,
    { connection: options.connection },
  );

  return {
    async publishForConfirmedOrder(job: OrderProcessJob, confirmedAt: string): Promise<void> {
      const payload: NotificationRecordJob = {
        orderId: job.orderId,
        saleOfferId: job.saleOfferId,
        correlationId: job.correlationId,
        ...(job.runId ? { runId: job.runId } : {}),
        channel: "email",
        recipientPlaceholder: `simulated-buyer:${job.publicOrderId}`,
        confirmedAt,
      };

      await queue.add(notificationRecordJobName, payload, {
        attempts: options.attempts ?? 3,
        backoff: { type: "exponential", delay: 250 },
        jobId: `${job.orderId}:email`,
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
    },
    close: () => queue.close(),
  };
}
