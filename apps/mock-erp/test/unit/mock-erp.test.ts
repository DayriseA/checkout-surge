import {
  controlServiceTokenHeaderName,
  type ErpConfirmationRequest,
  erpChaosResetPath,
  erpChaosStatusPath,
  erpChaosStatusSchema,
  erpConfirmationPath,
  erpConfirmationResponseSchema,
  errorPayloadSchema,
  healthResponseSchema,
  livenessResponseSchema,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import {
  ChaosConfirmationDecisionProvider,
  ErpChaosConfigSafetyError,
  ErpChaosConfigStore,
} from "../../src/application/chaos-control-service.js";
import { ConfirmationService } from "../../src/application/confirmation-service.js";
import { loadMockErpConfig } from "../../src/runtime/config.js";
import { buildMockErpServer } from "../../src/server.js";

const confirmationRequest: ErpConfirmationRequest = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test_1",
  reservationId: "22222222-2222-4222-8222-222222222222",
  saleOfferId: "33333333-3333-4333-8333-333333333333",
  runId: "44444444-4444-4444-8444-444444444444",
  idempotencyKey: "erp-confirmation:11111111-1111-4111-8111-111111111111",
  correlationId: "corr-mock-erp-test",
  quantity: 1,
};
const defaultChaosConfig = {
  latencyMs: 0,
  maxTps: 100,
  errorRate: 0,
  forcedOutage: false,
};
const testSafetyCaps = {
  maxLatencyMs: 5000,
  minMaxTps: 1,
  maxErrorRate: 1,
  allowForcedOutage: true,
};
const controlServiceToken = "test-control-token";

describe("Mock ERP configuration", () => {
  it("loads host-native defaults and explicit overrides", () => {
    expect(loadMockErpConfig({ CONTROL_SERVICE_TOKEN: controlServiceToken })).toEqual({
      host: "0.0.0.0",
      port: 4100,
      controlServiceToken,
      defaultChaosConfig,
      chaosSafetyCaps: testSafetyCaps,
    });
    expect(
      loadMockErpConfig({
        HOST: "127.0.0.1",
        PORT: "5100",
        CONTROL_SERVICE_TOKEN: controlServiceToken,
        LATENCY_MS: "25",
        MAX_TPS: "3",
        ERROR_RATE: "0.5",
        FORCED_OUTAGE: "true",
        ADMIN_MAX_LATENCY_MS: "1000",
        ADMIN_MIN_MAX_TPS: "2",
        ADMIN_MAX_ERROR_RATE: "0.75",
        ADMIN_ALLOW_FORCED_OUTAGE: "false",
      }),
    ).toEqual({
      host: "127.0.0.1",
      port: 5100,
      controlServiceToken,
      defaultChaosConfig: {
        latencyMs: 25,
        maxTps: 3,
        errorRate: 0.5,
        forcedOutage: true,
      },
      chaosSafetyCaps: {
        maxLatencyMs: 1000,
        minMaxTps: 2,
        maxErrorRate: 0.75,
        allowForcedOutage: false,
      },
    });
  });

  it("requires a control service token", () => {
    expect(() => loadMockErpConfig({})).toThrow("CONTROL_SERVICE_TOKEN is required");
  });

  it("rejects an invalid port", () => {
    expect(() =>
      loadMockErpConfig({ CONTROL_SERVICE_TOKEN: controlServiceToken, PORT: "0" }),
    ).toThrow("PORT must be a positive integer");
    expect(() =>
      loadMockErpConfig({ CONTROL_SERVICE_TOKEN: controlServiceToken, PORT: "invalid" }),
    ).toThrow("PORT must be a positive integer");
  });

  it("rejects invalid chaos environment values", () => {
    expect(() =>
      loadMockErpConfig({ CONTROL_SERVICE_TOKEN: controlServiceToken, ERROR_RATE: "2" }),
    ).toThrow("ERROR_RATE must be a number from 0 to 1");
    expect(() =>
      loadMockErpConfig({ CONTROL_SERVICE_TOKEN: controlServiceToken, FORCED_OUTAGE: "yes" }),
    ).toThrow("FORCED_OUTAGE must be true or false");
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

    expect(replay).toEqual(first);
    expect(generateConfirmationId).toHaveBeenCalledOnce();
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

describe("chaos control service", () => {
  it("tracks config status and rejects values outside admin safety caps", () => {
    const store = new ErpChaosConfigStore(
      defaultChaosConfig,
      testSafetyCaps,
      () => new Date("2026-06-22T00:00:00.000Z"),
    );

    expect(store.getStatus()).toEqual({
      ...defaultChaosConfig,
      updatedAt: "2026-06-22T00:00:00.000Z",
    });

    expect(() =>
      store.update({ latencyMs: 5001, maxTps: 100, errorRate: 0, forcedOutage: false }),
    ).toThrow(ErpChaosConfigSafetyError);
  });

  it("applies configured latency before returning a successful decision", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const store = new ErpChaosConfigStore(
      { latencyMs: 125, maxTps: 100, errorRate: 0, forcedOutage: false },
      testSafetyCaps,
    );
    const provider = new ChaosConfirmationDecisionProvider({ configStore: store, sleep });

    await expect(provider.decide(confirmationRequest)).resolves.toEqual({ status: "succeeded" });
    expect(sleep).toHaveBeenCalledWith(125);
  });

  it("prefers request-scoped ERP config over the operator chaos store", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const store = new ErpChaosConfigStore(
      { latencyMs: 125, maxTps: 100, errorRate: 0, forcedOutage: true },
      testSafetyCaps,
    );
    const provider = new ChaosConfirmationDecisionProvider({ configStore: store, sleep });

    await expect(
      provider.decide({
        ...confirmationRequest,
        erpConfig: { latencyMs: 0, maxTps: 100, errorRate: 0, forcedOutage: false },
      }),
    ).resolves.toEqual({ status: "succeeded" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throttles confirmations beyond the configured TPS cap", async () => {
    const store = new ErpChaosConfigStore(
      { latencyMs: 0, maxTps: 1, errorRate: 0, forcedOutage: false },
      testSafetyCaps,
    );
    const provider = new ChaosConfirmationDecisionProvider({
      configStore: store,
      now: () => new Date("2026-06-22T00:00:00.500Z"),
    });

    await expect(provider.decide(confirmationRequest)).resolves.toEqual({ status: "succeeded" });
    await expect(provider.decide(confirmationRequest)).resolves.toMatchObject({
      status: "failed",
      httpStatus: 429,
      errorCode: "erp_capacity_exceeded",
    });
  });

  it("tracks request-scoped TPS windows independently by run ID", async () => {
    const store = new ErpChaosConfigStore(defaultChaosConfig, testSafetyCaps);
    const provider = new ChaosConfirmationDecisionProvider({
      configStore: store,
      now: () => new Date("2026-06-22T00:00:00.500Z"),
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

  it("keeps global traffic out of a run-scoped TPS window", async () => {
    const store = new ErpChaosConfigStore(
      { latencyMs: 0, maxTps: 1, errorRate: 0, forcedOutage: false },
      testSafetyCaps,
    );
    const provider = new ChaosConfirmationDecisionProvider({
      configStore: store,
      now: () => new Date("2026-06-22T00:00:00.500Z"),
    });
    const globalRequest = {
      ...confirmationRequest,
      runId: undefined,
    };

    await expect(provider.decide(confirmationRequest)).resolves.toEqual({ status: "succeeded" });
    await expect(provider.decide(globalRequest)).resolves.toEqual({ status: "succeeded" });
    await expect(provider.decide(confirmationRequest)).resolves.toMatchObject({
      status: "failed",
      httpStatus: 429,
      errorCode: "erp_capacity_exceeded",
    });
    await expect(provider.decide(globalRequest)).resolves.toMatchObject({
      status: "failed",
      httpStatus: 429,
      errorCode: "erp_capacity_exceeded",
    });
  });

  it("separates no-run TPS windows for materially different request-scoped configs", async () => {
    const store = new ErpChaosConfigStore(defaultChaosConfig, testSafetyCaps);
    const provider = new ChaosConfirmationDecisionProvider({
      configStore: store,
      now: () => new Date("2026-06-22T00:00:00.500Z"),
      random: () => 1,
    });
    const firstConfigRequest = {
      ...confirmationRequest,
      runId: undefined,
      erpConfig: { latencyMs: 0, maxTps: 1, errorRate: 0, forcedOutage: false },
    };
    const secondConfigRequest = {
      ...confirmationRequest,
      orderId: "55555555-5555-4555-8555-555555555555",
      publicOrderId: "ord_test_2",
      idempotencyKey: "erp-confirmation:55555555-5555-4555-8555-555555555555",
      runId: undefined,
      erpConfig: { latencyMs: 0, maxTps: 1, errorRate: 0.25, forcedOutage: false },
    };

    await expect(provider.decide(firstConfigRequest)).resolves.toEqual({ status: "succeeded" });
    await expect(provider.decide(secondConfigRequest)).resolves.toEqual({ status: "succeeded" });
    await expect(provider.decide(firstConfigRequest)).resolves.toMatchObject({
      status: "failed",
      httpStatus: 429,
      errorCode: "erp_capacity_exceeded",
    });
    await expect(provider.decide(secondConfigRequest)).resolves.toMatchObject({
      status: "failed",
      httpStatus: 429,
      errorCode: "erp_capacity_exceeded",
    });
  });

  it("returns forced errors and forced outage failures", async () => {
    const errorStore = new ErpChaosConfigStore(
      { latencyMs: 0, maxTps: 100, errorRate: 1, forcedOutage: false },
      testSafetyCaps,
    );
    const outageStore = new ErpChaosConfigStore(
      { latencyMs: 0, maxTps: 100, errorRate: 0, forcedOutage: true },
      testSafetyCaps,
    );

    await expect(
      new ChaosConfirmationDecisionProvider({
        configStore: errorStore,
        random: () => 0,
      }).decide(confirmationRequest),
    ).resolves.toMatchObject({
      status: "failed",
      httpStatus: 503,
      errorCode: "erp_injected_error",
    });
    await expect(
      new ChaosConfirmationDecisionProvider({ configStore: outageStore }).decide(
        confirmationRequest,
      ),
    ).resolves.toMatchObject({
      status: "failed",
      httpStatus: 503,
      errorCode: "erp_forced_outage",
    });
  });
});

describe("Mock ERP HTTP service", () => {
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
            errorCode: "erp_unavailable",
            errorMessage: "The ERP is temporarily unavailable.",
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
      errorCode: "erp_unavailable",
    });
  });

  it("applies configured latency through the HTTP confirmation boundary", async () => {
    const server = buildChaosServer({
      chaosConfigStore: new ErpChaosConfigStore(
        { latencyMs: 25, maxTps: 100, errorRate: 0, forcedOutage: false },
        testSafetyCaps,
      ),
      serviceNow: sequenceClock(
        new Date("2026-06-22T00:00:00.000Z"),
        new Date("2026-06-22T00:00:00.025Z"),
      ),
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    const response = await server.inject({
      method: "POST",
      url: erpConfirmationPath,
      payload: confirmationRequest,
    });
    await server.close();

    expect(response.statusCode).toBe(200);
    expect(erpConfirmationResponseSchema.parse(response.json())).toMatchObject({
      status: "succeeded",
      latencyMs: 25,
    });
  });

  it("throttles confirmations through the HTTP confirmation boundary", async () => {
    const server = buildChaosServer({
      chaosConfigStore: new ErpChaosConfigStore(
        { latencyMs: 0, maxTps: 1, errorRate: 0, forcedOutage: false },
        testSafetyCaps,
      ),
      providerNow: () => new Date("2026-06-22T00:00:00.000Z"),
      serviceNow: sequenceClock(
        new Date("2026-06-22T00:00:00.000Z"),
        new Date("2026-06-22T00:00:00.000Z"),
        new Date("2026-06-22T00:00:00.100Z"),
        new Date("2026-06-22T00:00:00.100Z"),
      ),
    });

    const first = await server.inject({
      method: "POST",
      url: erpConfirmationPath,
      payload: confirmationRequest,
    });
    const second = await server.inject({
      method: "POST",
      url: erpConfirmationPath,
      payload: {
        ...confirmationRequest,
        orderId: "55555555-5555-4555-8555-555555555555",
        publicOrderId: "ord_test_2",
        idempotencyKey: "erp-confirmation:55555555-5555-4555-8555-555555555555",
      },
    });
    await server.close();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(erpConfirmationResponseSchema.parse(second.json())).toMatchObject({
      status: "failed",
      errorCode: "erp_capacity_exceeded",
    });
  });

  it("returns forced error and forced outage responses through HTTP", async () => {
    const forcedErrorServer = buildChaosServer({
      chaosConfigStore: new ErpChaosConfigStore(
        { latencyMs: 0, maxTps: 100, errorRate: 1, forcedOutage: false },
        testSafetyCaps,
      ),
      random: () => 0,
    });
    const forcedError = await forcedErrorServer.inject({
      method: "POST",
      url: erpConfirmationPath,
      payload: confirmationRequest,
    });
    await forcedErrorServer.close();

    const forcedOutageServer = buildChaosServer({
      chaosConfigStore: new ErpChaosConfigStore(
        { latencyMs: 0, maxTps: 100, errorRate: 0, forcedOutage: true },
        testSafetyCaps,
      ),
    });
    const forcedOutage = await forcedOutageServer.inject({
      method: "POST",
      url: erpConfirmationPath,
      payload: confirmationRequest,
    });
    await forcedOutageServer.close();

    expect(forcedError.statusCode).toBe(503);
    expect(erpConfirmationResponseSchema.parse(forcedError.json())).toMatchObject({
      status: "failed",
      errorCode: "erp_injected_error",
    });
    expect(forcedOutage.statusCode).toBe(503);
    expect(erpConfirmationResponseSchema.parse(forcedOutage.json())).toMatchObject({
      status: "failed",
      errorCode: "erp_forced_outage",
    });
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

  it("exposes chaos status as a public read", async () => {
    const server = buildTestServer({
      confirmationService: new ConfirmationService(),
      chaosConfigStore: new ErpChaosConfigStore(
        { latencyMs: 15, maxTps: 7, errorRate: 0.25, forcedOutage: false },
        testSafetyCaps,
        () => new Date("2026-06-22T00:00:00.000Z"),
      ),
    });

    const response = await server.inject({ method: "GET", url: erpChaosStatusPath });
    await server.close();

    expect(response.statusCode).toBe(200);
    expect(erpChaosStatusSchema.parse(response.json())).toEqual({
      latencyMs: 15,
      maxTps: 7,
      errorRate: 0.25,
      forcedOutage: false,
      updatedAt: "2026-06-22T00:00:00.000Z",
    });
  });

  it("protects chaos updates with the control service token", async () => {
    const server = buildTestServer({ confirmationService: new ConfirmationService() });

    const response = await server.inject({
      method: "PUT",
      url: erpChaosStatusPath,
      payload: { latencyMs: 10, maxTps: 10, errorRate: 0, forcedOutage: false },
    });
    await server.close();

    expect(response.statusCode).toBe(401);
    expect(errorPayloadSchema.parse(response.json())).toMatchObject({
      code: "control_token_required",
    });
  });

  it("updates and resets chaos controls within configured caps", async () => {
    const store = new ErpChaosConfigStore(
      { latencyMs: 1, maxTps: 100, errorRate: 0, forcedOutage: false },
      testSafetyCaps,
      sequenceClock(
        new Date("2026-06-22T00:00:00.000Z"),
        new Date("2026-06-22T00:00:01.000Z"),
        new Date("2026-06-22T00:00:02.000Z"),
      ),
    );
    const server = buildTestServer({
      confirmationService: new ConfirmationService(),
      chaosConfigStore: store,
    });

    const update = await server.inject({
      method: "PUT",
      url: erpChaosStatusPath,
      headers: { [controlServiceTokenHeaderName]: controlServiceToken },
      payload: { latencyMs: 250, maxTps: 5, errorRate: 0.5, forcedOutage: true },
    });
    const reset = await server.inject({
      method: "POST",
      url: erpChaosResetPath,
      headers: { [controlServiceTokenHeaderName]: controlServiceToken },
    });
    await server.close();

    expect(update.statusCode).toBe(200);
    expect(erpChaosStatusSchema.parse(update.json())).toEqual({
      latencyMs: 250,
      maxTps: 5,
      errorRate: 0.5,
      forcedOutage: true,
      updatedAt: "2026-06-22T00:00:01.000Z",
    });
    expect(reset.statusCode).toBe(200);
    expect(erpChaosStatusSchema.parse(reset.json())).toEqual({
      latencyMs: 1,
      maxTps: 100,
      errorRate: 0,
      forcedOutage: false,
      updatedAt: "2026-06-22T00:00:02.000Z",
    });
  });

  it("rejects chaos updates above configured caps", async () => {
    const server = buildTestServer({
      confirmationService: new ConfirmationService(),
      chaosConfigStore: new ErpChaosConfigStore(defaultChaosConfig, {
        ...testSafetyCaps,
        maxLatencyMs: 100,
      }),
    });

    const response = await server.inject({
      method: "PUT",
      url: erpChaosStatusPath,
      headers: { [controlServiceTokenHeaderName]: controlServiceToken },
      payload: { latencyMs: 101, maxTps: 10, errorRate: 0, forcedOutage: false },
    });
    await server.close();

    expect(response.statusCode).toBe(400);
    expect(errorPayloadSchema.parse(response.json())).toMatchObject({
      code: "chaos_config_exceeds_caps",
      details: { latencyMs: { maximum: 100, actual: 101 } },
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

function buildTestServer(options: {
  confirmationService: ConfirmationService;
  chaosConfigStore?: ErpChaosConfigStore;
  startedAt?: Date;
}) {
  return buildMockErpServer({
    confirmationService: options.confirmationService,
    chaosConfigStore:
      options.chaosConfigStore ?? new ErpChaosConfigStore(defaultChaosConfig, testSafetyCaps),
    controlServiceToken,
    logger: createSilentLogger("mock-erp"),
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
  });
}

function buildChaosServer(options: {
  chaosConfigStore: ErpChaosConfigStore;
  providerNow?: () => Date;
  serviceNow?: () => Date;
  random?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
}) {
  return buildTestServer({
    confirmationService: new ConfirmationService({
      decisionProvider: new ChaosConfirmationDecisionProvider({
        configStore: options.chaosConfigStore,
        ...(options.providerNow ? { now: options.providerNow } : {}),
        ...(options.random ? { random: options.random } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
      }),
      ...(options.serviceNow ? { now: options.serviceNow } : {}),
    }),
    chaosConfigStore: options.chaosConfigStore,
  });
}
