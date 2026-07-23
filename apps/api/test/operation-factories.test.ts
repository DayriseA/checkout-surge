import type {
  AbortableDatabaseConnection,
  CheckoutSurgeDatabase,
  CheckoutSurgeRedis,
} from "@checkout-surge/db";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import type { BullMqOrderProcessJobPublisher } from "../src/queue/bullmq-order-process-job-publisher.js";
import type { BullMqOrderProcessQueueInspector } from "../src/queue/bullmq-order-process-queue-inspector.js";
import {
  createDashboardRecoveryOperationFactory,
  type DashboardRecoveryInfrastructure,
} from "../src/runtime/dashboard-recovery-operation-factory.js";
import { OperationDeadlineExceededError } from "../src/runtime/operation-lifecycle.js";
import {
  createPendingPersistenceRecoveryOperations,
  type PendingPersistenceInfrastructure,
} from "../src/runtime/pending-persistence-operation-factory.js";
import {
  createTerminalInventoryReadOperation,
  type TerminalInventoryReadInfrastructure,
} from "../src/runtime/terminal-inventory-read-operation.js";

describe("dashboard recovery operation factory", () => {
  it("closes every acquired resource exactly once after success and repeated close", async () => {
    const harness = dashboardInfrastructure();
    const operation = await dashboardFactory(harness.infrastructure)(new AbortController().signal);

    await operation.close();
    await operation.close();

    expect(harness.closeDatabase).toHaveBeenCalledOnce();
    expect(harness.disconnectRedis).toHaveBeenCalledOnce();
    expect(harness.disconnectQueue).toHaveBeenCalledOnce();
  });

  it("uses the operation signal to release queued and active work on deadline abort", async () => {
    const harness = dashboardInfrastructure();
    const controller = new AbortController();
    const operation = await dashboardFactory(harness.infrastructure)(controller.signal);

    controller.abort(new OperationDeadlineExceededError(50));
    await operation.close();

    expect(harness.closeDatabase).toHaveBeenCalledOnce();
    expect(harness.disconnectRedis).toHaveBeenCalledOnce();
    expect(harness.disconnectQueue).toHaveBeenCalledOnce();
  });

  it("cleans partially constructed resources and keeps construction and cleanup failures", async () => {
    const constructionError = new Error("queue construction failed");
    const databaseCleanupError = new Error("database cleanup failed");
    const redisCleanupError = new Error("Redis cleanup failed");
    const harness = dashboardInfrastructure({
      closeDatabase: vi.fn().mockRejectedValue(databaseCleanupError),
      disconnectRedis: vi.fn(() => {
        throw redisCleanupError;
      }),
      createQueueInspector: vi.fn(() => {
        throw constructionError;
      }),
    });

    const opening = dashboardFactory(harness.infrastructure)(new AbortController().signal);

    await expect(opening).rejects.toMatchObject({
      errors: [constructionError, databaseCleanupError, redisCleanupError],
    });
    expect(harness.closeDatabase).toHaveBeenCalledOnce();
    expect(harness.disconnectRedis).toHaveBeenCalledOnce();
  });

  it("continues cleanup after failures and returns the same aggregate on repeated close", async () => {
    const databaseError = new Error("database cleanup failed");
    const redisError = new Error("Redis cleanup failed");
    const queueError = new Error("queue cleanup failed");
    const harness = dashboardInfrastructure({
      closeDatabase: vi.fn().mockRejectedValue(databaseError),
      disconnectRedis: vi.fn(() => {
        throw redisError;
      }),
      disconnectQueue: vi.fn().mockRejectedValue(queueError),
    });
    const operation = await dashboardFactory(harness.infrastructure)(new AbortController().signal);

    await expect(operation.close()).rejects.toMatchObject({
      errors: [databaseError, redisError, queueError],
    });
    await expect(operation.close()).rejects.toMatchObject({
      errors: [databaseError, redisError, queueError],
    });
    expect(harness.closeDatabase).toHaveBeenCalledOnce();
    expect(harness.disconnectRedis).toHaveBeenCalledOnce();
    expect(harness.disconnectQueue).toHaveBeenCalledOnce();
  });
});

describe("pending-persistence operation factory", () => {
  it("aborts and idempotently closes discovery and attempt resources", async () => {
    const rootDisconnect = vi.fn();
    const discoveryDisconnect = vi.fn();
    const attemptDisconnect = vi.fn();
    const closeDatabase = vi.fn(async () => undefined);
    const abortPublisher = vi.fn(async () => undefined);
    const redisClients = [
      redisClient(rootDisconnect),
      redisClient(discoveryDisconnect),
      redisClient(attemptDisconnect),
    ];
    const infrastructure: PendingPersistenceInfrastructure = {
      createRedis: vi.fn(() => requireNext(redisClients)),
      createDatabase: vi.fn(
        () =>
          ({
            db: {} as CheckoutSurgeDatabase,
            sql: {},
            abort: closeDatabase,
            close: closeDatabase,
          }) as unknown as AbortableDatabaseConnection,
      ),
      createPublisher: vi.fn(
        () =>
          ({
            enqueue: vi.fn(),
            abort: abortPublisher,
            close: vi.fn(),
          }) as BullMqOrderProcessJobPublisher,
      ),
    };
    const operations = createPendingPersistenceRecoveryOperations(
      pendingPersistenceConfig(),
      infrastructure,
    );
    const discoveryController = new AbortController();
    const discovery = await operations.openDiscoveryScope(discoveryController.signal);
    discoveryController.abort(new Error("discovery timed out"));
    await discovery.close();
    await discovery.close();
    const attemptController = new AbortController();
    const attempt = await operations.openAttemptScope({
      signal: attemptController.signal,
      timeoutMs: 100,
    });
    attemptController.abort(new Error("attempt timed out"));
    await attempt.close();
    await attempt.close();
    await operations.close();
    await operations.close();

    expect(discoveryDisconnect).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(attemptDisconnect).toHaveBeenCalledOnce();
    expect(abortPublisher).toHaveBeenCalledOnce();
    expect(rootDisconnect).toHaveBeenCalledOnce();
  });

  it("cleans database and Redis when publisher construction fails", async () => {
    const rootDisconnect = vi.fn();
    const attemptDisconnect = vi.fn();
    const closeDatabase = vi.fn(async () => undefined);
    const constructionError = new Error("publisher construction failed");
    const redisClients = [redisClient(rootDisconnect), redisClient(attemptDisconnect)];
    const infrastructure: PendingPersistenceInfrastructure = {
      createRedis: vi.fn(() => requireNext(redisClients)),
      createDatabase: vi.fn(
        () =>
          ({
            db: {} as CheckoutSurgeDatabase,
            sql: {},
            abort: closeDatabase,
            close: closeDatabase,
          }) as unknown as AbortableDatabaseConnection,
      ),
      createPublisher: vi.fn(() => {
        throw constructionError;
      }),
    };
    const operations = createPendingPersistenceRecoveryOperations(
      pendingPersistenceConfig(),
      infrastructure,
    );

    await expect(
      operations.openAttemptScope({
        signal: new AbortController().signal,
        timeoutMs: 100,
      }),
    ).rejects.toBe(constructionError);
    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(attemptDisconnect).toHaveBeenCalledOnce();
    expect(rootDisconnect).not.toHaveBeenCalled();
    await operations.close();
  });
});

describe("terminal inventory read operation", () => {
  it("disconnects its Redis client when the bounded in-fence read is aborted", async () => {
    const disconnect = vi.fn();
    const infrastructure: TerminalInventoryReadInfrastructure = {
      createRedis: vi.fn(() => redisClient(disconnect)),
      readInventory: vi.fn(async () => await new Promise<never>(() => undefined)),
    };
    const operation = createTerminalInventoryReadOperation(
      { redisUrl: "redis://operation.test", timeoutMs: 100 },
      infrastructure,
    );
    const controller = new AbortController();
    const reason = new OperationDeadlineExceededError(100);
    const read = operation.read({
      saleOfferId: "11111111-1111-4111-8111-111111111111",
      observedAt: new Date("2026-07-23T00:00:00.000Z"),
      signal: controller.signal,
    });

    controller.abort(reason);

    await expect(read).rejects.toBe(reason);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

function dashboardFactory(infrastructure: DashboardRecoveryInfrastructure) {
  return createDashboardRecoveryOperationFactory(
    {
      databaseUrl: "postgres://operation.test/database",
      redisUrl: "redis://operation.test",
      timeoutMs: 100,
      logger: createSilentLogger("api"),
    },
    infrastructure,
  );
}

function dashboardInfrastructure(
  overrides: {
    closeDatabase?: () => Promise<void>;
    disconnectRedis?: () => void;
    disconnectQueue?: () => Promise<void>;
    createQueueInspector?: DashboardRecoveryInfrastructure["createQueueInspector"];
  } = {},
) {
  const closeDatabase = overrides.closeDatabase ?? vi.fn(async () => undefined);
  const disconnectRedis = overrides.disconnectRedis ?? vi.fn();
  const disconnectQueue = overrides.disconnectQueue ?? vi.fn(async () => undefined);
  const queue = {
    inspect: vi.fn(),
    checkConnectivity: vi.fn(),
    close: vi.fn(),
    disconnect: disconnectQueue,
  } as BullMqOrderProcessQueueInspector;
  const infrastructure: DashboardRecoveryInfrastructure = {
    createDatabase: vi.fn(
      () =>
        ({
          db: {} as CheckoutSurgeDatabase,
          sql: {},
          abort: closeDatabase,
          close: closeDatabase,
        }) as unknown as AbortableDatabaseConnection,
    ),
    createRedis: vi.fn(() => redisClient(disconnectRedis)),
    createQueueInspector: overrides.createQueueInspector ?? vi.fn(() => queue),
  };
  return { infrastructure, closeDatabase, disconnectRedis, disconnectQueue };
}

function redisClient(disconnect: () => void): CheckoutSurgeRedis {
  return { disconnect } as unknown as CheckoutSurgeRedis;
}

function pendingPersistenceConfig() {
  return {
    databaseUrl: "postgres://operation.test/database",
    redisUrl: "redis://operation.test",
    discoveryTimeoutMs: 100,
    orderProcessMaxAttempts: 4,
    orderProcessBackoffBaseMs: 500,
  };
}

function requireNext<T>(values: T[]): T {
  const value = values.shift();
  if (!value) throw new Error("Missing fake resource.");
  return value;
}
