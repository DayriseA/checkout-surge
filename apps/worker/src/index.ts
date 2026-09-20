import {
  BusinessOutcomePublicationScheduler,
  createDatabaseConnection,
  publishDashboardProjectionDirtySignal,
  setErpCircuitBreakerSnapshot,
} from "@checkout-surge/db";
import { createServiceLogger } from "@checkout-surge/logger";
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
import { createNotificationRecoveryScanner } from "./application/notification-recovery-scanner.js";
import { createOrderDispatchScanner } from "./application/order-dispatch-scanner.js";
import { ProcessLocalOrderProcessAdmission } from "./application/order-process-admission.js";
import { createOrderProcessJobHandler } from "./application/order-process-job-handler.js";
import {
  createOrderRecoveryHandoff,
  createOrderRecoveryScanner,
} from "./application/order-recovery-scanner.js";
import { RunScopedBackpressureOrderConfirmation } from "./application/run-backpressure.js";
import { PostgresErpAttemptPersistence } from "./persistence/postgres-erp-attempt-persistence.js";
import { PostgresGeneratedRunPublicationFence } from "./persistence/postgres-generated-run-publication-fence.js";
import { PostgresNotificationRecordPersistence } from "./persistence/postgres-notification-record-persistence.js";
import { PostgresNotificationRecoveryPersistence } from "./persistence/postgres-notification-recovery-persistence.js";
import { PostgresOrderDispatchPersistence } from "./persistence/postgres-order-dispatch-persistence.js";
import { PostgresOrderRecoveryPersistence } from "./persistence/postgres-order-recovery-persistence.js";
import { PostgresOrderTransitionPersistence } from "./persistence/postgres-order-transition-persistence.js";
import { PostgresRunConfigReader } from "./persistence/postgres-run-config-reader.js";
import { createBullMqNotificationRecordConsumer } from "./queue/bullmq-notification-record-consumer.js";
import { createBullMqNotificationRecordPublisher } from "./queue/bullmq-notification-record-publisher.js";
import { createBullMqOrderProcessConsumer } from "./queue/bullmq-order-process-consumer.js";
import { createBullMqOrderProcessJobPublisher } from "./queue/bullmq-order-process-job-publisher.js";
import { loadWorkerConfig } from "./runtime/config.js";
import { createWorkerReadiness } from "./runtime/readiness.js";
import { createWorkerRuntime } from "./runtime/worker-runtime.js";
import { buildWorkerHealthServer } from "./server.js";

export async function startWorker(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const logger = createServiceLogger({ service: "worker" });
  const database = createDatabaseConnection(config.databaseUrl, { max: config.postgresPoolMax });
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  const runConfigReader = new PostgresRunConfigReader(database.db);
  const publicationFence = new PostgresGeneratedRunPublicationFence(database.db);
  const erpAttemptPersistence = new PostgresErpAttemptPersistence(database.db);
  const businessOutcomePublications = new BusinessOutcomePublicationScheduler({
    publish: (input) =>
      publishDashboardProjectionDirtySignal(redis, {
        type: "dashboard.projection.dirty",
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      }),
    onError: (error, input) => {
      logger.error(
        {
          err: error,
          saleOfferId: input.saleOfferId,
          ...(input.runId ? { runId: input.runId } : {}),
        },
        "Dashboard business outcome projection failed.",
      );
    },
    onDrop: (input) => {
      logger.warn(
        { saleOfferId: input.saleOfferId, ...(input.runId ? { runId: input.runId } : {}) },
        "Business outcome dashboard scope limit reached; dropped the oldest dirty scope.",
      );
    },
  });
  const notificationRecordPublisher = createBullMqNotificationRecordPublisher({
    connection: {
      url: config.redisUrl,
      maxRetriesPerRequest: 3,
    },
    publicationFence,
  });
  const orderProcessJobPublisher = createBullMqOrderProcessJobPublisher(
    {
      url: config.redisUrl,
      maxRetriesPerRequest: 3,
    },
    undefined,
    publicationFence,
  );
  const orderRecoveryPersistence = new PostgresOrderRecoveryPersistence(database.db);
  const orderRecoveryScanner = createOrderRecoveryScanner({
    persistence: orderRecoveryPersistence,
    publisher: orderProcessJobPublisher,
    logger,
    scanIntervalMs: config.orderRecoveryScanIntervalMs,
    batchSize: config.orderRecoveryBatchSize,
    maxRecoveryAttempts: config.orderRecoveryMaxAttempts,
    recoveryLeaseMs: config.orderRecoveryLeaseMs,
    failedJobReader: orderProcessJobPublisher,
  });
  const notificationRecoveryScanner = createNotificationRecoveryScanner({
    persistence: new PostgresNotificationRecoveryPersistence(database.db),
    publisher: notificationRecordPublisher,
    logger,
    scanIntervalMs: config.notificationRecoveryScanIntervalMs,
    batchSize: config.notificationRecoveryBatchSize,
  });
  const orderDispatchScanner = createOrderDispatchScanner({
    persistence: new PostgresOrderDispatchPersistence(database.db),
    publisher: orderProcessJobPublisher,
    logger,
    scanIntervalMs: config.orderDispatchScanIntervalMs,
    batchSize: config.orderDispatchBatchSize,
    minimumQueuedAgeMs: config.orderDispatchMinimumQueuedAgeMs,
  });
  const orderProcessConsumer = createBullMqOrderProcessConsumer({
    connection: {
      url: config.redisUrl,
      maxRetriesPerRequest: null,
    },
    concurrency: config.orderProcessConcurrency,
    admission: new ProcessLocalOrderProcessAdmission({
      runConfigReader,
      fallbackConcurrency: config.orderProcessConcurrency,
    }),
    handler: createOrderProcessJobHandler({
      confirmation: new RunScopedBackpressureOrderConfirmation({
        runConfigReader,
        inner: new ErpCircuitBreaker({
          confirmation: new HttpErpOrderConfirmation({
            baseUrl: config.mockErpBaseUrl,
            requestTimeoutMs: config.erpRequestTimeoutMs,
            attemptPersistence: erpAttemptPersistence,
          }),
          failureThreshold: config.erpCircuitFailureThreshold,
          resetTimeoutMs: config.erpCircuitResetTimeoutMs,
          isCountedFailure: isTemporaryErpDependencyError,
          onStateChange: async (snapshot) => {
            try {
              await setErpCircuitBreakerSnapshot(redis, snapshot, { type: "catalog" });
            } catch (error) {
              logger.error({ err: error }, "Could not publish ERP circuit breaker state.");
            }
          },
        }),
        circuitBreakerFactory: (snapshot, runId) =>
          new ErpCircuitBreaker({
            confirmation: new HttpErpOrderConfirmation({
              baseUrl: config.mockErpBaseUrl,
              requestTimeoutMs: config.erpRequestTimeoutMs,
              attemptPersistence: erpAttemptPersistence,
              runConfigReader: {
                read: async (requestedRunId) => (requestedRunId === runId ? snapshot : null),
              },
            }),
            failureThreshold: snapshot.backpressureConfig.circuitBreakerFailureThreshold,
            resetTimeoutMs: snapshot.backpressureConfig.circuitBreakerResetTimeoutMs,
            isCountedFailure: isTemporaryErpDependencyError,
            onStateChange: async (breakerSnapshot) => {
              try {
                await setErpCircuitBreakerSnapshot(redis, breakerSnapshot, { type: "run", runId });
              } catch (error) {
                logger.error(
                  { err: error, runId },
                  "Could not publish run ERP circuit breaker state.",
                );
              }
            },
          }),
        onMissingRunSnapshot: (runId) => {
          logger.warn(
            { runId },
            "Run configuration snapshot was not found; using the catalog ERP circuit breaker fallback.",
          );
        },
      }),
      persistence: new PostgresOrderTransitionPersistence(
        database.db,
        undefined,
        config.orderRecoveryLeaseMs,
      ),
      logger,
      recovery: createOrderRecoveryHandoff(orderRecoveryPersistence),
      isTemporaryConfirmationFailure,
      shouldRetryWithoutFailingOrder,
      notificationRecordPublisher,
      publishBusinessOutcomeUpdate: async (job) => {
        businessOutcomePublications.markDirty({
          saleOfferId: job.saleOfferId,
          ...(job.runId ? { runId: job.runId } : {}),
          correlationId: job.correlationId,
        });
      },
    }),
    logger,
    recovery: orderRecoveryPersistence,
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
        businessOutcomePublications.markDirty({
          saleOfferId: job.saleOfferId,
          ...(job.runId ? { runId: job.runId } : {}),
          correlationId: job.correlationId,
        });
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
    notificationRecoveryScanner,
    orderDispatchScanner,
    orderRecoveryScanner,
    closeOrderProcessJobPublisher: orderProcessJobPublisher.close,
    closeNotificationRecordPublisher: notificationRecordPublisher.close,
    closeBusinessOutcomePublicationScheduler: () => businessOutcomePublications.close(),
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

  const handleShutdown = () => {
    void shutdown()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "Worker shutdown failed.");
        process.exit(1);
      });
  };
  process.once("SIGTERM", handleShutdown);
  process.once("SIGINT", handleShutdown);

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
