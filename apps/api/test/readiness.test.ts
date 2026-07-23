import { resetTestDatabase } from "@checkout-surge/db/testing";
import { describe, expect, it, vi } from "vitest";
import { type ApiReadinessInfrastructure, createApiReadiness } from "../src/runtime/readiness.js";

const config = {
  databaseUrl: "postgresql://readiness-user:secret@postgres.test/readiness",
  redisUrl: "redis://:secret@redis.test:6379",
  timeoutMs: 100,
};

describe("API runtime readiness", () => {
  it("checks the isolated PostgreSQL, Redis, and BullMQ resources through production adapters", async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    const redisUrl = process.env.TEST_REDIS_URL;
    if (!databaseUrl || !redisUrl) {
      throw new Error("TEST_DATABASE_URL and TEST_REDIS_URL are required.");
    }
    await resetTestDatabase({ databaseUrl });
    const readiness = createApiReadiness({
      databaseUrl,
      redisUrl,
      timeoutMs: 2_000,
    });

    try {
      await expect(readiness.checks()).resolves.toEqual([
        { name: "database_reachable", status: "ok" },
        { name: "redis_reachable", status: "ok" },
        { name: "order_process_queue_reachable", status: "ok" },
      ]);
    } finally {
      await readiness.close();
    }
  });

  it("starts all dependency checks concurrently and closes their resources after success", async () => {
    const gate = deferred();
    const started: string[] = [];
    const closeDatabase = vi.fn(async () => undefined);
    const disconnectRedis = vi.fn();
    const disconnectQueue = vi.fn(async () => undefined);
    const infrastructure: ApiReadinessInfrastructure = {
      createDatabase: vi.fn((_input) => ({
        checkConnectivity: async () => {
          started.push("database");
          await gate.promise;
        },
        close: closeDatabase,
      })),
      createRedis: vi.fn(() => ({
        checkConnectivity: async () => {
          started.push("redis");
          await gate.promise;
        },
        disconnect: disconnectRedis,
      })),
      createQueue: vi.fn(() => ({
        checkConnectivity: async () => {
          started.push("queue");
          await gate.promise;
        },
        disconnect: disconnectQueue,
      })),
    };
    const readiness = createApiReadiness(config, infrastructure);

    const checking = readiness.checks();

    expect(started).toEqual(["database", "redis", "queue"]);
    expect(infrastructure.createDatabase).toHaveBeenCalledWith({
      databaseUrl: config.databaseUrl,
      signal: expect.any(AbortSignal),
      max: 1,
      connectTimeoutSeconds: 1,
    });
    expect(infrastructure.createRedis).toHaveBeenCalledWith({
      redisUrl: config.redisUrl,
      commandTimeoutMs: config.timeoutMs,
    });
    expect(infrastructure.createQueue).toHaveBeenCalledWith({
      redisUrl: config.redisUrl,
      commandTimeoutMs: config.timeoutMs,
    });

    gate.resolve();

    await expect(checking).resolves.toEqual([
      { name: "database_reachable", status: "ok" },
      { name: "redis_reachable", status: "ok" },
      { name: "order_process_queue_reachable", status: "ok" },
    ]);
    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(disconnectRedis).toHaveBeenCalledOnce();
    expect(disconnectQueue).toHaveBeenCalledOnce();
    await readiness.close();
  });

  it("sanitizes rejected dependency and cleanup errors", async () => {
    const secretDatabaseError = new Error(
      "connect ECONNREFUSED postgresql://readiness-user:secret@postgres.test/readiness",
    );
    const secretRedisCleanupError = new Error("Redis password was secret");
    const infrastructure: ApiReadinessInfrastructure = {
      createDatabase: () => ({
        checkConnectivity: async () => {
          throw secretDatabaseError;
        },
        close: async () => undefined,
      }),
      createRedis: () => ({
        checkConnectivity: async () => undefined,
        disconnect: () => {
          throw secretRedisCleanupError;
        },
      }),
      createQueue: () => ({
        checkConnectivity: async () => undefined,
        disconnect: async () => undefined,
      }),
    };
    const readiness = createApiReadiness(config, infrastructure);

    const checks = await readiness.checks();

    expect(checks).toEqual([
      {
        name: "database_reachable",
        status: "unavailable",
        message: "PostgreSQL readiness check failed.",
      },
      {
        name: "redis_reachable",
        status: "unavailable",
        message: "Redis readiness check failed.",
      },
      { name: "order_process_queue_reachable", status: "ok" },
    ]);
    expect(JSON.stringify(checks)).not.toContain("secret");
    expect(JSON.stringify(checks)).not.toContain("postgres.test");
    await readiness.close();
  });

  it("cancels hung or queued work and finishes resource cleanup before the deadline result", async () => {
    vi.useFakeTimers();
    const cleanupOrder: string[] = [];
    let databaseSignal: AbortSignal | undefined;
    try {
      const readiness = createApiReadiness(config, {
        createDatabase: ({ signal }) => {
          databaseSignal = signal;
          return {
            checkConnectivity: async () => await never(),
            close: async () => {
              cleanupOrder.push("database");
            },
          };
        },
        createRedis: () => ({
          checkConnectivity: async () => await never(),
          disconnect: () => {
            cleanupOrder.push("redis");
          },
        }),
        createQueue: () => ({
          checkConnectivity: async () => await never(),
          disconnect: async () => {
            cleanupOrder.push("queue");
          },
        }),
      });

      const checking = readiness.checks();
      await vi.advanceTimersByTimeAsync(config.timeoutMs);
      const checks = await checking;

      expect(databaseSignal?.aborted).toBe(true);
      expect(cleanupOrder).toEqual(expect.arrayContaining(["database", "redis", "queue"]));
      expect(checks).toEqual(
        ["database_reachable", "redis_reachable", "order_process_queue_reachable"].map((name) => ({
          name,
          status: "unavailable",
          message: `Check exceeded the ${config.timeoutMs}ms readiness deadline.`,
        })),
      );
      await readiness.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces concurrent callers and uses fresh resources for later recovery", async () => {
    const firstGate = deferred();
    let databaseOperation = 0;
    const infrastructure: ApiReadinessInfrastructure = {
      createDatabase: vi.fn(() => {
        databaseOperation += 1;
        const operation = databaseOperation;
        return {
          checkConnectivity: async () => {
            if (operation === 1) {
              await firstGate.promise;
              throw new Error("first PostgreSQL check failed");
            }
          },
          close: async () => undefined,
        };
      }),
      createRedis: vi.fn(() => ({
        checkConnectivity: async () => {
          if (databaseOperation === 1) await firstGate.promise;
        },
        disconnect: vi.fn(),
      })),
      createQueue: vi.fn(() => ({
        checkConnectivity: async () => {
          if (databaseOperation === 1) await firstGate.promise;
        },
        disconnect: vi.fn(async () => undefined),
      })),
    };
    const readiness = createApiReadiness(config, infrastructure);

    const first = readiness.checks();
    const concurrent = readiness.checks();

    expect(infrastructure.createDatabase).toHaveBeenCalledOnce();
    expect(infrastructure.createRedis).toHaveBeenCalledOnce();
    expect(infrastructure.createQueue).toHaveBeenCalledOnce();
    firstGate.resolve();

    const [firstChecks, concurrentChecks] = await Promise.all([first, concurrent]);
    expect(concurrentChecks).toEqual(firstChecks);
    expect(concurrentChecks).not.toBe(firstChecks);
    expect(concurrentChecks[0]).not.toBe(firstChecks[0]);
    expect(firstChecks[0]).toEqual({
      name: "database_reachable",
      status: "unavailable",
      message: "PostgreSQL readiness check failed.",
    });

    await expect(readiness.checks()).resolves.toEqual([
      { name: "database_reachable", status: "ok" },
      { name: "redis_reachable", status: "ok" },
      { name: "order_process_queue_reachable", status: "ok" },
    ]);
    expect(infrastructure.createDatabase).toHaveBeenCalledTimes(2);
    expect(infrastructure.createRedis).toHaveBeenCalledTimes(2);
    expect(infrastructure.createQueue).toHaveBeenCalledTimes(2);
    await readiness.close();
  });

  it("keeps other probes running and cleaned when one resource fails construction", async () => {
    const closeDatabase = vi.fn(async () => undefined);
    const disconnectQueue = vi.fn(async () => undefined);
    const infrastructure: ApiReadinessInfrastructure = {
      createDatabase: () => ({
        checkConnectivity: async () => undefined,
        close: closeDatabase,
      }),
      createRedis: () => {
        throw new Error("Redis construction failed with redis://:secret@redis.test");
      },
      createQueue: () => ({
        checkConnectivity: async () => undefined,
        disconnect: disconnectQueue,
      }),
    };
    const readiness = createApiReadiness(config, infrastructure);

    const checks = await readiness.checks();

    expect(checks).toEqual([
      { name: "database_reachable", status: "ok" },
      {
        name: "redis_reachable",
        status: "unavailable",
        message: "Redis readiness check failed.",
      },
      { name: "order_process_queue_reachable", status: "ok" },
    ]);
    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(disconnectQueue).toHaveBeenCalledOnce();
    await readiness.close();
  });

  it("aborts and drains an active operation on shutdown and never creates later resources", async () => {
    const closeDatabase = vi.fn(async () => undefined);
    const disconnectRedis = vi.fn();
    const disconnectQueue = vi.fn(async () => undefined);
    const infrastructure: ApiReadinessInfrastructure = {
      createDatabase: vi.fn(() => ({
        checkConnectivity: async () => await never(),
        close: closeDatabase,
      })),
      createRedis: vi.fn(() => ({
        checkConnectivity: async () => await never(),
        disconnect: disconnectRedis,
      })),
      createQueue: vi.fn(() => ({
        checkConnectivity: async () => await never(),
        disconnect: disconnectQueue,
      })),
    };
    const readiness = createApiReadiness(config, infrastructure);
    const checking = readiness.checks();

    const closing = readiness.close();

    await expect(closing).resolves.toBeUndefined();
    await expect(checking).resolves.toEqual(
      ["database_reachable", "redis_reachable", "order_process_queue_reachable"].map((name) => ({
        name,
        status: "unavailable",
        message: "API readiness is shutting down.",
      })),
    );
    expect(readiness.close()).toBe(closing);
    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(disconnectRedis).toHaveBeenCalledOnce();
    expect(disconnectQueue).toHaveBeenCalledOnce();

    await expect(readiness.checks()).resolves.toEqual(
      ["database_reachable", "redis_reachable", "order_process_queue_reachable"].map((name) => ({
        name,
        status: "unavailable",
        message: "API readiness is shutting down.",
      })),
    );
    expect(infrastructure.createDatabase).toHaveBeenCalledOnce();
    expect(infrastructure.createRedis).toHaveBeenCalledOnce();
    expect(infrastructure.createQueue).toHaveBeenCalledOnce();
  });
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function never(): Promise<never> {
  return await new Promise<never>(() => undefined);
}
