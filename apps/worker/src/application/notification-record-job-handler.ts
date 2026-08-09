import type { NotificationRecordJob } from "@checkout-surge/contracts";
import { type CheckoutSurgeLogger, childLoggerWithCorrelationId } from "@checkout-surge/logger";

export interface NotificationRecordPersistence {
  record(job: NotificationRecordJob): Promise<{ recorded: boolean }>;
}

export interface NotificationRecordJobHandler {
  handle(job: NotificationRecordJob): Promise<void>;
}

export function createNotificationRecordJobHandler(dependencies: {
  persistence: NotificationRecordPersistence;
  logger: CheckoutSurgeLogger;
  publishBusinessOutcomeUpdate: (job: NotificationRecordJob) => Promise<void>;
}): NotificationRecordJobHandler {
  return {
    handle: async (job) => {
      const logger = childLoggerWithCorrelationId(dependencies.logger, job.correlationId);
      const result = await dependencies.persistence.record(job);

      logger.info(
        {
          orderId: job.orderId,
          saleOfferId: job.saleOfferId,
          ...(job.runId ? { runId: job.runId } : {}),
          recorded: result.recorded,
        },
        result.recorded
          ? "Simulated notification recorded."
          : "Simulated notification replay acknowledged.",
      );

      if (result.recorded) {
        await publishBusinessOutcomeUpdateWithoutFailingJob(dependencies, job, logger);
      }
    },
  };
}

async function publishBusinessOutcomeUpdateWithoutFailingJob(
  dependencies: {
    publishBusinessOutcomeUpdate: (job: NotificationRecordJob) => Promise<void>;
  },
  job: NotificationRecordJob,
  logger: CheckoutSurgeLogger,
): Promise<void> {
  try {
    await dependencies.publishBusinessOutcomeUpdate(job);
  } catch (error) {
    try {
      logger.error(
        {
          err: error,
          orderId: job.orderId,
          saleOfferId: job.saleOfferId,
          ...(job.runId ? { runId: job.runId } : {}),
          correlationId: job.correlationId,
        },
        "Notification record succeeded but dashboard business outcome publication failed.",
      );
    } catch {
      // Logging must not fail the durable notification record.
    }
  }
}
