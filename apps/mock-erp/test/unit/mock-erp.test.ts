import {
  type ErpConfirmationRequest,
  erpConfirmationPath,
  erpConfirmationResponseSchema,
  errorPayloadSchema,
  healthResponseSchema,
  livenessResponseSchema,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { ConfirmationService } from "../../src/application/confirmation-service.js";
import { loadMockErpConfig } from "../../src/runtime/config.js";
import { buildMockErpServer } from "../../src/server.js";

const confirmationRequest: ErpConfirmationRequest = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test_1",
  reservationId: "22222222-2222-4222-8222-222222222222",
  saleOfferId: "33333333-3333-4333-8333-333333333333",
  runId: "44444444-4444-4444-8444-444444444444",
  correlationId: "corr-mock-erp-test",
  quantity: 1,
};

describe("Mock ERP configuration", () => {
  it("loads host-native defaults and explicit overrides", () => {
    expect(loadMockErpConfig({})).toEqual({ host: "0.0.0.0", port: 4100 });
    expect(loadMockErpConfig({ HOST: "127.0.0.1", PORT: "5100" })).toEqual({
      host: "127.0.0.1",
      port: 5100,
    });
  });

  it("rejects an invalid port", () => {
    expect(() => loadMockErpConfig({ PORT: "0" })).toThrow("PORT must be a positive integer");
    expect(() => loadMockErpConfig({ PORT: "invalid" })).toThrow("PORT must be a positive integer");
  });
});

describe("confirmation service", () => {
  it("returns a contract-valid successful confirmation with measured latency", async () => {
    const now = sequenceClock(
      new Date("2026-06-22T00:00:00.000Z"),
      new Date("2026-06-22T00:00:00.025Z"),
    );
    const service = new ConfirmationService({
      generateConfirmationId: () => "erp_confirmation_test",
      now,
    });

    await expect(service.confirm(confirmationRequest)).resolves.toEqual({
      status: "succeeded",
      confirmationId: "erp_confirmation_test",
      httpStatus: 200,
      latencyMs: 25,
      timestamp: "2026-06-22T00:00:00.025Z",
    });
  });

  it("returns dependency-style failure details from the injected decision boundary", async () => {
    const service = new ConfirmationService({
      decisionProvider: {
        decide: vi.fn().mockResolvedValue({
          status: "failed",
          httpStatus: 503,
          errorCode: "erp_capacity_exceeded",
          errorMessage: "The ERP cannot accept more confirmations right now.",
        }),
      },
      now: sequenceClock(
        new Date("2026-06-22T00:00:00.000Z"),
        new Date("2026-06-22T00:00:00.040Z"),
      ),
    });

    await expect(service.confirm(confirmationRequest)).resolves.toEqual({
      status: "failed",
      httpStatus: 503,
      errorCode: "erp_capacity_exceeded",
      errorMessage: "The ERP cannot accept more confirmations right now.",
      latencyMs: 40,
      timestamp: "2026-06-22T00:00:00.040Z",
    });
  });
});

describe("Mock ERP HTTP service", () => {
  it("serves contract-valid liveness and readiness endpoints", async () => {
    const server = buildMockErpServer({
      confirmationService: new ConfirmationService(),
      logger: createSilentLogger("mock-erp"),
      startedAt: new Date("2026-06-22T00:00:00.000Z"),
    });

    const live = await server.inject({ method: "GET", url: "/health/live" });
    const ready = await server.inject({ method: "GET", url: "/health/ready" });
    await server.close();

    expect(live.statusCode).toBe(200);
    expect(livenessResponseSchema.parse(live.json()).service).toBe("mock-erp");
    expect(ready.statusCode).toBe(200);
    expect(healthResponseSchema.parse(ready.json()).checks).toEqual([
      { name: "confirmation_endpoint_ready", status: "ok" },
    ]);
  });

  it("confirms an order and propagates its correlation ID", async () => {
    const server = buildMockErpServer({
      confirmationService: new ConfirmationService({
        generateConfirmationId: () => "erp_confirmation_http_test",
        now: sequenceClock(
          new Date("2026-06-22T00:00:00.000Z"),
          new Date("2026-06-22T00:00:00.010Z"),
        ),
      }),
      logger: createSilentLogger("mock-erp"),
    });

    const response = await server.inject({
      method: "POST",
      url: erpConfirmationPath,
      headers: { [correlationIdHeaderName]: confirmationRequest.correlationId },
      payload: confirmationRequest,
    });
    await server.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers[correlationIdHeaderName]).toBe(confirmationRequest.correlationId);
    expect(erpConfirmationResponseSchema.parse(response.json())).toEqual({
      status: "succeeded",
      confirmationId: "erp_confirmation_http_test",
      httpStatus: 200,
      latencyMs: 10,
      timestamp: "2026-06-22T00:00:00.010Z",
    });
  });

  it("returns a structured dependency failure with its intended HTTP status", async () => {
    const server = buildMockErpServer({
      confirmationService: new ConfirmationService({
        decisionProvider: {
          decide: async () => ({
            status: "failed",
            httpStatus: 503,
            errorCode: "erp_unavailable",
            errorMessage: "The ERP is temporarily unavailable.",
          }),
        },
      }),
      logger: createSilentLogger("mock-erp"),
    });

    const response = await server.inject({
      method: "POST",
      url: erpConfirmationPath,
      payload: confirmationRequest,
    });
    await server.close();

    expect(response.statusCode).toBe(503);
    expect(erpConfirmationResponseSchema.parse(response.json())).toMatchObject({
      status: "failed",
      httpStatus: 503,
      errorCode: "erp_unavailable",
    });
  });

  it("rejects invalid requests with the shared error contract", async () => {
    const server = buildMockErpServer({
      confirmationService: new ConfirmationService(),
      logger: createSilentLogger("mock-erp"),
    });

    const response = await server.inject({
      method: "POST",
      url: erpConfirmationPath,
      headers: { [correlationIdHeaderName]: "corr-invalid-request" },
      payload: { ...confirmationRequest, orderId: "not-a-uuid" },
    });
    await server.close();

    expect(response.statusCode).toBe(400);
    expect(response.headers[correlationIdHeaderName]).toBe("corr-invalid-request");
    expect(errorPayloadSchema.parse(response.json())).toMatchObject({
      code: "invalid_request",
      correlationId: "corr-invalid-request",
    });
  });
});

function sequenceClock(...dates: Date[]): () => Date {
  let index = 0;

  return () => {
    const date = dates[index];
    index += 1;

    if (!date) {
      throw new Error("Test clock exhausted.");
    }

    return date;
  };
}
