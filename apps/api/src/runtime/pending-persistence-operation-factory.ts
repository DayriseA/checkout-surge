import type { RunExecutionMode, SecuredReservationHold } from "@checkout-surge/contracts";
import {
  type AbortableDatabaseConnection,
  type CheckoutSurgeRedis,
  createAbortableDatabaseConnection,
  createRedisClient,
  deferPendingPersistenceRecord,
  demoRunSaleContexts,
  demoRuns,
  PostgresPendingPersistence,
  promoteReservationIdempotencyToAccepted,
  readPendingPersistencePage,
  readPendingPersistenceRecord,
} from "@checkout-surge/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  type BullMqOrderProcessJobPublisher,
  createBullMqOrderProcessJobPublisher,
} from "../queue/bullmq-order-process-job-publisher.js";
import type {
  PendingPersistenceAttemptScope,
  PendingPersistenceDiscoveryScope,
  PendingPersistenceRecoveryStorage,
} from "../services/pending-persistence-recovery-service.js";
import { PostgresBuyPersistence } from "../services/postgres-buy-persistence.js";
import {
  createOperationResourceCleanup,
  failAfterResourceConstruction,
  type ResourceCleanup,
  runWithResourceCleanup,
} from "./api-resource-cleanup.js";
import { createPostgresPendingPersistenceAttempt } from "./postgres-pending-persistence-attempt.js";

export interface PendingPersistenceOperationConfig {
  databaseUrl: string;
  redisUrl: string;
  discoveryTimeoutMs: number;
}

export interface PendingPersistenceRunScope {
  runId: string;
  saleOfferId: string;
  executionMode: RunExecutionMode;
}

export interface PendingPersistenceRecoveryOperations {
  storage: PendingPersistenceRecoveryStorage;
  openDiscoveryScope(signal: AbortSignal): Promise<PendingPersistenceDiscoveryScope>;
  listRunScopes(signal: AbortSignal): Promise<PendingPersistenceRunScope[]>;
  resolveRunScope(reservation: SecuredReservationHold): Promise<PendingPersistenceRunScope | null>;
  openAttemptScope(input: {
    executionMode?: RunExecutionMode;
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<PendingPersistenceAttemptScope>;
  close(): Promise<void>;
}

export interface PendingPersistenceInfrastructure {
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
  createPublisher(connection: {
    url: string;
    maxRetriesPerRequest: number;
    commandTimeout: number;
  }): BullMqOrderProcessJobPublisher;
}

const pendingPersistenceInfrastructure: PendingPersistenceInfrastructure = {
  createDatabase: createAbortableDatabaseConnection,
  createRedis: createRedisClient,
  createPublisher: createBullMqOrderProcessJobPublisher,
};

export function createPendingPersistenceRecoveryOperations(
  config: PendingPersistenceOperationConfig,
  infrastructure: PendingPersistenceInfrastructure = pendingPersistenceInfrastructure,
): PendingPersistenceRecoveryOperations {
  const redis = infrastructure.createRedis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    commandTimeout: config.discoveryTimeoutMs,
  });
  let closePromise: Promise<void> | undefined;

  const withPostgres = async <T>(
    operation: (database: AbortableDatabaseConnection) => Promise<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> => {
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, AbortSignal.timeout(config.discoveryTimeoutMs)])
      : AbortSignal.timeout(config.discoveryTimeoutMs);
    const database = infrastructure.createDatabase(config.databaseUrl, signal, {
      max: 1,
      connect_timeout: Math.ceil(config.discoveryTimeoutMs / 1_000),
    });
    const close = createOperationResourceCleanup({
      signal,
      operations: [() => database.close()],
      failureMessage: "Pending-persistence storage database cleanup failed.",
    });
    return runWithResourceCleanup(
      () => operation(database),
      close,
      "Pending-persistence storage operation and cleanup failed.",
    );
  };
  const modeStorage = (
    client: CheckoutSurgeRedis,
    signal?: AbortSignal,
  ): PendingPersistenceRecoveryStorage => {
    const demo = createRedisPendingPersistenceStorage(client);
    return {
      readPage: (input) =>
        input.executionMode === "without_redis"
          ? withPostgres(
              (database) => new PostgresPendingPersistence(database.sql).readPage(input),
              signal,
            )
          : demo.readPage(input),
      readRecord: (input) =>
        input.executionMode === "without_redis"
          ? withPostgres(
              (database) => new PostgresPendingPersistence(database.sql).readRecord(input),
              signal,
            )
          : demo.readRecord(input),
      defer: (input) =>
        input.executionMode === "without_redis"
          ? withPostgres(
              (database) => new PostgresPendingPersistence(database.sql).defer(input),
              signal,
            )
          : demo.defer(input),
    };
  };

  return {
    storage: modeStorage(redis),
    resolveRunScope: (reservation) =>
      withPostgres(async (database) => {
        const [owner] = await database.db
          .select({
            runId: demoRuns.id,
            saleOfferId: demoRunSaleContexts.saleOfferId,
            executionMode: demoRuns.executionMode,
          })
          .from(demoRuns)
          .innerJoin(
            demoRunSaleContexts,
            and(
              eq(demoRunSaleContexts.runId, demoRuns.id),
              eq(demoRunSaleContexts.saleOfferId, demoRuns.saleOfferId),
            ),
          )
          .where(
            and(
              eq(demoRuns.id, reservation.runId),
              eq(demoRunSaleContexts.saleOfferId, reservation.saleOfferId),
            ),
          )
          .limit(1);
        return owner ?? null;
      }),
    openDiscoveryScope: async (signal) => {
      const operationRedis = infrastructure.createRedis(config.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        commandTimeout: config.discoveryTimeoutMs,
      });
      return {
        storage: modeStorage(operationRedis, signal),
        close: createOperationResourceCleanup({
          signal,
          operations: [() => operationRedis.disconnect()],
          failureMessage: "Pending-persistence discovery Redis cleanup failed.",
        }),
      };
    },
    listRunScopes: async (signal) => {
      const database = infrastructure.createDatabase(config.databaseUrl, signal, {
        max: 1,
        connect_timeout: Math.ceil(config.discoveryTimeoutMs / 1_000),
      });
      const close = createOperationResourceCleanup({
        signal,
        operations: [() => database.close()],
        failureMessage: "Pending-persistence discovery database cleanup failed.",
      });
      return await runWithResourceCleanup(
        async () => {
          const runRows = await database.db
            .select({
              runId: demoRuns.id,
              saleOfferId: demoRuns.saleOfferId,
              executionMode: demoRuns.executionMode,
            })
            .from(demoRuns)
            .where(inArray(demoRuns.status, ["starting", "active", "draining"]));
          return runRows.flatMap((row) =>
            row.saleOfferId
              ? [
                  {
                    runId: row.runId,
                    saleOfferId: row.saleOfferId,
                    executionMode: row.executionMode,
                  },
                ]
              : [],
          );
        },
        close,
        "Pending-persistence discovery query and cleanup failed.",
      );
    },
    openAttemptScope: async ({ executionMode, signal, timeoutMs }) => {
      let database: AbortableDatabaseConnection | undefined;
      let operationRedis: CheckoutSurgeRedis | undefined;
      let publisher: BullMqOrderProcessJobPublisher | undefined;
      const acquiredCleanup: ResourceCleanup[] = [];

      try {
        database = infrastructure.createDatabase(config.databaseUrl, signal, {
          max: 1,
          connect_timeout: Math.ceil(timeoutMs / 1_000),
        });
        acquiredCleanup.push(() => database?.close());
        if (executionMode === "without_redis") {
          return createPostgresPendingPersistenceAttempt({
            database,
            signal,
            close: createOperationResourceCleanup({
              signal,
              operations: acquiredCleanup,
              failureMessage: "Pending-persistence attempt resource cleanup failed.",
            }),
          });
        }

        operationRedis = infrastructure.createRedis(config.redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 0,
          commandTimeout: timeoutMs,
        });
        acquiredCleanup.push(() => operationRedis?.disconnect());

        publisher = infrastructure.createPublisher({
          url: config.redisUrl,
          maxRetriesPerRequest: 0,
          commandTimeout: timeoutMs,
        });
        acquiredCleanup.push(() => publisher?.abort());
      } catch (constructionError) {
        await failAfterResourceConstruction(
          constructionError,
          acquiredCleanup,
          "Pending-persistence attempt resource construction and cleanup failed.",
        );
      }

      const operationDatabase = requireResource(database, "pending-persistence database");
      const attemptRedis = requireResource(operationRedis, "pending-persistence Redis client");
      const attemptPublisher = requireResource(publisher, "pending-persistence publisher");
      const persistence = new PostgresBuyPersistence(operationDatabase.db, signal);
      return {
        persistence,
        audit: {
          recordAttempt: (input) => persistence.recordPendingPersistenceAttempt(input),
          markResolved: (input) => persistence.markPendingPersistenceResolved(input),
          markExhausted: (input) => persistence.markPendingPersistenceExhausted(input),
        },
        stockReservations: {
          promoteAccepted: (input) =>
            promoteReservationIdempotencyToAccepted(attemptRedis, input).then(() => undefined),
        },
        orderProcessJobPublisher: attemptPublisher,
        close: createOperationResourceCleanup({
          signal,
          operations: acquiredCleanup,
          failureMessage: "Pending-persistence attempt resource cleanup failed.",
        }),
      };
    },
    close: () => {
      closePromise ??= Promise.resolve().then(() => redis.disconnect());
      return closePromise;
    },
  };
}

function requireResource<T>(resource: T | undefined, name: string): T {
  if (!resource) throw new Error(`Could not construct ${name}.`);
  return resource;
}

/** Demo composition adapter; service scheduling and retries share the same port. */
export function createRedisPendingPersistenceStorage(
  redis: CheckoutSurgeRedis,
): PendingPersistenceRecoveryStorage {
  return {
    readPage: (input) => readPendingPersistencePage(redis, input),
    readRecord: (input) => readPendingPersistenceRecord(redis, input),
    defer: (input) => deferPendingPersistenceRecord(redis, input),
  };
}
