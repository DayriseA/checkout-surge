import { type ErpConfirmationRequest, erpDispatchRateLimit } from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import { ChaosConfirmationDecisionProvider } from "../../src/application/chaos-control-service.js";
import {
  type ConfirmationResult,
  ConfirmationService,
} from "../../src/application/confirmation-service.js";
import { SlidingWindowTpsLimiter } from "../../src/application/tps-limiter.js";

const request: ErpConfirmationRequest = {
  erpConfig: { latencyMs: 0, maxTps: 100, errorRate: 0, forcedOutage: false },
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
  it("includes late arrivals from the leading native window in the sliding-second bound", () => {
    const { max, duration } = erpDispatchRateLimit(250);
    const arrivals = [0, ...Array<number>(max - 1).fill(duration - 1)];
    for (let start = duration; start <= 1_012; start += duration) {
      arrivals.push(...Array<number>(max).fill(start));
    }
    let now = 0;
    const limiter = new SlidingWindowTpsLimiter({ nowMs: () => now });
    let windowStart = 0;
    let nativeCount = 0;
    for (const at of arrivals) {
      if (at - windowStart >= duration) {
        windowStart = at;
        nativeCount = 0;
      }
      expect(++nativeCount).toBeLessThanOrEqual(max);
      now = at;
      expect(limiter.acquire("run", 250)).toBe(true);
    }
    const slidingCount = arrivals.filter((at) => now - at < 1_000).length;
    expect(slidingCount).toBe(234);
  });

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

describe("run-owned confirmation capacity", () => {
  it.each([
    0, 1,
  ])("acquires capacity before concurrent calls sleep at error rate %i", async (errorRate) => {
    let releaseSleep = () => {};
    const controlledSleep = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    const sleep = vi.fn((_durationMs: number) => controlledSleep);
    let nowMs = 0;
    const service = new ConfirmationService({
      decisionProvider: new ChaosConfirmationDecisionProvider({
        tpsLimiter: new SlidingWindowTpsLimiter({ nowMs: () => nowMs }),
        sleep,
        random: () => 0,
      }),
      now: () => new Date(nowMs),
    });
    const settled: ConfirmationResult[] = [];
    const confirmations = Array.from({ length: 5 }, (_, index) =>
      service
        .confirm({
          ...request,
          orderId: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
          publicOrderId: `ord_concurrent_${index}`,
          reservationId: `${String(index + 1).padStart(8, "0")}-2222-4222-8222-222222222222`,
          idempotencyKey: `erp-confirmation:concurrent-${index}`,
          erpConfig: { latencyMs: 25, maxTps: 2, errorRate, forcedOutage: false },
        })
        .then((result) => {
          settled.push(result);
          return result;
        }),
    );
    try {
      await vi.waitFor(() => {
        expect(sleep).toHaveBeenCalledTimes(2);
        expect(settled).toHaveLength(3);
      });
      expect(sleep.mock.calls).toEqual([[25], [25]]);
      expect(settled.map(({ response }) => response)).toEqual(
        Array.from({ length: 3 }, () =>
          expect.objectContaining({
            status: "failed",
            httpStatus: 429,
            errorCode: "erp_capacity_exceeded",
            latencyMs: 0,
          }),
        ),
      );
      nowMs = 25;
    } finally {
      releaseSleep();
    }
    const results = await Promise.all(confirmations);
    const admitted = results.filter(({ response }) => response.httpStatus !== 429);
    expect(admitted).toHaveLength(2);
    for (const { response } of admitted) {
      expect(response).toMatchObject(
        errorRate === 0
          ? { status: "succeeded", httpStatus: 200, latencyMs: 25 }
          : { status: "failed", httpStatus: 503, errorCode: "erp_injected_error", latencyMs: 25 },
      );
    }
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("checks outage before capacity and throttles before sleeping", async () => {
    const sleep = vi.fn(async () => undefined);
    const provider = new ChaosConfirmationDecisionProvider({
      tpsLimiter: new SlidingWindowTpsLimiter({ nowMs: () => 0 }),
      sleep,
    });
    const erpConfig = { latencyMs: 25, maxTps: 1, errorRate: 0, forcedOutage: false };
    await expect(
      provider.decide({ ...request, erpConfig: { ...erpConfig, forcedOutage: true } }),
    ).resolves.toMatchObject({ httpStatus: 503 });
    expect(sleep).not.toHaveBeenCalled();
    await expect(provider.decide({ ...request, erpConfig })).resolves.toEqual({
      status: "succeeded",
    });
    expect(sleep).toHaveBeenCalledOnce();
    sleep.mockClear();
    await expect(provider.decide({ ...request, erpConfig })).resolves.toMatchObject({
      httpStatus: 429,
    });
    expect(sleep).not.toHaveBeenCalled();
  });
  it("accounts admitted failures independently for each run", async () => {
    const provider = new ChaosConfirmationDecisionProvider({
      tpsLimiter: new SlidingWindowTpsLimiter({ nowMs: () => 0 }),
      random: () => 0,
    });
    const erpConfig = { latencyMs: 0, maxTps: 1, errorRate: 1, forcedOutage: false };
    await expect(provider.decide({ ...request, erpConfig })).resolves.toMatchObject({
      errorCode: "erp_injected_error",
    });
    await expect(provider.decide({ ...request, erpConfig })).resolves.toMatchObject({
      httpStatus: 429,
    });
    await expect(
      provider.decide({ ...request, runId: "55555555-5555-4555-8555-555555555555", erpConfig }),
    ).resolves.toMatchObject({ errorCode: "erp_injected_error" });
  });
});
