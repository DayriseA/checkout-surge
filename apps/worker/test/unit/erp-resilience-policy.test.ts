import { erpDispatchEnginePolicyIdentity } from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import {
  AdaptiveErpAdmissionController,
  type AdaptiveErpPermit,
  AdaptiveErpRequestDeadlineController,
  type ErpAdmissionOperation,
  type ErpAdmissionScope,
  erpResiliencePolicy,
} from "../../src/application/erp-resilience-policy.js";

describe("engine-policy identity", () => {
  it("derives its version from the shared contracts identity (D13)", () => {
    expect(erpResiliencePolicy.version).toBe(
      `${erpDispatchEnginePolicyIdentity.name}-v${erpDispatchEnginePolicyIdentity.version}`,
    );
  });
});

describe("adaptive ERP request deadlines", () => {
  it("uses the initial deadline for an empty scope and isolates scope samples", () => {
    const clock = testClock();
    const controller = new AdaptiveErpRequestDeadlineController({ now: clock.now });

    expect(controller.deadline("catalog")).toBe(erpResiliencePolicy.initialRequestDeadlineMs);
    controller.record({
      scope: "catalog",
      source: "confirmation_response",
      durationMs: 1_000,
      requestDeadlineMs: 2_000,
    });
    expect(controller.deadline("catalog")).toBe(2_000);
    expect(controller.deadline("run:separate")).toBe(erpResiliencePolicy.initialRequestDeadlineMs);
  });

  it("uses nearest-rank percentile, evicts the oldest sample, and clamps both bounds", () => {
    const controller = new AdaptiveErpRequestDeadlineController({ now: () => 0 });
    for (let index = 0; index < 95; index += 1) recordResponse(controller, 0);
    for (let index = 0; index < 5; index += 1) recordResponse(controller, 1_000);
    expect(controller.deadline("catalog")).toBe(500);

    recordResponse(controller, 1_000);
    expect(controller.snapshot("catalog").sampleCount).toBe(100);
    expect(controller.deadline("catalog")).toBe(2_000);

    for (let index = 0; index < 100; index += 1) recordResponse(controller, 10_000);
    expect(controller.deadline("catalog")).toBe(6_000);
  });

  it("counts timeouts at their used deadline and excludes lookup, replay, and local reuse", () => {
    const controller = new AdaptiveErpRequestDeadlineController({ now: () => 0 });
    for (const source of ["lookup", "replay", "local_reuse"] as const) {
      controller.record({
        scope: "catalog",
        source,
        durationMs: 5_000,
        requestDeadlineMs: 2_000,
      });
    }
    expect(controller.snapshot("catalog").sampleCount).toBe(0);

    for (const expected of [3_500, 5_750, 6_000]) {
      const usedDeadline = controller.deadline("catalog");
      controller.record({
        scope: "catalog",
        source: "confirmation_timeout",
        durationMs: usedDeadline + 1_000,
        requestDeadlineMs: usedDeadline,
      });
      expect(controller.deadline("catalog")).toBe(expected);
    }
    expect(controller.snapshot("catalog").sampleCount).toBe(3);
  });

  it("bounds retained scope state by evicting the least recently used scope", () => {
    let now = 0;
    const controller = new AdaptiveErpRequestDeadlineController({ now: () => now++ });
    for (let index = 0; index <= erpResiliencePolicy.maximumScopeStates; index += 1) {
      controller.record({
        scope: `run:${index}`,
        source: "confirmation_response",
        durationMs: 100,
        requestDeadlineMs: 2_000,
      });
    }
    expect(controller.snapshot("run:0").sampleCount).toBe(0);
    expect(controller.snapshot(`run:${erpResiliencePolicy.maximumScopeStates}`).sampleCount).toBe(
      1,
    );
    expect(controller.snapshot("run:0").scopeCount).toBe(erpResiliencePolicy.maximumScopeStates);
  });
});

describe("adaptive ERP admission policy", () => {
  it("releases technical failures without pacing or availability feedback", () => {
    const clock = testClock();
    const controller = createController(clock);
    const permit = acquire(controller, "catalog", "confirmation", 1);

    const snapshot = controller.feedback(permit, { outcome: "technical_failure" });

    expect(snapshot.scope).toMatchObject({
      cooldownUntilMs: 0,
      availabilityRetryAtMs: 0,
      availabilityFailureCount: 0,
      availabilityCircuitOpen: false,
    });
  });

  it("applies both in-flight safety bounds without pacing deferrals", () => {
    const clock = testClock();
    const controller = createController(clock);
    const first = acquire(controller, "catalog", "confirmation", 1);

    expect(controller.tryAcquire(request("catalog", "confirmation", 1))).toMatchObject({
      admitted: false,
      reason: "scope_in_flight",
    });
    controller.feedback(first, success());
    const next = acquire(controller, "catalog", "confirmation", 1);
    controller.feedback(next, success());

    const scopeHeld: AdaptiveErpPermit[] = [];
    for (let index = 0; index < erpResiliencePolicy.perScopeInFlightCeiling; index += 1) {
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
    for (let index = 0; index < erpResiliencePolicy.workerInFlightCeiling; index += 1) {
      held.push(acquire(controller, `run:${index}`, "lookup", 100));
    }
    expect(controller.tryAcquire(request("run:overflow", "lookup", 100))).toMatchObject({
      admitted: false,
      reason: "worker_in_flight",
    });
    for (const permit of held) controller.feedback(permit, success());
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
    });
  });

  it("lets bounded lookups bypass capacity cooldown while replayed results teach no health", () => {
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
      availabilityFailureCount: 0,
      cooldownUntilMs: 10_000,
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
      clock.set(snapshot?.cooldownUntilMs ?? 0);
    }
    expect(fallbackDelays).toEqual([999, 1_999, 3_998, 7_996, 15_992, 31_984, 59_970, 59_970]);
    expect(Math.max(...fallbackDelays)).toBeLessThanOrEqual(erpResiliencePolicy.maximumCooldownMs);

    const cappedClock = testClock();
    const capped = createController(cappedClock, () => 0.5);
    const permit = acquire(capped, "catalog", "confirmation", 10);
    capped.feedback(permit, { outcome: "capacity_rejected", retryAfterMs: 120_000 });
    expect(capped.snapshot("catalog", 10).scope?.cooldownUntilMs).toBe(
      erpResiliencePolicy.maximumCooldownMs,
    );
  });

  it("does not evict a scope with an unexpired cooldown at the retention limit", () => {
    const clock = testClock();
    const controller = createController(clock);
    const protectedPermit = acquire(controller, "catalog", "confirmation", 10);
    controller.feedback(protectedPermit, { outcome: "capacity_rejected", retryAfterMs: 500 });
    for (let index = 0; index < erpResiliencePolicy.maximumScopeStates - 1; index += 1) {
      const permit = acquire(controller, `run:${index}`, "lookup", 10);
      controller.feedback(permit, success());
    }

    const replacement = acquire(controller, "run:replacement", "lookup", 10);
    controller.feedback(replacement, success());
    expect(controller.tryAcquire(request("catalog", "confirmation", 10))).toMatchObject({
      admitted: false,
      reason: "capacity_cooldown",
      nextEligibleAtMs: 500,
    });
  });

  it("serializes and restores bounded restart safety", () => {
    const clock = testClock();
    const controller = createController(clock);
    const permit = acquire(controller, "catalog", "confirmation", 10);
    controller.feedback(permit, { outcome: "capacity_rejected", retryAfterMs: 4_000 });

    const safety = controller.safetyState();
    expect(safety).toEqual({
      policyVersion: erpResiliencePolicy.version,
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

    const restarted = new AdaptiveErpAdmissionController({
      now: clock.now,
      random: () => 0,
      safetyState: safety,
    });
    expect(restarted.snapshot("catalog", 10).scope).toMatchObject({
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
        policyVersion: erpResiliencePolicy.version,
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

  it("hands an unknown lookup probe directly to one confirmation probe", () => {
    const clock = testClock();
    clock.set(5_000);
    const controller = new AdaptiveErpAdmissionController({
      now: clock.now,
      random: () => 0,
      safetyState: {
        policyVersion: erpResiliencePolicy.version,
        scopes: [
          {
            scope: "catalog",
            cooldownUntilMs: 0,
            availabilityRetryAtMs: 5_001,
            availabilityCircuitOpen: true,
            circuitOpenUntilMs: 5_001,
            nextProbeAtMs: 5_001,
          },
        ],
      },
    });
    clock.set(5_001);
    const lookup = acquire(controller, "catalog", "lookup", 10);
    expect(lookup.probe).toBe(true);
    controller.feedback(lookup, success());
    expect(controller.tryAcquire(request("catalog", "confirmation", 10))).toMatchObject({
      admitted: false,
      reason: "availability_probe_wait",
    });
    expect(
      controller.tryAcquire({
        ...request("catalog", "confirmation", 10),
        confirmationProbeContinuation: true,
      }),
    ).toMatchObject({ admitted: true, permit: { probe: true } });
  });

  it("keeps capacity cooldown on a confirmation probe continuation", () => {
    const clock = testClock();
    const controller = new AdaptiveErpAdmissionController({
      now: clock.now,
      random: () => 0,
      safetyState: {
        policyVersion: erpResiliencePolicy.version,
        scopes: [
          {
            scope: "catalog",
            cooldownUntilMs: 0,
            availabilityRetryAtMs: 0,
            availabilityCircuitOpen: true,
            circuitOpenUntilMs: 1_000,
            nextProbeAtMs: 1_000,
          },
        ],
      },
    });

    clock.set(1_000);
    const confirmationProbe = acquire(controller, "catalog", "confirmation", 10);
    controller.feedback(confirmationProbe, {
      outcome: "capacity_rejected",
      retryAfterMs: 60_000,
    });
    clock.set(6_000);
    const lookupProbe = acquire(controller, "catalog", "lookup", 10);
    controller.feedback(lookupProbe, success());

    expect(
      controller.tryAcquire({
        ...request("catalog", "confirmation", 10),
        confirmationProbeContinuation: true,
      }),
    ).toMatchObject({
      admitted: false,
      reason: "availability_probe_wait",
      nextEligibleAtMs: 61_000,
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

function recordResponse(controller: AdaptiveErpRequestDeadlineController, durationMs: number) {
  controller.record({
    scope: "catalog",
    source: "confirmation_response",
    durationMs,
    requestDeadlineMs: 2_000,
  });
}

function createController(clock: ReturnType<typeof testClock>, random = () => 0) {
  return new AdaptiveErpAdmissionController({ now: clock.now, random });
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
