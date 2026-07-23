import { contractsPackageName } from "@checkout-surge/contracts";
import {
  BusinessOutcomePublicationScheduler,
  clearErpCircuitBreakerSnapshots,
  completeGeneratedRunTeardown,
  createDatabaseConnection,
  createRedisClient,
  createRedisDashboardEventSubscriber,
  createSqlClient,
  dbPackageName,
  deleteGeneratedRunRedisState,
  demoRuns,
  getInventoryStatus,
  markReservationPendingPersistence,
  prepareGeneratedRunTeardown,
  promoteReservationIdempotencyToAccepted,
  publishBusinessOutcomeDashboardUpdate,
  publishDashboardEvent,
  reserveInventoryStock,
  reverseReservation,
  setRunSaleEligibility,
} from "@checkout-surge/db";
import { createServiceLogger, loggerPackageName } from "@checkout-surge/logger";
import { eq } from "drizzle-orm";
import { createBullMqDemoQueueMaintenance } from "./queue/bullmq-demo-queue-maintenance.js";
import { createBullMqOrderProcessJobPublisher } from "./queue/bullmq-order-process-job-publisher.js";
import { createBullMqOrderProcessQueueInspector } from "./queue/bullmq-order-process-queue-inspector.js";
import { PostgresRunRetryPolicyResolver } from "./queue/postgres-run-retry-policy-resolver.js";
import { DashboardEventFanout } from "./realtime/dashboard-event-fanout.js";
import { invalidDashboardEventMetadata } from "./realtime/invalid-dashboard-event-metadata.js";
import { closeApiResources } from "./runtime/api-resource-cleanup.js";
import { loadApiConfig } from "./runtime/config.js";
import { createDashboardRecoveryOperationFactory } from "./runtime/dashboard-recovery-operation-factory.js";
import type { ApiFastifyInstance } from "./runtime/fastify.js";
import { createPendingPersistenceRecoveryOperations } from "./runtime/pending-persistence-operation-factory.js";
import { createApiReadiness } from "./runtime/readiness.js";
import { createTerminalInventoryReadOperation } from "./runtime/terminal-inventory-read-operation.js";
import { buildApiServer } from "./server.js";
import { AdminDemoResetService } from "./services/admin-demo-reset-service.js";
import { DashboardRecoveryAdmissionService } from "./services/dashboard-recovery-admission.js";
import {
  DashboardRecoveryService,
  PostgresDashboardBusinessOutcomeReader,
} from "./services/dashboard-recovery-service.js";
import { DashboardSnapshotPublicationScheduler } from "./services/dashboard-snapshot-publication-scheduler.js";
import { RedisDashboardTrafficMetricStore } from "./services/dashboard-traffic-metric-store.js";
import { ProcessLocalDemoMaintenanceAuthority } from "./services/demo-maintenance-authority.js";
import { DemoPresetService } from "./services/demo-preset-service.js";
import { DemoRunFinalizationService } from "./services/demo-run-finalization-service.js";
import { DemoRunLifecycleService } from "./services/demo-run-service.js";
import {
  DemoRunStartupReconciliationService,
  PostgresStartingDemoRunReconciliationStore,
} from "./services/demo-run-startup-reconciliation-service.js";
import {
  ErpStatusService,
  PostgresActiveErpRunReader,
  PostgresErpAttemptStatusReader,
  RedisErpCircuitBreakerStateReader,
} from "./services/erp-status-service.js";
import { GeneratedRunRetentionService } from "./services/generated-run-retention-service.js";
import { GeneratedRunTeardownService } from "./services/generated-run-teardown-service.js";
import { InventoryStatusService } from "./services/inventory-status-service.js";
import { OrderStatusService } from "./services/order-status-service.js";
import { PendingPersistenceRecoveryService } from "./services/pending-persistence-recovery-service.js";
import { PostgresBuyPersistence } from "./services/postgres-buy-persistence.js";
import { PostgresDemoResetWorkflowFence } from "./services/postgres-demo-reset-workflow-fence.js";
import { RedisPublicRunBudgetStore } from "./services/public-run-budget-store.js";
import { PublicRuntimePolicyService } from "./services/public-runtime-policy-service.js";
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
import { TrafficCompletionService } from "./services/traffic-completion-service.js";
import { HttpTrafficExecutionGateway } from "./services/traffic-execution-gateway.js";
import { TrafficMetricIngestionService } from "./services/traffic-metric-ingestion-service.js";

export const apiAppName = "api" as const;
export const apiAppDependencies = [contractsPackageName, dbPackageName, loggerPackageName] as const;
const terminalInventoryReadTimeoutMs = 2_000;

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
  PostgresDashboardTransportAttemptCountsReader,
} from "./services/dashboard-recovery-service.js";
export { DashboardSnapshotPublicationScheduler } from "./services/dashboard-snapshot-publication-scheduler.js";
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
export { PendingPersistenceRecoveryService } from "./services/pending-persistence-recovery-service.js";
export { PostgresBuyPersistence } from "./services/postgres-buy-persistence.js";
export { QueueStatusService } from "./services/queue-status-service.js";
export { ReserveOrderService } from "./services/reserve-order-service.js";
export { RunHistoryService } from "./services/run-history-service.js";
export { TrafficCompletionEnrichmentService } from "./services/traffic-completion-enrichment-service.js";
export { TrafficCompletionService } from "./services/traffic-completion-service.js";

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
  const pendingPersistenceOperations = createPendingPersistenceRecoveryOperations({
    databaseUrl: config.databaseUrl,
    redisUrl: config.redisUrl,
    discoveryTimeoutMs: config.pendingPersistenceRecoveryDiscoveryTimeoutMs,
    orderProcessMaxAttempts: config.orderProcessMaxAttempts,
    orderProcessBackoffBaseMs: config.orderProcessBackoffBaseMs,
  });
  const pendingPersistenceRecovery = new PendingPersistenceRecoveryService({
    redis: pendingPersistenceOperations.redis,
    persistence,
    audit: {
      recordAttempt: (input) => persistence.recordPendingPersistenceAttempt(input),
      markResolved: (input) => persistence.markPendingPersistenceResolved(input),
      markExhausted: (input) => persistence.markPendingPersistenceExhausted(input),
    },
    stockReservations: stockReservationGateway,
    orderProcessJobPublisher,
    openDiscoveryScope: (signal) => pendingPersistenceOperations.openDiscoveryScope(signal),
    listRunScopes: (signal) => pendingPersistenceOperations.listRunScopes(signal),
    openAttemptScope: (input) => pendingPersistenceOperations.openAttemptScope(input),
    closeDiscovery: () => pendingPersistenceOperations.close(),
    runRetryPolicyResolver,
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    dashboardSnapshotPublications,
    businessOutcomeUpdates: businessOutcomePublications,
    logger,
    recoveryWindowSeconds: config.pendingPersistenceRecoveryWindowSeconds,
    maxAttempts: config.pendingPersistenceRecoveryMaxAttempts,
    initialBackoffMs: config.pendingPersistenceRecoveryInitialBackoffMs,
    maxBackoffMs: config.pendingPersistenceRecoveryMaxBackoffMs,
    pollIntervalMs: config.pendingPersistenceRecoveryPollIntervalMs,
    discoveryTimeoutMs: config.pendingPersistenceRecoveryDiscoveryTimeoutMs,
    maxConcurrentDirectAttempts: config.pendingPersistenceRecoveryMaxConcurrentDirectAttempts,
  });
  const trafficMetricStore = new RedisDashboardTrafficMetricStore(redis);
  const trafficMetricIngestion = new TrafficMetricIngestionService({
    db: connection.db,
    store: trafficMetricStore,
    logger,
  });
  const trafficExecutionGateway = new HttpTrafficExecutionGateway({
    loadOrchestratorBaseUrl: config.loadOrchestratorBaseUrl,
    controlServiceToken: config.controlServiceToken,
  });
  const terminalRunWriter = new PostgresTerminalDemoRunSummaryWriter(connection.db);
  const maintenanceAuthority = new ProcessLocalDemoMaintenanceAuthority();
  const generatedRunTeardown = new GeneratedRunTeardownService({
    db: connection.db,
    redis,
    deleteGeneratedRunRedisState,
    prepareGeneratedRunTeardown,
    completeGeneratedRunTeardown,
    queueMaintenance: demoQueueMaintenance,
    maintenanceAuthority,
    logger,
  });
  const generatedRunRetention = new GeneratedRunRetentionService({
    db: connection.db,
    generatedRunTeardown,
    maintenanceAuthority,
  });
  const adminDemoReset = new AdminDemoResetService({
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
    maintenanceAuthority,
    logger,
  });
  const runHistoryService = new RunHistoryService({ db: connection.db });
  const dashboardRecoveryService = new DashboardRecoveryService({
    openOperation: createDashboardRecoveryOperationFactory({
      databaseUrl: config.databaseUrl,
      redisUrl: config.redisUrl,
      timeoutMs: config.dashboardRecoveryTimeoutMs,
      logger,
    }),
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
    terminalRunWriter,
    terminalInventoryRead: createTerminalInventoryReadOperation({
      redisUrl: config.redisUrl,
      timeoutMs: terminalInventoryReadTimeoutMs,
    }),
    terminalInventoryReadTimeoutMs,
    drainTimeoutSeconds: config.demoRunDrainTimeoutSeconds,
  });
  const demoRunStartupReconciliationService = new DemoRunStartupReconciliationService({
    logger,
    completionEnrichmentService: trafficCompletionEnrichmentService,
    startingRunStore: new PostgresStartingDemoRunReconciliationStore(connection.db),
    trafficExecutionGateway,
    apiBaseUrl: config.apiBaseUrl,
    buyEndpointPath: "/buy",
    listDrainingRuns: () =>
      connection.db.select().from(demoRuns).where(eq(demoRuns.status, "draining")),
    closeRunSaleEligibility: ({ runId, saleOfferId }) =>
      setRunSaleEligibility(redis, { runId, saleOfferId, status: "closed" }),
  });
  const presetService = new DemoPresetService({ db: connection.db });
  const runtimePolicyService = new PublicRuntimePolicyService({
    db: connection.db,
    deploymentHardCaps: config.deploymentHardCaps,
  });
  const demoRunLifecycleService = new DemoRunLifecycleService({
    db: connection.db,
    redis,
    presetReader: presetService,
    runtimePolicyReader: runtimePolicyService,
    trafficExecutionGateway,
    publicRunBudgetStore: new RedisPublicRunBudgetStore(redis),
    businessOutcomeReader,
    terminalRunWriter,
    apiBaseUrl: config.apiBaseUrl,
    buyEndpointPath: "/buy",
    logger,
    publicClientCookieSecret: config.publicClientCookieSecret,
  });
  const trafficCompletionService = new TrafficCompletionService({
    db: connection.db,
    redis,
    completionEnrichmentService: trafficCompletionEnrichmentService,
    finalizationService: demoRunFinalizationService,
    logger,
  });
  const reserveOrderService = new ReserveOrderService({
    persistence,
    orderProcessJobPublisher,
    runRetryPolicyResolver,
    stockReservations: stockReservationGateway,
    reservationHoldMinutes: config.reservationHoldMinutes,
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    pendingPersistenceRetryAfterSeconds: config.pendingPersistenceRetryAfterSeconds,
    pendingPersistenceRecovery,
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
  const readiness = createApiReadiness({
    databaseUrl: config.databaseUrl,
    redisUrl: config.redisUrl,
    timeoutMs: config.readinessTimeoutMs,
  });
  const close = () => {
    closePromise ??= (async () => {
      logger.info("Closing API server.");
      if (finalizationPoller) {
        clearInterval(finalizationPoller);
      }
      await closeApiResources({
        closePendingPersistenceRecovery: () => pendingPersistenceRecovery.close(),
        closeReadiness: () => readiness.close(),
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
    await runtimePolicyService.validateActivePolicyAtStartup();
    const startupReconciliation = await demoRunStartupReconciliationService.reconcile();
    pendingPersistenceRecovery.start();
    if (startupReconciliation.discoveredRunCount > 0) {
      logger.info(startupReconciliation, "API startup demo-run reconciliation completed.");
    }

    finalizationPoller = setInterval(() => {
      void demoRunStartupReconciliationService.reconcileStartingRuns().catch((error: unknown) => {
        logger.error({ err: error }, "Demo run traffic-start reconciliation failed.");
      });
      void demoRunFinalizationService.finalizeReadyRuns().catch((error: unknown) => {
        logger.error({ err: error }, "Demo run completion lifecycle poll failed.");
      });
    }, config.demoRunFinalizationPollIntervalSeconds * 1000);
    finalizationPoller.unref();

    server = await buildApiServer({
      config,
      logger,
      readiness,
      dashboardEventFanout,
      dashboardRecoveryService,
      dashboardRecoveryAdmission,
      erpStatusService,
      inventoryStatusService,
      orderStatusService,
      queueStatusService,
      reserveOrderService,
      presetService,
      runtimePolicyService,
      demoRunLifecycleService,
      trafficCompletionService,
      trafficMetricIngestion,
      adminDemoReset,
      generatedRunRetention,
      generatedRunTeardown,
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
