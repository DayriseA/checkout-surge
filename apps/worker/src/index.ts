import {
  BusinessOutcomePublicationScheduler,
  createDatabaseConnection,
  publishDashboardProjectionDirtySignal,
} from "@checkout-surge/db";
import { createServiceLogger } from "@checkout-surge/logger";
import { Redis } from "ioredis";
import { HttpErpOrderConfirmation } from "./application/erp-confirmation-client.js";
import {
  ErpUnresolvedCallReconciler,
  ScheduledErpOrderConfirmation,
} from "./application/erp-reconciliation.js";
import { erpResiliencePolicy } from "./application/erp-resilience-policy.js";
import { withPublicationDeadline } from "./application/generated-run-publication-fence.js";
import { createNotificationRecordJobHandler } from "./application/notification-record-job-handler.js";
import { createNotificationRecoveryScanner } from "./application/notification-recovery-scanner.js";
import { createOrderDispatchScanner } from "./application/order-dispatch-scanner.js";
import { AdaptiveErpRuntimeAdmission } from "./application/order-process-admission.js";
import { createOrderProcessJobHandler } from "./application/order-process-job-handler.js";
import {
  createOrderRecoveryHandoff,
  createOrderRecoveryScanner,
} from "./application/order-recovery-scanner.js";
import { PostgresErpAttemptPersistence } from "./persistence/postgres-erp-attempt-persistence.js";
import { PostgresErpScopeResiliencePersistence } from "./persistence/postgres-erp-scope-resilience-persistence.js";
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

/**
 * A fenced publication waits behind the API's exclusive hold of the run fence, seen up to
 * about 7 s at a run's end; past twice that, it fails and the recovery scanners republish.
 */
const publicationDeadlineMs = 15_000;
/**
 * Bounds the wait for active order jobs at shutdown, leaving the rest of the stop room
 * within the 10 s of Docker's default stop timeout and of the delayed stop of the hosted
 * core's PostgreSQL and Redis.
 */
const orderProcessCloseDeadlineMs = 5_000;

export async function startWorker(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const logger = createServiceLogger({ service: "worker" });
  const database = createDatabaseConnection(config.databaseUrl, { max: config.postgresPoolMax });
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  const runConfigReader = new PostgresRunConfigReader(database.db);
  const publicationFence = withPublicationDeadline(
    new PostgresGeneratedRunPublicationFence(database.db),
    publicationDeadlineMs,
  );
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
          runId: input.runId,
        },
        "Dashboard business outcome projection failed.",
      );
    },
    onDrop: (input) => {
      logger.warn(
        { saleOfferId: input.saleOfferId, runId: input.runId },
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
    publicationFence,
  );
  const orderRecoveryPersistence = new PostgresOrderRecoveryPersistence(database.db);
  const orderTransitionPersistence = new PostgresOrderTransitionPersistence(
    database.db,
    undefined,
    config.orderRecoveryLeaseMs,
  );
  const erpScopeState = new PostgresErpScopeResiliencePersistence(database.db);
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
  const orderProcessAdmission = await AdaptiveErpRuntimeAdmission.restore({
    pauseDelivery: (durationMs) => orderProcessJobPublisher.pauseDelivery(durationMs),
    persistence: erpScopeState,
    runConfigReader,
    reconciliationConcurrency: config.orderProcessConcurrency,
  });
  const erpClient = new HttpErpOrderConfirmation({
    baseUrl: config.mockErpBaseUrl,
    lookupTimeoutMs: erpResiliencePolicy.initialRequestDeadlineMs,
    retryAfterPolicy: {
      fallbackDelayMs: erpResiliencePolicy.fallbackCooldownMs,
      maximumDelayMs: erpResiliencePolicy.maximumCooldownMs,
    },
    attemptPersistence: erpAttemptPersistence,
    logger,
    runConfigReader,
  });
  const reconciler = new ErpUnresolvedCallReconciler({
    client: erpClient,
    callResolution: orderRecoveryPersistence,
    admission: orderProcessAdmission,
  });
  const scheduledConfirmation = new ScheduledErpOrderConfirmation({
    client: erpClient,
    reconciler,
    admission: orderProcessAdmission,
    control: orderRecoveryPersistence,
  });
  const orderProcessHandler = createOrderProcessJobHandler({
    confirmation: scheduledConfirmation,
    persistence: orderTransitionPersistence,
    logger,
    recovery: createOrderRecoveryHandoff(orderRecoveryPersistence),
    notificationRecordPublisher,
    publishBusinessOutcomeUpdate: async (job) => {
      businessOutcomePublications.markDirty({
        saleOfferId: job.saleOfferId,
        runId: job.runId,
        correlationId: job.correlationId,
      });
    },
  });
  const orderRecoveryScanner = createOrderRecoveryScanner({
    persistence: orderRecoveryPersistence,
    handler: orderProcessHandler,
    publisher: orderProcessJobPublisher,
    logger,
    scanIntervalMs: config.orderRecoveryScanIntervalMs,
    batchSize: config.orderRecoveryBatchSize,
    recoveryLeaseMs: config.orderRecoveryLeaseMs,
    failedJobReader: orderProcessJobPublisher,
    deliveryStateReader: orderProcessJobPublisher,
  });
  const orderProcessConsumer = createBullMqOrderProcessConsumer({
    connection: {
      url: config.redisUrl,
      maxRetriesPerRequest: null,
    },
    concurrency: config.orderProcessConcurrency,
    handler: orderProcessHandler,
    logger,
    recovery: orderRecoveryPersistence,
    closeDeadlineMs: orderProcessCloseDeadlineMs,
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
          runId: job.runId,
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
    closeAdaptiveErpAdmission: () => orderProcessAdmission.close(),
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

if (process.env.NODE_ENV !== "test" && import.meta.url === `file://${process.argv[1]}`) {
  void startWorker();
}
