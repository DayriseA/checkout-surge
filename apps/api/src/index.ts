import { contractsPackageName } from "@checkout-surge/contracts";
import { createDatabaseConnection, dbPackageName } from "@checkout-surge/db";
import { createServiceLogger, loggerPackageName } from "@checkout-surge/logger";
import { loadApiConfig } from "./runtime/config.js";
import { createDatabaseReadinessCheck } from "./runtime/readiness.js";
import { buildApiServer } from "./server.js";
import { PostgresBuyPersistence } from "./services/postgres-buy-persistence.js";
import { ReserveOrderService } from "./services/reserve-order-service.js";

export const apiAppName = "api" as const;
export const apiAppDependencies = [contractsPackageName, dbPackageName, loggerPackageName] as const;

export { type ApiConfig, loadApiConfig } from "./runtime/config.js";
export { buildApiServer } from "./server.js";
export { PostgresBuyPersistence } from "./services/postgres-buy-persistence.js";
export { ReserveOrderService } from "./services/reserve-order-service.js";

export async function startApiServer(): Promise<void> {
  const config = loadApiConfig(process.env);
  const logger = createServiceLogger({ service: "api" });
  const connection = createDatabaseConnection(config.databaseUrl, { max: config.postgresPoolMax });
  const persistence = new PostgresBuyPersistence(connection.db);
  const reserveOrderService = new ReserveOrderService({
    persistence,
    reservationHoldMinutes: config.reservationHoldMinutes,
  });

  const server = await buildApiServer({
    config,
    logger,
    readiness: createDatabaseReadinessCheck(connection.sql, config.redisUrl),
    reserveOrderService,
    startedAt: new Date(),
  });

  const close = async () => {
    logger.info("Closing API server.");
    await server.close();
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
    await connection.close();
    process.exitCode = 1;
  }
}

if (process.env.NODE_ENV !== "test" && import.meta.url === `file://${process.argv[1]}`) {
  void startApiServer();
}
