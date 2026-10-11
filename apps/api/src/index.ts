import { readFile } from "node:fs/promises";
import {
  BusinessOutcomePublicationScheduler,
  type CheckoutSurgeDatabase,
  createDatabaseConnection,
  createRedisClient,
  createRedisDashboardProjectionDirtySubscriber,
  createSqlClient,
  deleteGeneratedRunDurable,
  deleteGeneratedRunRedisState,
  demoRuns,
  inspectGeneratedRunTeardown,
  markReservationPendingPersistence,
  promoteReservationIdempotencyToAccepted,
  publishDashboardProjectionDirtySignal,
  purgeResetRunDurable,
  reserveInventoryStock,
  reverseReservation,
} from "@checkout-surge/db";
import { type FlyMachineConfig, FlyMachinesClient } from "@checkout-surge/fly-machines";
import { createServiceLogger } from "@checkout-surge/logger";
import { eq } from "drizzle-orm";
import { createBullMqDemoQueueMaintenance } from "./queue/bullmq-demo-queue-maintenance.js";
import { createBullMqOrderProcessJobPublisher } from "./queue/bullmq-order-process-job-publisher.js";
import { createBullMqOrderProcessQueueInspector } from "./queue/bullmq-order-process-queue-inspector.js";
import { DashboardProjectionFanout } from "./realtime/dashboard-projection-fanout.js";
import { invalidDashboardDirtySignalMetadata } from "./realtime/invalid-dashboard-dirty-signal-metadata.js";
import { closeApiResources } from "./runtime/api-resource-cleanup.js";
import { startBuyerApiServer } from "./runtime/buyer-api-runtime.js";
import { type ApiConfig, loadApiConfig } from "./runtime/config.js";
import { createReserveOrderService } from "./runtime/create-reserve-order-service.js";
import { createDashboardRecoveryOperationFactory } from "./runtime/dashboard-recovery-operation-factory.js";
import type { ApiFastifyInstance } from "./runtime/fastify.js";
import { createInventoryStatusReader } from "./runtime/inventory-status-reader.js";
import { warnWhenListenBacklogIsCapped } from "./runtime/listen-backlog-ceiling.js";
import { createPendingPersistenceRecoveryOperations } from "./runtime/pending-persistence-operation-factory.js";
import { createApiReadiness } from "./runtime/readiness.js";
import { createRunInventoryLifecycle } from "./runtime/run-inventory-lifecycle.js";
import { createTerminalInventoryReadOperation } from "./runtime/terminal-inventory-read-operation.js";
import { buildApiServer } from "./server.js";
import {
  ActiveBuyingRunContext,
  PostgresBuyingRunContextReader,
} from "./services/active-buying-run-context.js";
import { AdminDemoResetService } from "./services/admin-demo-reset-service.js";
import { AutomaticRunResetService } from "./services/automatic-run-reset-service.js";
import { BuyerReservationTimingBarrier } from "./services/buyer-reservation-timing-barrier.js";
import {
  type CoreIdleShutdown,
  CoreIdleStop,
  disabledCoreIdleShutdown,
  PostgresNonterminalRunReader,
} from "./services/core-idle-stop.js";
import { DashboardProjectionPublicationScheduler } from "./services/dashboard-projection-publication-scheduler.js";
import { DashboardRecoveryAdmissionService } from "./services/dashboard-recovery-admission.js";
import {
  DashboardProjectionService,
  PostgresDashboardBusinessOutcomeReader,
} from "./services/dashboard-recovery-service.js";
import { DashboardSourceDirtyScheduler } from "./services/dashboard-source-dirty-scheduler.js";
import { RedisDashboardTrafficMetricStore } from "./services/dashboard-traffic-metric-store.js";
import { ProcessLocalDemoMaintenanceAuthority } from "./services/demo-maintenance-authority.js";
import { DemoPresetService } from "./services/demo-preset-service.js";
import { DemoRunFinalizationService } from "./services/demo-run-finalization-service.js";
import { DemoRunLifecycleService } from "./services/demo-run-service.js";
import {
  DemoRunStartupReconciliationService,
  PostgresStartingDemoRunReconciliationStore,
} from "./services/demo-run-startup-reconciliation-service.js";
import { FlyRunnerHost } from "./services/fly-runner-host.js";
import { GeneratedRunRetentionService } from "./services/generated-run-retention-service.js";
import { GeneratedRunTeardownService } from "./services/generated-run-teardown-service.js";
import { InventoryStatusService } from "./services/inventory-status-service.js";
import { DemoRunQueueLimits } from "./services/order-process-queue-limits.js";
import { OrderStatusService } from "./services/order-status-service.js";
import { PendingPersistenceRecoveryService } from "./services/pending-persistence-recovery-service.js";
import { PostgresBuyPersistence } from "./services/postgres-buy-persistence.js";
import { PostgresDemoResetWorkflowFence } from "./services/postgres-demo-reset-workflow-fence.js";
import { RedisPublicRunBudgetStore } from "./services/public-run-budget-store.js";
import { PublicRuntimePolicyService } from "./services/public-runtime-policy-service.js";
import { QueueStatusService } from "./services/queue-status-service.js";
import {
  RedisReservationTimingStore,
  ReservationTimingObservationScheduler,
} from "./services/reservation-timing-observation.js";
import { RunHistoryService } from "./services/run-history-service.js";
import { alwaysOnRunnerHost, type RunnerHost } from "./services/runner-host.js";
import { PostgresMonitoredRunReader, RunnerLossMonitor } from "./services/runner-loss-monitor.js";
import { RunnerOperations } from "./services/runner-operations.js";
import { PostgresTerminalDemoRunSummaryWriter } from "./services/terminal-demo-run-transition.js";
import { TrafficCompletionEnrichmentService } from "./services/traffic-completion-enrichment-service.js";
import { TrafficCompletionService } from "./services/traffic-completion-service.js";
import { HttpTrafficExecutionGateway } from "./services/traffic-execution-gateway.js";
import { TrafficMetricIngestionService } from "./services/traffic-metric-ingestion-service.js";

const terminalInventoryReadTimeoutMs = 2_000;

export async function startApiServer(): Promise<void> {
  const config = loadApiConfig(process.env);
  if (config.role === "buyer") return startBuyerApiServer(config);
  const logger = createServiceLogger({ service: "api" });
  const connection = createDatabaseConnection(config.databaseUrl, { max: config.postgresPoolMax });
  const resetWorkflowSql = createSqlClient(config.databaseUrl, { max: 1 });
  const redis = createRedisClient(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  const dashboardProjectionDirtySubscriberRedis = createRedisClient(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  const orderProcessJobPublisher = createBullMqOrderProcessJobPublisher({
    url: config.redisUrl,
    maxRetriesPerRequest: 3,
  });
  const orderProcessQueueInspector = createBullMqOrderProcessQueueInspector({
    url: config.redisUrl,
    maxRetriesPerRequest: 3,
  });
  const demoQueueMaintenance = createBullMqDemoQueueMaintenance({
    url: config.redisUrl,
    maxRetriesPerRequest: 3,
  });

  const persistence = new PostgresBuyPersistence(connection.db);
  const stockReservationGateway = {
    reserve: (input: Parameters<typeof reserveInventoryStock>[1]) =>
      reserveInventoryStock(redis, input),
    markPendingPersistence: (input: Parameters<typeof markReservationPendingPersistence>[1]) =>
      markReservationPendingPersistence(redis, input),
    promoteAccepted: (input: Parameters<typeof promoteReservationIdempotencyToAccepted>[1]) =>
      promoteReservationIdempotencyToAccepted(redis, input).then(() => undefined),
    reverse: (input: Parameters<typeof reverseReservation>[1]) => reverseReservation(redis, input),
  };
  const dashboardProjectionFanout = new DashboardProjectionFanout({
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
  const queueStatusService = new QueueStatusService(orderProcessQueueInspector, logger);
  const inventoryStatusService = new InventoryStatusService(
    createInventoryStatusReader(connection.db, redis),
  );
  const orderStatusService = new OrderStatusService(connection.db);
  const dashboardSourceDirtyScheduler = new DashboardSourceDirtyScheduler({
    readQueue: () => queueStatusService.getStatus(),
    publish: (signal) => publishDashboardProjectionDirtySignal(redis, signal),
    logger,
  });
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
  const pendingPersistenceOperations = createPendingPersistenceRecoveryOperations({
    databaseUrl: config.databaseUrl,
    redisUrl: config.redisUrl,
    discoveryTimeoutMs: config.pendingPersistenceRecoveryDiscoveryTimeoutMs,
  });
  const pendingPersistenceRecovery = new PendingPersistenceRecoveryService({
    storage: pendingPersistenceOperations.storage,
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
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    dashboardSourceDirtyScheduler,
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
  const reservationTiming = new ReservationTimingObservationScheduler(
    new RedisReservationTimingStore(redis),
    logger,
  );
  const peerReservationTiming =
    config.role === "control"
      ? new BuyerReservationTimingBarrier({
          buyerBaseUrls: config.buyerBaseUrls ?? [],
          controlServiceToken: config.controlServiceToken,
          local: reservationTiming,
          logger,
        })
      : undefined;
  const trafficMetricIngestion = new TrafficMetricIngestionService({
    db: connection.db,
    store: trafficMetricStore,
    logger,
  });
  const trafficExecutionGateway = new HttpTrafficExecutionGateway({
    loadOrchestratorBaseUrl: config.loadOrchestratorBaseUrl,
    controlServiceToken: config.controlServiceToken,
  });
  const runnerOperations = new RunnerOperations({
    host: createRunnerHost(config, trafficExecutionGateway, logger),
    control: trafficExecutionGateway,
    aborter: trafficExecutionGateway,
    apiVersion: config.commitSha,
    acceptUnknownVersion: config.runnerHost.kind === "local",
    logger,
  });
  const queueLimits = new DemoRunQueueLimits(connection.db, orderProcessJobPublisher);
  const terminalRunWriter = new PostgresTerminalDemoRunSummaryWriter(
    connection.db,
    queueLimits,
    logger,
  );
  const maintenanceAuthority = new ProcessLocalDemoMaintenanceAuthority();
  const runInventory = createRunInventoryLifecycle(connection.db, redis);
  const generatedRunTeardown = new GeneratedRunTeardownService({
    inventory: runInventory,
    db: connection.db,
    redis,
    deleteGeneratedRunRedisState,
    inspectGeneratedRunTeardown,
    deleteGeneratedRunDurable,
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
    inventory: runInventory,
    queueLimits,
    db: connection.db,
    redis,
    queueMaintenance: demoQueueMaintenance,
    terminalRunWriter,
    trafficAborter: runnerOperations,
    runnerOperations,
    dashboardLiveStateReset: {
      fenceRun: (runId) => trafficMetricStore.fenceRun(runId),
      hasRunState: (runId) => trafficMetricStore.hasRunState(runId),
      clearRun: async (runId) => {
        dashboardSourceDirtyScheduler.clearRun(runId);
        businessOutcomePublications.clearRun(runId);
        await trafficMetricStore.clearRun(runId);
      },
    },
    reservationTiming: peerReservationTiming ?? reservationTiming,
    resetWorkflowFence: new PostgresDemoResetWorkflowFence(resetWorkflowSql),
    maintenanceAuthority,
    deleteGeneratedRunRedisState,
    purgeResetRunDurable,
    logger,
  });
  const runHistoryService = new RunHistoryService({ db: connection.db });
  const dashboardProjectionService = new DashboardProjectionService({
    openOperation: createDashboardRecoveryOperationFactory({
      databaseUrl: config.databaseUrl,
      redisUrl: config.redisUrl,
      timeoutMs: config.dashboardRecoveryTimeoutMs,
      logger,
    }),
    logger,
  });
  const dashboardProjectionPublications = new DashboardProjectionPublicationScheduler({
    projectionService: dashboardProjectionService,
    publish: (projection) => dashboardProjectionFanout.publish(projection),
    logger,
    buildTimeoutMs: config.dashboardRecoveryTimeoutMs,
  });
  const dashboardProjectionDirtySubscriber = createRedisDashboardProjectionDirtySubscriber(
    dashboardProjectionDirtySubscriberRedis,
    {
      onDirty: (signal) => {
        dashboardProjectionPublications.markDirty(signal);
      },
      onHandlerError: (error) => {
        logger.error({ err: error }, "Dashboard projection dirty handler failed.");
      },
      onInvalidMessage: (error, message) => {
        logger.warn(
          invalidDashboardDirtySignalMetadata(message, error),
          "Ignored invalid dashboard projection dirty signal from Redis Pub/Sub.",
        );
      },
    },
  );
  const businessOutcomeReader = new PostgresDashboardBusinessOutcomeReader(connection.db);
  const trafficCompletionEnrichmentService = new TrafficCompletionEnrichmentService({
    inventory: runInventory,
    db: connection.db,
    redis,
    businessOutcomeReader,
    logger,
  });
  const demoRunFinalizationService = new DemoRunFinalizationService({
    inventory: runInventory,
    queueLimits,
    db: connection.db,
    redis,
    logger,
    terminalRunWriter,
    runnerOperations,
    terminalInventoryRead: createTerminalInventoryReadOperation({
      redisUrl: config.redisUrl,
      timeoutMs: terminalInventoryReadTimeoutMs,
    }),
    terminalInventoryReadTimeoutMs,
    reservationTiming: peerReservationTiming ?? reservationTiming,
    liveMetricDrops: trafficMetricIngestion,
    completedOrderJobs: demoQueueMaintenance,
  });
  const reserveOrderService = createReserveOrderService(
    {
      persistence,
      orderProcessJobPublisher,
      stockReservations: stockReservationGateway,
      reservationHoldMinutes: config.reservationHoldMinutes,
      idempotencyTtlSeconds: config.idempotencyTtlSeconds,
      pendingPersistenceRetryAfterSeconds: config.pendingPersistenceRetryAfterSeconds,
      pendingPersistenceRecovery,
      dashboardSourceDirtyScheduler,
      soldOutObservations: dashboardSourceDirtyScheduler,
      reservationTimingObservations: reservationTiming,
      publishBusinessOutcomeUpdate: async (input) => businessOutcomePublications.markDirty(input),
    },
    logger,
  );

  const buyingContext = new ActiveBuyingRunContext({
    reader: new PostgresBuyingRunContextReader(connection.db),
    services: { demo: reserveOrderService },
  });
  const presetService = new DemoPresetService({ db: connection.db });
  const runtimePolicyService = new PublicRuntimePolicyService({
    db: connection.db,
    deploymentHardCaps: config.deploymentHardCaps,
  });
  const demoRunLifecycleService = new DemoRunLifecycleService({
    inventory: runInventory,
    onRunAccepted: async (runId) => {
      await buyingContext.activate(runId);
      await peerReservationTiming?.captureBaseline(runId);
    },
    maintenanceAuthority,
    queueLimits,
    db: connection.db,
    redis,
    presetReader: presetService,
    runtimePolicyReader: runtimePolicyService,
    trafficExecutionGateway,
    runnerOperations,
    publicRunBudgetStore: new RedisPublicRunBudgetStore(redis),
    businessOutcomeReader,
    terminalRunWriter,
    apiBaseUrl: config.apiBaseUrl,
    logger,
    publicClientCookieSecret: config.publicClientCookieSecret,
    estimatorConstants: config.estimatorConstants,
    deploymentCapacity: config.deploymentCapacity,
  });
  const demoRunStartupReconciliationService = new DemoRunStartupReconciliationService({
    maintenanceAuthority,
    logger,
    completionEnrichmentService: trafficCompletionEnrichmentService,
    startingRunStore: new PostgresStartingDemoRunReconciliationStore(connection.db),
    trafficExecutionGateway,
    undispatchedRuns: demoRunLifecycleService,
    prepareBuyingRun: async (runId) => {
      await buyingContext.activate(runId);
      await peerReservationTiming?.activate(runId);
    },
    apiBaseUrl: config.apiBaseUrl,
    listDrainingRuns: () =>
      connection.db.select().from(demoRuns).where(eq(demoRuns.status, "draining")),
    closeRunSaleEligibility: (scope) => runInventory.close(scope),
  });
  const runnerLossMonitor = new RunnerLossMonitor({
    runs: new PostgresMonitoredRunReader(connection.db),
    runner: runnerOperations,
    lostRuns: demoRunLifecycleService,
    logger,
  });
  const coreIdleShutdown = createCoreIdleShutdown(config, connection.db, logger);
  const trafficCompletionService = new TrafficCompletionService({
    db: connection.db,
    redis,
    completionEnrichmentService: trafficCompletionEnrichmentService,
    finalizationService: demoRunFinalizationService,
    logger,
  });
  const automaticRunReset = new AutomaticRunResetService({
    db: connection.db,
    resetWorkflow: adminDemoReset,
  });
  let automaticResetPoller: ReturnType<typeof setInterval> | null = null;
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
      if (automaticResetPoller) clearInterval(automaticResetPoller);
      await automaticRunReset.close().catch((err: unknown) => {
        logger.error({ err }, "Automatic run reset failed during shutdown.");
      });
      await closeApiResources({
        closePendingPersistenceRecovery: () => pendingPersistenceRecovery.close(),
        closeReadiness: () => readiness.close(),
        closeServer: async () => {
          dashboardProjectionFanout.close();
          await server?.close();
        },
        closeDashboardAndReservationSchedulers: async () => {
          await Promise.all([
            dashboardSourceDirtyScheduler.close(),
            dashboardProjectionPublications.close(),
            reservationTiming.close(),
          ]);
        },
        closeBusinessOutcomePublicationScheduler: () => businessOutcomePublications.close(),
        closeDashboardProjectionDirtySubscriber: async () => {
          try {
            await dashboardProjectionDirtySubscriber.close();
          } finally {
            dashboardProjectionDirtySubscriberRedis.disconnect();
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
    await queueLimits.synchronize();
    await automaticRunReset.check().catch((err: unknown) => {
      logger.error(
        { err },
        "Automatic run reset startup check failed; periodic checks will retry.",
      );
    });
    automaticResetPoller = setInterval(() => {
      void automaticRunReset.check().catch((err: unknown) => {
        logger.error({ err }, "Automatic run reset check failed.");
      });
    }, 5_000);
    automaticResetPoller.unref();
    const startupReconciliation = await demoRunStartupReconciliationService.reconcile();
    await buyingContext.hydrate();
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
      void runnerLossMonitor.check().catch((error: unknown) => {
        logger.error({ err: error }, "Runner loss check failed.");
      });
      void coreIdleShutdown.check().catch((error: unknown) => {
        logger.error({ err: error }, "Core idle stop check failed.");
      });
    }, config.demoRunFinalizationPollIntervalSeconds * 1000);
    finalizationPoller.unref();

    server = await buildApiServer({
      config,
      logger,
      readiness,
      dashboardProjectionFanout,
      dashboardRecoveryService: dashboardProjectionService,
      dashboardRecoveryAdmission,
      inventoryStatusService,
      orderStatusService,
      queueStatusService,
      reserveOrderService: buyingContext,
      pendingPersistenceRecovery,
      presetService,
      runtimePolicyService,
      demoRunLifecycleService,
      trafficCompletionService,
      trafficMetricIngestion,
      adminDemoReset,
      generatedRunRetention,
      generatedRunTeardown,
      runnerRecreation: runnerOperations,
      runHistoryService,
      coreIdleShutdown,
      startedAt: new Date(),
    });
    await dashboardProjectionDirtySubscriber.start();

    const handleShutdown = () => {
      void close()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          logger.error({ err: error }, "API shutdown failed.");
          process.exit(1);
        });
    };
    process.once("SIGTERM", handleShutdown);
    process.once("SIGINT", handleShutdown);

    await warnWhenListenBacklogIsCapped({ requestedBacklog: config.listenBacklog, logger });

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

function createRunnerHost(
  config: ApiConfig,
  control: HttpTrafficExecutionGateway,
  logger: ReturnType<typeof createServiceLogger>,
): RunnerHost {
  if (config.runnerHost.kind === "local") return alwaysOnRunnerHost;
  const { deployedConfigFile } = config.runnerHost;
  return new FlyRunnerHost({
    machines: new FlyMachinesClient({
      appName: config.runnerHost.appName,
      token: config.runnerHost.machinesApiToken,
      ...(config.runnerHost.expectedOrganization
        ? { expectedOrganization: config.runnerHost.expectedOrganization }
        : {}),
    }),
    control,
    size: {
      cpuKind: config.runnerHost.cpuKind,
      cpus: config.runnerHost.cpus,
      memoryMb: config.runnerHost.memoryMb,
    },
    apiBaseUrl: config.apiBaseUrl,
    coreRegion: config.runnerHost.coreRegion,
    ...(config.runnerHost.expectedOrganization ? { leaseSeconds: 900 } : {}),
    readDeployedConfig: async () =>
      JSON.parse(await readFile(deployedConfigFile, "utf8")) as FlyMachineConfig,
    logger,
  });
}

function createCoreIdleShutdown(
  config: ApiConfig,
  db: CheckoutSurgeDatabase,
  logger: ReturnType<typeof createServiceLogger>,
): CoreIdleShutdown {
  const idleStop = config.coreIdleStop;
  if (idleStop.kind === "off") return disabledCoreIdleShutdown;
  const machines = new FlyMachinesClient({
    appName: idleStop.appName,
    token: idleStop.machinesApiToken,
  });
  return new CoreIdleStop({
    runs: new PostgresNonterminalRunReader(db),
    stopCore: async () => {
      if (!idleStop.shutdownUrl) return machines.stopMachine(idleStop.machineId);
      const response = await fetch(idleStop.shutdownUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${idleStop.lifecycleToken}`,
          "x-core-machine-id": idleStop.machineId,
        },
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`Gate idle shutdown failed with ${response.status}.`);
    },
    logger,
  });
}

if (process.env.NODE_ENV !== "test" && import.meta.url === `file://${process.argv[1]}`) {
  void startApiServer();
}
