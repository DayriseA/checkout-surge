import { contractsPackageName } from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  dbPackageName,
  publishBusinessOutcomeDashboardUpdate,
  setErpCircuitBreakerSnapshot,
} from "@checkout-surge/db";
import { createServiceLogger, loggerPackageName } from "@checkout-surge/logger";
import { Redis } from "ioredis";
import {
  ErpCircuitBreaker,
  isTemporaryErpCircuitError,
} from "./application/erp-circuit-breaker.js";
import {
  HttpErpOrderConfirmation,
  isErpAttemptPersistenceError,
  isTemporaryErpConfirmationError,
  isTemporaryErpDependencyError,
} from "./application/erp-confirmation-client.js";
import { createNotificationRecordJobHandler } from "./application/notification-record-job-handler.js";
import { createOrderProcessJobHandler } from "./application/order-process-job-handler.js";
import { RunScopedBackpressureOrderConfirmation } from "./application/run-backpressure.js";
import { PostgresErpAttemptPersistence } from "./persistence/postgres-erp-attempt-persistence.js";
import { PostgresNotificationRecordPersistence } from "./persistence/postgres-notification-record-persistence.js";
import { PostgresOrderTransitionPersistence } from "./persistence/postgres-order-transition-persistence.js";
import { PostgresRunConfigReader } from "./persistence/postgres-run-config-reader.js";
import { createBullMqNotificationRecordConsumer } from "./queue/bullmq-notification-record-consumer.js";
import { createBullMqNotificationRecordPublisher } from "./queue/bullmq-notification-record-publisher.js";
import { createBullMqOrderProcessConsumer } from "./queue/bullmq-order-process-consumer.js";
import { loadWorkerConfig } from "./runtime/config.js";
import { createWorkerReadiness } from "./runtime/readiness.js";
import { createWorkerRuntime } from "./runtime/worker-runtime.js";
import { buildWorkerHealthServer } from "./server.js";

export const workerAppName = "worker" as const;
export const workerAppDependencies = [
  contractsPackageName,
  dbPackageName,
  loggerPackageName,
] as const;

export {
  ErpCircuitBreaker,
  type ErpCircuitBreakerSnapshot,
  ErpCircuitOpenError,
  type ErpCircuitState,
  isTemporaryErpCircuitError,
} from "./application/erp-circuit-breaker.js";
export {
  ErpAcceptedConfirmationPersistenceError,
  type ErpAttemptPersistence,
  ErpAttemptPersistenceError,
  type ErpAttemptRecord,
  ErpConfirmationFailedError,
  ErpConfirmationInvalidResponseError,
  ErpConfirmationRequestError,
  ErpConfirmationTimeoutError,
  HttpErpOrderConfirmation,
  isAcceptedErpConfirmationPersistenceError,
  isErpAttemptPersistenceError,
  isTemporaryErpConfirmationError,
  isTemporaryErpDependencyError,
  type ReusableErpConfirmationAttempt,
} from "./application/erp-confirmation-client.js";
export {
  createNotificationRecordJobHandler,
  type NotificationRecordJobHandler,
  type NotificationRecordPersistence,
} from "./application/notification-record-job-handler.js";
export {
  createLocalOrderConfirmation,
  createOrderProcessJobHandler,
  type NotificationRecordPublisher,
  OrderFailurePersistenceError,
} from "./application/order-process-job-handler.js";
export { RunScopedBackpressureOrderConfirmation } from "./application/run-backpressure.js";
export type { RunConfigReader } from "./application/run-config.js";
export { PostgresErpAttemptPersistence } from "./persistence/postgres-erp-attempt-persistence.js";
export {
  NotificationBeforeConfirmationError,
  NotificationOrderIdentityMismatchError,
  NotificationOrderNotFoundError,
  PostgresNotificationRecordPersistence,
} from "./persistence/postgres-notification-record-persistence.js";
export {
  InvalidOrderTransitionError,
  OrderJobIdentityMismatchError,
  OrderNotFoundError,
  PostgresOrderTransitionPersistence,
} from "./persistence/postgres-order-transition-persistence.js";
export { PostgresRunConfigReader } from "./persistence/postgres-run-config-reader.js";
export { createBullMqNotificationRecordConsumer } from "./queue/bullmq-notification-record-consumer.js";
export { createBullMqNotificationRecordPublisher } from "./queue/bullmq-notification-record-publisher.js";
export { createBullMqOrderProcessConsumer } from "./queue/bullmq-order-process-consumer.js";
export type { NotificationRecordConsumer } from "./queue/notification-record-consumer.js";
export type { OrderProcessConsumer } from "./queue/order-process-consumer.js";
export { loadWorkerConfig, type WorkerConfig } from "./runtime/config.js";
export { createWorkerReadiness } from "./runtime/readiness.js";
export { createWorkerRuntime } from "./runtime/worker-runtime.js";
export { buildWorkerHealthServer } from "./server.js";

export async function startWorker(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const logger = createServiceLogger({ service: "worker" });
  const database = createDatabaseConnection(config.databaseUrl, { max: config.postgresPoolMax });
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  const runConfigReader = new PostgresRunConfigReader(database.db);
  const notificationRecordPublisher = createBullMqNotificationRecordPublisher({
    connection: {
      url: config.redisUrl,
      maxRetriesPerRequest: null,
    },
  });
  const orderProcessConsumer = createBullMqOrderProcessConsumer({
    connection: {
      url: config.redisUrl,
      maxRetriesPerRequest: null,
    },
    concurrency: config.orderProcessConcurrency,
    handler: createOrderProcessJobHandler({
      confirmation: new RunScopedBackpressureOrderConfirmation({
        runConfigReader,
        inner: new ErpCircuitBreaker({
          confirmation: new HttpErpOrderConfirmation({
            baseUrl: config.mockErpBaseUrl,
            requestTimeoutMs: config.erpRequestTimeoutMs,
            attemptPersistence: new PostgresErpAttemptPersistence(database.db),
            runConfigReader,
          }),
          failureThreshold: config.erpCircuitFailureThreshold,
          resetTimeoutMs: config.erpCircuitResetTimeoutMs,
          isCountedFailure: isTemporaryErpDependencyError,
          onStateChange: async (snapshot) => {
            try {
              await setErpCircuitBreakerSnapshot(redis, snapshot);
            } catch (error) {
              logger.error({ err: error }, "Could not publish ERP circuit breaker state.");
            }
          },
        }),
      }),
      persistence: new PostgresOrderTransitionPersistence(database.db),
      logger,
      isTemporaryConfirmationFailure,
      shouldRetryWithoutFailingOrder,
      notificationRecordPublisher,
      reportNotificationRecordPublishFailure: (report) => {
        logger.error(
          {
            err: report.error,
            orderId: report.orderId,
            saleOfferId: report.saleOfferId,
            ...(report.runId ? { runId: report.runId } : {}),
            correlationId: report.correlationId,
          },
          "Order confirmed but notification-recording job publication failed.",
        );
      },
      publishBusinessOutcomeUpdate: async (job) => {
        await publishBusinessOutcomeDashboardUpdate(database.db, redis, {
          saleOfferId: job.saleOfferId,
          ...(job.runId ? { runId: job.runId } : {}),
          correlationId: job.correlationId,
        });
      },
      reportBusinessOutcomeUpdateFailure: (report) => {
        logger.error(
          {
            err: report.error,
            orderId: report.orderId,
            saleOfferId: report.saleOfferId,
            ...(report.runId ? { runId: report.runId } : {}),
            correlationId: report.correlationId,
            transition: report.transition,
          },
          "Order transition succeeded but dashboard business outcome publication failed.",
        );
      },
    }),
    logger,
  });
  const notificationRecordConsumer = createBullMqNotificationRecordConsumer({
    connection: {
      url: config.redisUrl,
      maxRetriesPerRequest: null,
    },
    concurrency: config.notificationRecordConcurrency,
    handler: createNotificationRecordJobHandler({
      persistence: new PostgresNotificationRecordPersistence(database.db),
      logger,
      publishBusinessOutcomeUpdate: async (job) => {
        await publishBusinessOutcomeDashboardUpdate(database.db, redis, {
          saleOfferId: job.saleOfferId,
          ...(job.runId ? { runId: job.runId } : {}),
          correlationId: job.correlationId,
        });
      },
      reportBusinessOutcomeUpdateFailure: (report) => {
        logger.error(
          {
            err: report.error,
            orderId: report.orderId,
            saleOfferId: report.saleOfferId,
            ...(report.runId ? { runId: report.runId } : {}),
            correlationId: report.correlationId,
          },
          "Notification record succeeded but dashboard business outcome publication failed.",
        );
      },
    }),
    logger,
  });
  const healthServer = buildWorkerHealthServer({
    logger,
    readiness: createWorkerReadiness({
      postgres: database.sql,
      redis,
      orderProcessConsumer,
      notificationRecordConsumer,
    }),
    startedAt: new Date(),
  });
  const runtime = createWorkerRuntime({
    healthServer,
    healthHost: config.healthHost,
    healthPort: config.healthPort,
    orderProcessConsumer,
    notificationRecordConsumer,
    closeNotificationRecordPublisher: notificationRecordPublisher.close,
    closePostgres: database.close,
    closeRedis: async () => {
      await redis.quit();
    },
    logger,
  });

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      await runtime.close();
    })();
    return shutdownPromise;
  };

  process.once("SIGTERM", () => {
    void shutdown()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "Worker shutdown failed.");
        process.exit(1);
      });
  });
  process.once("SIGINT", () => {
    void shutdown()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "Worker shutdown failed.");
        process.exit(1);
      });
  });

  try {
    await runtime.start();
  } catch (error) {
    logger.error({ err: error }, "Worker runtime failed to start.");
    process.exitCode = 1;
  }
}

function isTemporaryConfirmationFailure(error: unknown): boolean {
  return isTemporaryErpConfirmationError(error) || isTemporaryErpCircuitError(error);
}

function shouldRetryWithoutFailingOrder(error: unknown): boolean {
  return isErpAttemptPersistenceError(error) || isTemporaryErpCircuitError(error);
}

if (process.env.NODE_ENV !== "test" && import.meta.url === `file://${process.argv[1]}`) {
  void startWorker();
}
