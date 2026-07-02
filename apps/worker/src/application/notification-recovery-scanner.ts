import type { OrderProcessJob } from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { NotificationRecordPublisher } from "./order-process-job-handler.js";

export interface RecoverableNotificationOrder {
  job: OrderProcessJob;
  confirmedAt: string;
}

export interface NotificationRecoveryPersistence {
  findConfirmedOrdersMissingNotifications(input: {
    limit: number;
  }): Promise<RecoverableNotificationOrder[]>;
}

export interface NotificationRecoveryPublishFailureReport {
  error: unknown;
  orderId: string;
  saleOfferId: string;
  runId?: string;
  correlationId: string;
}

export interface NotificationRecoveryScanResult {
  candidates: number;
  published: number;
  failed: number;
}

export interface NotificationRecoveryScanner {
  scanOnce(): Promise<NotificationRecoveryScanResult>;
  start(): void;
  close(): Promise<void>;
}

export function createNotificationRecoveryScanner(dependencies: {
  persistence: NotificationRecoveryPersistence;
  publisher: NotificationRecordPublisher;
  logger: CheckoutSurgeLogger;
  scanIntervalMs: number;
  batchSize: number;
  reportPublishFailure?: (report: NotificationRecoveryPublishFailureReport) => void;
}): NotificationRecoveryScanner {
  let interval: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let closed = false;

  const scanOnce = async (): Promise<NotificationRecoveryScanResult> => {
    const candidates = await dependencies.persistence.findConfirmedOrdersMissingNotifications({
      limit: dependencies.batchSize,
    });
    let published = 0;
    let failed = 0;

    for (const candidate of candidates) {
      try {
        await dependencies.publisher.publishForConfirmedOrder(candidate.job, candidate.confirmedAt);
        published += 1;
      } catch (error) {
        failed += 1;
        reportPublishFailure(dependencies, candidate.job, error);
      }
    }

    if (candidates.length > 0) {
      dependencies.logger.info(
        { candidates: candidates.length, published, failed },
        "Notification recovery scan completed.",
      );
    }

    return { candidates: candidates.length, published, failed };
  };

  const runScanWithoutOverlap = () => {
    if (closed || inFlight) {
      return;
    }

    inFlight = scanOnce()
      .then(() => undefined)
      .catch((error: unknown) => {
        dependencies.logger.error({ err: error }, "Notification recovery scan failed.");
      })
      .finally(() => {
        inFlight = null;
      });
  };

  return {
    scanOnce,
    start() {
      if (interval) {
        return;
      }

      closed = false;
      runScanWithoutOverlap();
      interval = setInterval(runScanWithoutOverlap, dependencies.scanIntervalMs);
      interval.unref();
    },
    async close() {
      closed = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      await inFlight;
    },
  };
}

function reportPublishFailure(
  dependencies: {
    logger: CheckoutSurgeLogger;
    reportPublishFailure?: (report: NotificationRecoveryPublishFailureReport) => void;
  },
  job: OrderProcessJob,
  error: unknown,
): void {
  const report = {
    error,
    orderId: job.orderId,
    saleOfferId: job.saleOfferId,
    ...(job.runId ? { runId: job.runId } : {}),
    correlationId: job.correlationId,
  };

  if (dependencies.reportPublishFailure) {
    try {
      dependencies.reportPublishFailure(report);
    } catch {
      // Reporting is non-critical; the next recovery scan can retry publication.
    }
    return;
  }

  dependencies.logger.error(
    report,
    "Notification recovery could not publish a notification-recording job.",
  );
}
