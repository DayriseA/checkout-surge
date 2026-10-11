import { randomUUID } from "node:crypto";
import {
  BusinessOutcomePublicationScheduler,
  createDatabaseConnection,
  createRedisClient,
  markReservationPendingPersistence,
  promoteReservationIdempotencyToAccepted,
  publishDashboardProjectionDirtySignal,
  reserveInventoryStock,
  reverseReservation,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { createServiceLogger } from "@checkout-surge/logger";
import { createBullMqOrderProcessJobPublisher } from "../queue/bullmq-order-process-job-publisher.js";
import { createBullMqOrderProcessQueueInspector } from "../queue/bullmq-order-process-queue-inspector.js";
import { registerBuyerTimingFlushRoute } from "../routes/api-peer-routes.js";
import { registerBuyRoutes } from "../routes/buy-routes.js";
import { registerHealthRoutes } from "../routes/health-routes.js";
import {
  ActiveBuyingRunContext,
  PostgresBuyingRunContextReader,
} from "../services/active-buying-run-context.js";
import { BuyerRequestDrain } from "../services/buyer-request-drain.js";
import { prepareBuyerRun } from "../services/buyer-run-preparation.js";
import { DashboardSourceDirtyScheduler } from "../services/dashboard-source-dirty-scheduler.js";
import { HttpPendingPersistenceRecovery } from "../services/http-pending-persistence-recovery.js";
import { PostgresBuyPersistence } from "../services/postgres-buy-persistence.js";
import { QueueStatusService } from "../services/queue-status-service.js";
import {
  RedisReservationTimingStore,
  ReservationTimingObservationScheduler,
} from "../services/reservation-timing-observation.js";
import type { ReserveOrderService } from "../services/reserve-order-service.js";
import { buildApiHttpServer } from "./api-http-server.js";
import { closeResources } from "./api-resource-cleanup.js";
import type { ApiConfig } from "./config.js";
import { createPostgresReserveOrderService } from "./create-postgres-reserve-order-service.js";
import { createReserveOrderService } from "./create-reserve-order-service.js";
import type { ApiFastifyInstance } from "./fastify.js";
import { warnWhenListenBacklogIsCapped } from "./listen-backlog-ceiling.js";
import type { ApiReadiness } from "./readiness.js";
import { createApiReadiness } from "./readiness.js";

export async function buildBuyerApiServer(options: {
  config: ApiConfig;
  logger: CheckoutSurgeLogger;
  readiness: ApiReadiness;
  reserveOrderService: Pick<ReserveOrderService, "reserve">;
  flush(runId: string): Promise<{ bootId: string; mergeFailureGeneration: number }>;
  prepare?(runId: string): Promise<{
    bootId: string;
    mergeFailureGeneration: number;
    activatedRunId: string;
    timingAvailable: boolean;
  }>;
}): Promise<ApiFastifyInstance> {
  const server = await buildApiHttpServer(options);
  registerHealthRoutes(server, { readiness: options.readiness, startedAt: new Date() });
  registerBuyRoutes(server, { reserveOrderService: options.reserveOrderService });
  registerBuyerTimingFlushRoute(server, {
    controlServiceToken: options.config.controlServiceToken,
    flush: options.flush,
    ...(options.prepare ? { prepare: options.prepare } : {}),
  });
  return server;
}

/** Buyer composition has no maintenance clients, runner control, pollers, or dashboard fanout. */
export async function startBuyerApiServer(config: ApiConfig): Promise<void> {
  if (!config.controlBaseUrl) throw new Error("Buyer API requires a control origin.");
  const logger = createServiceLogger({ service: "api" }).child({ role: "buyer" });
  const bootId = randomUUID();
  const connection = createDatabaseConnection(config.databaseUrl, { max: config.postgresPoolMax });
  const redis = createRedisClient(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
  const publisher = createBullMqOrderProcessJobPublisher({
    url: config.redisUrl,
    maxRetriesPerRequest: 3,
  });
  const inspector = createBullMqOrderProcessQueueInspector({
    url: config.redisUrl,
    maxRetriesPerRequest: 3,
  });
  const queueStatus = new QueueStatusService(inspector, logger);
  const sourceDirty = new DashboardSourceDirtyScheduler({
    readQueue: () => queueStatus.getStatus(),
    publish: (signal) => publishDashboardProjectionDirtySignal(redis, signal),
    logger,
  });
  const businessOutcomes = new BusinessOutcomePublicationScheduler({
    publish: (input) =>
      publishDashboardProjectionDirtySignal(redis, {
        type: "dashboard.projection.dirty",
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      }),
    onError: (error, input) =>
      logger.error({ err: error, ...input }, "Buyer dashboard dirty publication failed."),
    onDrop: (input) => logger.warn(input, "Buyer dashboard dirty scope dropped."),
  });
  const timing = new ReservationTimingObservationScheduler(
    new RedisReservationTimingStore(redis),
    logger,
  );
  const service = createReserveOrderService(
    {
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: {
        reserve: (input) => reserveInventoryStock(redis, input),
        markPendingPersistence: (input) => markReservationPendingPersistence(redis, input),
        promoteAccepted: (input) =>
          promoteReservationIdempotencyToAccepted(redis, input).then(() => undefined),
        reverse: (input) => reverseReservation(redis, input),
      },
      orderProcessJobPublisher: publisher,
      pendingPersistenceRecovery: new HttpPendingPersistenceRecovery({
        baseUrl: config.controlBaseUrl,
        controlServiceToken: config.controlServiceToken,
      }),
      reservationHoldMinutes: config.reservationHoldMinutes,
      idempotencyTtlSeconds: config.idempotencyTtlSeconds,
      pendingPersistenceRetryAfterSeconds: config.pendingPersistenceRetryAfterSeconds,
      dashboardSourceDirtyScheduler: sourceDirty,
      soldOutObservations: sourceDirty,
      reservationTimingObservations: timing,
      publishBusinessOutcomeUpdate: async (input) => businessOutcomes.markDirty(input),
    },
    logger,
  );
  const context = new ActiveBuyingRunContext({
    reader: new PostgresBuyingRunContextReader(connection.db),
    services: {
      demo: service,
      without_redis: createPostgresReserveOrderService(
        connection,
        {
          pendingPersistenceRecovery: new HttpPendingPersistenceRecovery({
            baseUrl: config.controlBaseUrl,
            controlServiceToken: config.controlServiceToken,
          }),
          reservationHoldMinutes: config.reservationHoldMinutes,
          idempotencyTtlSeconds: config.idempotencyTtlSeconds,
          pendingPersistenceRetryAfterSeconds: config.pendingPersistenceRetryAfterSeconds,
          dashboardSourceDirtyScheduler: sourceDirty,
          reservationTimingObservations: timing,
          publishBusinessOutcomeUpdate: async (input) => businessOutcomes.markDirty(input),
        },
        logger,
      ),
    },
  });
  const requests = new BuyerRequestDrain(context);
  const flush = async (runId: string) => {
    await requests.drain(runId);
    return { bootId, mergeFailureGeneration: await timing.flushAndReadFailureGeneration() };
  };
  const readiness = createApiReadiness({
    databaseUrl: config.databaseUrl,
    redisUrl: config.redisUrl,
    timeoutMs: config.readinessTimeoutMs,
  });
  let server: ApiFastifyInstance | undefined;
  let closePromise: Promise<void> | undefined;
  const close = () => {
    closePromise ??= (async () => {
      const errors: unknown[] = [];
      const phases = [
        [
          () => readiness.close(),
          async () => {
            await server?.close();
          },
        ],
        [() => sourceDirty.close(), () => businessOutcomes.close(), () => timing.close()],
        [
          () => publisher.close(),
          () => inspector.close(),
          () => redis.disconnect(),
          () => connection.close(),
        ],
      ];
      for (const phase of phases) {
        try {
          await closeResources(phase, "Buyer resource cleanup failed.");
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "Buyer API shutdown failed.");
    })();
    return closePromise;
  };
  try {
    await context.hydrate();
    server = await buildBuyerApiServer({
      config,
      logger,
      readiness,
      reserveOrderService: requests,
      flush,
      prepare: (runId) => prepareBuyerRun({ context, runId, bootId, flush }),
    });
    const shutdown = () => {
      void close()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          logger.error({ err: error }, "Buyer API shutdown failed.");
          process.exit(1);
        });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    await warnWhenListenBacklogIsCapped({ requestedBacklog: config.listenBacklog, logger });
    await server.listen({ host: config.host, port: config.port, backlog: config.listenBacklog });
  } catch (error) {
    process.exitCode = 1;
    logger.error({ err: error }, "Buyer API failed to start.");
    await close();
  }
}
