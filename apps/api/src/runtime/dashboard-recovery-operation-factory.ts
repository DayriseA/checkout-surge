import {
  type AbortableDatabaseConnection,
  type CheckoutSurgeRedis,
  createAbortableDatabaseConnection,
  createRedisClient,
  getInventoryStatus,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import {
  type BullMqOrderProcessQueueInspector,
  createBullMqOrderProcessQueueInspector,
} from "../queue/bullmq-order-process-queue-inspector.js";
import {
  type DashboardRecoveryOperation,
  type DashboardRecoveryOperationFactory,
  PostgresDashboardBusinessOutcomeReader,
  PostgresDashboardCompletionOutcomeReader,
  PostgresDashboardConsistencyLagReader,
  PostgresDashboardRecoveryContextReader,
  PostgresDashboardTransportObservationReader,
  RedisDashboardProjectionRevisionAllocator,
} from "../services/dashboard-recovery-service.js";
import { RedisDashboardTrafficMetricStore } from "../services/dashboard-traffic-metric-store.js";
import {
  PostgresErpAttemptStatusReader,
  RedisErpCircuitBreakerStateReader,
  RunErpOutcomeService,
  SharedErpProtectionService,
} from "../services/erp-status-service.js";
import { InventoryStatusService } from "../services/inventory-status-service.js";
import { QueueStatusService } from "../services/queue-status-service.js";
import {
  createOperationResourceCleanup,
  failAfterResourceConstruction,
  type ResourceCleanup,
} from "./api-resource-cleanup.js";

export interface DashboardRecoveryOperationConfig {
  databaseUrl: string;
  redisUrl: string;
  timeoutMs: number;
  logger: CheckoutSurgeLogger;
}

export interface DashboardRecoveryInfrastructure {
  createDatabase(
    databaseUrl: string,
    signal: AbortSignal,
    options: { max: number; connect_timeout: number },
  ): AbortableDatabaseConnection;
  createRedis(
    redisUrl: string,
    options: {
      lazyConnect: boolean;
      maxRetriesPerRequest: number;
      commandTimeout: number;
    },
  ): CheckoutSurgeRedis;
  createQueueInspector(options: {
    url: string;
    maxRetriesPerRequest: number;
    commandTimeout: number;
  }): BullMqOrderProcessQueueInspector;
}

const dashboardRecoveryInfrastructure: DashboardRecoveryInfrastructure = {
  createDatabase: createAbortableDatabaseConnection,
  createRedis: createRedisClient,
  createQueueInspector: createBullMqOrderProcessQueueInspector,
};

export function createDashboardRecoveryOperationFactory(
  config: DashboardRecoveryOperationConfig,
  infrastructure: DashboardRecoveryInfrastructure = dashboardRecoveryInfrastructure,
): DashboardRecoveryOperationFactory {
  return async (signal) => {
    let database: AbortableDatabaseConnection | undefined;
    let redis: CheckoutSurgeRedis | undefined;
    let queueInspector: BullMqOrderProcessQueueInspector | undefined;
    const acquiredCleanup: ResourceCleanup[] = [];

    try {
      database = infrastructure.createDatabase(config.databaseUrl, signal, {
        max: 1,
        connect_timeout: Math.ceil(config.timeoutMs / 1_000),
      });
      acquiredCleanup.push(() => database?.close());

      redis = infrastructure.createRedis(config.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        commandTimeout: config.timeoutMs,
      });
      acquiredCleanup.push(() => redis?.disconnect());

      queueInspector = infrastructure.createQueueInspector({
        url: config.redisUrl,
        maxRetriesPerRequest: 0,
        commandTimeout: config.timeoutMs,
      });
      acquiredCleanup.push(() => queueInspector?.disconnect());
    } catch (constructionError) {
      await failAfterResourceConstruction(
        constructionError,
        acquiredCleanup,
        "Dashboard recovery resource construction and cleanup failed.",
      );
    }

    const operationDatabase = requireResource(database, "dashboard recovery database");
    const operationRedis = requireResource(redis, "dashboard recovery Redis client");
    const operationQueueInspector = requireResource(
      queueInspector,
      "dashboard recovery queue inspector",
    );
    const queueStatusService = new QueueStatusService(operationQueueInspector, config.logger);
    const circuitBreakerStateReader = new RedisErpCircuitBreakerStateReader(operationRedis);
    const operation: DashboardRecoveryOperation = {
      dependencies: {
        contextReader: new PostgresDashboardRecoveryContextReader(operationDatabase.db),
        businessOutcomeReader: new PostgresDashboardBusinessOutcomeReader(operationDatabase.db),
        consistencyLagReader: new PostgresDashboardConsistencyLagReader(operationDatabase.db),
        completionOutcomeReader: new PostgresDashboardCompletionOutcomeReader(operationDatabase.db),
        inventoryStatusService: new InventoryStatusService({
          getStatus: (saleOfferId) => getInventoryStatus(operationRedis, saleOfferId),
        }),
        queueStatusService,
        sharedErpProtectionService: new SharedErpProtectionService({
          circuitBreakerStateReader,
          queueStatusService,
          logger: config.logger,
        }),
        runErpOutcomeService: new RunErpOutcomeService({
          circuitBreakerStateReader,
          attemptStatusReader: new PostgresErpAttemptStatusReader(operationDatabase.db),
          logger: config.logger,
        }),
        trafficMetricReader: new RedisDashboardTrafficMetricStore(operationRedis),
        transportObservationReader: new PostgresDashboardTransportObservationReader(
          operationDatabase.db,
        ),
        revisionAllocator: new RedisDashboardProjectionRevisionAllocator(operationRedis),
      },
      close: createOperationResourceCleanup({
        signal,
        operations: acquiredCleanup,
        failureMessage: "Dashboard recovery resource cleanup failed.",
      }),
    };
    return operation;
  };
}

function requireResource<T>(resource: T | undefined, name: string): T {
  if (!resource) throw new Error(`Could not construct ${name}.`);
  return resource;
}
