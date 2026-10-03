import {
  controlServiceTokenHeaderName,
  type TrafficExecutionStartRequest,
  trafficExecutionStartPath,
  trafficExecutionStatusPath,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { ApiHttpError } from "../../src/runtime/errors.js";
import { HttpTrafficExecutionGateway } from "../../src/services/traffic-execution-gateway.js";

const request: TrafficExecutionStartRequest = {
  runId: "55555555-5555-4555-8555-555555555555",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  apiBaseUrl: "http://api.test",
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
    inventoryConfig: { startingStock: 1 },
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

function successfulStartResponse(
  overrides: Partial<{
    runId: string;
    status: "starting" | "active";
    startedAt: string;
    correlationId: string;
  }> = {},
): Response {
  return Response.json(
    {
      runId: request.runId,
      status: "active",
      startedAt: "2026-06-20T00:00:11.000Z",
      correlationId: request.correlationId,
      ...overrides,
    },
    { status: 202 },
  );
}

function unknownStatusResponse(): Response {
  return Response.json({
    runId: request.runId,
    state: "unknown",
    bootId: "11111111-1111-4111-8111-111111111111",
    version: "unknown",
    observedAt: "2026-06-20T00:00:09.000Z",
    correlationId: request.correlationId,
  });
}

function acceptedStatusResponse(): Response {
  return Response.json({
    runId: request.runId,
    state: "accepted",
    bootId: "11111111-1111-4111-8111-111111111111",
    version: "unknown",
    acceptedAt: "2026-06-20T00:00:01.000Z",
    observedAt: "2026-06-20T00:00:09.000Z",
    correlationId: request.correlationId,
  });
}

describe("HttpTrafficExecutionGateway start", () => {
  it("sends the validated request with service authentication and canonical correlation", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successfulStartResponse());
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test/",
      controlServiceToken: "control-token",
      fetch: fetchMock,
    });

    await expect(gateway.start(request)).resolves.toMatchObject({
      runId: request.runId,
      correlationId: request.correlationId,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://load.test${trafficExecutionStartPath}`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          [correlationIdHeaderName]: request.correlationId,
          [controlServiceTokenHeaderName]: "control-token",
          "content-type": "application/json",
        }),
        body: JSON.stringify(request),
      }),
    );
  });

  it.each([
    ["run ID", { runId: "66666666-6666-4666-8666-666666666666" }],
    ["correlation ID", { correlationId: "different-correlation" }],
  ])("rejects a start confirmation bound to a different %s", async (_field, overrides) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(successfulStartResponse(overrides))
      .mockResolvedValueOnce(unknownStatusResponse());
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "control-token",
      fetch: fetchMock,
    });

    await expect(gateway.start(request)).rejects.toMatchObject({
      code: "load_orchestrator_start_ambiguous",
    });
  });

  it("recovers a malformed successful start response only through exact durable status", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(unknownStatusResponse());
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "control-token",
      fetch: fetchMock,
    });

    await expect(gateway.start(request)).rejects.toMatchObject({
      code: "load_orchestrator_start_ambiguous",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers a server-side start failure from exact durable accepted status", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ code: "internal_error" }, { status: 500 }))
      .mockResolvedValueOnce(acceptedStatusResponse());
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "control-token",
      fetch: fetchMock,
    });

    await expect(gateway.start(request)).resolves.toMatchObject({
      runId: request.runId,
      status: "starting",
      correlationId: request.correlationId,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an unconfirmed server-side start failure ambiguous", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ code: "internal_error" }, { status: 503 }))
      .mockResolvedValueOnce(unknownStatusResponse());
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "control-token",
      fetch: fetchMock,
    });

    await expect(gateway.start(request)).rejects.toMatchObject({
      code: "load_orchestrator_start_ambiguous",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a definitive client-side start rejection unavailable", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ code: "traffic_execution_conflict" }, { status: 409 }),
      );
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "control-token",
      fetch: fetchMock,
    });

    await expect(gateway.start(request)).rejects.toMatchObject({
      code: "load_orchestrator_unavailable",
      details: { statusCode: 409 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds successful start response parsing before status recovery", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start() {
              // Headers arrive, but the successful response body intentionally never closes.
            },
          }),
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(unknownStatusResponse());
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "control-token",
      requestTimeoutMs: 2,
      fetch: fetchMock,
    });

    await expect(gateway.start(request)).rejects.toMatchObject({
      code: "load_orchestrator_start_ambiguous",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

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
            bootId: "11111111-1111-4111-8111-111111111111",
            version: "unknown",
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
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `http://load.test${trafficExecutionStatusPath.replace(":runId", request.runId)}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          [correlationIdHeaderName]: request.correlationId,
          [controlServiceTokenHeaderName]: "token",
        }),
      }),
    );
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
            bootId: "11111111-1111-4111-8111-111111111111",
            version: "unknown",
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

  it("rejects malformed recovery safely", async () => {
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

  it.each([
    ["run ID", { runId: "66666666-6666-4666-8666-666666666666" }],
    ["correlation ID", { correlationId: "different-correlation" }],
  ])("rejects durable status bound to a different %s", async (_field, overrides) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(
        Response.json({
          runId: request.runId,
          state: "accepted",
          bootId: "11111111-1111-4111-8111-111111111111",
          version: "unknown",
          acceptedAt: "2026-06-20T00:00:01.000Z",
          observedAt: "2026-06-20T00:00:09.000Z",
          correlationId: request.correlationId,
          ...overrides,
        }),
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

  it("bounds durable status response parsing", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start() {
              // Headers arrive, but the status body intentionally never closes.
            },
          }),
        ),
      );
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "token",
      requestTimeoutMs: 2,
      fetch: fetchMock,
    });

    await expect(gateway.start(request)).rejects.toMatchObject({
      code: "load_orchestrator_start_ambiguous",
    });
  });
});

describe("HttpTrafficExecutionGateway abort", () => {
  const abortInput = {
    runId: request.runId,
    reason: "admin_reset",
    correlationId: "abort-correlation",
  };

  it.each([
    "current_run_aborted",
    "no_current_run",
  ] as const)("sends the authenticated fenced request and parses %s", async (outcome) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        outcome,
        requestedRunId: request.runId,
        ...(outcome === "current_run_aborted" ? { abortedRunId: request.runId } : {}),
        observedAt: "2026-07-13T00:00:00.000Z",
        correlationId: abortInput.correlationId,
      }),
    );
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "control-token",
      fetch: fetchMock,
    });

    await expect(gateway.abortCurrent(abortInput)).resolves.toMatchObject({ outcome });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://load.test/traffic/current/abort",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-control-service-token": "control-token",
          "x-correlation-id": abortInput.correlationId,
          "content-type": "application/json",
        }),
        body: JSON.stringify(abortInput),
      }),
    );
  });

  it("preserves a run mismatch as a sanitized 409", async () => {
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "secret-token",
      fetch: async () => new Response("secret-token internal details", { status: 409 }),
    });
    await expect(gateway.abortCurrent(abortInput)).rejects.toMatchObject({
      statusCode: 409,
      code: "load_orchestrator_run_mismatch",
    });
  });

  it.each([
    [
      "network",
      async () => Promise.reject(new Error("network secret")),
      "load_orchestrator_abort_unconfirmed",
    ],
    [
      "server",
      async () => new Response("upstream secret", { status: 503 }),
      "load_orchestrator_abort_unconfirmed",
    ],
    ["malformed", async () => Response.json({}), "load_orchestrator_unavailable"],
  ] as const)("maps %s failures without exposing upstream details", async (_name, fetchImpl, code) => {
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "secret-token",
      fetch: fetchImpl as typeof fetch,
    });
    const rejection = gateway.abortCurrent(abortInput);
    await expect(rejection).rejects.toMatchObject({ statusCode: 502, code });
    await expect(rejection).rejects.not.toThrow(/secret/);
  });

  it("bounds an abort request timeout", async () => {
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "secret-token",
      abortRequestTimeoutMs: 2,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    await expect(gateway.abortCurrent(abortInput)).rejects.toMatchObject({
      statusCode: 502,
      code: "load_orchestrator_abort_unconfirmed",
    });
  });

  it("bounds a successful response whose body never completes", async () => {
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "secret-token",
      abortRequestTimeoutMs: 2,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start() {
              // Headers arrive, but the success body intentionally never closes.
            },
          }),
          { status: 200 },
        ),
    });
    await expect(gateway.abortCurrent(abortInput)).rejects.toMatchObject({
      statusCode: 502,
      code: "load_orchestrator_abort_unconfirmed",
    });
  });
});
