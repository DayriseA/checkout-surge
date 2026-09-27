import {
  orderProcessBullMqQueueName,
  orderProcessQueueName,
  type QueueStatus,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { ApiHttpError } from "../runtime/errors.js";

export interface OrderProcessQueueInspector {
  inspect(): Promise<QueueStatus>;
}

export interface QueueConnectivityChecker {
  checkConnectivity(): Promise<void>;
}

export class QueueStatusService {
  constructor(
    private readonly inspector: OrderProcessQueueInspector,
    private readonly logger: CheckoutSurgeLogger,
  ) {}

  async getStatus(): Promise<QueueStatus> {
    try {
      const status = await this.inspector.inspect();
      this.logger.info(
        {
          queueName: status.name,
          physicalQueueName: orderProcessBullMqQueueName,
          depth: status.depth,
          activeCount: status.counts.active,
          failedJobCount: status.failedJobs.totalCount,
          observedAt: status.observedAt,
        },
        "Order-processing queue status inspected.",
      );
      return status;
    } catch (error) {
      this.logger.error(
        {
          err: error,
          queueName: orderProcessQueueName,
          physicalQueueName: orderProcessBullMqQueueName,
        },
        "Order-processing queue status inspection failed.",
      );
      throw new ApiHttpError({
        statusCode: 503,
        code: "queue_status_unavailable",
        message: "Order-processing queue status is unavailable.",
      });
    }
  }
}
