import type { TrafficExecutionStartRequest } from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiHttpError } from "../src/runtime/errors.js";
import { HttpTrafficExecutionGateway } from "../src/services/demo-run-service.js";

const request: TrafficExecutionStartRequest = {
  runId: "55555555-5555-4555-8555-555555555555",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  apiBaseUrl: "http://api.test",
  buyEndpointPath: "/buy",
  correlationId: "gateway-reconcile",
  configSnapshot: {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 1,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 5,
      quantityPerAttempt: 1,
    },
    inventoryConfig: { startingStock: 1, quantityPerCheckout: 1, reservationHoldMinutes: 15 },
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
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
      drainTimeoutSeconds: 30,
      pendingPersistenceRetryAfterSeconds: 5,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
    },
  },
};

describe("HttpTrafficExecutionGateway ambiguity recovery", () => {
  it("recovers a timed-out start from durable accepted status and preserves acceptedAt", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            }),
          ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: request.runId,
            state: "accepted",
            acceptedAt: "2026-06-20T00:00:01.000Z",
            observedAt: "2026-06-20T00:00:09.000Z",
            correlationId: request.correlationId,
          }),
          { status: 200 },
        ),
      );
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "token",
      requestTimeoutMs: 2,
      fetch: fetchMock,
    });
    await expect(gateway.start(request)).resolves.toMatchObject({
      status: "starting",
      startedAt: "2026-06-20T00:00:01.000Z",
    });
  });

  it("keeps a reachable unknown status ambiguous", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: request.runId,
            state: "unknown",
            observedAt: "2026-06-20T00:00:09.000Z",
            correlationId: request.correlationId,
          }),
          { status: 200 },
        ),
      );
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "token",
      fetch: fetchMock,
    });
    await expect(gateway.start(request)).rejects.toMatchObject({
      code: "load_orchestrator_start_ambiguous",
    });
  });

  it("bounds the status lookup and rejects malformed recovery safely", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "token",
      requestTimeoutMs: 2,
      fetch: fetchMock,
    });
    await expect(gateway.start(request)).rejects.toBeInstanceOf(ApiHttpError);
  });
});
