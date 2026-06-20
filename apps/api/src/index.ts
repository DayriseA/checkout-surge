import { contractsPackageName } from "@checkout-surge/contracts";
import {
  type CheckoutSurgeRedis,
  createDatabaseConnection,
  createRedisClient,
  dbPackageName,
  getInventoryStatus,
} from "@checkout-surge/db";
import { createServiceLogger, loggerPackageName } from "@checkout-surge/logger";
import { loadApiConfig } from "./runtime/config.js";
import { createDatabaseReadinessCheck } from "./runtime/readiness.js";
import { buildApiServer } from "./server.js";
import { InventoryStatusService } from "./services/inventory-status-service.js";
import { PostgresBuyPersistence } from "./services/postgres-buy-persistence.js";
import { ReserveOrderService } from "./services/reserve-order-service.js";

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
  let redis: CheckoutSurgeRedis | null = null;

  if (config.redisUrl) {
    redis = createRedisClient(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
  }

  const persistence = new PostgresBuyPersistence(connection.db);
  const reserveOrderService = new ReserveOrderService({
    persistence,
    reservationHoldMinutes: config.reservationHoldMinutes,
  });

  const server = await buildApiServer({
    config,
    logger,
    readiness: createDatabaseReadinessCheck(connection.sql, config.redisUrl),
    inventoryStatusService: new InventoryStatusService(
      redis ? { getStatus: (saleOfferId) => getInventoryStatus(redis, saleOfferId) } : null,
    ),
    reserveOrderService,
    startedAt: new Date(),
  });

  const close = async () => {
    logger.info("Closing API server.");
    await server.close();
    redis?.disconnect();
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
    redis?.disconnect();
    await connection.close();
    process.exitCode = 1;
  }
}

if (process.env.NODE_ENV !== "test" && import.meta.url === `file://${process.argv[1]}`) {
  void startApiServer();
}
