import {
  controlServiceTokenHeaderName,
  errorPayloadSchema,
  type TrafficExecutionStartRequest,
  trafficExecutionStartPath,
  trafficExecutionStartResponseSchema,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName, createServiceLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import type { K6Runner } from "../src/application/k6-runner.js";
import { TrafficExecutionService } from "../src/application/traffic-execution-service.js";
import { buildLoadOrchestratorServer } from "../src/server.js";
import { createLoadOrchestratorConfig as createConfig } from "./load-orchestrator-test-helper.js";

const timestamp = "2026-06-20T12:00:00.000Z";

const startRequest: TrafficExecutionStartRequest = {
  runId: "55555555-5555-4555-8555-555555555555",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  apiBaseUrl: "http://localhost:4000",
  buyEndpointPath: "/buy",
  correlationId: "load-body-corr",
  configSnapshot: {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 1,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 1,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 1,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 1,
    },
    erpConfig: {
      latencyMs: 0,
      maxTps: 1,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 1000,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 1,
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 0 },
      drainTimeoutSeconds: 1,
      pendingPersistenceRetryAfterSeconds: 1,
      circuitBreakerFailureThreshold: 2,
      circuitBreakerResetTimeoutMs: 100,
    },
  },
};

describe("load-orchestrator correlation boundary", () => {
  it("binds the inbound id into the response header, error body, routine logs, and promotes body correlation", async () => {
    const lines: string[] = [];
    const logger = createServiceLogger({
      service: "load-orchestrator",
      level: "info",
      destination: { write: (line) => void lines.push(line) },
    });
    const runner: K6Runner = {
      start: vi.fn(async () => ({ startedAt: new Date(timestamp), plannedRequests: 1 })),
      statusSnapshot: vi.fn(async () => ({ state: "unknown" as const })),
      currentRunId: vi.fn(() => null),
      abort: vi.fn(async () => "aborted" as const),
      initialize: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const server = buildLoadOrchestratorServer({
      config: createConfig(),
      logger,
      readiness: { checks: async () => [{ name: "k6_binary_executable", status: "ok" }] },
      trafficExecutionService: new TrafficExecutionService(runner),
      startedAt: new Date(timestamp),
    });
    server.route({
      method: "GET",
      url: "/test-correlation-echo",
      handler: async (request) => {
        request.log.info({ marker: "load-marker" }, "load-echo");
        return { correlationId: request.correlationId };
      },
    });

    try {
      const echo = await server.inject({
        method: "GET",
        url: "/test-correlation-echo",
        headers: { [correlationIdHeaderName]: "load-inbound-1" },
      });
      const accepted = await server.inject({
        method: "POST",
        url: trafficExecutionStartPath,
        headers: {
          [controlServiceTokenHeaderName]: "test-token",
          [correlationIdHeaderName]: "load-inbound-1",
        },
        payload: startRequest,
      });
      const unauthorized = await server.inject({
        method: "POST",
        url: trafficExecutionStartPath,
        headers: { [correlationIdHeaderName]: "load-inbound-1" },
        payload: startRequest,
      });
      const second = await server.inject({
        method: "GET",
        url: "/test-correlation-echo",
        headers: { [correlationIdHeaderName]: "load-inbound-2" },
      });

      expect(echo.headers[correlationIdHeaderName]).toBe("load-inbound-1");
      expect(echo.json().correlationId).toBe("load-inbound-1");

      expect(accepted.headers[correlationIdHeaderName]).toBe("load-body-corr");
      expect(trafficExecutionStartResponseSchema.parse(accepted.json()).correlationId).toBe(
        "load-body-corr",
      );

      expect(unauthorized.statusCode).toBe(401);
      expect(errorPayloadSchema.parse(unauthorized.json()).correlationId).toBe("load-inbound-1");

      expect(second.headers[correlationIdHeaderName]).toBe("load-inbound-2");

      const echoRecords = lines
        .map((line) => JSON.parse(line) as { msg?: string; correlationId?: string })
        .filter((record) => record.msg === "load-echo");
      expect(echoRecords).toHaveLength(2);
      expect(echoRecords[0]?.correlationId).toBe("load-inbound-1");
      expect(echoRecords[1]?.correlationId).toBe("load-inbound-2");
    } finally {
      await server.close();
    }
  });
});
