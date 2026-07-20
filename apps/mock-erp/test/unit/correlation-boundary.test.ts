import {
  type ErpConfirmationRequest,
  erpConfirmationPath,
  errorPayloadSchema,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName, createServiceLogger } from "@checkout-surge/logger";
import { describe, expect, it } from "vitest";
import { ErpChaosConfigStore } from "../../src/application/chaos-control-service.js";
import { ConfirmationService } from "../../src/application/confirmation-service.js";
import { createMockErpReadiness } from "../../src/application/readiness.js";
import { buildMockErpServer } from "../../src/server.js";

const defaultChaosConfig = { latencyMs: 0, maxTps: 100, errorRate: 0, forcedOutage: false };
const testSafetyCaps = {
  maxLatencyMs: 5000,
  minMaxTps: 1,
  maxErrorRate: 1,
  allowForcedOutage: true,
};
const controlServiceToken = "test-control-token";

const confirmationRequest: ErpConfirmationRequest = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_corr_1",
  reservationId: "22222222-2222-4222-8222-222222222222",
  saleOfferId: "33333333-3333-4333-8333-333333333333",
  runId: "44444444-4444-4444-8444-444444444444",
  idempotencyKey: "erp-confirmation:11111111-1111-4111-8111-111111111111",
  correlationId: "mock-body-corr",
  quantity: 1,
};

describe("Mock ERP correlation boundary", () => {
  it("binds the inbound id into the response header, error body, routine logs, and promotes body correlation", async () => {
    const lines: string[] = [];
    const logger = createServiceLogger({
      service: "mock-erp",
      level: "info",
      destination: { write: (line) => void lines.push(line) },
    });
    const server = buildMockErpServer({
      confirmationService: new ConfirmationService(),
      chaosConfigStore: new ErpChaosConfigStore(defaultChaosConfig, testSafetyCaps),
      controlServiceToken,
      logger,
      readiness: createMockErpReadiness({
        ledgerProbe: { check: async () => undefined },
        timeoutMs: 100,
      }),
    });
    server.route({
      method: "GET",
      url: "/test-correlation-echo",
      handler: async (request) => {
        request.log.info({ marker: "mock-erp-marker" }, "mock-erp-echo");
        return { correlationId: request.correlationId };
      },
    });

    try {
      const echo = await server.inject({
        method: "GET",
        url: "/test-correlation-echo",
        headers: { [correlationIdHeaderName]: "mock-inbound-1" },
      });
      const confirmation = await server.inject({
        method: "POST",
        url: erpConfirmationPath,
        headers: { [correlationIdHeaderName]: "mock-inbound-1" },
        payload: confirmationRequest,
      });
      const badBody = await server.inject({
        method: "POST",
        url: erpConfirmationPath,
        headers: { [correlationIdHeaderName]: "mock-inbound-1" },
        payload: { not: "valid" },
      });
      const second = await server.inject({
        method: "GET",
        url: "/test-correlation-echo",
        headers: { [correlationIdHeaderName]: "mock-inbound-2" },
      });

      expect(echo.headers[correlationIdHeaderName]).toBe("mock-inbound-1");
      expect(echo.json().correlationId).toBe("mock-inbound-1");

      expect(confirmation.headers[correlationIdHeaderName]).toBe("mock-body-corr");
      const receivedRecords = lines
        .map((line) => JSON.parse(line) as { msg?: string; correlationId?: string })
        .filter((record) => record.msg === "Mock ERP confirmation request received.");
      expect(receivedRecords[0]?.correlationId).toBe("mock-body-corr");

      expect(badBody.statusCode).toBe(400);
      expect(errorPayloadSchema.parse(badBody.json()).correlationId).toBe("mock-inbound-1");

      expect(second.headers[correlationIdHeaderName]).toBe("mock-inbound-2");

      const echoRecords = lines
        .map((line) => JSON.parse(line) as { msg?: string; correlationId?: string })
        .filter((record) => record.msg === "mock-erp-echo");
      expect(echoRecords).toHaveLength(2);
      expect(echoRecords[0]?.correlationId).toBe("mock-inbound-1");
      expect(echoRecords[1]?.correlationId).toBe("mock-inbound-2");
    } finally {
      await server.close();
    }
  });
});
