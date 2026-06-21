import { healthResponseSchema, livenessResponseSchema } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import {
  createOrderProcessJobHandler,
  OrderProcessingNotImplementedError,
} from "../../src/application/order-process-job-handler.js";
import { loadWorkerConfig } from "../../src/runtime/config.js";
import { createWorkerReadiness } from "../../src/runtime/readiness.js";
import { createWorkerRuntime } from "../../src/runtime/worker-runtime.js";
import { buildWorkerHealthServer } from "../../src/server.js";

describe("worker configuration", () => {
  it("loads bounded worker defaults", () => {
    expect(loadWorkerConfig({ REDIS_URL: "redis://localhost:6379" })).toEqual({
      healthHost: "0.0.0.0",
      healthPort: 4300,
      redisUrl: "redis://localhost:6379",
      orderProcessConcurrency: 5,
    });
  });

  it("rejects missing infrastructure and invalid concurrency", () => {
    expect(() => loadWorkerConfig({})).toThrow("REDIS_URL is required");
    expect(() =>
      loadWorkerConfig({ REDIS_URL: "redis://localhost:6379", ORDER_PROCESS_CONCURRENCY: "0" }),
    ).toThrow("ORDER_PROCESS_CONCURRENCY must be a positive integer");
  });
});

describe("production order-processing skeleton", () => {
  it("rejects received jobs until durable processing is implemented", async () => {
    const handler = createOrderProcessJobHandler({ logger: createSilentLogger("worker") });

    await expect(
      handler.handle({
        orderId: "11111111-1111-4111-8111-111111111111",
        publicOrderId: "ord_test",
        reservationId: "33333333-3333-4333-8333-333333333333",
        saleOfferId: "22222222-2222-4222-8222-222222222222",
        correlationId: "corr-worker-test",
        quantity: 1,
        queuedAt: "2026-06-21T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(OrderProcessingNotImplementedError);
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
      redis: { ping: vi.fn().mockResolvedValue("PONG") } as never,
      orderProcessConsumer: {
        start: vi.fn(),
        close: vi.fn(),
        isRunning: () => true,
      },
    });

    await expect(readiness.checks()).resolves.toEqual([
      { name: "redis_reachable", status: "ok" },
      { name: "order_process_worker_running", status: "ok" },
    ]);
  });

  it("reports Redis and consumer failures directly", async () => {
    const readiness = createWorkerReadiness({
      redis: { ping: vi.fn().mockRejectedValue(new Error("Redis unavailable")) } as never,
      orderProcessConsumer: {
        start: vi.fn(),
        close: vi.fn(),
        isRunning: () => false,
      },
    });

    await expect(readiness.checks()).resolves.toEqual([
      { name: "redis_reachable", status: "unavailable", message: "Redis unavailable" },
      {
        name: "order_process_worker_running",
        status: "unavailable",
        message: "The order-processing consumer is not running.",
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
    };
    const runtime = createWorkerRuntime({
      healthServer,
      healthHost: "127.0.0.1",
      healthPort: 0,
      orderProcessConsumer: consumer,
      logger,
    });

    await runtime.start();
    await Promise.all([runtime.close(), runtime.close()]);

    expect(consumer.start).toHaveBeenCalledOnce();
    expect(consumer.close).toHaveBeenCalledOnce();
  });
});
