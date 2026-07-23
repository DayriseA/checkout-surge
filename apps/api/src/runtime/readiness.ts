import type { ReadinessCheck } from "@checkout-surge/contracts";
import {
  type AbortableDatabaseConnection,
  type CheckoutSurgeRedis,
  createAbortableDatabaseConnection,
  createRedisClient,
} from "@checkout-surge/db";
import { createReadinessCheck } from "@checkout-surge/logger";
import {
  type BullMqOrderProcessQueueInspector,
  createBullMqOrderProcessQueueInspector,
} from "../queue/bullmq-order-process-queue-inspector.js";
import { createOperationResourceCleanup, runWithResourceCleanup } from "./api-resource-cleanup.js";
import { OperationDeadlineExceededError, settleWithAbort } from "./operation-lifecycle.js";

const databaseCheckName = "database_reachable";
const redisCheckName = "redis_reachable";
const orderQueueCheckName = "order_process_queue_reachable";
const readinessCheckNames = [databaseCheckName, redisCheckName, orderQueueCheckName] as const;

export interface ApiReadiness {
  checks(): Promise<ReadinessCheck[]>;
  close(): Promise<void>;
}

export interface ApiReadinessConfig {
  databaseUrl: string;
  redisUrl: string;
  timeoutMs: number;
}

interface ReadinessDatabase {
  checkConnectivity(): Promise<void>;
  close(): Promise<void>;
}

interface ReadinessRedis {
  checkConnectivity(): Promise<void>;
  disconnect(): void;
}

interface ReadinessQueue {
  checkConnectivity(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ApiReadinessInfrastructure {
  createDatabase(input: {
    databaseUrl: string;
    signal: AbortSignal;
    max: number;
    connectTimeoutSeconds: number;
  }): ReadinessDatabase;
  createRedis(input: { redisUrl: string; commandTimeoutMs: number }): ReadinessRedis;
  createQueue(input: { redisUrl: string; commandTimeoutMs: number }): ReadinessQueue;
}

interface ReadinessDependency {
  name: (typeof readinessCheckNames)[number];
  failureMessage: string;
  check(signal: AbortSignal): Promise<void>;
}

interface ActiveReadinessOperation {
  controller: AbortController;
  result: Promise<ReadinessCheck[]>;
}

class ApiReadinessShutdownError extends Error {
  constructor() {
    super("API readiness is shutting down.");
    this.name = "ApiReadinessShutdownError";
  }
}

const defaultInfrastructure: ApiReadinessInfrastructure = {
  createDatabase: ({ databaseUrl, signal, max, connectTimeoutSeconds }) =>
    createReadinessDatabase(
      createAbortableDatabaseConnection(databaseUrl, signal, {
        max,
        connect_timeout: connectTimeoutSeconds,
      }),
    ),
  createRedis: ({ redisUrl, commandTimeoutMs }) =>
    createReadinessRedis(
      createRedisClient(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        commandTimeout: commandTimeoutMs,
      }),
    ),
  createQueue: ({ redisUrl, commandTimeoutMs }) =>
    createReadinessQueue(
      createBullMqOrderProcessQueueInspector({
        url: redisUrl,
        maxRetriesPerRequest: 0,
        commandTimeout: commandTimeoutMs,
      }),
    ),
};

export function createApiReadiness(
  config: ApiReadinessConfig,
  infrastructure: ApiReadinessInfrastructure = defaultInfrastructure,
): ApiReadiness {
  const dependencies = createDependencies(config, infrastructure);
  let activeOperation: ActiveReadinessOperation | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const startOperation = (): ActiveReadinessOperation => {
    const controller = new AbortController();
    const operation: ActiveReadinessOperation = {
      controller,
      result: runChecks(dependencies, controller, config.timeoutMs),
    };
    activeOperation = operation;
    void operation.result.finally(() => {
      if (activeOperation === operation) activeOperation = undefined;
    });
    return operation;
  };

  return {
    checks: async () => {
      if (closed) return unavailableChecks("API readiness is shutting down.");
      const operation = activeOperation ?? startOperation();
      return cloneChecks(await operation.result);
    },
    close: () => {
      if (!closePromise) {
        closed = true;
        const operation = activeOperation;
        if (operation && !operation.controller.signal.aborted) {
          operation.controller.abort(new ApiReadinessShutdownError());
        }
        closePromise = operation ? operation.result.then(() => undefined) : Promise.resolve();
      }
      return closePromise;
    },
  };
}

function createDependencies(
  config: ApiReadinessConfig,
  infrastructure: ApiReadinessInfrastructure,
): ReadinessDependency[] {
  return [
    {
      name: databaseCheckName,
      failureMessage: "PostgreSQL readiness check failed.",
      check: async (signal) => {
        const database = infrastructure.createDatabase({
          databaseUrl: config.databaseUrl,
          signal,
          max: 1,
          connectTimeoutSeconds: Math.ceil(config.timeoutMs / 1_000),
        });
        await runOwnedCheck(
          signal,
          () => database.checkConnectivity(),
          () => database.close(),
          "PostgreSQL readiness resource cleanup failed.",
        );
      },
    },
    {
      name: redisCheckName,
      failureMessage: "Redis readiness check failed.",
      check: async (signal) => {
        const redis = infrastructure.createRedis({
          redisUrl: config.redisUrl,
          commandTimeoutMs: config.timeoutMs,
        });
        await runOwnedCheck(
          signal,
          () => redis.checkConnectivity(),
          () => redis.disconnect(),
          "Redis readiness resource cleanup failed.",
        );
      },
    },
    {
      name: orderQueueCheckName,
      failureMessage: "Order-process queue readiness check failed.",
      check: async (signal) => {
        const queue = infrastructure.createQueue({
          redisUrl: config.redisUrl,
          commandTimeoutMs: config.timeoutMs,
        });
        await runOwnedCheck(
          signal,
          () => queue.checkConnectivity(),
          () => queue.disconnect(),
          "Order-process queue readiness resource cleanup failed.",
        );
      },
    },
  ];
}

async function runChecks(
  dependencies: readonly ReadinessDependency[],
  controller: AbortController,
  timeoutMs: number,
): Promise<ReadinessCheck[]> {
  const deadline = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new OperationDeadlineExceededError(timeoutMs));
    }
  }, timeoutMs);
  deadline.unref();

  try {
    return await Promise.all(
      dependencies.map(async (dependency) => {
        try {
          await dependency.check(controller.signal);
          return createReadinessCheck({ name: dependency.name, status: "ok" });
        } catch {
          return createReadinessCheck({
            name: dependency.name,
            status: "unavailable",
            message:
              controller.signal.reason instanceof OperationDeadlineExceededError
                ? `Check exceeded the ${timeoutMs}ms readiness deadline.`
                : controller.signal.reason instanceof ApiReadinessShutdownError
                  ? controller.signal.reason.message
                  : dependency.failureMessage,
          });
        }
      }),
    );
  } finally {
    clearTimeout(deadline);
  }
}

async function runOwnedCheck(
  signal: AbortSignal,
  check: () => Promise<void>,
  closeResource: () => void | Promise<void>,
  cleanupFailureMessage: string,
): Promise<void> {
  const close = createOperationResourceCleanup({
    signal,
    operations: [closeResource],
    failureMessage: cleanupFailureMessage,
  });
  await runWithResourceCleanup(
    () => settleWithAbort(check(), signal),
    close,
    cleanupFailureMessage,
  );
}

function createReadinessDatabase(connection: AbortableDatabaseConnection): ReadinessDatabase {
  return {
    checkConnectivity: async () => {
      await connection.sql`SELECT 1`;
    },
    close: () => connection.close(),
  };
}

function createReadinessRedis(redis: CheckoutSurgeRedis): ReadinessRedis {
  return {
    checkConnectivity: async () => {
      await redis.ping();
    },
    disconnect: () => redis.disconnect(),
  };
}

function createReadinessQueue(queue: BullMqOrderProcessQueueInspector): ReadinessQueue {
  return {
    checkConnectivity: () => queue.checkConnectivity(),
    disconnect: () => queue.disconnect(),
  };
}

function unavailableChecks(message: string): ReadinessCheck[] {
  return readinessCheckNames.map((name) =>
    createReadinessCheck({ name, status: "unavailable", message }),
  );
}

function cloneChecks(checks: readonly ReadinessCheck[]): ReadinessCheck[] {
  return checks.map((check) => ({ ...check }));
}
