import type { InlineConfirmationRequest, OrderProcessJob } from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { InlineOrderConfirmation } from "./inline-order-confirmation.js";
import type { OrderDispatchPersistence } from "./order-dispatch-scanner.js";
import type { OrderRecoveryPersistence } from "./order-recovery-scanner.js";

/** Discovery is durable; this scanner is deliberately incapable of ORDER publication. */
export function createInlineOrderRecoveryScanner(options: {
  service: Pick<InlineOrderConfirmation, "recover">;
  recovery: Pick<OrderRecoveryPersistence, "findRecoverable">;
  dispatch: OrderDispatchPersistence;
  logger: CheckoutSurgeLogger;
  scanIntervalMs: number;
  batchSize: number;
  minimumQueuedAgeMs: number;
}) {
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const scanOnce = async () => {
    const now = new Date();
    const recovery = await options.recovery.findRecoverable({ now, limit: options.batchSize });
    const queued = await options.dispatch.findQueuedOrdersForDispatch({
      queuedBefore: new Date(now.getTime() - options.minimumQueuedAgeMs),
      limit: options.batchSize,
    });
    for (const job of [...recovery.map((candidate) => candidate.job), ...queued]) {
      if (closed) break;
      await options.service.recover(toRequest(job));
    }
  };
  const run = () => {
    if (closed || running) return;
    running = scanOnce()
      .catch((error: unknown) =>
        options.logger.error({ err: error }, "Inline recovery scan failed."),
      )
      .finally(() => {
        running = undefined;
      });
  };
  return {
    scanOnce,
    start() {
      if (timer || closed) return;
      run();
      timer = setInterval(run, options.scanIntervalMs);
      timer.unref();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}

function toRequest(job: OrderProcessJob): InlineConfirmationRequest {
  return {
    orderId: job.orderId,
    reservationId: job.reservationId,
    saleOfferId: job.saleOfferId,
    runId: job.runId,
    correlationId: job.correlationId,
  };
}
