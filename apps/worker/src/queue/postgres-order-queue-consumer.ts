import type { OrderProcessJob } from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { PostgresOrderQueuePersistence } from "../persistence/postgres-order-queue-persistence.js";

export interface PostgresOrderQueueConsumer {
  start(): void;
  /** The ERP asked to slow down: deliver nothing for this long, like BullMQ's rate limit. */
  pause(durationMs: number): void;
  close(): Promise<void>;
}

/** Delivery pacing and concurrency of a run, the values BullMQ's limiter gets for it. */
export interface DeliveryLimits {
  intervalMs: number;
  concurrency: number;
}

/**
 * Delivers the PostgreSQL order queue's jobs to the order handler, with the same pacing and
 * concurrency as the BullMQ queue. A notification at commit wakes it; it never polls.
 */
export function createPostgresOrderQueueConsumer(options: {
  queue: Pick<PostgresOrderQueuePersistence, "claim" | "settle" | "retryLater">;
  /** Calls `wake` on each notification and each time the listening connection (re)connects. */
  listen(wake: () => void): Promise<{ unlisten(): Promise<void> }>;
  limits(runId: string): Promise<DeliveryLimits>;
  deliver(job: OrderProcessJob, deliveries: number): Promise<void>;
  logger: CheckoutSurgeLogger;
  leaseMs?: number;
  retryDelayMs?: number;
  maxDeliveries?: number;
  closeDeadlineMs?: number;
}): PostgresOrderQueueConsumer {
  const leaseMs = options.leaseMs ?? 60_000;
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const maxDeliveries = options.maxDeliveries ?? 3;
  const active = new Set<Promise<void>>();
  let running = false;
  let draining = false;
  let drainAgain = false;
  let pausedUntil = 0;
  let nextDeliveryAt = 0;
  let concurrency = Number.POSITIVE_INFINITY;
  let timer: NodeJS.Timeout | undefined;
  let listening: Promise<{ unlisten(): Promise<void> } | null> | undefined;

  const wakeAt = (at: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void drain(), Math.max(0, at - Date.now()));
    timer.unref();
  };

  const deliver = ({ job, deliveries }: { job: OrderProcessJob; deliveries: number }) => {
    const task = options
      .deliver(job, deliveries)
      .then(() => options.queue.settle(job.orderId))
      .catch(async (error: unknown) => {
        options.logger.error(
          { err: error, orderId: job.orderId, deliveries },
          "PostgreSQL order queue delivery failed.",
        );
        // A later delivery is safe: the handler's execution claim guards the order.
        if (deliveries >= maxDeliveries) return options.queue.settle(job.orderId);
        await options.queue.retryLater(job.orderId, retryDelayMs);
        wakeAt(Date.now() + retryDelayMs);
      })
      .catch((error: unknown) => {
        // The job keeps its lease and is delivered again when it expires.
        options.logger.error({ err: error, orderId: job.orderId }, "Could not settle a job.");
      })
      .finally(() => {
        active.delete(task);
        void drain();
      });
    active.add(task);
  };

  async function drain(): Promise<void> {
    if (!running) return;
    if (draining) {
      drainAgain = true;
      return;
    }
    draining = true;
    try {
      do {
        drainAgain = false;
        while (running && active.size < concurrency) {
          const notBefore = Math.max(pausedUntil, nextDeliveryAt);
          if (notBefore > Date.now()) {
            wakeAt(notBefore);
            break;
          }
          const claimed = await options.queue.claim(leaseMs);
          if (!claimed) break;
          const limits = await options.limits(claimed.job.runId);
          concurrency = limits.concurrency;
          nextDeliveryAt = Date.now() + limits.intervalMs;
          deliver(claimed);
        }
      } while (drainAgain && running);
    } catch (error) {
      options.logger.error({ err: error }, "PostgreSQL order queue claim failed.");
      wakeAt(Date.now() + retryDelayMs);
    } finally {
      draining = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      listening = options
        .listen(() => void drain())
        .catch((error: unknown) => {
          options.logger.error({ err: error }, "Could not listen for PostgreSQL order jobs.");
          return null;
        });
      void drain();
    },
    pause(durationMs) {
      pausedUntil = Math.max(pausedUntil, Date.now() + durationMs);
    },
    async close() {
      running = false;
      clearTimeout(timer);
      await (await listening)?.unlisten().catch(() => undefined);
      let deadline: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(active),
        new Promise((resolve) => {
          deadline = setTimeout(resolve, options.closeDeadlineMs ?? 5_000);
        }),
      ]);
      clearTimeout(deadline);
    },
  };
}
