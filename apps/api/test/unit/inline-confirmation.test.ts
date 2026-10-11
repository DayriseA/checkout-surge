import {
  type BuyResponse,
  controlServiceTokenHeaderName,
  inlineConfirmationPath,
  inlineConfirmationStatusPath,
} from "@checkout-surge/contracts";
import { installFastifyCorrelation } from "@checkout-surge/logger/fastify";
import { fastify } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBuyRoutes } from "../../src/routes/buy-routes.js";
import type { ApiFastifyInstance } from "../../src/runtime/fastify.js";
import { HttpInlineOrderConfirmation } from "../../src/services/http-inline-order-confirmation.js";
import type { PersistedBuyAcceptance } from "../../src/services/reserve-order-service.js";

const securedAt = "2026-10-11T12:00:00.000Z";
const reservation = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  correlationId: "original-correlation",
  quantity: 1,
  securedAt,
  expiresAt: "2026-10-11T12:15:00.000Z",
};
const acceptance: PersistedBuyAcceptance = {
  reservation,
  order: {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    publicOrderId: "ord_inline",
    reservationId: reservation.id,
    saleOfferId: reservation.saleOfferId,
    runId: reservation.runId,
    correlationId: reservation.correlationId,
    quantity: 1,
    queuedAt: securedAt,
    status: "queued",
  },
};
const input = { ...acceptance, correlationId: "retry-correlation" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("worker HTTP inline confirmation", () => {
  it("authenticates canonical identity and limits each retry to the original remaining window", async () => {
    let now = Date.parse(securedAt) + 10_000;
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async () =>
      Response.json({ outcome: "order_confirmation_pending", order: acceptance.order }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HttpInlineOrderConfirmation({
      baseUrl: "http://worker:4300",
      controlServiceToken: "secret",
      now: () => now,
    });
    await adapter.confirm(input);
    now += 20_000;
    await adapter.confirm(input);
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([45_000, 25_000]);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe(inlineConfirmationPath);
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      [controlServiceTokenHeaderName]: "secret",
      "x-correlation-id": input.correlationId,
    });
    expect(JSON.parse(options.body as string)).toEqual({
      orderId: acceptance.order.id,
      reservationId: reservation.id,
      saleOfferId: reservation.saleOfferId,
      runId: reservation.runId,
      correlationId: input.correlationId,
    });
  });

  it.each([
    "confirmed",
    "failed",
  ] as const)("reads expired durable %s evidence using only bounded authenticated GET", async (status) => {
    const terminal =
      status === "confirmed"
        ? {
            outcome: "order_confirmed",
            order: { ...acceptance.order, status, confirmedAt: securedAt },
          }
        : {
            outcome: "order_confirmation_failed",
            order: { ...acceptance.order, status, failedAt: securedAt },
          };
    const fetchMock = vi.fn(async () => Response.json(terminal));
    vi.stubGlobal("fetch", fetchMock);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const adapter = new HttpInlineOrderConfirmation({
      baseUrl: "http://worker:4300",
      controlServiceToken: "secret",
      now: () => Date.parse(securedAt) + 60_000,
    });
    await expect(adapter.confirm(input)).resolves.toEqual(terminal);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe(inlineConfirmationStatusPath);
    expect(url.searchParams.get("orderId")).toBe(acceptance.order.id);
    expect(url.searchParams.get("reservationId")).toBe(reservation.id);
    expect(options.method).toBe("GET");
    expect(options.body).toBeUndefined();
    expect(options.headers).toMatchObject({ [controlServiceTokenHeaderName]: "secret" });
    expect(timeout).toHaveBeenCalledWith(1_000);
  });

  it("retains pending identity when transport reaches its deadline", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw new Error("timeout");
      }),
    );
    const adapter = new HttpInlineOrderConfirmation({
      baseUrl: "http://worker:4300",
      controlServiceToken: "secret",
      now: () => Date.parse(securedAt),
    });
    await expect(adapter.confirm(input)).resolves.toEqual({
      outcome: "order_confirmation_timed_out",
      order: acceptance.order,
    });
  });

  it("keeps an HTTP availability failure unresolved rather than failing the order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const adapter = new HttpInlineOrderConfirmation({
      baseUrl: "http://worker:4300",
      controlServiceToken: "secret",
      now: () => Date.parse(securedAt),
    });
    await expect(adapter.confirm(input)).resolves.toEqual({
      outcome: "order_confirmation_pending",
      order: acceptance.order,
    });
  });

  it.each([
    { outcome: "order_confirmed", order: acceptance.order },
    { outcome: "order_confirmed", order: { ...acceptance.order, status: "confirmed" } },
    {
      outcome: "order_confirmed",
      order: {
        ...acceptance.order,
        id: reservation.id,
        status: "confirmed",
        confirmedAt: securedAt,
      },
    },
  ])("does not turn acceptance or inconsistent worker evidence into confirmation", async (result) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(result)),
    );
    const adapter = new HttpInlineOrderConfirmation({
      baseUrl: "http://worker:4300",
      controlServiceToken: "secret",
      now: () => Date.parse(securedAt),
    });
    await expect(adapter.confirm(input)).resolves.toEqual({
      outcome: "order_confirmation_pending",
      order: acceptance.order,
    });
  });
});

describe("buy route outcome status", () => {
  it.each([
    ["order_confirmed", 200, { ...acceptance.order, status: "confirmed", confirmedAt: securedAt }],
    ["order_confirmation_pending", 503, null],
    ["order_confirmation_timed_out", 504, acceptance.order],
    [
      "order_confirmation_failed",
      502,
      { ...acceptance.order, status: "failed", failedAt: securedAt },
    ],
    ["reservation_secured", 202, acceptance.order],
    ["reservation_pending_persistence", 202, null],
    ["sold_out", 409, null],
  ] as const)("maps %s to %s and preserves its header", async (outcome, status, order) => {
    const app = fastify() as ApiFastifyInstance;
    installFastifyCorrelation(app);
    registerBuyRoutes(app, {
      reserveOrderService: {
        reserve: async () =>
          ({
            outcome,
            order,
            reservation: outcome === "sold_out" ? null : reservation,
            correlationId: input.correlationId,
            timestamp: securedAt,
            ...(outcome === "reservation_pending_persistence" ? { retryAfterSeconds: 30 } : {}),
          }) as BuyResponse,
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/buy",
        payload: {
          saleOfferId: reservation.saleOfferId,
          runId: reservation.runId,
          quantity: 1,
          idempotencyKey: "inline-route",
        },
      });
      expect(response.statusCode).toBe(status);
      expect(response.headers["x-checkout-outcome"]).toBe(outcome);
      expect(response.json().order).toEqual(order);
    } finally {
      await app.close();
    }
  });
});
