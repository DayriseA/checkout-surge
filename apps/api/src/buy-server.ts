import cluster from "node:cluster";
import { randomBytes } from "node:crypto";
import {
  BusinessOutcomePublicationScheduler,
  createDatabaseConnection,
  createRedisClient,
  publishDashboardProjectionDirtySignal,
} from "@checkout-surge/db";
import { createServiceLogger } from "@checkout-surge/logger";
import { createBullMqOrderProcessJobPublisher } from "./queue/bullmq-order-process-job-publisher.js";
import { createBullMqOrderProcessQueueInspector } from "./queue/bullmq-order-process-queue-inspector.js";
import { createBuyPath, createStockReservationGateway } from "./runtime/buy-path.js";
import { loadApiConfig } from "./runtime/config.js";
import { createApiReadiness } from "./runtime/readiness.js";
import { buildBuyServer } from "./server.js";
import { DashboardSourceDirtyScheduler } from "./services/dashboard-source-dirty-scheduler.js";
import { PostgresBuyPersistence } from "./services/postgres-buy-persistence.js";
import { QueueStatusService } from "./services/queue-status-service.js";
import {
  RedisReservationTimingStore,
  ReservationTimingObservationScheduler,
} from "./services/reservation-timing-observation.js";

/**
 * Buy-only API processes, for the Redis comparison's runs: a cluster primary forks
 * `API_BUY_PROCESSES` workers that share one port, each with its own pools of the same size as
 * the control API's. They own no run: starts, resets, finalization and pending-persistence
 * recovery stay in the control process (HD-11).
 */
export async function startBuyServer(): Promise<void> {
  // The buy routes use neither the control token nor the cookie secret: the container is not
  // given them, and throwaway values satisfy the shared configuration.
  const unusedSecret = randomBytes(32).toString("hex");
  const config = loadApiConfig({
    ...process.env,
    CONTROL_SERVICE_TOKEN: unusedSecret,
    PUBLIC_CLIENT_COOKIE_SECRET: unusedSecret,
  });
  const logger = createServiceLogger({ service: "api" }).child({ process: "buy-only" });
  const connection = createDatabaseConnection(config.databaseUrl, { max: config.postgresPoolMax });
  const redis = createRedisClient(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
  const redisConnection = { url: config.redisUrl, maxRetriesPerRequest: 3 };
  const orderProcessJobPublisher = createBullMqOrderProcessJobPublisher(redisConnection);
  const queueInspector = createBullMqOrderProcessQueueInspector(redisConnection);
  const queueStatusService = new QueueStatusService(queueInspector, logger);
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
    onError: (error) =>
      logger.error({ err: error }, "Dashboard business outcome projection failed."),
    onDrop: () => logger.warn("Business outcome dashboard scope limit reached."),
  });
  const reservationTiming = new ReservationTimingObservationScheduler(
    new RedisReservationTimingStore(redis),
    logger,
  );
  const persistence = new PostgresBuyPersistence(connection.db);
  const buyPath = createBuyPath({
    config,
    logger,
    db: connection.db,
    sql: connection.sql,
    redis,
    persistence,
    stockReservations: createStockReservationGateway(redis),
    orderProcessJobPublisher,
    // A pending answer is resolved by the control process's recovery scheduler.
    pendingPersistenceRecovery: { recoverReservation: async () => null },
    dashboardSourceDirtyScheduler,
    businessOutcomePublications,
    reservationTiming,
  });
  const readiness = createApiReadiness({
    databaseUrl: config.databaseUrl,
    redisUrl: config.redisUrl,
    timeoutMs: config.readinessTimeoutMs,
  });
  const server = await buildBuyServer({ config, logger, readiness, ...buyPath });

  const close = async () => {
    buyPath.confirmationWaiter.close();
    await server.close();
    await Promise.allSettled([
      buyPath.inventoryCounts.close(),
      dashboardSourceDirtyScheduler.close(),
      reservationTiming.close(),
      businessOutcomePublications.close(),
    ]);
    await Promise.allSettled([
      orderProcessJobPublisher.close(),
      queueInspector.close(),
      readiness.close(),
      connection.close(),
    ]);
    redis.disconnect();
  };
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));

  await server.listen({ host: config.host, port: config.port, backlog: config.listenBacklog });
}

function startPrimary(): void {
  const processes = Number(process.env.API_BUY_PROCESSES ?? "2");
  if (!Number.isSafeInteger(processes) || processes < 1) {
    throw new Error("API_BUY_PROCESSES must be a positive integer.");
  }
  const logger = createServiceLogger({ service: "api" }).child({ process: "buy-only-primary" });
  let stopping = false;
  for (let index = 0; index < processes; index += 1) cluster.fork();
  cluster.on("exit", (worker, code, signal) => {
    if (stopping) return;
    logger.error(
      { pid: worker.process.pid, code, signal },
      "A buy-only process exited; starting another in 1 s.",
    );
    // A delay, so that a process failing at startup cannot spin a fork loop.
    setTimeout(() => {
      if (!stopping) cluster.fork();
    }, 1_000);
  });
  const stop = () => {
    stopping = true;
    for (const worker of Object.values(cluster.workers ?? {})) worker?.kill("SIGTERM");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.env.NODE_ENV !== "test" && import.meta.url === `file://${process.argv[1]}`) {
  if (cluster.isPrimary) startPrimary();
  else void startBuyServer();
}
