import {
  errorPayloadSchema,
  type InlineConfirmationRequest,
  type InlineConfirmationResult,
} from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { afterEach, expect, it, vi } from "vitest";
import {
  InlineOrderConfirmation,
  type InlineOrderSnapshot,
} from "../../src/application/inline-order-confirmation.js";
import type { OrderProcessJobHandler } from "../../src/application/order-process-job-handler.js";
import { buildWorkerHealthServer } from "../../src/server.js";

vi.mock("node:timers/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:timers/promises")>();
  return { ...original, setTimeout: vi.fn(original.setTimeout) };
});

const request: InlineConfirmationRequest = {
  orderId: "11111111-1111-4111-8111-111111111111",
  reservationId: "22222222-2222-4222-8222-222222222222",
  saleOfferId: "33333333-3333-4333-8333-333333333333",
  runId: "44444444-4444-4444-8444-444444444444",
  correlationId: "buyer-retry",
};
function fixture() {
  let now = 0;
  const order = {
    id: request.orderId,
    publicOrderId: "ord_inline",
    reservationId: request.reservationId,
    saleOfferId: request.saleOfferId,
    runId: request.runId,
    correlationId: "original",
    quantity: 1,
    queuedAt: new Date(40_000).toISOString(),
    status: "queued" as const,
  };
  const snapshot: InlineOrderSnapshot = {
    job: {
      ...request,
      publicOrderId: order.publicOrderId,
      correlationId: order.correlationId,
      quantity: 1,
      queuedAt: order.queuedAt,
      processingGeneration: 0,
    },
    securedAt: new Date(0),
    runActive: true,
    result: { outcome: "order_confirmation_pending", order },
  };
  const reader = { read: vi.fn(async () => ({ ...snapshot })) };
  const handler = {
    handle: vi.fn<OrderProcessJobHandler["handle"]>(async () => {
      snapshot.result = {
        outcome: "order_confirmed",
        order: { ...order, status: "confirmed", confirmedAt: new Date(now).toISOString() },
      };
    }),
  };
  const control = {
    readControlRecord: vi.fn().mockResolvedValue(null),
    claimForPublication: vi.fn().mockResolvedValue(null),
  };
  const service = new InlineOrderConfirmation({
    reader,
    handler,
    control,
    now: () => new Date(now),
  });
  return {
    service,
    reader,
    handler,
    control,
    snapshot,
    setNow: (value: number) => {
      now = value;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(timersPromises.setTimeout).mockReset();
});

it("derives the budget from original securedAt and uses canonical correlation, not queuedAt or retry context", async () => {
  const f = fixture();
  await expect(f.service.confirm(request)).resolves.toMatchObject({ outcome: "order_confirmed" });
  expect(f.handler.handle).toHaveBeenCalledWith(f.snapshot.job, expect.anything(), {
    budget: { deadlineAt: new Date(55_000), signal: expect.any(AbortSignal) },
    replayUnknown: false,
  });
});

it("reads terminal replay after expiry and keeps status entirely read-only", async () => {
  const f = fixture();
  await f.service.confirm(request);
  f.handler.handle.mockClear();
  f.setNow(60_000);
  await expect(f.service.confirm(request)).resolves.toMatchObject({ outcome: "order_confirmed" });
  await expect(f.service.status(request)).resolves.toMatchObject({ outcome: "order_confirmed" });
  expect(f.handler.handle).not.toHaveBeenCalled();
  expect(f.control.claimForPublication).not.toHaveBeenCalled();
});

it("coalesces live buyers and never converts a fulfilled void into confirmation", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let release = () => {};
  f.handler.handle.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = f.service.confirm(request);
  const second = f.service.confirm(request);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.handler.handle).toHaveBeenCalledOnce();
  f.service.cancelRun(request.runId);
  expect(await first).toMatchObject({ outcome: "order_confirmation_pending" });
  expect(await second).toMatchObject({ outcome: "order_confirmation_pending" });
  release();
  await vi.advanceTimersByTimeAsync(0);
});

it("returns elapsed-window status without processing and rejects no business state on close", async () => {
  const f = fixture();
  f.setNow(55_000);
  await expect(f.service.confirm(request)).resolves.toMatchObject({
    outcome: "order_confirmation_timed_out",
  });
  expect(f.handler.handle).not.toHaveBeenCalled();
  f.setNow(0);
  f.service.close();
  await expect(f.service.confirm(request)).resolves.toMatchObject({
    outcome: "order_confirmation_pending",
  });
  expect(f.handler.handle).not.toHaveBeenCalled();
});

it("uses due durable ownership generation in job and delivery after deferral", async () => {
  const f = fixture();
  f.control.readControlRecord.mockResolvedValue({ recoveryKey: `order:${request.orderId}` });
  f.control.claimForPublication.mockResolvedValue({
    attempt: 2,
    processingGeneration: 7,
    jobId: "recovery-owned",
  });
  await expect(f.service.confirm(request)).resolves.toMatchObject({ outcome: "order_confirmed" });
  expect(f.handler.handle).toHaveBeenCalledWith(
    expect.objectContaining({ processingGeneration: 7 }),
    expect.objectContaining({ processingGeneration: 7, deliveryId: "recovery-owned" }),
    expect.anything(),
  );
});

it("waits for durable eligibility without intermediate claims or reads, then resumes", async () => {
  vi.useFakeTimers();
  // Fake timers do not replace node:timers/promises; bridge this one wait to
  // the fake clock so the assertions measure scheduled eligibility precisely.
  vi.mocked(timersPromises.setTimeout).mockImplementationOnce(
    (ms) =>
      new Promise<never>((resolve) => {
        setTimeout(resolve, ms);
      }),
  );
  const f = fixture();
  f.control.readControlRecord.mockResolvedValue({
    recoveryKey: `order:${request.orderId}`,
    nextAttemptAt: new Date(3000),
    leaseExpiresAt: null,
  });
  f.control.claimForPublication.mockResolvedValueOnce(null).mockResolvedValue({
    attempt: 2,
    processingGeneration: 7,
    jobId: "recovery-owned",
  });
  const result = f.service.confirm(request);
  await vi.advanceTimersByTimeAsync(0);
  f.setNow(2999);
  await vi.advanceTimersByTimeAsync(2999);
  expect(f.reader.read).toHaveBeenCalledOnce();
  expect(f.control.readControlRecord).toHaveBeenCalledOnce();
  expect(f.control.claimForPublication).toHaveBeenCalledOnce();
  expect(f.handler.handle).not.toHaveBeenCalled();
  f.setNow(3000);
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toMatchObject({ outcome: "order_confirmed" });
  expect(f.control.claimForPublication).toHaveBeenCalledTimes(2);
  expect(f.control.claimForPublication).toHaveBeenLastCalledWith({
    recoveryKey: `order:${request.orderId}`,
    now: new Date(3000),
    leaseMs: 30_000,
  });
  expect(f.handler.handle).toHaveBeenCalledOnce();
});

it.each([
  "confirmed",
  "deferred",
] as const)("observes a disconnected handler's early lease release when it settles as %s", async (settlement) => {
  vi.useFakeTimers();
  vi.mocked(timersPromises.setTimeout).mockImplementation(
    (ms) => new Promise<never>((resolve) => setTimeout(resolve, ms)),
  );
  const f = fixture();
  f.setNow(26_000);
  let release = () => {};
  const confirmOrder = f.handler.handle.getMockImplementation();
  f.handler.handle.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const cancellation = new AbortController();
  const first = f.service.confirm(request, cancellation.signal);
  await vi.advanceTimersByTimeAsync(0);
  const control = {
    recoveryKey: `order:${request.orderId}`,
    nextAttemptAt: new Date(26_000),
    leaseExpiresAt: new Date(56_000) as Date | null,
  };
  f.control.readControlRecord.mockResolvedValue(control);
  cancellation.abort();
  await expect(first).resolves.toMatchObject({ outcome: "order_confirmation_pending" });
  const retry = f.service.confirm(request);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.control.claimForPublication).toHaveBeenCalledOnce();
  expect(f.handler.handle).toHaveBeenCalledOnce();

  control.leaseExpiresAt = null;
  if (settlement === "confirmed") {
    await confirmOrder?.(f.snapshot.job, { attemptNumber: 1, attemptsMade: 0 });
  } else {
    control.nextAttemptAt = new Date(28_000);
  }
  release();
  await vi.advanceTimersByTimeAsync(0);
  f.setNow(26_250);
  await vi.advanceTimersByTimeAsync(250);
  if (settlement === "deferred") {
    const reads = f.reader.read.mock.calls.length;
    const claims = f.control.claimForPublication.mock.calls.length;
    f.setNow(27_999);
    await vi.advanceTimersByTimeAsync(1749);
    expect(f.reader.read).toHaveBeenCalledTimes(reads);
    expect(f.control.claimForPublication).toHaveBeenCalledTimes(claims);
    f.control.claimForPublication.mockResolvedValue({
      attempt: 2,
      processingGeneration: 1,
      jobId: "resumed-inline",
    });
    f.setNow(28_000);
    await vi.advanceTimersByTimeAsync(1);
  }
  await expect(retry).resolves.toMatchObject({ outcome: "order_confirmed" });
  expect(f.handler.handle).toHaveBeenCalledTimes(settlement === "confirmed" ? 1 : 2);
});

it.each([
  { stop: "cancel", wait: "deferral" },
  { stop: "deadline", wait: "deferral" },
  { stop: "cancel", wait: "lease" },
  { stop: "deadline", wait: "lease" },
] as const)("interrupts a $wait wait promptly on $stop", async ({ stop, wait }) => {
  vi.useFakeTimers();
  const f = fixture();
  f.control.readControlRecord.mockResolvedValue({
    recoveryKey: `order:${request.orderId}`,
    nextAttemptAt: new Date(90_000),
    leaseExpiresAt: wait === "lease" ? new Date(90_000) : null,
  });
  const cancellation = new AbortController();
  const result = f.service.confirm(request, cancellation.signal);
  await vi.advanceTimersByTimeAsync(0);
  if (stop === "cancel") {
    cancellation.abort();
  } else {
    f.setNow(55_000);
    await vi.advanceTimersByTimeAsync(55_000);
  }
  await expect(result).resolves.toMatchObject({
    outcome: stop === "deadline" ? "order_confirmation_timed_out" : "order_confirmation_pending",
  });
  expect(f.reader.read).toHaveBeenCalledOnce();
  expect(f.control.readControlRecord).toHaveBeenCalledOnce();
  expect(f.control.claimForPublication).toHaveBeenCalledOnce();
  expect(f.handler.handle).not.toHaveBeenCalled();
});

it.each([
  "deadline",
  "close",
] as const)("bounds an unfinished handler on %s and aborts its owned signal", async (stop) => {
  vi.useFakeTimers();
  const f = fixture();
  let release = () => {};
  f.handler.handle.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const result = f.service.confirm(request);
  await vi.advanceTimersByTimeAsync(0);
  const processing = f.handler.handle.mock.calls[0]?.[2];
  if (stop === "deadline") {
    f.setNow(55_000);
    await vi.advanceTimersByTimeAsync(55_000);
  } else {
    f.service.close();
  }
  expect(processing?.budget?.signal.aborted).toBe(true);
  await expect(result).resolves.toMatchObject({
    outcome: stop === "deadline" ? "order_confirmation_timed_out" : "order_confirmation_pending",
  });
  release();
  await vi.advanceTimersByTimeAsync(0);
});

it("authenticates both routes, parses the shared protocol and calls status without confirm", async () => {
  const result: InlineConfirmationResult = { outcome: "order_confirmation_pending", order: null };
  const service = {
    confirm: vi.fn().mockResolvedValue(result),
    status: vi.fn().mockResolvedValue(result),
  };
  const app = buildWorkerHealthServer({
    logger: createSilentLogger("worker"),
    readiness: { checks: async () => [] },
    inlineConfirmation: { service, controlServiceToken: "test-secret" },
  });
  try {
    for (const method of ["GET", "POST"] as const) {
      const path =
        method === "GET" ? "/internal/orders/confirmation-status" : "/internal/orders/confirm";
      const unauthorized = await app.inject({
        method,
        url: path,
        headers: { "x-correlation-id": "unauthorized-trace" },
      });
      expect(unauthorized.statusCode).toBe(401);
      expect(errorPayloadSchema.parse(unauthorized.json()).correlationId).toBe(
        "unauthorized-trace",
      );
    }
    const query = new URLSearchParams(request).toString();
    const response = await app.inject({
      method: "GET",
      url: `/internal/orders/confirmation-status?${query}`,
      headers: { "x-control-service-token": "test-secret" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(response.headers["x-correlation-id"]).toBe(request.correlationId);
    expect(service.status).toHaveBeenCalledWith(request);
    expect(service.confirm).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/internal/orders/confirm",
          headers: { "x-control-service-token": "test-secret" },
          payload: { ...request, deadlineAt: "caller-chosen" },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});

import * as timersPromises from "node:timers/promises";
