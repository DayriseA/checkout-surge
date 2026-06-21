import {
  type OrderProcessJob,
  orderProcessBullMqQueueName,
  orderProcessJobName,
  orderProcessJobSchema,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { type ConnectionOptions, type Job, Worker } from "bullmq";
import type { OrderProcessJobHandler } from "../application/order-process-job-handler.js";
import type { OrderProcessConsumer } from "./order-process-consumer.js";

export interface OrderProcessJobFailureReport {
  jobId?: string;
  jobName: string;
  attemptsMade: number;
  error: Error;
}

export interface CreateBullMqOrderProcessConsumerOptions {
  connection: ConnectionOptions;
  concurrency: number;
  handler: OrderProcessJobHandler;
  logger: CheckoutSurgeLogger;
  reportFailure?: (report: OrderProcessJobFailureReport) => void | Promise<void>;
}

export function createBullMqOrderProcessConsumer(
  options: CreateBullMqOrderProcessConsumerOptions,
): OrderProcessConsumer {
  const worker = new Worker<OrderProcessJob, void, typeof orderProcessJobName>(
    orderProcessBullMqQueueName,
    async (job) => processJob(job, options.handler),
    {
      autorun: false,
      concurrency: options.concurrency,
      connection: options.connection,
    },
  );

  let runPromise: Promise<void> | null = null;
  let isClosing = false;

  worker.on("failed", (job, error) => {
    const report: OrderProcessJobFailureReport = {
      ...(job?.id ? { jobId: job.id } : {}),
      jobName: job?.name ?? orderProcessJobName,
      attemptsMade: job?.attemptsMade ?? 0,
      error,
    };

    options.logger.error(
      {
        err: error,
        ...(report.jobId ? { jobId: report.jobId } : {}),
        jobName: report.jobName,
        attemptsMade: report.attemptsMade,
        ...correlationLogContext(job?.data),
      },
      "Order-processing job failed.",
    );
    reportFailureSafely(options, report);
  });

  worker.on("completed", (job) => {
    options.logger.info(
      {
        jobId: job.id,
        jobName: job.name,
        ...correlationLogContext(job.data),
      },
      "Order-processing job completed.",
    );
  });

  worker.on("error", (error) => {
    options.logger.error({ err: error }, "Order-processing BullMQ worker error.");
  });

  return {
    start() {
      if (runPromise) {
        return;
      }

      runPromise = worker.run().catch((error: unknown) => {
        if (!isClosing) {
          options.logger.error(
            { err: error },
            "Order-processing BullMQ worker stopped unexpectedly.",
          );
        }
      });
    },
    async close() {
      isClosing = true;
      await worker.close();
      await runPromise;
    },
    isRunning: () => worker.isRunning(),
  };
}

function reportFailureSafely(
  options: CreateBullMqOrderProcessConsumerOptions,
  report: OrderProcessJobFailureReport,
): void {
  if (!options.reportFailure) {
    return;
  }

  try {
    void Promise.resolve(options.reportFailure(report)).catch((error: unknown) =>
      logFailureReporterError(options.logger, error),
    );
  } catch (error) {
    logFailureReporterError(options.logger, error);
  }
}

function logFailureReporterError(logger: CheckoutSurgeLogger, error: unknown): void {
  logger.error({ err: error }, "Order-processing failure reporter threw an error.");
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

async function processJob(
  job: Job<OrderProcessJob, void, typeof orderProcessJobName>,
  handler: OrderProcessJobHandler,
): Promise<void> {
  if (job.name !== orderProcessJobName) {
    throw new Error(`Unsupported order-processing job name: ${job.name}`);
  }

  await handler.handle(orderProcessJobSchema.parse(job.data));
}
