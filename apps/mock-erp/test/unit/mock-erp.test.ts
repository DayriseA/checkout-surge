import {
  type ErpConfirmationRequest,
  erpConfirmationLookupPath,
  erpConfirmationPath,
  erpConfirmationResponseSchema,
  erpLookupResponseSchema,
  erpReplayedResponseHeaderName,
  errorPayloadSchema,
  healthResponseSchema,
  livenessResponseSchema,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { ChaosConfirmationDecisionProvider } from "../../src/application/chaos-control-service.js";
import {
  ConfirmationIdempotencyConflictError,
  ConfirmationService,
} from "../../src/application/confirmation-service.js";
import { SlidingWindowTpsLimiter } from "../../src/application/tps-limiter.js";
import { loadMockErpConfig as loadProductionMockErpConfig } from "../../src/runtime/config.js";
import { buildMockErpServer } from "../../src/server.js";

const confirmationRequest: ErpConfirmationRequest = {
  erpConfig: { latencyMs: 0, maxTps: 100, errorRate: 0, forcedOutage: false },
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test_1",
  reservationId: "22222222-2222-4222-8222-222222222222",
  saleOfferId: "33333333-3333-4333-8333-333333333333",
  runId: "44444444-4444-4444-8444-444444444444",
  idempotencyKey: "erp-confirmation:11111111-1111-4111-8111-111111111111",
  correlationId: "corr-mock-erp-test",
  quantity: 1,
};
const loadMockErpConfig = (environment: Record<string, string | undefined>) =>
  loadProductionMockErpConfig({
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/checkout_surge_test",
    ...environment,
    NODE_ENV: "test",
  });

describe("Mock ERP configuration", () => {
  it("loads database and listener defaults", () => {
    expect(loadMockErpConfig({})).toEqual({
      host: "0.0.0.0",
      port: 4100,
      databaseUrl: "postgresql://postgres:postgres@localhost:5432/checkout_surge_test",
      postgresPoolMax: 5,
    });
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
      replayed: false,
      response: {
        status: "succeeded",
        confirmationId: "erp_confirmation_test",
        httpStatus: 200,
        latencyMs: 25,
        timestamp: "2026-06-22T00:00:00.025Z",
      },
    });
  });

  it("reuses successful confirmations by idempotency key", async () => {
    const generateConfirmationId = vi
      .fn()
      .mockReturnValueOnce("erp_confirmation_first")
      .mockReturnValueOnce("erp_confirmation_second");
    const service = new ConfirmationService({
      generateConfirmationId,
      now: sequenceClock(
        new Date("2026-06-22T00:00:00.000Z"),
        new Date("2026-06-22T00:00:00.025Z"),
      ),
    });

    const first = await service.confirm(confirmationRequest);
    const replay = await service.confirm({
      ...confirmationRequest,
      correlationId: "corr-mock-erp-replay",
    });

    expect(replay.response).toEqual(first.response);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(generateConfirmationId).toHaveBeenCalledOnce();
  });

  it("returns dependency-style failure details from the injected decision boundary", async () => {
    const service = new ConfirmationService({
      decisionProvider: {
        decide: vi.fn().mockResolvedValue({
          status: "failed",
          httpStatus: 503,
          errorCode: "erp_forced_outage",
          errorMessage: "The ERP forced-outage diagnostic control is enabled.",
        }),
      },
      now: sequenceClock(
        new Date("2026-06-22T00:00:00.000Z"),
        new Date("2026-06-22T00:00:00.040Z"),
      ),
    });

    await expect(service.confirm(confirmationRequest)).resolves.toEqual({
      replayed: false,
      response: {
        status: "failed",
        httpStatus: 503,
        errorCode: "erp_forced_outage",
        errorMessage: "The ERP forced-outage diagnostic control is enabled.",
        latencyMs: 40,
        timestamp: "2026-06-22T00:00:00.040Z",
      },
    });
  });

  it("does not cache failed decisions", async () => {
    let decisions = 0;
    const service = new ConfirmationService({
      decisionProvider: {
        decide: async () => {
          decisions += 1;
          return decisions === 1
            ? {
                status: "failed" as const,
                httpStatus: 503,
                errorCode: "erp_injected_error",
                errorMessage: "The ERP injected a configured dependency failure.",
              }
            : { status: "succeeded" as const };
        },
      },
      generateConfirmationId: () => "erp_confirmation_after_retry",
      now: () => new Date("2026-06-22T00:00:00.000Z"),
    });

    await expect(service.confirm(confirmationRequest)).resolves.toMatchObject({
      response: { status: "failed" },
    });
    await expect(service.confirm(confirmationRequest)).resolves.toMatchObject({
      response: { status: "succeeded", confirmationId: "erp_confirmation_after_retry" },
    });
    expect(decisions).toBe(2);
  });

  it("converges concurrent duplicate requests on one generated confirmation", async () => {
    const generateConfirmationId = vi.fn().mockReturnValue("erp_confirmation_concurrent");
    const decide = vi.fn().mockResolvedValue({ status: "succeeded" as const });
    const service = new ConfirmationService({
      decisionProvider: { decide },
      generateConfirmationId,
    });

    const [first, second] = await Promise.all([
      service.confirm(confirmationRequest),
      service.confirm(confirmationRequest),
    ]);

    expect(first.response).toEqual(second.response);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(decide).toHaveBeenCalledOnce();
    expect(generateConfirmationId).toHaveBeenCalledOnce();
  });

  it("shares concurrent transient failures without marking either response as replayed", async () => {
    let releaseDecision!: () => void;
    const decisionReady = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const decide = vi.fn(async () => {
      await decisionReady;
      return {
        status: "failed" as const,
        httpStatus: 503,
        errorCode: "erp_injected_error",
        errorMessage: "Try again.",
      };
    });
    const service = new ConfirmationService({ decisionProvider: { decide } });
    const confirmations = [
      service.confirm(confirmationRequest),
      service.confirm(confirmationRequest),
    ];

    releaseDecision();
    const results = await Promise.all(confirmations);

    expect(results.map((result) => result.replayed)).toEqual([false, false]);
    expect(results.every((result) => result.response.status === "failed")).toBe(true);
    expect(decide).toHaveBeenCalledOnce();
  });

  it("rejects an immutable mismatch even while the first request is in flight", async () => {
    let releaseDecision!: () => void;
    const decisionReady = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const service = new ConfirmationService({
      decisionProvider: {
        decide: vi.fn(async () => {
          await decisionReady;
          return { status: "succeeded" as const };
        }),
      },
    });
    const first = service.confirm(confirmationRequest);
    await expect(service.confirm({ ...confirmationRequest, quantity: 2 })).rejects.toBeInstanceOf(
      ConfirmationIdempotencyConflictError,
    );
    releaseDecision();
    await first;
  });

  it("rejects reuse of an idempotency key for different immutable order data", async () => {
    const service = new ConfirmationService({ generateConfirmationId: () => "erp_confirmation" });
    await service.confirm(confirmationRequest);

    await expect(service.confirm({ ...confirmationRequest, quantity: 2 })).rejects.toBeInstanceOf(
      ConfirmationIdempotencyConflictError,
    );
  });

  it("looks up the exact canonical result and leaves transient failures unknown", async () => {
    let decisions = 0;
    const service = new ConfirmationService({
      decisionProvider: {
        decide: async () => {
          decisions += 1;
          return decisions === 1
            ? {
                status: "failed" as const,
                httpStatus: 503,
                errorCode: "erp_injected_error",
                errorMessage: "Try again.",
              }
            : { status: "succeeded" as const };
        },
      },
      generateConfirmationId: () => "erp_confirmation_lookup",
      now: () => new Date("2026-06-22T00:00:00.000Z"),
    });

    await service.confirm(confirmationRequest);
    await expect(service.lookup(confirmationRequest.idempotencyKey)).resolves.toMatchObject({
      lookup: { status: "unknown" },
    });
    const confirmation = await service.confirm(confirmationRequest);
    const lookup = await service.lookup(confirmationRequest.idempotencyKey);

    expect(lookup.lookup).toMatchObject({
      status: "succeeded",
      identity: {
        orderId: confirmationRequest.orderId,
        idempotencyKey: confirmationRequest.idempotencyKey,
      },
      result: confirmation.response,
    });
  });
});

describe("chaos control service", () => {
  it("tracks request-scoped TPS windows independently by run ID", async () => {
    const provider = new ChaosConfirmationDecisionProvider({
      tpsLimiter: new SlidingWindowTpsLimiter({ nowMs: () => 500 }),
    });
    const runScopedConfig = { latencyMs: 0, maxTps: 1, errorRate: 0, forcedOutage: false };
    const firstRunRequest = {
      ...confirmationRequest,
      runId: "44444444-4444-4444-8444-444444444444",
      erpConfig: runScopedConfig,
    };
    const secondRunRequest = {
      ...confirmationRequest,
      orderId: "55555555-5555-4555-8555-555555555555",
      publicOrderId: "ord_test_2",
      idempotencyKey: "erp-confirmation:55555555-5555-4555-8555-555555555555",
      runId: "66666666-6666-4666-8666-666666666666",
      erpConfig: runScopedConfig,
    };

    await expect(provider.decide(firstRunRequest)).resolves.toEqual({ status: "succeeded" });
    await expect(provider.decide(secondRunRequest)).resolves.toEqual({ status: "succeeded" });
    await expect(provider.decide(firstRunRequest)).resolves.toMatchObject({
      status: "failed",
      httpStatus: 429,
      errorCode: "erp_capacity_exceeded",
    });
    await expect(provider.decide(secondRunRequest)).resolves.toMatchObject({
      status: "failed",
      httpStatus: 429,
      errorCode: "erp_capacity_exceeded",
    });
  });
});

describe("Mock ERP HTTP service", () => {
  it("keeps a lookup response contract-valid while graceful shutdown begins", async () => {
    const server = buildTestServer({ confirmationService: new ConfirmationService() });
    let markClosing = () => {};
    let releaseClose = () => {};
    const closingStarted = new Promise<void>((resolve) => {
      markClosing = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    // Hold the real closing phase so the public HTTP race is deterministic.
    server.addHook("preClose", async () => {
      markClosing();
      await closeGate;
    });
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const closing = server.close();
    await closingStarted;
    try {
      const response = await fetch(`${address}/confirmations/unknown-during-shutdown`, {
        signal: AbortSignal.timeout(2000),
      });
      expect(response.status).toBe(200);
      expect(erpLookupResponseSchema.parse(await response.json()).lookup.status).toBe("unknown");
      expect(response.headers.get("connection")).toBe("close");
    } finally {
      releaseClose();
      await closing;
    }
  });

  it("serves contract-valid liveness and readiness endpoints", async () => {
    const server = buildTestServer({
      confirmationService: new ConfirmationService(),
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
    const server = buildTestServer({
      confirmationService: new ConfirmationService({
        generateConfirmationId: () => "erp_confirmation_http_test",
        now: sequenceClock(
          new Date("2026-06-22T00:00:00.000Z"),
          new Date("2026-06-22T00:00:00.010Z"),
        ),
      }),
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
    const server = buildTestServer({
      confirmationService: new ConfirmationService({
        decisionProvider: {
          decide: async () => ({
            status: "failed",
            httpStatus: 503,
            errorCode: "erp_forced_outage",
            errorMessage: "The ERP forced-outage diagnostic control is enabled.",
          }),
        },
      }),
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
      errorCode: "erp_forced_outage",
    });
  });

  it("returns 409 for an idempotency key conflict", async () => {
    const server = buildTestServer({ confirmationService: new ConfirmationService() });
    await server.inject({ method: "POST", url: erpConfirmationPath, payload: confirmationRequest });
    const conflict = await server.inject({
      method: "POST",
      url: erpConfirmationPath,
      payload: { ...confirmationRequest, quantity: 2 },
    });
    await server.close();

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "erp_idempotency_conflict" });
  });

  it("signals replay only by header and exposes the canonical result through lookup", async () => {
    const server = buildTestServer({
      confirmationService: new ConfirmationService({
        generateConfirmationId: () => "erp_confirmation_replayed",
        now: () => new Date("2026-06-22T00:00:00.010Z"),
      }),
    });
    const first = await server.inject({
      method: "POST",
      url: erpConfirmationPath,
      payload: confirmationRequest,
    });
    const replay = await server.inject({
      method: "POST",
      url: erpConfirmationPath,
      payload: { ...confirmationRequest, correlationId: "corr-replay" },
    });
    const lookup = await server.inject({
      method: "GET",
      url: erpConfirmationLookupPath.replace(
        ":idempotencyKey",
        encodeURIComponent(confirmationRequest.idempotencyKey),
      ),
    });
    await server.close();

    expect(first.headers[erpReplayedResponseHeaderName]).toBeUndefined();
    expect(replay.headers[erpReplayedResponseHeaderName]).toBe("true");
    expect(replay.body).toBe(first.body);
    expect(erpLookupResponseSchema.parse(lookup.json())).toMatchObject({
      lookup: { status: "succeeded", result: first.json() },
    });
  });

  it("accepts the contract maximum idempotency key in POST and lookup routes", async () => {
    const idempotencyKey = "k".repeat(200);
    const server = buildTestServer({ confirmationService: new ConfirmationService() });
    const confirmation = await server.inject({
      method: "POST",
      url: erpConfirmationPath,
      payload: { ...confirmationRequest, idempotencyKey },
    });
    const lookup = await server.inject({
      method: "GET",
      url: erpConfirmationLookupPath.replace(":idempotencyKey", idempotencyKey),
    });
    await server.close();

    expect(confirmation.statusCode).toBe(200);
    expect(lookup.statusCode).toBe(200);
    expect(erpLookupResponseSchema.parse(lookup.json())).toMatchObject({
      lookup: { status: "succeeded", identity: { idempotencyKey } },
    });
  });

  it("keeps lookup outside chaos and TPS decisions", async () => {
    const decide = new ChaosConfirmationDecisionProvider({
      tpsLimiter: new SlidingWindowTpsLimiter({ nowMs: () => 500 }),
    });
    const server = buildTestServer({
      confirmationService: new ConfirmationService({ decisionProvider: decide }),
    });
    const lookupUrl = erpConfirmationLookupPath.replace(
      ":idempotencyKey",
      encodeURIComponent("erp-confirmation:unknown"),
    );

    expect((await server.inject({ method: "GET", url: lookupUrl })).statusCode).toBe(200);
    expect(
      (
        await server.inject({
          method: "POST",
          url: erpConfirmationPath,
          payload: confirmationRequest,
        })
      ).statusCode,
    ).toBe(200);
    const lookup = await server.inject({
      method: "GET",
      url: erpConfirmationLookupPath.replace(
        ":idempotencyKey",
        encodeURIComponent(confirmationRequest.idempotencyKey),
      ),
    });
    await server.close();

    expect(lookup.statusCode).toBe(200);
    expect(erpLookupResponseSchema.parse(lookup.json()).lookup.status).toBe("succeeded");
  });

  it("rejects invalid requests with the shared error contract", async () => {
    const server = buildTestServer({
      confirmationService: new ConfirmationService(),
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

function buildTestServer(options: { confirmationService: ConfirmationService; startedAt?: Date }) {
  return buildMockErpServer({
    confirmationService: options.confirmationService,

    logger: createSilentLogger("mock-erp"),
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
  });
}
