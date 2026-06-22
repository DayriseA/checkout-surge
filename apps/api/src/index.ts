import { contractsPackageName } from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createRedisClient,
  dbPackageName,
  getInventoryStatus,
  markReservationPendingPersistence,
  promoteReservationIdempotencyToAccepted,
  reserveInventoryStock,
} from "@checkout-surge/db";
import { createServiceLogger, loggerPackageName } from "@checkout-surge/logger";
import { createBullMqOrderProcessJobPublisher } from "./queue/bullmq-order-process-job-publisher.js";
import { createBullMqOrderProcessQueueInspector } from "./queue/bullmq-order-process-queue-inspector.js";
import { closeApiResources } from "./runtime/api-resource-cleanup.js";
import { loadApiConfig } from "./runtime/config.js";
import type { ApiFastifyInstance } from "./runtime/fastify.js";
import { createInfrastructureReadinessCheck } from "./runtime/readiness.js";
import { buildApiServer } from "./server.js";
import { InventoryStatusService } from "./services/inventory-status-service.js";
import { PostgresBuyPersistence } from "./services/postgres-buy-persistence.js";
import { QueueStatusService } from "./services/queue-status-service.js";
import {
  type OrderEnqueueFailureReport,
  type ReservationPartialFailureReport,
  ReserveOrderService,
} from "./services/reserve-order-service.js";

export const apiAppName = "api" as const;
export const apiAppDependencies = [contractsPackageName, dbPackageName, loggerPackageName] as const;

export { createBullMqOrderProcessJobPublisher } from "./queue/bullmq-order-process-job-publisher.js";
export { createBullMqOrderProcessQueueInspector } from "./queue/bullmq-order-process-queue-inspector.js";
export { type ApiConfig, loadApiConfig } from "./runtime/config.js";
export { buildApiServer } from "./server.js";
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
  const orderProcessJobPublisher = createBullMqOrderProcessJobPublisher({
    url: config.redisUrl,
    maxRetriesPerRequest: 3,
  });
  const orderProcessQueueInspector = createBullMqOrderProcessQueueInspector({
    url: config.redisUrl,
    maxRetriesPerRequest: 3,
  });

  const persistence = new PostgresBuyPersistence(connection.db);
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
  });

  let server: ApiFastifyInstance | null = null;
  let closePromise: Promise<void> | null = null;
  const close = () => {
    closePromise ??= (async () => {
      logger.info("Closing API server.");
      await closeApiResources({
        closeServer: async () => {
          await server?.close();
        },
        closeOrderProcessJobPublisher: () => orderProcessJobPublisher.close(),
        closeOrderProcessQueueInspector: () => orderProcessQueueInspector.close(),
        disconnectRedis: () => redis.disconnect(),
        closeDatabase: () => connection.close(),
      });
    })();
    return closePromise;
  };

  try {
    server = await buildApiServer({
      config,
      logger,
      readiness: createInfrastructureReadinessCheck(
        connection.sql,
        redis,
        orderProcessQueueInspector,
      ),
      inventoryStatusService: new InventoryStatusService({
        getStatus: (saleOfferId) => getInventoryStatus(redis, saleOfferId),
      }),
      queueStatusService: new QueueStatusService(orderProcessQueueInspector, logger),
      reserveOrderService,
      startedAt: new Date(),
    });

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

if (process.env.NODE_ENV !== "test" && import.meta.url === `file://${process.argv[1]}`) {
  void startApiServer();
}
