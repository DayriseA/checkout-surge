import type { OrderProcessJob } from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ErpCircuitBreaker,
  ErpCircuitOpenError,
} from "../../src/application/erp-circuit-breaker.js";
import {
  ErpConfirmationTimeoutError,
  isTemporaryErpDependencyError,
} from "../../src/application/erp-confirmation-client.js";
import type { OrderProcessDeliveryMetadata } from "../../src/application/order-process-job-handler.js";

const job: OrderProcessJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_circuit_test",
  reservationId: "22222222-2222-4222-8222-222222222222",
  saleOfferId: "33333333-3333-4333-8333-333333333333",
  correlationId: "corr-circuit-test",
  quantity: 1,
  queuedAt: "2026-06-22T00:00:00.000Z",
  processingGeneration: 0,
};
const delivery: OrderProcessDeliveryMetadata = {
  attemptNumber: 1,
  attemptsMade: 0,
  maxAttempts: 4,
};

describe("ERP circuit breaker", () => {
  it("publishes the configured closed snapshot at startup without coupling construction to reporting", async () => {
    const onStateChange = vi.fn().mockRejectedValue(new Error("Redis unavailable"));

    expect(
      () =>
        new ErpCircuitBreaker({
          confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
          failureThreshold: 5,
          resetTimeoutMs: 10_000,
          isCountedFailure: () => true,
          onStateChange,
          now: () => new Date("2026-06-22T00:00:00.000Z"),
        }),
    ).not.toThrow();
    await Promise.resolve();

    expect(onStateChange).toHaveBeenCalledWith({
      state: "closed",
      consecutiveFailureCount: 0,
      failureThreshold: 5,
      resetTimeoutMs: 10_000,
      openedAt: null,
      nextAttemptAt: null,
      halfOpenProbeInFlight: false,
      lastChangedAt: "2026-06-22T00:00:00.000Z",
    });
  });

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

  it("advances lastChangedAt only when the circuit state transitions", async () => {
    let now = new Date("2026-06-22T00:00:00.000Z");
    let resolveProbe!: () => void;
    const probe = new Promise<void>((resolve) => {
      resolveProbe = resolve;
    });
    const delegate = {
      confirm: vi
        .fn()
        .mockRejectedValueOnce(new Error("first failure"))
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("second failure"))
        .mockRejectedValueOnce(new Error("third failure"))
        .mockReturnValueOnce(probe),
    };
    const breaker = new ErpCircuitBreaker({
      confirmation: delegate,
      failureThreshold: 2,
      resetTimeoutMs: 1000,
      isCountedFailure: () => true,
      now: () => now,
    });

    now = new Date("2026-06-22T00:00:00.100Z");
    await expect(breaker.confirm(job, delivery)).rejects.toThrow("first failure");
    expect(breaker.snapshot()).toMatchObject({
      state: "closed",
      consecutiveFailureCount: 1,
      lastChangedAt: "2026-06-22T00:00:00.000Z",
    });

    now = new Date("2026-06-22T00:00:00.200Z");
    await expect(breaker.confirm(job, delivery)).resolves.toBeUndefined();
    expect(breaker.snapshot()).toMatchObject({
      state: "closed",
      consecutiveFailureCount: 0,
      lastChangedAt: "2026-06-22T00:00:00.000Z",
    });

    now = new Date("2026-06-22T00:00:00.300Z");
    await expect(breaker.confirm(job, delivery)).rejects.toThrow("second failure");
    now = new Date("2026-06-22T00:00:00.400Z");
    await expect(breaker.confirm(job, delivery)).rejects.toThrow("third failure");
    expect(breaker.snapshot()).toMatchObject({
      state: "open",
      lastChangedAt: "2026-06-22T00:00:00.400Z",
    });

    now = new Date("2026-06-22T00:00:01.400Z");
    const pendingProbe = breaker.confirm(job, delivery);
    expect(breaker.snapshot()).toMatchObject({
      state: "half_open",
      halfOpenProbeInFlight: true,
      lastChangedAt: "2026-06-22T00:00:01.400Z",
    });

    now = new Date("2026-06-22T00:00:01.500Z");
    resolveProbe();
    await expect(pendingProbe).resolves.toBeUndefined();
    expect(breaker.snapshot()).toMatchObject({
      state: "closed",
      halfOpenProbeInFlight: false,
      lastChangedAt: "2026-06-22T00:00:01.500Z",
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

  it("counts an uncertain dispatched timeout as an availability failure", async () => {
    const timeout = new ErpConfirmationTimeoutError(1_000, true, {
      disposition: "uncertain_result",
      operation: "dispatched_confirmation",
      call: {
        erpCallId: "99999999-9999-4999-8999-999999999999",
        orderId: job.orderId,
        idempotencyKey: `erp-confirmation:${job.orderId}`,
        processingGeneration: 1,
        dispatchedAt: "2026-06-22T00:00:00.000Z",
      },
      startedAt: new Date("2026-06-22T00:00:00.000Z"),
      finishedAt: new Date("2026-06-22T00:00:01.000Z"),
      latencyMs: 1_000,
      replayed: false,
    });
    const breaker = new ErpCircuitBreaker({
      confirmation: { confirm: vi.fn().mockRejectedValue(timeout) },
      failureThreshold: 1,
      resetTimeoutMs: 1_000,
      isCountedFailure: isTemporaryErpDependencyError,
      now: () => new Date("2026-06-22T00:00:01.000Z"),
    });

    await expect(breaker.confirm(job, delivery)).rejects.toBe(timeout);
    expect(breaker.snapshot().state).toBe("open");
  });

  it("gates lookups while open and allows them without learning once half-open", async () => {
    let now = new Date("2026-06-22T00:00:00.000Z");
    const breaker = new ErpCircuitBreaker({
      confirmation: { confirm: vi.fn().mockRejectedValue(new Error("ERP unavailable")) },
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      isCountedFailure: () => true,
      now: () => now,
    });

    await expect(breaker.confirm(job, delivery)).rejects.toThrow("ERP unavailable");
    expect(() => breaker.assertAvailable()).toThrow(ErpCircuitOpenError);

    now = new Date("2026-06-22T00:00:01.000Z");
    expect(() => breaker.assertAvailable()).not.toThrow();
    expect(breaker.snapshot().state).toBe("half_open");
  });

  it("does not reset failure evidence from a reused or replayed success", async () => {
    const delegate = {
      confirm: vi
        .fn()
        .mockRejectedValueOnce(new Error("ERP unavailable"))
        .mockResolvedValueOnce({ erpHealthLearningEligible: false }),
    };
    const breaker = new ErpCircuitBreaker({
      confirmation: delegate,
      failureThreshold: 2,
      resetTimeoutMs: 1000,
      isCountedFailure: () => true,
      now: () => new Date("2026-06-22T00:00:00.000Z"),
    });

    await expect(breaker.confirm(job, delivery)).rejects.toThrow("ERP unavailable");
    await expect(breaker.confirm(job, delivery)).resolves.toEqual({
      erpHealthLearningEligible: false,
    });
    expect(breaker.snapshot()).toMatchObject({ state: "closed", consecutiveFailureCount: 1 });
  });
});
