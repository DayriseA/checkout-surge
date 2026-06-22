import { contractsPackageName } from "@checkout-surge/contracts";
import { createDatabaseConnection, dbPackageName } from "@checkout-surge/db";
import { createServiceLogger, loggerPackageName } from "@checkout-surge/logger";
import { Redis } from "ioredis";
import {
  createLocalOrderConfirmation,
  createOrderProcessJobHandler,
} from "./application/order-process-job-handler.js";
import { PostgresOrderTransitionPersistence } from "./persistence/postgres-order-transition-persistence.js";
import { createBullMqOrderProcessConsumer } from "./queue/bullmq-order-process-consumer.js";
import { loadWorkerConfig } from "./runtime/config.js";
import { createWorkerReadiness } from "./runtime/readiness.js";
import { createWorkerRuntime } from "./runtime/worker-runtime.js";
import { buildWorkerHealthServer } from "./server.js";

export const workerAppName = "worker" as const;
export const workerAppDependencies = [
  contractsPackageName,
  dbPackageName,
  loggerPackageName,
] as const;

export {
  createLocalOrderConfirmation,
  createOrderProcessJobHandler,
  OrderFailurePersistenceError,
} from "./application/order-process-job-handler.js";
export {
  InvalidOrderTransitionError,
  OrderJobIdentityMismatchError,
  OrderNotFoundError,
  PostgresOrderTransitionPersistence,
} from "./persistence/postgres-order-transition-persistence.js";
export { createBullMqOrderProcessConsumer } from "./queue/bullmq-order-process-consumer.js";
export type { OrderProcessConsumer } from "./queue/order-process-consumer.js";
export { loadWorkerConfig, type WorkerConfig } from "./runtime/config.js";
export { createWorkerReadiness } from "./runtime/readiness.js";
export { createWorkerRuntime } from "./runtime/worker-runtime.js";
export { buildWorkerHealthServer } from "./server.js";

export async function startWorker(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const logger = createServiceLogger({ service: "worker" });
  const database = createDatabaseConnection(config.databaseUrl, { max: config.postgresPoolMax });
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  const orderProcessConsumer = createBullMqOrderProcessConsumer({
    connection: {
      url: config.redisUrl,
      maxRetriesPerRequest: null,
    },
    concurrency: config.orderProcessConcurrency,
    handler: createOrderProcessJobHandler({
      confirmation: createLocalOrderConfirmation(),
      persistence: new PostgresOrderTransitionPersistence(database.db),
      logger,
    }),
    logger,
  });
  const healthServer = buildWorkerHealthServer({
    logger,
    readiness: createWorkerReadiness({ postgres: database.sql, redis, orderProcessConsumer }),
    startedAt: new Date(),
  });
  const runtime = createWorkerRuntime({
    healthServer,
    healthHost: config.healthHost,
    healthPort: config.healthPort,
    orderProcessConsumer,
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

  process.once("SIGTERM", () => {
    void shutdown()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "Worker shutdown failed.");
        process.exit(1);
      });
  });
  process.once("SIGINT", () => {
    void shutdown()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "Worker shutdown failed.");
        process.exit(1);
      });
  });

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
