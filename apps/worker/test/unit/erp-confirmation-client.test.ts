import type { ErpCallReference } from "@checkout-surge/contracts";
import { type CheckoutSurgeLogger, correlationIdHeaderName } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import {
  ErpAcceptedConfirmationPersistenceError,
  type ErpAttemptPersistence,
  ErpConfirmationInvalidResponseError,
  HttpErpOrderConfirmation,
} from "../../src/application/erp-confirmation-client.js";
import type { OrderProcessDeliveryMetadata } from "../../src/application/order-process-job-handler.js";

const job = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_worker_erp_client",
  reservationId: "22222222-2222-4222-8222-222222222222",
  saleOfferId: "33333333-3333-4333-8333-333333333333",
  runId: "44444444-4444-4444-8444-444444444444",
  correlationId: "corr-worker-erp-client",
  quantity: 1,
  queuedAt: "2026-06-22T00:00:00.000Z",
};
const delivery: OrderProcessDeliveryMetadata = {
  attemptNumber: 2,
  attemptsMade: 1,
  maxAttempts: 3,
  processingGeneration: 7,
};
const call: ErpCallReference = {
  erpCallId: "99999999-9999-4999-8999-999999999999",
  orderId: job.orderId,
  idempotencyKey: `erp-confirmation:${job.orderId}`,
  processingGeneration: 7,
  dispatchedAt: "2026-06-22T00:00:00.000Z",
};

describe("HTTP ERP confirmation outcomes", () => {
  it.each([
    {
      name: "success",
      status: 200,
      body: successResponse(),
      disposition: "succeeded",
      interventionScope: undefined,
    },
    {
      name: "capacity",
      status: 429,
      body: failedResponse(429, "erp_capacity_exceeded"),
      disposition: "capacity_rejected",
      interventionScope: undefined,
    },
    {
      name: "forced outage",
      status: 503,
      body: failedResponse(503, "erp_forced_outage"),
      disposition: "temporarily_unavailable",
      interventionScope: undefined,
    },
    {
      name: "injected error",
      status: 503,
      body: failedResponse(503, "erp_injected_error"),
      disposition: "temporarily_unavailable",
      interventionScope: undefined,
    },
    {
      name: "idempotency conflict",
      status: 409,
      body: { code: "erp_idempotency_conflict", message: "Conflict" },
      disposition: "intervention_required",
      interventionScope: "order",
    },
    {
      name: "authorization",
      status: 403,
      body: { code: "forbidden", message: "Forbidden" },
      disposition: "intervention_required",
      interventionScope: "scope",
    },
    {
      name: "unknown 4xx code",
      status: 422,
      body: failedResponse(422, "erp_unknown_business_code"),
      disposition: "intervention_required",
      interventionScope: "order",
    },
    {
      name: "opaque 5xx",
      status: 500,
      body: { code: "internal_error", message: "Opaque" },
      disposition: "intervention_required",
      interventionScope: "order",
    },
    {
      name: "status-mismatched recognized availability",
      status: 500,
      body: failedResponse(503, "erp_forced_outage"),
      disposition: "intervention_required",
      interventionScope: "order",
    },
    {
      name: "malformed response",
      status: 200,
      body: { bad: true },
      disposition: "intervention_required",
      interventionScope: "order",
    },
  ] as const)("classifies $name without broad permanent rejection", async (testCase) => {
    const persistence = attemptPersistence();
    const client = createClient({
      persistence,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(testCase.body, testCase.status)),
    });

    const outcome = await client.dispatch(job, delivery);

    expect(outcome).toMatchObject({
      disposition: testCase.disposition,
      operation: "dispatched_confirmation",
      call,
      ...(testCase.interventionScope ? { interventionScope: testCase.interventionScope } : {}),
    });
    expect(outcome.disposition).not.toBe("permanent_rejection");
    expect(persistence.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "dispatched_confirmation",
        disposition: testCase.disposition,
        terminal: testCase.disposition === "succeeded",
      }),
    );
  });

  it("records dispatch identity before sending the contract request", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(successResponse(), 200));
    const persistence = attemptPersistence();
    const client = createClient({ persistence, fetch });

    await client.dispatch(job, delivery);

    expect(persistence.recordDispatchIntent).toHaveBeenCalledWith({
      job,
      idempotencyKey: call.idempotencyKey,
      dispatchedAt: new Date("2026-06-22T00:00:00.000Z"),
      expectedProcessingGeneration: 7,
    });
    const request = fetch.mock.calls[0];
    expect(request?.[0]).toEqual(new URL("http://mock-erp:4100/confirmations"));
    expect(request?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ [correlationIdHeaderName]: job.correlationId }),
    });
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      orderId: job.orderId,
      idempotencyKey: call.idempotencyKey,
    });
  });

  it.each([
    ["delay seconds", "2", 2_000],
    ["HTTP date", "Mon, 22 Jun 2026 00:00:03 GMT", 2_965],
    ["invalid", "later", 750],
    ["negative", "-1", 750],
    ["fractional", "1.5", 750],
    ["non-IMF date", "Sunday, 06-Nov-94 08:49:37 GMT", 750],
  ])("parses %s Retry-After guidance", async (_name, retryAfter, expectedMs) => {
    const client = createClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(failedResponse(429, "erp_capacity_exceeded"), 429, {
          "retry-after": retryAfter,
        }),
      ),
    });
    await expect(client.dispatch(job, delivery)).resolves.toMatchObject({
      disposition: "capacity_rejected",
      retryAfterMs: expectedMs,
    });
  });

  it("caps oversized Retry-After guidance and logs the cap", async () => {
    const logger = { warn: vi.fn() };
    const client = createClient({
      logger,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(failedResponse(503, "erp_forced_outage"), 503, {
          "retry-after": "120",
        }),
      ),
    });

    await expect(client.dispatch(job, delivery)).resolves.toMatchObject({ retryAfterMs: 5_000 });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("captures replay metadata outside canonical JSON", async () => {
    const body = successResponse();
    const client = createClient({
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse(body, 200, { "x-erp-replayed": "true" })),
    });

    await expect(client.dispatch(job, delivery)).resolves.toMatchObject({
      disposition: "succeeded",
      replayed: true,
      response: body,
    });
    expect(body).not.toHaveProperty("replayed");
  });

  it("keeps a timeout after dispatch uncertain and a connection failure unavailable", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const timedOut = createClient({ fetch: vi.fn<typeof fetch>().mockRejectedValue(abort) });
    const unavailable = createClient({
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNREFUSED")),
    });

    await expect(timedOut.dispatch(job, delivery)).resolves.toMatchObject({
      disposition: "uncertain_result",
      errorCode: "erp_request_timeout",
    });
    await expect(unavailable.dispatch(job, delivery)).resolves.toMatchObject({
      disposition: "temporarily_unavailable",
      errorCode: "erp_request_failed",
    });
  });

  it("records body-read connection loss as availability without authoritative response evidence", async () => {
    const persistence = attemptPersistence();
    const response = jsonResponse(successResponse(), 200);
    vi.spyOn(response, "json").mockRejectedValue(new TypeError("terminated"));
    const client = createClient({
      persistence,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
    });

    const outcome = await client.dispatch(job, delivery);

    expect(outcome).toMatchObject({
      disposition: "temporarily_unavailable",
      errorCode: "erp_request_failed",
    });
    expect(outcome.response).toBeUndefined();
    expect(persistence.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        call,
        disposition: "temporarily_unavailable",
        terminal: false,
      }),
    );
    expect(vi.mocked(persistence.recordAttempt).mock.calls[0]?.[0].response).toBeUndefined();
  });

  it("classifies body-read aborts as transport timeouts", async () => {
    const abort = new Error("body read aborted");
    abort.name = "AbortError";
    const confirmationResponse = jsonResponse(successResponse(), 200);
    vi.spyOn(confirmationResponse, "json").mockRejectedValue(abort);
    const lookupResponse = jsonResponse({ status: "unknown" }, 200);
    vi.spyOn(lookupResponse, "json").mockRejectedValue(abort);

    await expect(
      createClient({
        fetch: vi.fn<typeof fetch>().mockResolvedValue(confirmationResponse),
      }).dispatch(job, delivery),
    ).resolves.toMatchObject({ disposition: "uncertain_result" });
    await expect(
      createClient({ fetch: vi.fn<typeof fetch>().mockResolvedValue(lookupResponse) }).lookup(
        call.idempotencyKey,
        job.correlationId,
      ),
    ).resolves.toMatchObject({
      disposition: "temporarily_unavailable",
      errorCode: "erp_lookup_timeout",
    });
  });

  it.each([
    [
      "recognized availability",
      failedResponse(503, "erp_forced_outage"),
      "temporarily_unavailable",
    ],
    ["unknown code", failedResponse(503, "erp_unknown_failure"), "intervention_required"],
    ["malformed body", { code: "erp_forced_outage" }, "intervention_required"],
  ] as const)("classifies lookup $name through validated vocabulary", async (_name, body, disposition) => {
    const client = createClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body, 503)),
    });

    await expect(client.lookup(call.idempotencyKey, job.correlationId)).resolves.toMatchObject({
      disposition,
      ...(disposition === "intervention_required" ? { interventionScope: "order" } : {}),
    });
  });

  it("turns a local attempt contradiction into affected-order intervention", async () => {
    const persistence = attemptPersistence();
    const contradiction = new Error("contradictory ERP attempt");
    contradiction.name = "ErpAttemptContradictionError";
    persistence.recordAttempt = vi.fn().mockRejectedValue(contradiction);
    const client = createClient({ persistence });

    const error = await client.dispatch(job, delivery).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ErpConfirmationInvalidResponseError);
    expect(error).toMatchObject({
      outcome: {
        disposition: "intervention_required",
        interventionScope: "order",
        errorCode: "erp_attempt_contradiction",
      },
    });
  });

  it("preserves an accepted result when local persistence fails", async () => {
    const persistence = attemptPersistence();
    persistence.recordAttempt = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const client = createClient({ persistence });

    const error = await client.dispatch(job, delivery).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ErpAcceptedConfirmationPersistenceError);
    expect(error).toMatchObject({ record: { status: "succeeded", response: successResponse() } });
  });
});

function createClient(
  options: {
    persistence?: ErpAttemptPersistence;
    fetch?: typeof fetch;
    logger?: Pick<CheckoutSurgeLogger, "warn">;
  } = {},
): HttpErpOrderConfirmation {
  return new HttpErpOrderConfirmation({
    baseUrl: "http://mock-erp:4100",
    requestTimeoutMs: 1_000,
    retryAfterPolicy: { fallbackDelayMs: 750, maximumDelayMs: 5_000 },
    attemptPersistence: options.persistence ?? attemptPersistence(),
    fetch:
      options.fetch ??
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(successResponse(), 200)),
    now: sequenceClock(new Date("2026-06-22T00:00:00.000Z"), new Date("2026-06-22T00:00:00.035Z")),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

function attemptPersistence(): ErpAttemptPersistence {
  return {
    findSuccessfulAttempt: vi.fn().mockResolvedValue(null),
    recordDispatchIntent: vi.fn().mockResolvedValue(call),
    recordAttempt: vi.fn().mockResolvedValue(true),
  };
}

function successResponse() {
  return {
    status: "succeeded" as const,
    confirmationId: "erp_confirmation_test",
    httpStatus: 200 as const,
    latencyMs: 20,
    timestamp: "2026-06-22T00:00:00.020Z",
  };
}

function failedResponse(httpStatus: number, errorCode: string) {
  return {
    status: "failed" as const,
    httpStatus,
    errorCode,
    errorMessage: errorCode,
    latencyMs: 20,
    timestamp: "2026-06-22T00:00:00.020Z",
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sequenceClock(...dates: Date[]): () => Date {
  let index = 0;
  return () => {
    const date = dates[index++];
    if (!date) throw new Error("Test clock exhausted.");
    return date;
  };
}
