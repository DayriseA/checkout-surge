import type { OrderProcessJob } from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { OrderJobPublisher } from "./order-job-publisher.js";

export interface OrderDispatchPersistence {
  findQueuedOrdersForDispatch(input: {
    queuedBefore: Date;
    limit: number;
  }): Promise<OrderProcessJob[]>;
}

export interface OrderDispatchScanResult {
  candidates: number;
  published: number;
  failed: number;
}

export interface OrderDispatchScanner {
  scanOnce(): Promise<OrderDispatchScanResult>;
  start(): void;
  close(): Promise<void>;
}

/**
 * Re-asserts the queue handoff for durable orders that are still queued in
 * PostgreSQL. The order ID is the BullMQ identity, so an API enqueue racing
 * this scanner (or a repeated scan) cannot create a second logical job.
 */
export function createOrderDispatchScanner(dependencies: {
  persistence: OrderDispatchPersistence;
  publisher: OrderJobPublisher;
  logger: CheckoutSurgeLogger;
  scanIntervalMs: number;
  batchSize: number;
  minimumQueuedAgeMs: number;
  now?: () => Date;
  reportPublishFailure?: (report: { error: unknown; job: OrderProcessJob }) => void;
}): OrderDispatchScanner {
  let interval: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let closed = false;

  const scanOnce = async (): Promise<OrderDispatchScanResult> => {
    const now = dependencies.now?.() ?? new Date();
    const queuedBefore = new Date(now.getTime() - dependencies.minimumQueuedAgeMs);
    const candidates = await dependencies.persistence.findQueuedOrdersForDispatch({
      queuedBefore,
      limit: dependencies.batchSize,
    });
    let published = 0;
    let failed = 0;

    for (const job of candidates) {
      try {
        await dependencies.publisher.enqueue(job);
        published += 1;
      } catch (error) {
        failed += 1;
        reportPublishFailure(dependencies, job, error);
      }
    }

    if (candidates.length > 0) {
      dependencies.logger.info(
        { candidates: candidates.length, published, failed },
        "Order dispatch recovery scan completed.",
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
        dependencies.logger.error({ err: error }, "Order dispatch recovery scan failed.");
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
    reportPublishFailure?: (report: { error: unknown; job: OrderProcessJob }) => void;
  },
  job: OrderProcessJob,
  error: unknown,
): void {
  const report = { error, job };

  if (dependencies.reportPublishFailure) {
    try {
      dependencies.reportPublishFailure(report);
    } catch {
      // Reporting is non-critical; a later scan can retry publication.
    }
    return;
  }

  dependencies.logger.error(
    {
      err: error,
      orderId: job.orderId,
      saleOfferId: job.saleOfferId,
      correlationId: job.correlationId,
    },
    "Order dispatch recovery could not publish an order-processing job.",
  );
}
