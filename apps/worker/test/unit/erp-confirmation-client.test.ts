import { correlationIdHeaderName } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import {
  type ErpAttemptPersistence,
  ErpConfirmationFailedError,
  ErpConfirmationInvalidResponseError,
  ErpConfirmationRequestError,
  ErpConfirmationTimeoutError,
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
const delivery: OrderProcessDeliveryMetadata = { attemptNumber: 2, attemptsMade: 1 };

describe("HTTP ERP order confirmation", () => {
  it("posts a contract-valid confirmation request and records a successful attempt", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse(
        {
          status: "succeeded",
          confirmationId: "erp_confirmation_test",
          httpStatus: 200,
          latencyMs: 20,
          timestamp: "2026-06-22T00:00:00.020Z",
        },
        200,
      ),
    );
    const attemptPersistence = createAttemptPersistence();
    const confirmation = new HttpErpOrderConfirmation({
      baseUrl: "http://mock-erp:4100",
      requestTimeoutMs: 1000,
      attemptPersistence,
      fetch,
      now: sequenceClock(
        new Date("2026-06-22T00:00:00.000Z"),
        new Date("2026-06-22T00:00:00.035Z"),
      ),
    });

    await confirmation.confirm(job, delivery);

    expect(fetch).toHaveBeenCalledWith(
      new URL("http://mock-erp:4100/confirmations"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          [correlationIdHeaderName]: job.correlationId,
        }),
      }),
    );
    const requestBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(requestBody).toMatchObject({
      orderId: job.orderId,
      publicOrderId: job.publicOrderId,
      correlationId: job.correlationId,
    });
    expect(attemptPersistence.recordAttempt).toHaveBeenCalledWith({
      job,
      delivery,
      status: "succeeded",
      httpStatus: 200,
      latencyMs: 35,
      startedAt: new Date("2026-06-22T00:00:00.000Z"),
      finishedAt: new Date("2026-06-22T00:00:00.035Z"),
    });
  });

  it("records dependency failures and propagates a confirmation error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse(
        {
          status: "failed",
          httpStatus: 503,
          errorCode: "erp_unavailable",
          errorMessage: "The ERP is unavailable.",
          latencyMs: 40,
          timestamp: "2026-06-22T00:00:00.040Z",
        },
        503,
      ),
    );
    const attemptPersistence = createAttemptPersistence();
    const confirmation = new HttpErpOrderConfirmation({
      baseUrl: "http://mock-erp:4100",
      requestTimeoutMs: 1000,
      attemptPersistence,
      fetch,
      now: sequenceClock(
        new Date("2026-06-22T00:00:00.000Z"),
        new Date("2026-06-22T00:00:00.045Z"),
      ),
    });

    await expect(confirmation.confirm(job, delivery)).rejects.toBeInstanceOf(
      ErpConfirmationFailedError,
    );
    expect(attemptPersistence.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        httpStatus: 503,
        errorCode: "erp_unavailable",
        errorMessage: "The ERP is unavailable.",
        latencyMs: 45,
      }),
    );
  });

  it("records timed-out attempts", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const attemptPersistence = createAttemptPersistence();
    const confirmation = new HttpErpOrderConfirmation({
      baseUrl: "http://mock-erp:4100",
      requestTimeoutMs: 250,
      attemptPersistence,
      fetch: vi.fn<typeof globalThis.fetch>().mockRejectedValue(abortError),
      now: sequenceClock(
        new Date("2026-06-22T00:00:00.000Z"),
        new Date("2026-06-22T00:00:00.250Z"),
      ),
    });

    await expect(confirmation.confirm(job, delivery)).rejects.toBeInstanceOf(
      ErpConfirmationTimeoutError,
    );
    expect(attemptPersistence.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "timed_out",
        errorCode: "erp_request_timeout",
        latencyMs: 250,
      }),
    );
  });

  it("records invalid ERP responses", async () => {
    const attemptPersistence = createAttemptPersistence();
    const confirmation = new HttpErpOrderConfirmation({
      baseUrl: "http://mock-erp:4100",
      requestTimeoutMs: 1000,
      attemptPersistence,
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ bad: true }, 502)),
      now: sequenceClock(
        new Date("2026-06-22T00:00:00.000Z"),
        new Date("2026-06-22T00:00:00.010Z"),
      ),
    });

    await expect(confirmation.confirm(job, delivery)).rejects.toBeInstanceOf(
      ErpConfirmationInvalidResponseError,
    );
    expect(attemptPersistence.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        httpStatus: 502,
        errorCode: "erp_invalid_response",
      }),
    );
  });

  it("records transport failures", async () => {
    const attemptPersistence = createAttemptPersistence();
    const confirmation = new HttpErpOrderConfirmation({
      baseUrl: "http://mock-erp:4100",
      requestTimeoutMs: 1000,
      attemptPersistence,
      fetch: vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("ECONNREFUSED")),
      now: sequenceClock(
        new Date("2026-06-22T00:00:00.000Z"),
        new Date("2026-06-22T00:00:00.005Z"),
      ),
    });

    await expect(confirmation.confirm(job, delivery)).rejects.toBeInstanceOf(
      ErpConfirmationRequestError,
    );
    expect(attemptPersistence.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: "erp_request_failed",
        errorMessage: "ECONNREFUSED",
        latencyMs: 5,
      }),
    );
  });
});

function createAttemptPersistence(): ErpAttemptPersistence {
  return {
    recordAttempt: vi.fn().mockResolvedValue(undefined),
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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
