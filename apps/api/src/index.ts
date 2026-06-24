import { contractsPackageName } from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createRedisClient,
  createRedisDashboardEventSubscriber,
  dbPackageName,
  getInventoryStatus,
  markReservationPendingPersistence,
  promoteReservationIdempotencyToAccepted,
  publishBusinessOutcomeDashboardUpdate,
  reserveInventoryStock,
} from "@checkout-surge/db";
import { createServiceLogger, loggerPackageName } from "@checkout-surge/logger";
import { createBullMqDemoQueueMaintenance } from "./queue/bullmq-demo-queue-maintenance.js";
import { createBullMqOrderProcessJobPublisher } from "./queue/bullmq-order-process-job-publisher.js";
import { createBullMqOrderProcessQueueInspector } from "./queue/bullmq-order-process-queue-inspector.js";
import { DashboardEventFanout } from "./realtime/dashboard-event-fanout.js";
import { closeApiResources } from "./runtime/api-resource-cleanup.js";
import { loadApiConfig } from "./runtime/config.js";
import type { ApiFastifyInstance } from "./runtime/fastify.js";
import { createInfrastructureReadinessCheck } from "./runtime/readiness.js";
import { buildApiServer } from "./server.js";
import {
  DashboardRecoveryService,
  PostgresDashboardBusinessOutcomeReader,
  PostgresDashboardCompletionOutcomeReader,
  PostgresDashboardConsistencyLagReader,
  PostgresDashboardRecoveryContextReader,
} from "./services/dashboard-recovery-service.js";
import { DemoMaintenanceService } from "./services/demo-maintenance-service.js";
import { DemoRunFinalizationService } from "./services/demo-run-finalization-service.js";
import {
  DemoRunService,
  HttpTrafficExecutionGateway,
  RedisDashboardTrafficMetricStore,
  RedisPublicRunBudgetStore,
} from "./services/demo-run-service.js";
import { DemoRunStartupReconciliationService } from "./services/demo-run-startup-reconciliation-service.js";
import {
  ErpStatusService,
  PostgresErpAttemptStatusReader,
  RedisErpCircuitBreakerStateReader,
} from "./services/erp-status-service.js";
import { InventoryStatusService } from "./services/inventory-status-service.js";
import { PostgresBuyPersistence } from "./services/postgres-buy-persistence.js";
import { QueueStatusService } from "./services/queue-status-service.js";
import {
  type BusinessOutcomeUpdateFailureReport,
  type OrderEnqueueFailureReport,
  type ReservationPartialFailureReport,
  ReserveOrderService,
} from "./services/reserve-order-service.js";

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
export { PostgresBuyPersistence } from "./services/postgres-buy-persistence.js";
export { QueueStatusService } from "./services/queue-status-service.js";
export { ReserveOrderService } from "./services/reserve-order-service.js";

export async function startApiServer(): Promise<void> {
  const config = loadApiConfig(process.env);
  const logger = createServiceLogger({ service: "api" });
  const connection = createDatabaseConnection(config.databaseUrl, { max: config.postgresPoolMax });
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
  const dashboardEventFanout = new DashboardEventFanout({ logger });
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
          { err: error, messageLength: message.length },
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
  });
  const inventoryStatusService = new InventoryStatusService({
    getStatus: (saleOfferId) => getInventoryStatus(redis, saleOfferId),
  });
  const trafficMetricStore = new RedisDashboardTrafficMetricStore(redis);
  const demoMaintenanceService = new DemoMaintenanceService({
    db: connection.db,
    redis,
    queueMaintenance: demoQueueMaintenance,
    logger,
  });
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
  const demoRunFinalizationService = new DemoRunFinalizationService({
    db: connection.db,
    redis,
    logger,
  });
  const demoRunStartupReconciliationService = new DemoRunStartupReconciliationService({
    db: connection.db,
    redis,
    logger,
  });
  const demoRunService = new DemoRunService({
    db: connection.db,
    redis,
    trafficExecutionGateway: new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: config.loadOrchestratorBaseUrl,
      controlServiceToken: config.controlServiceToken,
    }),
    publicRunBudgetStore: new RedisPublicRunBudgetStore(redis),
    trafficMetricStore,
    businessOutcomeReader,
    finalizationService: demoRunFinalizationService,
    apiBaseUrl: config.apiBaseUrl,
    buyEndpointPath: "/buy",
    logger,
  });
  const reserveOrderService = new ReserveOrderService({
    persistence,
    orderProcessJobPublisher,
    stockReservations: {
      reserve: (input) => reserveInventoryStock(redis, input),
      markPendingPersistence: (input) => markReservationPendingPersistence(redis, input),
      promoteAccepted: (input) =>
        promoteReservationIdempotencyToAccepted(redis, input).then(() => undefined),
    },
    reservationHoldMinutes: config.reservationHoldMinutes,
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    pendingPersistenceRetryAfterSeconds: config.pendingPersistenceRetryAfterSeconds,
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
    publishBusinessOutcomeUpdate: async (input) => {
      await publishBusinessOutcomeDashboardUpdate(connection.db, redis, input);
    },
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
        closeDatabase: () => connection.close(),
      });
    })();
    return closePromise;
  };

  try {
    const startupReconciliation = await demoRunStartupReconciliationService.reconcile();
    if (
      startupReconciliation.interruptedRunCount > 0 ||
      startupReconciliation.recoverableDrainingRunCount > 0
    ) {
      logger.info(startupReconciliation, "API startup demo-run reconciliation completed.");
    }

    finalizationPoller = setInterval(() => {
      void demoRunFinalizationService.finalizeReadyRuns().catch((error: unknown) => {
        logger.error({ err: error }, "Demo run finalization poll failed.");
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
      erpStatusService,
      inventoryStatusService,
      queueStatusService,
      reserveOrderService,
      demoRunService,
      demoMaintenanceService,
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
