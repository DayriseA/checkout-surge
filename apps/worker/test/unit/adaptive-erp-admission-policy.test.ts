import { describe, expect, it } from "vitest";
import {
  AdaptiveErpAdmissionController,
  type AdaptiveErpPermit,
  adaptiveErpAdmissionPolicy,
  type ErpAdmissionOperation,
  type ErpAdmissionScope,
} from "../../src/application/adaptive-erp-admission-policy.js";

describe("adaptive ERP admission policy", () => {
  it("paces starts without idle burst credit and applies both in-flight bounds", () => {
    const clock = testClock();
    const controller = createController(clock);
    const first = acquire(controller, "catalog", "confirmation", 1);

    expect(controller.tryAcquire(request("catalog", "confirmation", 1))).toMatchObject({
      admitted: false,
      reason: "scope_in_flight",
    });
    controller.feedback(first, success());
    expect(controller.tryAcquire(request("catalog", "confirmation", 1))).toMatchObject({
      admitted: false,
      reason: "pacing",
      nextEligibleAtMs: 500,
    });

    clock.set(60_000);
    const afterIdle = acquire(controller, "catalog", "confirmation", 10);
    expect(controller.tryAcquire(request("catalog", "confirmation", 10))).toMatchObject({
      admitted: false,
      reason: "pacing",
      nextEligibleAtMs: 60_500,
    });
    controller.feedback(afterIdle, success());

    const scopeHeld: AdaptiveErpPermit[] = [];
    for (let index = 0; index < adaptiveErpAdmissionPolicy.perScopeInFlightCeiling; index += 1) {
      clock.advance(500);
      scopeHeld.push(acquire(controller, "run:bounded", "confirmation", 100));
    }
    clock.advance(500);
    expect(controller.tryAcquire(request("run:bounded", "confirmation", 100))).toMatchObject({
      admitted: false,
      reason: "scope_in_flight",
    });
    for (const permit of scopeHeld) controller.feedback(permit, success());

    const held: AdaptiveErpPermit[] = [];
    for (let index = 0; index < adaptiveErpAdmissionPolicy.workerInFlightCeiling; index += 1) {
      held.push(acquire(controller, `run:${index}`, "lookup", 100));
    }
    expect(controller.tryAcquire(request("run:overflow", "lookup", 100))).toMatchObject({
      admitted: false,
      reason: "worker_in_flight",
    });
    for (const permit of held) controller.feedback(permit, success());
  });

  it("increases only after useful stable windows, stops at the ceiling, and isolates scopes", () => {
    const clock = testClock();
    const controller = createController(clock);
    const catalog = acquire(controller, "catalog", "confirmation", 20);
    clock.set(adaptiveErpAdmissionPolicy.observationWindowMs);
    controller.feedback(catalog, { outcome: "succeeded", replayed: true });
    expect(controller.snapshot("catalog", 20).scope?.targetRatePerSecond).toBe(2);

    for (
      let expected = 3;
      expected <= adaptiveErpAdmissionPolicy.ceilingRatePerSecond;
      expected += 1
    ) {
      const permit = acquire(controller, "catalog", "confirmation", 20);
      clock.advance(adaptiveErpAdmissionPolicy.observationWindowMs);
      controller.feedback(permit, success());
      expect(controller.snapshot("catalog", 20).scope?.targetRatePerSecond).toBe(expected);
    }
    const atCeiling = acquire(controller, "catalog", "confirmation", 20);
    clock.advance(adaptiveErpAdmissionPolicy.observationWindowMs);
    controller.feedback(atCeiling, success());
    expect(controller.snapshot("catalog", 20).scope?.targetRatePerSecond).toBe(20);
    expect(controller.snapshot("run:separate", 20).scope).toBeNull();
    const separate = acquire(controller, "run:separate", "confirmation", 20);
    expect(controller.snapshot("run:separate", 20).scope?.targetRatePerSecond).toBe(2);
    controller.feedback(separate, success());
  });

  it("coalesces a time-based rejection wave, restarts stability, then reduces after the wave", () => {
    const clock = testClock();
    const controller = createController(clock);
    raiseRateToCeiling(controller, clock);
    const first = acquire(controller, "catalog", "confirmation", 20);

    controller.feedback(first, { outcome: "capacity_rejected", retryAfterMs: 0 });
    expect(controller.snapshot("catalog", 10).scope).toMatchObject({
      targetRatePerSecond: 10,
      generation: 1,
    });

    clock.advance(100);
    const coalesced = acquire(controller, "catalog", "confirmation", 20);
    controller.feedback(coalesced, { outcome: "capacity_rejected", retryAfterMs: 0 });
    expect(controller.snapshot("catalog", 10).scope).toMatchObject({
      targetRatePerSecond: 10,
      generation: 1,
    });

    clock.advance(adaptiveErpAdmissionPolicy.observationWindowMs - 100);
    const tooEarly = acquire(controller, "catalog", "confirmation", 20);
    controller.feedback(tooEarly, success());
    expect(controller.snapshot("catalog", 20).scope?.targetRatePerSecond).toBe(10);

    clock.advance(100);
    const stable = acquire(controller, "catalog", "confirmation", 20);
    controller.feedback(stable, success());
    expect(controller.snapshot("catalog", 20).scope?.targetRatePerSecond).toBe(11);

    clock.advance(100);
    const nextWave = acquire(controller, "catalog", "confirmation", 20);
    controller.feedback(nextWave, { outcome: "capacity_rejected", retryAfterMs: 0 });
    expect(controller.snapshot("catalog", 10).scope).toMatchObject({
      targetRatePerSecond: 5.5,
      generation: 2,
    });
  });

  it("keeps safety guidance from obsolete capacity and availability feedback", () => {
    const clock = testClock();
    const controller = createController(clock);
    const first = acquire(controller, "catalog", "confirmation", 10);
    clock.advance(500);
    const second = acquire(controller, "catalog", "confirmation", 10);

    controller.feedback(first, { outcome: "capacity_rejected", retryAfterMs: 1_000 });
    clock.set(1_500);
    const currentSuccess = acquire(controller, "catalog", "confirmation", 10);
    clock.set(5_000);
    controller.feedback(second, { outcome: "capacity_rejected", retryAfterMs: 10_000 });
    expect(controller.snapshot("catalog", 10).scope).toMatchObject({
      generation: 1,
      targetRatePerSecond: 1,
      cooldownUntilMs: 15_000,
    });
    clock.set(10_500);
    controller.feedback(currentSuccess, success());
    expect(controller.snapshot("catalog", 10).scope?.targetRatePerSecond).toBe(1);
    clock.set(15_000);
    const stableSuccess = acquire(controller, "catalog", "confirmation", 10);
    controller.feedback(stableSuccess, success());
    expect(controller.snapshot("catalog", 10).scope?.targetRatePerSecond).toBe(2);

    const otherClock = testClock();
    const other = createController(otherClock);
    const reduction = acquire(other, "catalog", "confirmation", 10);
    const staleLookup = acquire(other, "catalog", "lookup", 10);
    other.feedback(reduction, { outcome: "capacity_rejected", retryAfterMs: 0 });
    other.feedback(staleLookup, { outcome: "temporarily_unavailable", retryAfterMs: 20_000 });
    expect(other.snapshot("catalog", 10).scope).toMatchObject({
      availabilityFailureCount: 0,
      availabilityRetryAtMs: 20_000,
    });
    expect(other.tryAcquire(request("catalog", "lookup", 10))).toMatchObject({
      admitted: false,
      reason: "availability_backoff",
      nextEligibleAtMs: 20_000,
    });
  });

  it("honors availability Retry-After before opening for confirmations and lookups", () => {
    const clock = testClock();
    const controller = createController(clock);
    const confirmation = acquire(controller, "catalog", "confirmation", 10);
    controller.feedback(confirmation, {
      outcome: "temporarily_unavailable",
      retryAfterMs: 60_000,
    });

    for (const operation of ["confirmation", "lookup"] as const) {
      expect(controller.tryAcquire(request("catalog", operation, 10))).toMatchObject({
        admitted: false,
        reason: "availability_backoff",
        nextEligibleAtMs: 60_000,
      });
    }
    expect(controller.snapshot("catalog", 10).scope).toMatchObject({
      availabilityCircuitOpen: false,
      availabilityFailureCount: 1,
      availabilityRetryAtMs: 60_000,
    });

    const lookup = acquire(controller, "run:lookup", "lookup", 10);
    controller.feedback(lookup, { outcome: "temporarily_unavailable", retryAfterMs: 30_000 });
    expect(controller.tryAcquire(request("run:lookup", "confirmation", 10))).toMatchObject({
      admitted: false,
      reason: "availability_backoff",
      nextEligibleAtMs: 30_000,
    });
  });

  it("does not let concurrent success shorten availability or capacity deadlines", () => {
    const clock = testClock();
    const controller = createController(clock);
    const earlierSuccess = acquire(controller, "catalog", "confirmation", 10);
    clock.set(500);
    const unavailable = acquire(controller, "catalog", "confirmation", 10);
    controller.feedback(unavailable, {
      outcome: "temporarily_unavailable",
      retryAfterMs: 60_000,
    });
    clock.set(600);
    controller.feedback(earlierSuccess, success());
    expect(controller.snapshot("catalog", 10).scope).toMatchObject({
      availabilityFailureCount: 0,
      availabilityRetryAtMs: 60_500,
    });
    expect(controller.tryAcquire(request("catalog", "lookup", 10))).toMatchObject({
      admitted: false,
      reason: "availability_backoff",
      nextEligibleAtMs: 60_500,
    });

    const capacityClock = testClock();
    const capacity = createController(capacityClock);
    const obsoleteSuccess = acquire(capacity, "catalog", "confirmation", 10);
    capacityClock.set(500);
    const rejected = acquire(capacity, "catalog", "confirmation", 10);
    capacity.feedback(rejected, { outcome: "capacity_rejected", retryAfterMs: 60_000 });
    capacityClock.set(10_500);
    capacity.feedback(obsoleteSuccess, success());
    expect(capacity.snapshot("catalog", 10).scope).toMatchObject({
      targetRatePerSecond: 1,
      generation: 1,
      cooldownUntilMs: 60_500,
    });
  });

  it("opens only for availability failures and admits at most one probe per five seconds", () => {
    const clock = testClock();
    const controller = createController(clock);
    const lateSuccess = acquire(controller, "catalog", "confirmation", 10);
    clock.advance(500);

    for (const outcome of ["temporarily_unavailable", "uncertain_result"] as const) {
      const permit = acquire(controller, "catalog", "confirmation", 10);
      controller.feedback(permit, { outcome });
      clock.set(controller.snapshot("catalog", 10).scope?.availabilityRetryAtMs ?? 0);
    }
    const third = acquire(controller, "catalog", "confirmation", 10);
    controller.feedback(third, { outcome: "temporarily_unavailable", retryAfterMs: 20_000 });
    controller.feedback(lateSuccess, success());
    expect(controller.snapshot("catalog", 10).scope).toMatchObject({
      availabilityCircuitOpen: true,
      circuitOpenUntilMs: 28_000,
    });
    expect(controller.tryAcquire(request("catalog", "lookup", 10))).toMatchObject({
      admitted: false,
      reason: "availability_probe_wait",
      nextEligibleAtMs: 28_000,
    });

    clock.set(28_000);
    const lookupProbe = acquire(controller, "catalog", "lookup", 10);
    expect(lookupProbe.probe).toBe(true);
    expect(controller.tryAcquire(request("catalog", "confirmation", 10))).toMatchObject({
      admitted: false,
      reason: "availability_probe_in_flight",
    });
    controller.feedback(lookupProbe, success());
    expect(controller.snapshot("catalog", 10).scope?.availabilityCircuitOpen).toBe(true);
    expect(controller.tryAcquire(request("catalog", "lookup", 10))).toMatchObject({
      admitted: false,
      reason: "availability_probe_wait",
      nextEligibleAtMs: 33_000,
    });

    clock.set(33_000);
    const replayProbe = acquire(controller, "catalog", "confirmation", 10);
    controller.feedback(replayProbe, { outcome: "succeeded", replayed: true });
    expect(controller.snapshot("catalog", 10).scope?.availabilityCircuitOpen).toBe(true);

    clock.set(38_000);
    const healthyProbe = acquire(controller, "catalog", "confirmation", 10);
    controller.feedback(healthyProbe, success());
    expect(controller.snapshot("catalog", 10).scope).toMatchObject({
      availabilityCircuitOpen: false,
      targetRatePerSecond: adaptiveErpAdmissionPolicy.initialRatePerSecond,
    });
  });

  it("lets bounded lookups bypass capacity pacing while replayed results teach no health", () => {
    const clock = testClock();
    const controller = createController(clock);
    const confirmation = acquire(controller, "catalog", "confirmation", 10);
    controller.feedback(confirmation, { outcome: "capacity_rejected", retryAfterMs: 10_000 });

    const firstLookup = acquire(controller, "catalog", "lookup", 10);
    const secondLookup = acquire(controller, "catalog", "lookup", 10);
    expect(controller.tryAcquire(request("catalog", "lookup", 10))).toMatchObject({
      admitted: false,
      reason: "lookup_in_flight",
    });
    controller.feedback(firstLookup, success());
    controller.feedback(secondLookup, success());
    expect(controller.snapshot("catalog", 10).scope).toMatchObject({
      targetRatePerSecond: 1,
      availabilityFailureCount: 0,
      cooldownUntilMs: 10_000,
    });
  });

  it("never raises a capacity-reduced rate when an outage opens or recovers", () => {
    const clock = testClock();
    const controller = createController(clock);
    for (let reduction = 0; reduction < 3; reduction += 1) {
      const permit = acquire(controller, "catalog", "confirmation", 10);
      controller.feedback(permit, { outcome: "capacity_rejected", retryAfterMs: 0 });
      clock.set(controller.snapshot("catalog", 10).scope?.nextStartAtMs ?? 0);
    }
    expect(controller.snapshot("catalog", 10).scope?.targetRatePerSecond).toBe(
      adaptiveErpAdmissionPolicy.floorRatePerSecond,
    );

    for (let failure = 0; failure < 3; failure += 1) {
      const permit = acquire(controller, "catalog", "confirmation", 10);
      controller.feedback(permit, { outcome: "temporarily_unavailable" });
      clock.set(controller.snapshot("catalog", 10).scope?.availabilityRetryAtMs ?? 0);
    }
    expect(controller.snapshot("catalog", 10).scope).toMatchObject({
      targetRatePerSecond: adaptiveErpAdmissionPolicy.floorRatePerSecond,
      availabilityCircuitOpen: true,
    });

    const probe = acquire(controller, "catalog", "confirmation", 10);
    controller.feedback(probe, success());
    expect(controller.snapshot("catalog", 10).scope).toMatchObject({
      targetRatePerSecond: adaptiveErpAdmissionPolicy.floorRatePerSecond,
      availabilityCircuitOpen: false,
    });
  });

  it("bounds jitter, escalates fallback backoff, and caps retry guidance", () => {
    const invalidClock = testClock();
    const minimumJitter = createController(invalidClock, () => 0);
    const invalid = acquire(minimumJitter, "catalog", "confirmation", 10);
    minimumJitter.feedback(invalid, {
      outcome: "capacity_rejected",
      retryAfterMs: Number.NaN,
    });
    expect(minimumJitter.snapshot("catalog", 10).scope?.cooldownUntilMs).toBe(500);

    const clock = testClock();
    const maximumJitter = createController(clock, () => 0.999);
    const fallbackDelays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const permit = acquire(maximumJitter, "catalog", "confirmation", 10);
      const feedbackAt = clock.now();
      maximumJitter.feedback(permit, { outcome: "capacity_rejected" });
      const snapshot = maximumJitter.snapshot("catalog", 10).scope;
      fallbackDelays.push((snapshot?.cooldownUntilMs ?? 0) - feedbackAt);
      clock.set(Math.max(snapshot?.cooldownUntilMs ?? 0, snapshot?.nextStartAtMs ?? 0));
    }
    expect(fallbackDelays).toEqual([999, 1_999, 3_998, 7_996, 15_992, 31_984, 59_970, 59_970]);
    expect(Math.max(...fallbackDelays)).toBeLessThanOrEqual(
      adaptiveErpAdmissionPolicy.maximumCooldownMs,
    );

    const cappedClock = testClock();
    const capped = createController(cappedClock, () => 0.5);
    const permit = acquire(capped, "catalog", "confirmation", 10);
    capped.feedback(permit, { outcome: "capacity_rejected", retryAfterMs: 120_000 });
    expect(capped.snapshot("catalog", 10).scope?.cooldownUntilMs).toBe(
      adaptiveErpAdmissionPolicy.maximumCooldownMs,
    );
  });

  it("does not evict a scope with pending pacing at the retention limit", () => {
    const clock = testClock();
    const controller = createController(clock);
    const protectedPermit = acquire(controller, "catalog", "confirmation", 10);
    controller.feedback(protectedPermit, success());
    for (let index = 0; index < adaptiveErpAdmissionPolicy.maximumScopeStates - 1; index += 1) {
      const permit = acquire(controller, `run:${index}`, "lookup", 10);
      controller.feedback(permit, success());
    }

    const replacement = acquire(controller, "run:replacement", "lookup", 10);
    controller.feedback(replacement, success());
    expect(controller.tryAcquire(request("catalog", "confirmation", 10))).toMatchObject({
      admitted: false,
      reason: "pacing",
      nextEligibleAtMs: 500,
    });
  });

  it("serializes only bounded restart safety and restores learning conservatively", () => {
    const clock = testClock();
    const controller = createController(clock);
    const permit = acquire(controller, "catalog", "confirmation", 10);
    controller.feedback(permit, { outcome: "capacity_rejected", retryAfterMs: 4_000 });

    const safety = controller.safetyState();
    expect(safety).toEqual({
      policyVersion: adaptiveErpAdmissionPolicy.version,
      scopes: [
        {
          scope: "catalog",
          cooldownUntilMs: 4_000,
          availabilityRetryAtMs: 0,
          availabilityCircuitOpen: false,
          circuitOpenUntilMs: 0,
          nextProbeAtMs: 0,
        },
      ],
    });
    expect(Object.keys(safety.scopes[0] ?? {})).not.toContain("targetRatePerSecond");

    const restarted = new AdaptiveErpAdmissionController({
      now: clock.now,
      random: () => 0,
      safetyState: safety,
    });
    expect(restarted.snapshot("catalog", 10).scope).toMatchObject({
      targetRatePerSecond: adaptiveErpAdmissionPolicy.initialRatePerSecond,
      generation: 0,
      cooldownUntilMs: 4_000,
    });
  });

  it("restores only still-running circuit safety", () => {
    const clock = testClock();
    clock.set(5_000);
    const controller = new AdaptiveErpAdmissionController({
      now: clock.now,
      random: () => 0,
      safetyState: {
        policyVersion: adaptiveErpAdmissionPolicy.version,
        scopes: [
          {
            scope: "catalog",
            cooldownUntilMs: 4_000,
            availabilityRetryAtMs: 4_000,
            availabilityCircuitOpen: true,
            circuitOpenUntilMs: 4_000,
            nextProbeAtMs: 4_000,
          },
          {
            scope: "run:active",
            cooldownUntilMs: 6_000,
            availabilityRetryAtMs: 10_000,
            availabilityCircuitOpen: true,
            circuitOpenUntilMs: 10_000,
            nextProbeAtMs: 10_000,
          },
        ],
      },
    });

    expect(controller.snapshot("catalog", 10).scope).toMatchObject({
      targetRatePerSecond: adaptiveErpAdmissionPolicy.initialRatePerSecond,
      cooldownUntilMs: 0,
      availabilityRetryAtMs: 0,
      availabilityCircuitOpen: false,
      circuitOpenUntilMs: 0,
    });
    expect(controller.tryAcquire(request("run:active", "lookup", 10))).toMatchObject({
      admitted: false,
      reason: "availability_probe_wait",
      nextEligibleAtMs: 10_000,
    });
  });

  it("restores an unexpired probe deadline after the circuit-open deadline", () => {
    const clock = testClock();
    const controller = createController(clock);
    for (let failure = 0; failure < 2; failure += 1) {
      const permit = acquire(controller, "catalog", "confirmation", 10);
      controller.feedback(permit, { outcome: "temporarily_unavailable" });
      clock.set(controller.snapshot("catalog", 10).scope?.availabilityRetryAtMs ?? 0);
    }
    const openingFailure = acquire(controller, "catalog", "confirmation", 10);
    controller.feedback(openingFailure, {
      outcome: "temporarily_unavailable",
      retryAfterMs: 20_500,
    });
    clock.set(28_000);
    const lookupProbe = acquire(controller, "catalog", "lookup", 10);
    controller.feedback(lookupProbe, success());

    clock.set(28_001);
    const restarted = new AdaptiveErpAdmissionController({
      now: clock.now,
      random: () => 0,
      safetyState: controller.safetyState(),
    });
    expect(restarted.snapshot("catalog", 10).scope).toMatchObject({
      availabilityCircuitOpen: true,
      circuitOpenUntilMs: 0,
      nextProbeAtMs: 33_000,
    });
    expect(restarted.tryAcquire(request("catalog", "lookup", 10))).toMatchObject({
      admitted: false,
      reason: "availability_probe_wait",
      nextEligibleAtMs: 33_000,
    });
  });
});

function request(
  scope: ErpAdmissionScope,
  operation: ErpAdmissionOperation,
  configuredConcurrency: number,
) {
  return { scope, operation, configuredConcurrency };
}

function acquire(
  controller: AdaptiveErpAdmissionController,
  scope: ErpAdmissionScope,
  operation: ErpAdmissionOperation,
  configuredConcurrency: number,
): AdaptiveErpPermit {
  const decision = controller.tryAcquire(request(scope, operation, configuredConcurrency));
  if (!decision.admitted) throw new Error(`Expected admission, received ${decision.reason}.`);
  return decision.permit;
}

function success() {
  return { outcome: "succeeded" as const, replayed: false };
}

function createController(clock: ReturnType<typeof testClock>, random = () => 0) {
  return new AdaptiveErpAdmissionController({ now: clock.now, random });
}

function raiseRateToCeiling(
  controller: AdaptiveErpAdmissionController,
  clock: ReturnType<typeof testClock>,
) {
  while (
    controller.snapshot("catalog", 20).scope?.targetRatePerSecond !==
    adaptiveErpAdmissionPolicy.ceilingRatePerSecond
  ) {
    const permit = acquire(controller, "catalog", "confirmation", 20);
    clock.advance(adaptiveErpAdmissionPolicy.observationWindowMs);
    controller.feedback(permit, success());
  }
}

function testClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    set(value: number) {
      nowMs = value;
    },
    advance(value: number) {
      nowMs += value;
    },
  };
}
