import { contractsPackageName } from "@checkout-surge/contracts";
import {
  BusinessOutcomePublicationScheduler,
  clearErpCircuitBreakerSnapshots,
  createDatabaseConnection,
  createRedisClient,
  createRedisDashboardEventSubscriber,
  createSqlClient,
  dbPackageName,
  getInventoryStatus,
  markReservationPendingPersistence,
  promoteReservationIdempotencyToAccepted,
  publishBusinessOutcomeDashboardUpdate,
  publishDashboardEvent,
  reserveInventoryStock,
  reverseReservation,
} from "@checkout-surge/db";
import { createServiceLogger, loggerPackageName } from "@checkout-surge/logger";
import { createBullMqDemoQueueMaintenance } from "./queue/bullmq-demo-queue-maintenance.js";
import { createBullMqOrderProcessJobPublisher } from "./queue/bullmq-order-process-job-publisher.js";
import { createBullMqOrderProcessQueueInspector } from "./queue/bullmq-order-process-queue-inspector.js";
import { PostgresRunRetryPolicyResolver } from "./queue/postgres-run-retry-policy-resolver.js";
import { DashboardEventFanout } from "./realtime/dashboard-event-fanout.js";
import { invalidDashboardEventMetadata } from "./realtime/invalid-dashboard-event-metadata.js";
import { closeApiResources } from "./runtime/api-resource-cleanup.js";
import { loadApiConfig } from "./runtime/config.js";
import type { ApiFastifyInstance } from "./runtime/fastify.js";
import { createInfrastructureReadinessCheck } from "./runtime/readiness.js";
import { buildApiServer } from "./server.js";
import {
  DashboardRecoveryAdmissionService,
  RedisDashboardRecoveryBudgetStore,
} from "./services/dashboard-recovery-admission.js";
import {
  DashboardRecoveryService,
  PostgresDashboardBusinessOutcomeReader,
  PostgresDashboardCompletionOutcomeReader,
  PostgresDashboardConsistencyLagReader,
  PostgresDashboardRecoveryContextReader,
} from "./services/dashboard-recovery-service.js";
import { DashboardSnapshotPublicationScheduler } from "./services/dashboard-snapshot-publication-scheduler.js";
import { DemoMaintenanceService } from "./services/demo-maintenance-service.js";
import { DemoRunFinalizationService } from "./services/demo-run-finalization-service.js";
import {
  DemoRunService,
  HttpTrafficExecutionGateway,
  RedisDashboardTrafficMetricStore,
  validateActivePublicRuntimePolicyAtStartup,
} from "./services/demo-run-service.js";
import { DemoRunStartupReconciliationService } from "./services/demo-run-startup-reconciliation-service.js";
import {
  ErpStatusService,
  PostgresActiveErpRunReader,
  PostgresErpAttemptStatusReader,
  RedisErpCircuitBreakerStateReader,
} from "./services/erp-status-service.js";
import { InventoryStatusService } from "./services/inventory-status-service.js";
import { OrderStatusService } from "./services/order-status-service.js";
import { PendingPersistenceReconciler } from "./services/pending-persistence-reconciler.js";
import { PostgresBuyPersistence } from "./services/postgres-buy-persistence.js";
import { PostgresDemoResetWorkflowFence } from "./services/postgres-demo-reset-workflow-fence.js";
import { RedisPublicRunBudgetStore } from "./services/public-run-budget-store.js";
import { QueueStatusService } from "./services/queue-status-service.js";
import {
  type BusinessOutcomeUpdateFailureReport,
  type OrderEnqueueFailureReport,
  type ReservationPartialFailureReport,
  ReserveOrderService,
} from "./services/reserve-order-service.js";
import { RunHistoryService } from "./services/run-history-service.js";
import { PostgresTerminalDemoRunSummaryWriter } from "./services/terminal-demo-run-transition.js";
import { TrafficCompletionEnrichmentService } from "./services/traffic-completion-enrichment-service.js";

export const apiAppName = "api" as const;
export const apiAppDependencies = [contractsPackageName, dbPackageName, loggerPackageName] as const;

export { createBullMqDemoQueueMaintenance } from "./queue/bullmq-demo-queue-maintenance.js";
export { createBullMqOrderProcessJobPublisher } from "./queue/bullmq-order-process-job-publisher.js";
export { createBullMqOrderProcessQueueInspector } from "./queue/bullmq-order-process-queue-inspector.js";
export { DashboardEventFanout } from "./realtime/dashboard-event-fanout.js";
export { type ApiConfig, loadApiConfig } from "./runtime/config.js";
export { buildApiServer } from "./server.js";
export {
  DashboardRecoveryService,
  PostgresDashboardBusinessOutcomeReader,
  PostgresDashboardCompletionOutcomeReader,
  PostgresDashboardConsistencyLagReader,
  PostgresDashboardRecoveryContextReader,
} from "./services/dashboard-recovery-service.js";
export { DashboardSnapshotPublicationScheduler } from "./services/dashboard-snapshot-publication-scheduler.js";
export { DemoMaintenanceService } from "./services/demo-maintenance-service.js";
export { DemoRunFinalizationService } from "./services/demo-run-finalization-service.js";
export { DemoRunStartupReconciliationService } from "./services/demo-run-startup-reconciliation-service.js";
export {
  ErpStatusService,
  PostgresErpAttemptStatusReader,
  RedisErpCircuitBreakerStateReader,
} from "./services/erp-status-service.js";
export { InventoryStatusService } from "./services/inventory-status-service.js";
export type { OrderProcessJobPublisher } from "./services/order-process-job-publisher.js";
export { OrderStatusService } from "./services/order-status-service.js";
export { PendingPersistenceReconciler } from "./services/pending-persistence-reconciler.js";
export { PostgresBuyPersistence } from "./services/postgres-buy-persistence.js";
export { QueueStatusService } from "./services/queue-status-service.js";
export { ReserveOrderService } from "./services/reserve-order-service.js";
export { RunHistoryService } from "./services/run-history-service.js";
export { TrafficCompletionEnrichmentService } from "./services/traffic-completion-enrichment-service.js";

export async function startApiServer(): Promise<void> {
  const config = loadApiConfig(process.env);
  const logger = createServiceLogger({ service: "api" });
  const connection = createDatabaseConnection(config.databaseUrl, { max: config.postgresPoolMax });
  const resetWorkflowSql = createSqlClient(config.databaseUrl, { max: 1 });
  const redis = createRedisClient(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  const dashboardEventSubscriberRedis = createRedisClient(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  const orderProcessJobPublisher = createBullMqOrderProcessJobPublisher(
    {
      url: config.redisUrl,
      maxRetriesPerRequest: 3,
    },
    {
      maxAttempts: config.orderProcessMaxAttempts,
      backoffBaseMs: config.orderProcessBackoffBaseMs,
    },
  );
  const orderProcessQueueInspector = createBullMqOrderProcessQueueInspector({
    url: config.redisUrl,
    maxRetriesPerRequest: 3,
  });
  const demoQueueMaintenance = createBullMqDemoQueueMaintenance({
    url: config.redisUrl,
    maxRetriesPerRequest: 3,
  });

  const persistence = new PostgresBuyPersistence(connection.db);
  const runRetryPolicyResolver = new PostgresRunRetryPolicyResolver(connection.db);
  const stockReservationGateway = {
    reserve: (input: Parameters<typeof reserveInventoryStock>[1]) =>
      reserveInventoryStock(redis, input),
    markPendingPersistence: (input: Parameters<typeof markReservationPendingPersistence>[1]) =>
      markReservationPendingPersistence(redis, input),
    promoteAccepted: (input: Parameters<typeof promoteReservationIdempotencyToAccepted>[1]) =>
      promoteReservationIdempotencyToAccepted(redis, input).then(() => undefined),
    reverse: (input: Parameters<typeof reverseReservation>[1]) => reverseReservation(redis, input),
  };
  const dashboardEventFanout = new DashboardEventFanout({
    logger,
    maxClients: config.dashboardMaxSseClients,
    maxClientsPerSource: config.dashboardMaxSseClientsPerSource,
    maxBufferedFrames: config.dashboardSseMaxBufferedFrames,
    maxBufferedBytes: config.dashboardSseMaxBufferedBytes,
  });
  const dashboardRecoveryAdmission = new DashboardRecoveryAdmissionService({
    store: new RedisDashboardRecoveryBudgetStore(redis),
    maxConcurrent: config.dashboardRecoveryMaxConcurrent,
    globalMax: config.dashboardRecoveryGlobalMaxRequests,
    perSourceMax: config.dashboardRecoveryPerSourceMaxRequests,
    windowSeconds: config.dashboardRecoveryWindowSeconds,
    logger,
  });
  const dashboardEventSubscriber = createRedisDashboardEventSubscriber(
    dashboardEventSubscriberRedis,
    {
      onEvent: (event) => {
        dashboardEventFanout.publish(event);
      },
      onHandlerError: (error) => {
        logger.error({ err: error }, "Dashboard event fan-out failed.");
      },
      onInvalidMessage: (error, message) => {
        logger.warn(
          invalidDashboardEventMetadata(message, error),
          "Ignored invalid dashboard realtime event from Redis Pub/Sub.",
        );
      },
    },
  );
  const queueStatusService = new QueueStatusService(orderProcessQueueInspector, logger);
  const erpStatusService = new ErpStatusService({
    circuitBreakerStateReader: new RedisErpCircuitBreakerStateReader(redis),
    attemptStatusReader: new PostgresErpAttemptStatusReader(connection.db),
    queueStatusService,
    logger,
    activeRunReader: new PostgresActiveErpRunReader(connection.db),
  });
  const inventoryStatusService = new InventoryStatusService({
    getStatus: (saleOfferId) => getInventoryStatus(redis, saleOfferId),
  });
  const orderStatusService = new OrderStatusService(connection.db);
  const dashboardSnapshotPublications = new DashboardSnapshotPublicationScheduler({
    readInventory: (saleOfferId) => inventoryStatusService.getStatus(saleOfferId),
    readQueue: () => queueStatusService.getStatus(),
    publish: (event) => publishDashboardEvent(redis, event),
    logger,
  });
  const businessOutcomePublications = new BusinessOutcomePublicationScheduler({
    publish: (input) => publishBusinessOutcomeDashboardUpdate(connection.db, redis, input),
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
  const pendingPersistenceReconciler = new PendingPersistenceReconciler({
    redis,
    persistence,
    stockReservations: stockReservationGateway,
    orderProcessJobPublisher,
    runRetryPolicyResolver,
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    dashboardSnapshotPublications,
    businessOutcomeUpdates: businessOutcomePublications,
    logger,
  });
  const trafficMetricStore = new RedisDashboardTrafficMetricStore(redis);
  const trafficExecutionGateway = new HttpTrafficExecutionGateway({
    loadOrchestratorBaseUrl: config.loadOrchestratorBaseUrl,
    controlServiceToken: config.controlServiceToken,
  });
  const terminalRunWriter = new PostgresTerminalDemoRunSummaryWriter(connection.db);
  const demoMaintenanceService = new DemoMaintenanceService({
    db: connection.db,
    redis,
    clearErpCircuitBreakerState: () => clearErpCircuitBreakerSnapshots(redis),
    queueMaintenance: demoQueueMaintenance,
    terminalRunWriter,
    trafficAborter: trafficExecutionGateway,
    dashboardLiveStateReset: {
      fenceRun: (runId) => trafficMetricStore.fenceRun(runId),
      hasRunState: (runId) => trafficMetricStore.hasRunState(runId),
      clearRun: async (runId) => {
        dashboardSnapshotPublications.clearRun(runId);
        businessOutcomePublications.clearRun(runId);
        await trafficMetricStore.clearRun(runId);
      },
    },
    resetWorkflowFence: new PostgresDemoResetWorkflowFence(resetWorkflowSql),
    logger,
  });
  const runHistoryService = new RunHistoryService({ db: connection.db });
  const dashboardRecoveryService = new DashboardRecoveryService({
    contextReader: new PostgresDashboardRecoveryContextReader(connection.db),
    businessOutcomeReader: new PostgresDashboardBusinessOutcomeReader(connection.db),
    consistencyLagReader: new PostgresDashboardConsistencyLagReader(connection.db),
    completionOutcomeReader: new PostgresDashboardCompletionOutcomeReader(connection.db),
    inventoryStatusService,
    queueStatusService,
    erpStatusService,
    trafficMetricReader: trafficMetricStore,
    logger,
  });
  const businessOutcomeReader = new PostgresDashboardBusinessOutcomeReader(connection.db);
  const trafficCompletionEnrichmentService = new TrafficCompletionEnrichmentService({
    db: connection.db,
    redis,
    businessOutcomeReader,
    logger,
  });
  const demoRunFinalizationService = new DemoRunFinalizationService({
    db: connection.db,
    redis,
    logger,
    pendingPersistenceReconciler,
    terminalRunWriter,
    drainTimeoutSeconds: config.demoRunDrainTimeoutSeconds,
  });
  const demoRunStartupReconciliationService = new DemoRunStartupReconciliationService({
    db: connection.db,
    redis,
    logger,
    pendingPersistenceReconciler,
    completionEnrichmentService: trafficCompletionEnrichmentService,
  });
  const demoRunService = new DemoRunService({
    db: connection.db,
    redis,
    trafficExecutionGateway,
    publicRunBudgetStore: new RedisPublicRunBudgetStore(redis),
    trafficMetricStore,
    businessOutcomeReader,
    completionEnrichmentService: trafficCompletionEnrichmentService,
    terminalRunWriter,
    finalizationService: demoRunFinalizationService,
    apiBaseUrl: config.apiBaseUrl,
    buyEndpointPath: "/buy",
    logger,
    publicClientCookieSecret: config.publicClientCookieSecret,
    deploymentHardCaps: config.deploymentHardCaps,
  });
  const reserveOrderService = new ReserveOrderService({
    persistence,
    orderProcessJobPublisher,
    runRetryPolicyResolver,
    stockReservations: stockReservationGateway,
    reservationHoldMinutes: config.reservationHoldMinutes,
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    pendingPersistenceRetryAfterSeconds: config.pendingPersistenceRetryAfterSeconds,
    dashboardSnapshotPublications,
    soldOutObservations: dashboardSnapshotPublications,
    reportPersistenceFailure: (report) => {
      logger.error(
        partialFailureLogContext(report),
        "Redis secured a reservation but PostgreSQL persistence failed.",
      );
    },
    reportPendingPersistenceEnsureFailure: (report) => {
      logger.error(
        partialFailureLogContext(report),
        "Could not ensure the Redis pending-persistence marker.",
      );
    },
    reportPendingPersistenceRecordFailure: (report) => {
      logger.error(
        partialFailureLogContext(report),
        "Could not record the pending-persistence reconciliation state.",
      );
    },
    reportPromotionFailure: (report) => {
      logger.error(
        partialFailureLogContext(report),
        "Durable reservation succeeded but Redis idempotency promotion failed.",
      );
    },
    reportOrderEnqueueFailure: (report) => {
      logger.error(
        orderEnqueueFailureLogContext(report),
        "Durable reservation succeeded but order-processing enqueue failed.",
      );
    },
    reportReservationReversalFailure: (report) => {
      logger.error(
        partialFailureLogContext(report),
        "Could not reverse a definitively rejected Redis reservation hold.",
      );
    },
    publishBusinessOutcomeUpdate: async (input) => businessOutcomePublications.markDirty(input),
    scheduleBusinessOutcomeUpdate: (task) => task(),
    reportBusinessOutcomeUpdateFailure: (report) => {
      logger.error(
        businessOutcomeUpdateFailureLogContext(report),
        "Durable reservation succeeded but dashboard business outcome publication failed.",
      );
    },
  });

  let server: ApiFastifyInstance | null = null;
  let closePromise: Promise<void> | null = null;
  let finalizationPoller: ReturnType<typeof setInterval> | null = null;
  const close = () => {
    closePromise ??= (async () => {
      logger.info("Closing API server.");
      if (finalizationPoller) {
        clearInterval(finalizationPoller);
      }
      await closeApiResources({
        closeServer: async () => {
          dashboardEventFanout.close();
          await server?.close();
        },
        closeDashboardPublicationScheduler: () => dashboardSnapshotPublications.close(),
        closeBusinessOutcomePublicationScheduler: () => businessOutcomePublications.close(),
        closeDashboardEventSubscriber: async () => {
          try {
            await dashboardEventSubscriber.close();
          } finally {
            dashboardEventSubscriberRedis.disconnect();
          }
        },
        closeOrderProcessJobPublisher: () => orderProcessJobPublisher.close(),
        closeOrderProcessQueueInspector: () => orderProcessQueueInspector.close(),
        closeDemoQueueMaintenance: () => demoQueueMaintenance.close(),
        disconnectRedis: () => redis.disconnect(),
        closeDatabase: async () => {
          await Promise.all([connection.close(), resetWorkflowSql.end({ timeout: 5 })]);
        },
      });
    })();
    return closePromise;
  };

  try {
    await validateActivePublicRuntimePolicyAtStartup(connection.db, config.deploymentHardCaps);
    const startupReconciliation = await demoRunStartupReconciliationService.reconcile();
    try {
      await pendingPersistenceReconciler.reconcileAll();
    } catch (error) {
      logger.warn(
        { err: error },
        "Global pending Redis reservation reconciliation will retry on the next lifecycle pass.",
      );
    }
    if (startupReconciliation.discoveredRunCount > 0) {
      logger.info(startupReconciliation, "API startup demo-run reconciliation completed.");
    }

    finalizationPoller = setInterval(() => {
      void demoRunService.reconcileStartingRuns().catch((error: unknown) => {
        logger.error({ err: error }, "Demo run traffic-start reconciliation failed.");
      });
      void (async () => {
        await trafficCompletionEnrichmentService.reconcilePendingEnrichments();
        await demoRunFinalizationService.finalizeReadyRuns();
      })().catch((error: unknown) => {
        logger.error({ err: error }, "Demo run completion lifecycle poll failed.");
      });
    }, config.demoRunFinalizationPollIntervalSeconds * 1000);
    finalizationPoller.unref();

    server = await buildApiServer({
      config,
      logger,
      readiness: createInfrastructureReadinessCheck(
        connection.sql,
        redis,
        orderProcessQueueInspector,
      ),
      dashboardEventFanout,
      dashboardRecoveryService,
      dashboardRecoveryAdmission,
      erpStatusService,
      inventoryStatusService,
      orderStatusService,
      queueStatusService,
      reserveOrderService,
      demoRunService,
      demoMaintenanceService,
      runHistoryService,
      startedAt: new Date(),
    });
    await dashboardEventSubscriber.start();

    process.once("SIGTERM", () => {
      void close()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          logger.error({ err: error }, "API shutdown failed.");
          process.exit(1);
        });
    });
    process.once("SIGINT", () => {
      void close()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          logger.error({ err: error }, "API shutdown failed.");
          process.exit(1);
        });
    });

    await server.listen({
      host: config.host,
      port: config.port,
      listenTextResolver: (address) => `API gateway listening at ${address}`,
      backlog: config.listenBacklog,
    });
  } catch (error) {
    process.exitCode = 1;
    logger.error({ err: error }, "API server failed to start.");
    try {
      await close();
    } catch (cleanupError) {
      logger.error({ err: cleanupError }, "API startup cleanup failed.");
    }
  }
}

function orderEnqueueFailureLogContext(report: OrderEnqueueFailureReport) {
  return {
    ...partialFailureLogContext(report),
    orderId: report.orderId,
  };
}

function partialFailureLogContext(report: ReservationPartialFailureReport) {
  return {
    err: report.error,
    reservationId: report.reservationId,
    saleOfferId: report.saleOfferId,
    ...(report.runId ? { runId: report.runId } : {}),
    correlationId: report.correlationId,
    idempotencyKey: report.idempotencyKey,
  };
}

function businessOutcomeUpdateFailureLogContext(report: BusinessOutcomeUpdateFailureReport) {
  return {
    err: report.error,
    saleOfferId: report.saleOfferId,
    ...(report.runId ? { runId: report.runId } : {}),
    correlationId: report.correlationId,
  };
}

if (process.env.NODE_ENV !== "test" && import.meta.url === `file://${process.argv[1]}`) {
  void startApiServer();
}
