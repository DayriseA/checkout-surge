import { healthResponseSchema, livenessResponseSchema } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { loadWorkerConfig } from "../../src/runtime/config.js";
import { createWorkerReadiness } from "../../src/runtime/readiness.js";
import { createWorkerRuntime } from "../../src/runtime/worker-runtime.js";
import { buildWorkerHealthServer } from "../../src/server.js";

describe("worker configuration", () => {
  it("loads bounded worker defaults", () => {
    expect(
      loadWorkerConfig({
        DATABASE_URL: "postgresql://localhost/checkout_surge",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toEqual({
      databaseUrl: "postgresql://localhost/checkout_surge",
      healthHost: "0.0.0.0",
      healthPort: 4300,
      redisUrl: "redis://localhost:6379",
      orderProcessConcurrency: 5,
      notificationRecordConcurrency: 5,
      notificationRecoveryScanIntervalMs: 1000,
      notificationRecoveryBatchSize: 100,
      postgresPoolMax: 10,
      mockErpBaseUrl: "http://localhost:4100/",
      erpRequestTimeoutMs: 2000,
      erpCircuitFailureThreshold: 5,
      erpCircuitResetTimeoutMs: 10_000,
    });
  });

  it("loads ERP client overrides", () => {
    expect(
      loadWorkerConfig({
        DATABASE_URL: "postgresql://localhost/checkout_surge",
        REDIS_URL: "redis://localhost:6379",
        MOCK_ERP_BASE_URL: "http://mock-erp:4100",
        ERP_REQUEST_TIMEOUT_MS: "500",
        ERP_CIRCUIT_FAILURE_THRESHOLD: "2",
        ERP_CIRCUIT_RESET_TIMEOUT_MS: "1500",
      }),
    ).toMatchObject({
      mockErpBaseUrl: "http://mock-erp:4100/",
      erpRequestTimeoutMs: 500,
      erpCircuitFailureThreshold: 2,
      erpCircuitResetTimeoutMs: 1500,
    });
  });

  it("rejects missing infrastructure and invalid worker values", () => {
    expect(() => loadWorkerConfig({})).toThrow("DATABASE_URL is required");
    expect(() =>
      loadWorkerConfig({
        DATABASE_URL: "postgresql://localhost/test",
        REDIS_URL: "redis://localhost:6379",
        ORDER_PROCESS_CONCURRENCY: "0",
      }),
    ).toThrow("ORDER_PROCESS_CONCURRENCY must be a positive integer");
    expect(() =>
      loadWorkerConfig({
        DATABASE_URL: "postgresql://localhost/test",
        REDIS_URL: "redis://localhost:6379",
        WORKER_POSTGRES_POOL_MAX: "invalid",
      }),
    ).toThrow("WORKER_POSTGRES_POOL_MAX must be a positive integer");
    expect(() =>
      loadWorkerConfig({
        DATABASE_URL: "postgresql://localhost/test",
        REDIS_URL: "redis://localhost:6379",
        MOCK_ERP_BASE_URL: "not-a-url",
      }),
    ).toThrow("MOCK_ERP_BASE_URL must be a valid URL");
    expect(() =>
      loadWorkerConfig({
        DATABASE_URL: "postgresql://localhost/test",
        REDIS_URL: "redis://localhost:6379",
        ERP_REQUEST_TIMEOUT_MS: "0",
      }),
    ).toThrow("ERP_REQUEST_TIMEOUT_MS must be a positive integer");
    expect(() =>
      loadWorkerConfig({
        DATABASE_URL: "postgresql://localhost/test",
        REDIS_URL: "redis://localhost:6379",
        ERP_CIRCUIT_FAILURE_THRESHOLD: "0",
      }),
    ).toThrow("ERP_CIRCUIT_FAILURE_THRESHOLD must be a positive integer");
    expect(() =>
      loadWorkerConfig({
        DATABASE_URL: "postgresql://localhost/test",
        REDIS_URL: "redis://localhost:6379",
        NOTIFICATION_RECOVERY_SCAN_INTERVAL_MS: "0",
      }),
    ).toThrow("NOTIFICATION_RECOVERY_SCAN_INTERVAL_MS must be a positive integer");
  });
});

describe("worker health server", () => {
  it("returns contract-valid liveness and readiness", async () => {
    const server = buildWorkerHealthServer({
      logger: createSilentLogger("worker"),
      readiness: { checks: async () => [{ name: "order_process_worker_running", status: "ok" }] },
      startedAt: new Date("2026-06-21T00:00:00.000Z"),
    });

    const live = await server.inject({ method: "GET", url: "/health/live" });
    const ready = await server.inject({ method: "GET", url: "/health/ready" });
    await server.close();

    expect(live.statusCode).toBe(200);
    expect(() => livenessResponseSchema.parse(live.json())).not.toThrow();
    expect(ready.statusCode).toBe(200);
    expect(() => healthResponseSchema.parse(ready.json())).not.toThrow();
  });

  it("reports unavailable readiness with HTTP 503", async () => {
    const server = buildWorkerHealthServer({
      logger: createSilentLogger("worker"),
      readiness: {
        checks: async () => [{ name: "order_process_worker_running", status: "unavailable" }],
      },
    });

    const response = await server.inject({ method: "GET", url: "/health/ready" });
    await server.close();

    expect(response.statusCode).toBe(503);
    expect(healthResponseSchema.parse(response.json()).status).toBe("unavailable");
  });
});

describe("worker readiness", () => {
  it("checks Redis and the consumer through injected boundaries", async () => {
    const readiness = createWorkerReadiness({
      postgres: { unsafe: vi.fn().mockResolvedValue([{ one: 1 }]) } as never,
      redis: { ping: vi.fn().mockResolvedValue("PONG") } as never,
      orderProcessConsumer: {
        start: vi.fn(),
        close: vi.fn(),
        isRunning: () => true,
        checkConnectivity: vi.fn().mockResolvedValue(undefined),
      },
      notificationRecordConsumer: {
        start: vi.fn(),
        close: vi.fn(),
        isRunning: () => true,
        checkConnectivity: vi.fn().mockResolvedValue(undefined),
      },
    });

    await expect(readiness.checks()).resolves.toEqual([
      { name: "database_reachable", status: "ok" },
      { name: "redis_reachable", status: "ok" },
      { name: "order_process_worker_running", status: "ok" },
      { name: "order_process_queue_reachable", status: "ok" },
      { name: "notification_record_worker_running", status: "ok" },
      { name: "notification_record_queue_reachable", status: "ok" },
    ]);
  });

  it("reports Redis and consumer failures directly", async () => {
    const readiness = createWorkerReadiness({
      postgres: { unsafe: vi.fn().mockRejectedValue(new Error("PostgreSQL unavailable")) } as never,
      redis: { ping: vi.fn().mockRejectedValue(new Error("Redis unavailable")) } as never,
      orderProcessConsumer: {
        start: vi.fn(),
        close: vi.fn(),
        isRunning: () => false,
        checkConnectivity: vi.fn().mockRejectedValue(new Error("Queue unavailable")),
      },
      notificationRecordConsumer: {
        start: vi.fn(),
        close: vi.fn(),
        isRunning: () => false,
        checkConnectivity: vi.fn().mockRejectedValue(new Error("Notification queue unavailable")),
      },
    });

    await expect(readiness.checks()).resolves.toEqual([
      {
        name: "database_reachable",
        status: "unavailable",
        message: "PostgreSQL unavailable",
      },
      { name: "redis_reachable", status: "unavailable", message: "Redis unavailable" },
      {
        name: "order_process_worker_running",
        status: "unavailable",
        message: "The order-processing consumer is not running.",
      },
      {
        name: "order_process_queue_reachable",
        status: "unavailable",
        message: "Queue unavailable",
      },
      {
        name: "notification_record_worker_running",
        status: "unavailable",
        message: "The notification-recording consumer is not running.",
      },
      {
        name: "notification_record_queue_reachable",
        status: "unavailable",
        message: "Notification queue unavailable",
      },
    ]);
  });
});

describe("worker runtime lifecycle", () => {
  it("starts and cleanly closes injected runtime dependencies", async () => {
    const logger = createSilentLogger("worker");
    const healthServer = buildWorkerHealthServer({
      logger,
      readiness: { checks: async () => [] },
    });
    const consumer = {
      start: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      isRunning: () => true,
      checkConnectivity: vi.fn().mockResolvedValue(undefined),
    };
    const notificationConsumer = {
      start: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      isRunning: () => true,
      checkConnectivity: vi.fn().mockResolvedValue(undefined),
    };
    const notificationRecoveryScanner = {
      start: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      scanOnce: vi.fn().mockResolvedValue({ candidates: 0, published: 0, failed: 0 }),
    };
    const runtime = createWorkerRuntime({
      healthServer,
      healthHost: "127.0.0.1",
      healthPort: 0,
      orderProcessConsumer: consumer,
      notificationRecordConsumer: notificationConsumer,
      notificationRecoveryScanner,
      closeNotificationRecordPublisher: vi.fn().mockResolvedValue(undefined),
      closePostgres: vi.fn().mockResolvedValue(undefined),
      closeRedis: vi.fn().mockResolvedValue(undefined),
      logger,
    });

    await runtime.start();
    await Promise.all([runtime.close(), runtime.close()]);

    expect(consumer.start).toHaveBeenCalledOnce();
    expect(consumer.close).toHaveBeenCalledOnce();
    expect(notificationConsumer.start).toHaveBeenCalledOnce();
    expect(notificationConsumer.close).toHaveBeenCalledOnce();
    expect(notificationRecoveryScanner.start).toHaveBeenCalledOnce();
    expect(notificationRecoveryScanner.close).toHaveBeenCalledOnce();
  });

  it("closes serving and consuming boundaries before PostgreSQL and Redis", async () => {
    const closeOrder: string[] = [];
    const healthServer = {
      listen: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(async () => {
        closeOrder.push("health");
      }),
    } as never;
    const runtime = createWorkerRuntime({
      healthServer,
      healthHost: "127.0.0.1",
      healthPort: 0,
      orderProcessConsumer: {
        start: vi.fn(),
        close: vi.fn(async () => {
          closeOrder.push("consumer");
        }),
        isRunning: () => true,
        checkConnectivity: vi.fn().mockResolvedValue(undefined),
      },
      notificationRecordConsumer: {
        start: vi.fn(),
        close: vi.fn(async () => {
          closeOrder.push("notifications");
        }),
        isRunning: () => true,
        checkConnectivity: vi.fn().mockResolvedValue(undefined),
      },
      notificationRecoveryScanner: {
        start: vi.fn(),
        close: vi.fn(async () => {
          closeOrder.push("notification-recovery");
        }),
        scanOnce: vi.fn().mockResolvedValue({ candidates: 0, published: 0, failed: 0 }),
      },
      closeNotificationRecordPublisher: vi.fn(async () => {
        closeOrder.push("notification-publisher");
      }),
      closePostgres: vi.fn(async () => {
        closeOrder.push("postgres");
      }),
      closeRedis: vi.fn(async () => {
        closeOrder.push("redis");
      }),
      logger: createSilentLogger("worker"),
    });

    await runtime.start();
    await Promise.all([runtime.close(), runtime.close()]);

    expect(closeOrder).toEqual([
      "health",
      "consumer",
      "notifications",
      "notification-recovery",
      "notification-publisher",
      "postgres",
      "redis",
    ]);
  });

  it("cleans every resource after startup failure and preserves cleanup failures", async () => {
    const listenError = new Error("port unavailable");
    const closeError = new Error("postgres close failed");
    const closeRedis = vi.fn().mockResolvedValue(undefined);
    const runtime = createWorkerRuntime({
      healthServer: {
        listen: vi.fn().mockRejectedValue(listenError),
        close: vi.fn().mockResolvedValue(undefined),
      } as never,
      healthHost: "127.0.0.1",
      healthPort: 4300,
      orderProcessConsumer: {
        start: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
        isRunning: () => false,
        checkConnectivity: vi.fn().mockResolvedValue(undefined),
      },
      notificationRecordConsumer: {
        start: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
        isRunning: () => false,
        checkConnectivity: vi.fn().mockResolvedValue(undefined),
      },
      closeNotificationRecordPublisher: vi.fn().mockResolvedValue(undefined),
      closePostgres: vi.fn().mockRejectedValue(closeError),
      closeRedis,
      logger: createSilentLogger("worker"),
    });

    const rejection = await runtime.start().catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AggregateError);
    expect(rejection).toMatchObject({ cause: listenError });
    expect(closeRedis).toHaveBeenCalledOnce();
  });
});
