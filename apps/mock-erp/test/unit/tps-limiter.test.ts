import type { ErpConfirmationRequest } from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ChaosConfirmationDecisionProvider,
  ErpChaosConfigStore,
} from "../../src/application/chaos-control-service.js";
import { ConfirmationService } from "../../src/application/confirmation-service.js";
import { SlidingWindowTpsLimiter } from "../../src/application/tps-limiter.js";

const safetyCaps = {
  maxLatencyMs: 5_000,
  minMaxTps: 1,
  maxErrorRate: 1,
  allowForcedOutage: true,
};

const request: ErpConfirmationRequest = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test_1",
  reservationId: "22222222-2222-4222-8222-222222222222",
  saleOfferId: "33333333-3333-4333-8333-333333333333",
  runId: "44444444-4444-4444-8444-444444444444",
  idempotencyKey: "erp-confirmation:11111111-1111-4111-8111-111111111111",
  correlationId: "corr-tps-test",
  quantity: 1,
};

describe("SlidingWindowTpsLimiter", () => {
  it("allows exactly the cap and does not retain rejected attempts", () => {
    let nowMs = 0;
    const limiter = new SlidingWindowTpsLimiter({ nowMs: () => nowMs });

    expect(limiter.acquire("scope", 2)).toBe(true);
    expect(limiter.acquire("scope", 2)).toBe(true);
    expect(limiter.acquire("scope", 2)).toBe(false);
    nowMs = 500;
    expect(limiter.acquire("scope", 2)).toBe(false);
    nowMs = 1_000;
    expect(limiter.acquire("scope", 2)).toBe(true);
    expect(limiter.acquire("scope", 2)).toBe(true);
  });

  it("prevents a fixed-second boundary burst", () => {
    let nowMs = 999;
    const limiter = new SlidingWindowTpsLimiter({ nowMs: () => nowMs });

    expect(limiter.acquire("scope", 2)).toBe(true);
    expect(limiter.acquire("scope", 2)).toBe(true);
    nowMs = 1_000;
    expect(limiter.acquire("scope", 2)).toBe(false);
  });

  it("expires an arrival at exactly 1,000ms but not at 999ms", () => {
    let nowMs = 0;
    const limiter = new SlidingWindowTpsLimiter({ nowMs: () => nowMs });

    expect(limiter.acquire("scope", 1)).toBe(true);
    nowMs = 999;
    expect(limiter.acquire("scope", 1)).toBe(false);
    nowMs = 1_000;
    expect(limiter.acquire("scope", 1)).toBe(true);
  });

  it("restores staggered capacity one slot at a time", () => {
    let nowMs = 0;
    const limiter = new SlidingWindowTpsLimiter({ nowMs: () => nowMs });

    expect(limiter.acquire("scope", 2)).toBe(true);
    nowMs = 400;
    expect(limiter.acquire("scope", 2)).toBe(true);
    nowMs = 1_000;
    expect(limiter.acquire("scope", 2)).toBe(true);
    expect(limiter.acquire("scope", 2)).toBe(false);
    nowMs = 1_399;
    expect(limiter.acquire("scope", 2)).toBe(false);
    nowMs = 1_400;
    expect(limiter.acquire("scope", 2)).toBe(true);
  });

  it("isolates scopes", () => {
    const limiter = new SlidingWindowTpsLimiter({ nowMs: () => 0 });

    for (const scope of ["run:first", "run:second", "global", "config:different"]) {
      expect(limiter.acquire(scope, 1)).toBe(true);
      expect(limiter.acquire(scope, 1)).toBe(false);
    }
  });

  it("applies lower and higher caps without clearing accepted history", () => {
    const limiter = new SlidingWindowTpsLimiter({ nowMs: () => 0 });

    expect(limiter.acquire("scope", 3)).toBe(true);
    expect(limiter.acquire("scope", 3)).toBe(true);
    expect(limiter.acquire("scope", 1)).toBe(false);
    expect(limiter.acquire("scope", 3)).toBe(true);
    expect(limiter.acquire("scope", 3)).toBe(false);
  });

  it("opportunistically removes scopes inactive for one second", () => {
    let nowMs = 0;
    const limiter = new SlidingWindowTpsLimiter({ nowMs: () => nowMs });

    expect(limiter.acquire("stale:first", 1)).toBe(true);
    expect(limiter.acquire("stale:second", 1)).toBe(true);
    expect(limiter.activeScopeCount).toBe(2);
    nowMs = 1_000;
    expect(limiter.acquire("active", 1)).toBe(true);
    expect(limiter.activeScopeCount).toBe(1);
  });
});

describe("ChaosConfirmationDecisionProvider TPS ordering", () => {
  it("returns forced outage without sleeping or consuming capacity", async () => {
    const store = new ErpChaosConfigStore(
      { latencyMs: 25, maxTps: 1, errorRate: 0, forcedOutage: true },
      safetyCaps,
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = createProvider(store, { sleep });

    await expect(provider.decide(request)).resolves.toMatchObject({
      httpStatus: 503,
      errorCode: "erp_forced_outage",
    });
    expect(sleep).not.toHaveBeenCalled();

    store.update({ latencyMs: 0, maxTps: 1, errorRate: 0, forcedOutage: false });
    await expect(provider.decide(request)).resolves.toEqual({ status: "succeeded" });
  });

  it("returns throttle without sleeping", async () => {
    const store = new ErpChaosConfigStore(
      { latencyMs: 25, maxTps: 1, errorRate: 0, forcedOutage: false },
      safetyCaps,
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = createProvider(store, { sleep });

    await provider.decide(request);
    sleep.mockClear();
    await expect(provider.decide(request)).resolves.toMatchObject({
      httpStatus: 429,
      errorCode: "erp_capacity_exceeded",
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("sleeps for admitted injected errors and retains their capacity", async () => {
    const store = new ErpChaosConfigStore(
      { latencyMs: 25, maxTps: 1, errorRate: 1, forcedOutage: false },
      safetyCaps,
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = createProvider(store, { sleep, random: () => 0 });

    await expect(provider.decide(request)).resolves.toMatchObject({
      httpStatus: 503,
      errorCode: "erp_injected_error",
    });
    expect(sleep).toHaveBeenCalledOnce();
    sleep.mockClear();
    await expect(provider.decide(request)).resolves.toMatchObject({
      httpStatus: 429,
      errorCode: "erp_capacity_exceeded",
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("preserves run history across live cap updates and reset", async () => {
    const store = new ErpChaosConfigStore(
      { latencyMs: 0, maxTps: 2, errorRate: 0, forcedOutage: false },
      safetyCaps,
    );
    const provider = createProvider(store);

    await expect(provider.decide(request)).resolves.toEqual({ status: "succeeded" });
    await expect(provider.decide(request)).resolves.toEqual({ status: "succeeded" });
    store.update({ latencyMs: 0, maxTps: 1, errorRate: 0, forcedOutage: false });
    await expect(provider.decide(request)).resolves.toMatchObject({ httpStatus: 429 });
    store.update({ latencyMs: 0, maxTps: 3, errorRate: 0, forcedOutage: false });
    await expect(provider.decide(request)).resolves.toEqual({ status: "succeeded" });
    store.reset();
    await expect(provider.decide(request)).resolves.toMatchObject({ httpStatus: 429 });
  });

  it("acquires capacity synchronously before concurrent calls sleep", async () => {
    const cap = 2;
    const store = new ErpChaosConfigStore(
      { latencyMs: 10, maxTps: cap, errorRate: 0, forcedOutage: false },
      safetyCaps,
    );
    let releaseSleep!: () => void;
    const controlledSleep = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    const sleep = vi.fn(() => controlledSleep);
    const service = new ConfirmationService({
      decisionProvider: createProvider(store, { sleep }),
      generateConfirmationId: () => crypto.randomUUID(),
    });
    const confirmations = Array.from({ length: 5 }, (_, index) =>
      service.confirm({
        ...request,
        orderId: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
        publicOrderId: `ord_concurrent_${index}`,
        idempotencyKey: `erp-confirmation:concurrent-${index}`,
      }),
    );

    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(cap));
    releaseSleep();
    const results = await Promise.all(confirmations);
    expect(results.filter((result) => result.status === "succeeded")).toHaveLength(cap);
    expect(
      results.filter(
        (result) =>
          result.status === "failed" &&
          result.httpStatus === 429 &&
          result.errorCode === "erp_capacity_exceeded",
      ),
    ).toHaveLength(3);
  });
});

function createProvider(
  configStore: ErpChaosConfigStore,
  options: {
    sleep?: (durationMs: number) => Promise<void>;
    random?: () => number;
  } = {},
): ChaosConfirmationDecisionProvider {
  return new ChaosConfirmationDecisionProvider({
    configStore,
    tpsLimiter: new SlidingWindowTpsLimiter({ nowMs: () => 0 }),
    ...options,
  });
}
