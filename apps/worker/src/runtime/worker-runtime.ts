import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { NotificationRecordConsumer } from "../queue/notification-record-consumer.js";
import type { OrderProcessConsumer } from "../queue/order-process-consumer.js";
import type { WorkerHealthServer } from "../server.js";

export interface WorkerRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createWorkerRuntime(options: {
  healthServer: WorkerHealthServer;
  healthHost: string;
  healthPort: number;
  orderProcessConsumer: OrderProcessConsumer;
  notificationRecordConsumer: NotificationRecordConsumer;
  closeNotificationRecordPublisher?: () => Promise<void>;
  closePostgres: () => Promise<void>;
  closeRedis: () => Promise<void>;
  logger: CheckoutSurgeLogger;
}): WorkerRuntime {
  let started = false;
  let closePromise: Promise<void> | null = null;

  return {
    async start() {
      if (started) {
        return;
      }
      if (closePromise) {
        throw new Error("A closed worker runtime cannot be restarted.");
      }

      try {
        options.orderProcessConsumer.start();
        options.notificationRecordConsumer.start();
        await options.healthServer.listen({
          host: options.healthHost,
          port: options.healthPort,
          listenTextResolver: (address) => `Worker health server listening at ${address}`,
        });
        started = true;
      } catch (error) {
        closePromise = closeResources(options).finally(() => {
          started = false;
        });
        try {
          await closePromise;
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Worker startup failed and resource cleanup also failed.",
            { cause: error },
          );
        }
        throw error;
      }
    },
    close() {
      closePromise ??= (async () => {
        options.logger.info("Closing worker runtime.");
        try {
          await closeResources(options);
        } finally {
          started = false;
        }
      })();

      return closePromise;
    },
  };
}

async function closeResources(options: Parameters<typeof createWorkerRuntime>[0]): Promise<void> {
  const errors: unknown[] = [];
  const close = async (resource: () => Promise<void>) => {
    try {
      await resource();
    } catch (error) {
      errors.push(error);
    }
  };

  await close(() => options.healthServer.close());
  await close(() => options.orderProcessConsumer.close());
  await close(() => options.notificationRecordConsumer.close());
  if (options.closeNotificationRecordPublisher) {
    await close(options.closeNotificationRecordPublisher);
  }
  await close(options.closePostgres);
  await close(options.closeRedis);

  if (errors.length > 0) {
    throw new AggregateError(errors, "One or more worker resources failed to close.");
  }
}
