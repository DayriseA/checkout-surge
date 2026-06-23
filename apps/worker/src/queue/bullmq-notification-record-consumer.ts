import {
  type NotificationRecordJob,
  notificationRecordBullMqQueueName,
  notificationRecordJobName,
  notificationRecordJobSchema,
  notificationRecordQueueName,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { type ConnectionOptions, type Job, Worker } from "bullmq";
import type { NotificationRecordJobHandler } from "../application/notification-record-job-handler.js";
import type { NotificationRecordConsumer } from "./notification-record-consumer.js";

export interface CreateBullMqNotificationRecordConsumerOptions {
  connection: ConnectionOptions;
  concurrency: number;
  handler: NotificationRecordJobHandler;
  logger: CheckoutSurgeLogger;
}

export const notificationRecordQueueNotReadyMessage =
  "The notification-recording queue connection is not ready.";

export function createBullMqNotificationRecordConsumer(
  options: CreateBullMqNotificationRecordConsumerOptions,
): NotificationRecordConsumer {
  const worker = new Worker<NotificationRecordJob, void, typeof notificationRecordJobName>(
    notificationRecordBullMqQueueName,
    async (job) => processJob(job, options.handler),
    {
      autorun: false,
      concurrency: options.concurrency,
      connection: options.connection,
    },
  );

  let runPromise: Promise<void> | null = null;
  let isClosing = false;
  let isQueueConnectionReady = false;

  worker.on("failed", (job, error) => {
    options.logger.error(
      {
        err: error,
        ...(job?.id ? { jobId: job.id } : {}),
        jobName: job?.name ?? notificationRecordJobName,
        attemptsMade: job?.attemptsMade ?? 0,
        ...correlationLogContext(job?.data),
      },
      "Notification-recording job failed.",
    );
  });

  worker.on("completed", (job) => {
    options.logger.info(
      {
        jobId: job.id,
        jobName: job.name,
        ...correlationLogContext(job.data),
      },
      "Notification-recording job completed.",
    );
  });

  worker.on("error", (error) => {
    isQueueConnectionReady = false;
    options.logger.error({ err: error }, "Notification-recording BullMQ worker error.");
  });

  worker.on("ready", () => {
    isQueueConnectionReady = !isClosing;
    options.logger.info(
      {
        queueName: notificationRecordQueueName,
        physicalQueueName: notificationRecordBullMqQueueName,
      },
      "Notification-recording BullMQ worker is ready.",
    );
  });

  worker.on("ioredis:close", () => {
    isQueueConnectionReady = false;
  });
  worker.on("closing", () => {
    isQueueConnectionReady = false;
  });
  worker.on("closed", () => {
    isQueueConnectionReady = false;
  });

  return {
    start() {
      if (runPromise) {
        return;
      }

      runPromise = worker.run().catch((error: unknown) => {
        isQueueConnectionReady = false;
        if (!isClosing) {
          options.logger.error(
            { err: error },
            "Notification-recording BullMQ worker stopped unexpectedly.",
          );
        }
      });
    },
    async close() {
      isClosing = true;
      isQueueConnectionReady = false;
      await worker.close();
      await runPromise;
    },
    isRunning: () => worker.isRunning(),
    async checkConnectivity() {
      if (!isQueueConnectionReady) {
        throw new Error(notificationRecordQueueNotReadyMessage);
      }
    },
  };
}

async function processJob(
  job: Job<NotificationRecordJob, void, typeof notificationRecordJobName>,
  handler: NotificationRecordJobHandler,
): Promise<void> {
  if (job.name !== notificationRecordJobName) {
    throw new Error(`Unsupported notification-recording job name: ${job.name}`);
  }

  await handler.handle(notificationRecordJobSchema.parse(job.data));
}

function correlationLogContext(data: unknown): { correlationId?: string } {
  if (
    typeof data === "object" &&
    data !== null &&
    "correlationId" in data &&
    typeof data.correlationId === "string"
  ) {
    return { correlationId: data.correlationId };
  }

  return {};
}
