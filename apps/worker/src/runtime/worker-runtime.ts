import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { NotificationRecoveryScanner } from "../application/notification-recovery-scanner.js";
import type { OrderDispatchScanner } from "../application/order-dispatch-scanner.js";
import type { OrderRecoveryScanner } from "../application/order-recovery-scanner.js";
import type { NotificationRecordConsumer } from "../queue/notification-record-consumer.js";
import type { OrderProcessConsumer } from "../queue/order-process-consumer.js";
import type { WorkerHealthServer } from "../server.js";

export function createWorkerRuntime(options: {
  healthServer: WorkerHealthServer;
  healthHost: string;
  healthPort: number;
  orderProcessConsumer: OrderProcessConsumer;
  notificationRecordConsumer: NotificationRecordConsumer;
  notificationRecoveryScanner?: NotificationRecoveryScanner;
  orderDispatchScanner?: OrderDispatchScanner;
  orderRecoveryScanner?: OrderRecoveryScanner;
  closeOrderProcessJobPublisher?: () => Promise<void>;
  closeNotificationRecordPublisher?: () => Promise<void>;
  closeBusinessOutcomePublicationScheduler?: () => Promise<void>;
  closeAdaptiveErpAdmission?: () => Promise<void>;
  closePostgres: () => Promise<void>;
  closeRedis: () => Promise<void>;
  logger: CheckoutSurgeLogger;
}) {
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
        await options.orderRecoveryScanner?.scanOnce();
        options.orderProcessConsumer.start();
        options.notificationRecordConsumer.start();
        options.notificationRecoveryScanner?.start();
        options.orderDispatchScanner?.start();
        options.orderRecoveryScanner?.start();
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
  const notificationRecoveryScanner = options.notificationRecoveryScanner;
  if (notificationRecoveryScanner) {
    await close(() => notificationRecoveryScanner.close());
  }
  const orderDispatchScanner = options.orderDispatchScanner;
  if (orderDispatchScanner) {
    await close(() => orderDispatchScanner.close());
  }
  const orderRecoveryScanner = options.orderRecoveryScanner;
  if (orderRecoveryScanner) {
    await close(() => orderRecoveryScanner.close());
  }
  if (options.closeOrderProcessJobPublisher) {
    await close(options.closeOrderProcessJobPublisher);
  }
  if (options.closeNotificationRecordPublisher) {
    await close(options.closeNotificationRecordPublisher);
  }
  if (options.closeBusinessOutcomePublicationScheduler) {
    await close(options.closeBusinessOutcomePublicationScheduler);
  }
  if (options.closeAdaptiveErpAdmission) {
    await close(options.closeAdaptiveErpAdmission);
  }
  await close(options.closePostgres);
  await close(options.closeRedis);

  if (errors.length > 0) {
    throw new AggregateError(errors, "One or more worker resources failed to close.");
  }
}
