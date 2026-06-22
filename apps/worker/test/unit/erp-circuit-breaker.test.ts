import type { OrderProcessJob } from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ErpCircuitBreaker,
  ErpCircuitOpenError,
} from "../../src/application/erp-circuit-breaker.js";
import type { OrderProcessDeliveryMetadata } from "../../src/application/order-process-job-handler.js";

const job: OrderProcessJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_circuit_test",
  reservationId: "22222222-2222-4222-8222-222222222222",
  saleOfferId: "33333333-3333-4333-8333-333333333333",
  correlationId: "corr-circuit-test",
  quantity: 1,
  queuedAt: "2026-06-22T00:00:00.000Z",
};
const delivery: OrderProcessDeliveryMetadata = {
  attemptNumber: 1,
  attemptsMade: 0,
  maxAttempts: 4,
};

describe("ERP circuit breaker", () => {
  it("opens after consecutive counted failures and blocks calls until reset", async () => {
    let now = new Date("2026-06-22T00:00:00.000Z");
    const confirmationError = new Error("ERP unavailable");
    const delegate = { confirm: vi.fn().mockRejectedValue(confirmationError) };
    const breaker = new ErpCircuitBreaker({
      confirmation: delegate,
      failureThreshold: 2,
      resetTimeoutMs: 1000,
      isCountedFailure: () => true,
      now: () => now,
    });

    await expect(breaker.confirm(job, delivery)).rejects.toBe(confirmationError);
    await expect(breaker.confirm(job, delivery)).rejects.toBe(confirmationError);
    await expect(breaker.confirm(job, delivery)).rejects.toBeInstanceOf(ErpCircuitOpenError);

    expect(delegate.confirm).toHaveBeenCalledTimes(2);
    expect(breaker.snapshot()).toMatchObject({
      state: "open",
      consecutiveFailureCount: 2,
      nextAttemptAt: "2026-06-22T00:00:01.000Z",
    });

    now = new Date("2026-06-22T00:00:01.000Z");
    delegate.confirm.mockResolvedValueOnce(undefined);
    await expect(breaker.confirm(job, delivery)).resolves.toBeUndefined();
    expect(breaker.snapshot()).toMatchObject({
      state: "closed",
      consecutiveFailureCount: 0,
      openedAt: null,
    });
  });

  it("reopens when the half-open probe fails", async () => {
    let now = new Date("2026-06-22T00:00:00.000Z");
    const delegate = { confirm: vi.fn().mockRejectedValue(new Error("ERP unavailable")) };
    const breaker = new ErpCircuitBreaker({
      confirmation: delegate,
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      isCountedFailure: () => true,
      now: () => now,
    });

    await expect(breaker.confirm(job, delivery)).rejects.toThrow("ERP unavailable");
    expect(breaker.snapshot().state).toBe("open");

    now = new Date("2026-06-22T00:00:01.000Z");
    await expect(breaker.confirm(job, delivery)).rejects.toThrow("ERP unavailable");

    expect(delegate.confirm).toHaveBeenCalledTimes(2);
    expect(breaker.snapshot()).toMatchObject({
      state: "open",
      openedAt: "2026-06-22T00:00:01.000Z",
      nextAttemptAt: "2026-06-22T00:00:02.000Z",
    });
  });

  it("does not count terminal failures against the circuit", async () => {
    const delegate = { confirm: vi.fn().mockRejectedValue(new Error("invalid order")) };
    const breaker = new ErpCircuitBreaker({
      confirmation: delegate,
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      isCountedFailure: () => false,
      now: () => new Date("2026-06-22T00:00:00.000Z"),
    });

    await expect(breaker.confirm(job, delivery)).rejects.toThrow("invalid order");
    await expect(breaker.confirm(job, delivery)).rejects.toThrow("invalid order");

    expect(delegate.confirm).toHaveBeenCalledTimes(2);
    expect(breaker.snapshot()).toMatchObject({
      state: "closed",
      consecutiveFailureCount: 0,
    });
  });
});
