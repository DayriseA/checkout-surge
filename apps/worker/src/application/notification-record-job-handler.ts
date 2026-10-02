import type { NotificationRecordJob } from "@checkout-surge/contracts";
import { type CheckoutSurgeLogger, childLoggerWithCorrelationId } from "@checkout-surge/logger";

export interface NotificationRecordPersistence {
  isTerminalResetRun?(runId: string): Promise<boolean>;
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
      let result: { recorded: boolean };
      try {
        result = await dependencies.persistence.record(job);
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "NotificationOrderNotFoundError" &&
          (await dependencies.persistence.isTerminalResetRun?.(job.runId)) === true
        ) {
          return;
        }
        throw error;
      }

      logger.info(
        {
          orderId: job.orderId,
          saleOfferId: job.saleOfferId,
          runId: job.runId,
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
          runId: job.runId,
          correlationId: job.correlationId,
        },
        "Notification record succeeded but dashboard business outcome publication failed.",
      );
    } catch {
      // Logging must not fail the durable notification record.
    }
  }
}
