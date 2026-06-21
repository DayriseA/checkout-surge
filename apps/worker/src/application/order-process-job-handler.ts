import type { OrderProcessJob } from "@checkout-surge/contracts";
import { type CheckoutSurgeLogger, childLoggerWithCorrelationId } from "@checkout-surge/logger";

export interface OrderProcessJobHandler {
  handle(job: OrderProcessJob): Promise<void>;
}

export class OrderProcessingNotImplementedError extends Error {
  override readonly name = "OrderProcessingNotImplementedError";

  constructor() {
    super("Durable order processing is not implemented until Phase 4, Task 4.3.");
  }
}

export function createOrderProcessJobHandler(dependencies: {
  logger: CheckoutSurgeLogger;
}): OrderProcessJobHandler {
  return {
    handle: async (job) => {
      childLoggerWithCorrelationId(dependencies.logger, job.correlationId).info(
        {
          orderId: job.orderId,
          reservationId: job.reservationId,
          saleOfferId: job.saleOfferId,
          ...(job.runId ? { runId: job.runId } : {}),
        },
        "Order-processing job received by the worker skeleton.",
      );

      throw new OrderProcessingNotImplementedError();
    },
  };
}
