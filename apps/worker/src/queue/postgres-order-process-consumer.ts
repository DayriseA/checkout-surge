import { orderProcessJobName, orderProcessQueueName } from "@checkout-surge/contracts";
import type {
  PostgresOrderDelivery,
  PostgresOrderDeliveryClaim,
  SqlClient,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { OrderProcessJobHandler } from "../application/order-process-job-handler.js";
import type { OrderRecoveryPersistence } from "../application/order-recovery-scanner.js";
import {
  OrderJobIdentityMismatchError,
  OrderNotFoundError,
} from "../persistence/postgres-order-transition-persistence.js";
import type { OrderProcessConsumer } from "./order-process-consumer.js";

export function createPostgresOrderProcessConsumer(options: {
  delivery: Pick<PostgresOrderDelivery, "claim" | "renew" | "settle">;
  sql: SqlClient;
  handler: OrderProcessJobHandler;
  recovery: Pick<
    OrderRecoveryPersistence,
    "isTerminalResetRun" | "recordRecoverable" | "recordDeadLetter"
  >;
  logger: CheckoutSurgeLogger;
  concurrency: number;
  scanIntervalMs: number;
  leaseSeconds: number;
  closeDeadlineMs: number;
}): OrderProcessConsumer {
  let running = false;
  let closed = false;
  let forced = false;
  let timer: NodeJS.Timeout | undefined;
  let claiming: Promise<void> | undefined;
  const active = new Set<Promise<void>>();
  const renewals = new Set<NodeJS.Timeout>();

  const processClaim = async (claim: PostgresOrderDeliveryClaim) => {
    let renewing = false;
    const renewal = setInterval(
      () => {
        if (renewing || forced) return;
        renewing = true;
        void options.delivery
          .renew(claim, options.leaseSeconds)
          .then((owned) => {
            if (!owned) clearInterval(renewal);
          })
          .catch((error) =>
            options.logger.error({ err: error }, "PostgreSQL order delivery renewal failed."),
          )
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(1, Math.floor((options.leaseSeconds * 1000) / 3)),
    );
    renewal.unref();
    renewals.add(renewal);
    const metadata = {
      attemptNumber: 1,
      attemptsMade: 0,
      deliveryId: claim.publicationId,
      ...(claim.job.processingGeneration === undefined
        ? {}
        : { processingGeneration: claim.job.processingGeneration }),
      ...(claim.publicationId.startsWith("recovery-")
        ? { recoveryKey: `order:${claim.job.orderId}` }
        : {}),
    };
    try {
      try {
        await options.handler.handle(claim.job, metadata);
      } catch (error) {
        if (
          error instanceof OrderNotFoundError &&
          (await options.recovery.isTerminalResetRun?.(claim.job.runId))
        ) {
          // Reset purges the order while retaining the history identity.
        } else if (
          error instanceof OrderNotFoundError ||
          error instanceof OrderJobIdentityMismatchError
        ) {
          await options.recovery.recordDeadLetter({
            jobId: claim.publicationId,
            jobName: orderProcessJobName,
            queueName: orderProcessQueueName,
            payload: claim.job,
            orderId: error.orderId,
            reason:
              error instanceof OrderNotFoundError ? "order_not_found" : "order_identity_mismatch",
            ...(error instanceof OrderJobIdentityMismatchError
              ? { mismatchedFields: error.mismatchedFields }
              : {}),
            attemptsMade: 0,
            correlationId: claim.job.correlationId,
            observedAt: new Date(),
          });
        } else {
          await options.recovery.recordRecoverable({
            job: claim.job,
            delivery: metadata,
            reason: "exhausted_order_processing_delivery",
            error,
            sourceJobId: claim.publicationId,
            sourceDisposition: `${claim.publicationId}:${claim.deliveryGeneration}`,
          });
          throw error;
        }
      }
      if (!forced) await options.delivery.settle(claim);
    } finally {
      clearInterval(renewal);
      renewals.delete(renewal);
    }
  };
  const scan = () => {
    if (!running || closed || claiming || active.size >= options.concurrency) return;
    claiming = (async () => {
      const claims = await options.delivery.claim({
        limit: options.concurrency - active.size,
        leaseSeconds: options.leaseSeconds,
      });
      for (const claim of claims) {
        if (closed) break;
        const task = processClaim(claim)
          .catch((error) => {
            options.logger.error(
              { err: error, publicationId: claim.publicationId },
              "PostgreSQL order delivery failed; its lease remains recoverable.",
            );
          })
          .finally(() => {
            active.delete(task);
          });
        active.add(task);
      }
    })()
      .catch((error) => {
        options.logger.error({ err: error }, "PostgreSQL order delivery claim failed.");
      })
      .finally(() => {
        claiming = undefined;
      });
  };
  let closePromise: Promise<void> | undefined;
  return {
    start() {
      if (running || closed) return;
      running = true;
      scan();
      timer = setInterval(scan, options.scanIntervalMs);
      timer.unref();
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        running = false;
        clearInterval(timer);
        let deadline: NodeJS.Timeout | undefined;
        const drained = await Promise.race([
          (async () => {
            await claiming;
            await Promise.all(active);
            return true;
          })(),
          new Promise<false>((resolve) => {
            deadline = setTimeout(resolve, options.closeDeadlineMs, false);
          }),
        ]);
        clearTimeout(deadline);
        forced = !drained;
        for (const renewal of renewals) clearInterval(renewal);
        if (!drained)
          options.logger.warn(
            { closeDeadlineMs: options.closeDeadlineMs },
            "PostgreSQL order deliveries did not settle before shutdown.",
          );
      })();
      return closePromise;
    },
    isRunning: () => running,
    async checkConnectivity() {
      await options.sql`select 1 from postgres_order_deliveries limit 1`;
    },
  };
}
