import {
  erpDispatchRateLimit,
  idleErpDispatchLimits,
  type OrderProcessJob,
  orderProcessJobName,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { OrderProcessJobHandler } from "../application/order-process-job-handler.js";
import type { OrderRecoveryPersistence } from "../application/order-recovery-scanner.js";
import type { RunConfigReader } from "../application/run-config.js";
import type { PostgresOrderQueuePersistence } from "../persistence/postgres-order-queue-persistence.js";
import { processJob } from "./bullmq-order-process-consumer.js";

export interface PostgresOrderQueueConsumer {
  start(): void;
  /** The ERP asked to slow down: deliver nothing for this long, like BullMQ's rate limit. */
  pause(durationMs: number): void;
  close(): Promise<void>;
}

/** After a failed claim or LISTEN, before trying again. */
const retryAfterErrorMs = 5_000;

/**
 * Delivers the PostgreSQL order queue's jobs to the order handler with the BullMQ queue's pacing,
 * concurrency and single attempt. A notification at commit wakes it; otherwise it wakes only when
 * a pause, the pacing or the earliest lease ends: it never polls.
 */
export function createPostgresOrderQueueConsumer(options: {
  queue: Pick<PostgresOrderQueuePersistence, "claim" | "settle">;
  /** Calls `wake` on each notification and each time the listening connection (re)connects. */
  listen(wake: () => void): Promise<{ unlisten(): Promise<void> }>;
  runConfig: RunConfigReader;
  handler: OrderProcessJobHandler;
  recovery: Pick<
    OrderRecoveryPersistence,
    "isTerminalResetRun" | "recordRecoverable" | "recordDeadLetter"
  >;
  logger: CheckoutSurgeLogger;
  leaseMs?: number;
  closeDeadlineMs?: number;
}): PostgresOrderQueueConsumer {
  const leaseMs = options.leaseMs ?? 60_000;
  const active = new Set<Promise<void>>();
  let running = false;
  let draining = false;
  let drainAgain = false;
  let pausedUntil = 0;
  let nextDeliveryAt = 0;
  let concurrency = Number.POSITIVE_INFINITY;
  let timer: NodeJS.Timeout | undefined;
  let timerAt = Number.POSITIVE_INFINITY;
  let listening: Promise<{ unlisten(): Promise<void> } | null> | undefined;

  /** One timer, kept for the earliest wake-up asked for. */
  const wakeAt = (at: number) => {
    if (timer && timerAt <= at) return;
    clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(
      () => {
        timer = undefined;
        timerAt = Number.POSITIVE_INFINITY;
        void drain();
      },
      Math.max(0, at - Date.now()),
    );
    timer.unref();
  };

  const limitsFor = async (runId: string) => {
    const snapshot = await options.runConfig.read(runId);
    const { max, duration } = erpDispatchRateLimit(
      snapshot?.erpConfig.maxTps ?? idleErpDispatchLimits.maxTps,
    );
    return {
      intervalMs: duration / max,
      concurrency:
        snapshot?.backpressureConfig.orderProcessConcurrency ?? idleErpDispatchLimits.concurrency,
    };
  };

  /**
   * One attempt, as with BullMQ: a failure goes to the shared recovery path, and the job is
   * settled once that disposition is recorded. If recording it failed, the job stays leased and
   * is delivered again when its lease expires.
   */
  const deliver = async (job: OrderProcessJob) => {
    let handedOff = false;
    try {
      await processJob(
        {
          name: orderProcessJobName,
          data: job,
          id: job.orderId,
          attemptsMade: 0,
          updateProgress: async () => undefined,
        },
        {
          handler: options.handler,
          recovery: {
            isTerminalResetRun: async (runId) =>
              (await options.recovery.isTerminalResetRun?.(runId)) ?? false,
            recordDeadLetter: (input) => options.recovery.recordDeadLetter(input),
            recordRecoverable: async (input) => {
              await options.recovery.recordRecoverable(input);
              handedOff = true;
            },
          },
        },
      );
    } catch (error) {
      if (!handedOff) throw error;
    }
    await options.queue.settle(job.orderId);
  };

  const start = (job: OrderProcessJob) => {
    const task = deliver(job)
      .catch((error: unknown) => {
        options.logger.error(
          { err: error, orderId: job.orderId },
          "PostgreSQL order queue delivery failed; the job is delivered again when its lease expires.",
        );
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
          const claim = await options.queue.claim(leaseMs);
          if (!("job" in claim)) {
            if (claim.nextAt) wakeAt(claim.nextAt.getTime());
            break;
          }
          const limits = await limitsFor(claim.job.runId);
          concurrency = limits.concurrency;
          nextDeliveryAt = Date.now() + limits.intervalMs;
          start(claim.job);
        }
      } while (drainAgain && running);
    } catch (error) {
      options.logger.error({ err: error }, "PostgreSQL order queue claim failed.");
      wakeAt(Date.now() + retryAfterErrorMs);
    } finally {
      draining = false;
    }
  }

  const listen = () => {
    if (!running) return;
    listening = options
      .listen(() => void drain())
      .catch((error: unknown) => {
        options.logger.error({ err: error }, "Could not listen for PostgreSQL order jobs.");
        setTimeout(listen, retryAfterErrorMs).unref();
        return null;
      });
  };

  return {
    start() {
      if (running) return;
      running = true;
      listen();
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
