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
  reportBusinessOutcomeUpdateFailure?: (report: {
    error: unknown;
    orderId: string;
    saleOfferId: string;
    runId?: string;
    correlationId: string;
  }) => void;
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
    reportBusinessOutcomeUpdateFailure?: (report: {
      error: unknown;
      orderId: string;
      saleOfferId: string;
      runId?: string;
      correlationId: string;
    }) => void;
  },
  job: NotificationRecordJob,
  logger: CheckoutSurgeLogger,
): Promise<void> {
  try {
    await dependencies.publishBusinessOutcomeUpdate(job);
  } catch (error) {
    const report = {
      error,
      orderId: job.orderId,
      saleOfferId: job.saleOfferId,
      ...(job.runId ? { runId: job.runId } : {}),
      correlationId: job.correlationId,
    };

    if (dependencies.reportBusinessOutcomeUpdateFailure) {
      try {
        dependencies.reportBusinessOutcomeUpdateFailure(report);
      } catch {
        // Reporting is non-critical; the durable notification record remains authoritative.
      }
      return;
    }

    logger.error(
      report,
      "Dashboard business outcome publication failed after notification record.",
    );
  }
}
