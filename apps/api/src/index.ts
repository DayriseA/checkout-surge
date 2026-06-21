import { contractsPackageName } from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createRedisClient,
  dbPackageName,
  getInventoryStatus,
  isRunSaleEligible,
  markReservationPendingPersistence,
  promoteReservationIdempotencyToAccepted,
  reserveInventoryStock,
} from "@checkout-surge/db";
import { createServiceLogger, loggerPackageName } from "@checkout-surge/logger";
import { loadApiConfig } from "./runtime/config.js";
import { createInfrastructureReadinessCheck } from "./runtime/readiness.js";
import { buildApiServer } from "./server.js";
import { InventoryStatusService } from "./services/inventory-status-service.js";
import { PostgresBuyPersistence } from "./services/postgres-buy-persistence.js";
import {
  type ReservationPartialFailureReport,
  ReserveOrderService,
} from "./services/reserve-order-service.js";

export const apiAppName = "api" as const;
export const apiAppDependencies = [contractsPackageName, dbPackageName, loggerPackageName] as const;

export { type ApiConfig, loadApiConfig } from "./runtime/config.js";
export { buildApiServer } from "./server.js";
export { InventoryStatusService } from "./services/inventory-status-service.js";
export { PostgresBuyPersistence } from "./services/postgres-buy-persistence.js";
export { ReserveOrderService } from "./services/reserve-order-service.js";

export async function startApiServer(): Promise<void> {
  const config = loadApiConfig(process.env);
  const logger = createServiceLogger({ service: "api" });
  const connection = createDatabaseConnection(config.databaseUrl, { max: config.postgresPoolMax });
  const redis = createRedisClient(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });

  const persistence = new PostgresBuyPersistence(connection.db);
  const reserveOrderService = new ReserveOrderService({
    persistence,
    stockReservations: {
      isRunSaleEligible: (input) => isRunSaleEligible(redis, input),
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
  });

  const server = await buildApiServer({
    config,
    logger,
    readiness: createInfrastructureReadinessCheck(connection.sql, redis),
    inventoryStatusService: new InventoryStatusService({
      getStatus: (saleOfferId) => getInventoryStatus(redis, saleOfferId),
    }),
    reserveOrderService,
    startedAt: new Date(),
  });

  const close = async () => {
    logger.info("Closing API server.");
    await server.close();
    redis.disconnect();
    await connection.close();
  };

  process.once("SIGTERM", () => {
    void close().then(() => process.exit(0));
  });
  process.once("SIGINT", () => {
    void close().then(() => process.exit(0));
  });

  try {
    await server.listen({
      host: config.host,
      port: config.port,
      listenTextResolver: (address) => `API gateway listening at ${address}`,
      backlog: config.listenBacklog,
    });
  } catch (error) {
    logger.error({ err: error }, "API server failed to start.");
    redis.disconnect();
    await connection.close();
    process.exitCode = 1;
  }
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
