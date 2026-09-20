import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  ChaosConfirmationDecisionProvider,
  ErpChaosConfigStore,
} from "../../../mock-erp/src/application/chaos-control-service.js";
import { ConfirmationService } from "../../../mock-erp/src/application/confirmation-service.js";
import { SlidingWindowTpsLimiter } from "../../../mock-erp/src/application/tps-limiter.js";
import { buildMockErpServer } from "../../../mock-erp/src/server.js";
import {
  type ErpAttemptPersistence,
  HttpErpOrderConfirmation,
} from "../../src/application/erp-confirmation-client.js";

const globalFallback = {
  latencyMs: 0,
  maxTps: 100,
  errorRate: 0,
  forcedOutage: true,
};
const store = new ErpChaosConfigStore(globalFallback, {
  maxLatencyMs: 5000,
  minMaxTps: 1,
  maxErrorRate: 1,
  allowForcedOutage: true,
});
const server = buildMockErpServer({
  chaosConfigStore: store,
  confirmationService: new ConfirmationService({
    decisionProvider: new ChaosConfirmationDecisionProvider({
      configStore: store,
      tpsLimiter: new SlidingWindowTpsLimiter(),
    }),
  }),
  controlServiceToken: "integration-token",
  logger: createSilentLogger("mock-erp"),
});

afterAll(() => server.close());

describe("worker and Mock ERP precedence", () => {
  it("uses the accepted run snapshot instead of the global fallback", async () => {
    const snapshot = previewRunConfigSnapshotFixture();
    snapshot.erpConfig = {
      latencyMs: 0,
      maxTps: 100,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 1000,
    };
    const attemptPersistence: ErpAttemptPersistence = {
      findTechnicalFailure: vi.fn().mockResolvedValue(null),
      findSuccessfulAttempt: vi.fn().mockResolvedValue(null),
      recordDispatchIntent: vi
        .fn()
        .mockResolvedValue({ erpCallId: "99999999-9999-4999-8999-999999999999" }),
      recordAttempt: vi.fn().mockResolvedValue(true),
    };
    const confirmation = new HttpErpOrderConfirmation({
      baseUrl: "http://mock-erp:4100",
      requestTimeoutMs: 1000,
      retryAfterPolicy: { fallbackDelayMs: 1_000, maximumDelayMs: 60_000 },
      attemptPersistence,
      runConfigReader: { read: vi.fn().mockResolvedValue(snapshot) },
      fetch: async (_input, init) => {
        const response = await server.inject({
          method: "POST",
          url: "/confirmations",
          headers: init?.headers as Record<string, string>,
          payload: String(init?.body),
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: response.headers as Record<string, string>,
        });
      },
    });

    await expect(
      confirmation.dispatch(
        {
          orderId: "11111111-1111-4111-8111-111111111111",
          publicOrderId: "ord_precedence",
          reservationId: "22222222-2222-4222-8222-222222222222",
          saleOfferId: "33333333-3333-4333-8333-333333333333",
          runId: "44444444-4444-4444-8444-444444444444",
          correlationId: "corr-precedence",
          quantity: 1,
          queuedAt: "2026-08-07T00:00:00.000Z",
          processingGeneration: 0,
        },
        { attemptNumber: 1, attemptsMade: 0, maxAttempts: 1, processingGeneration: 0 },
      ),
    ).resolves.toMatchObject({ response: { status: "succeeded" } });
  });
});
