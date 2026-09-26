import {
  controlServiceTokenHeaderName,
  errorPayloadSchema,
  type TrafficExecutionStartRequest,
  trafficExecutionStartPath,
  trafficExecutionStartResponseSchema,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
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
    },
    erpConfig: {
      latencyMs: 0,
      maxTps: 1,
      errorRate: 0,
      forcedOutage: false,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 1,
    },
  },
};

describe("load-orchestrator correlation boundary", () => {
  it("promotes body correlation on start and returns inbound correlation in a 401 body", async () => {
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
      logger: createSilentLogger("load-orchestrator"),
      readiness: { checks: async () => [{ name: "k6_binary_executable", status: "ok" }] },
      trafficExecutionService: new TrafficExecutionService(runner),
      startedAt: new Date(timestamp),
    });
    try {
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
      expect(accepted.headers[correlationIdHeaderName]).toBe("load-body-corr");
      expect(trafficExecutionStartResponseSchema.parse(accepted.json()).correlationId).toBe(
        "load-body-corr",
      );

      expect(unauthorized.statusCode).toBe(401);
      expect(errorPayloadSchema.parse(unauthorized.json()).correlationId).toBe("load-inbound-1");
    } finally {
      await server.close();
    }
  });
});
