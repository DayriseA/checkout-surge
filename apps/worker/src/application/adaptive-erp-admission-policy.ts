import type { ErpOutcomeDisposition } from "@checkout-surge/contracts";

export const adaptiveErpAdmissionPolicy = {
  version: "adaptive-erp-admission-v1-provisional",
  initialRatePerSecond: 2,
  floorRatePerSecond: 0.5,
  ceilingRatePerSecond: 20,
  additiveStepPerSecond: 1,
  reductionFactor: 0.5,
  observationWindowMs: 10_000,
  rejectionWaveWindowMs: 1_000,
  fallbackCooldownMs: 1_000,
  maximumCooldownMs: 60_000,
  availabilityFailuresToOpen: 3,
  availabilityBackoffMs: 5_000,
  maximumAvailabilityBackoffMs: 60_000,
  probeCadenceMs: 5_000,
  perScopeInFlightCeiling: 10,
  workerInFlightCeiling: 20,
  lookupInFlightCeiling: 2,
  deferredRecheckMs: 100,
  maximumScopeStates: 1_000,
} as const;

export type ErpAdmissionScope = `run:${string}` | "catalog";
export type ErpAdmissionOperation = "confirmation" | "lookup";

export type ErpAdmissionFeedback =
  | {
      outcome: Extract<ErpOutcomeDisposition, "succeeded" | "permanent_rejection">;
      replayed: boolean;
    }
  | { outcome: Extract<ErpOutcomeDisposition, "capacity_rejected">; retryAfterMs?: number }
  | {
      outcome: Extract<ErpOutcomeDisposition, "temporarily_unavailable" | "uncertain_result">;
      retryAfterMs?: number;
    }
  | { outcome: Extract<ErpOutcomeDisposition, "intervention_required"> };

export interface AdaptiveErpPermit {
  readonly scope: ErpAdmissionScope;
  readonly operation: ErpAdmissionOperation;
  readonly admittedAtMs: number;
  readonly generation: number;
  readonly probe: boolean;
}

export type ErpAdmissionReason =
  | "admitted"
  | "availability_probe_wait"
  | "availability_probe_in_flight"
  | "availability_backoff"
  | "capacity_cooldown"
  | "lookup_in_flight"
  | "pacing"
  | "scope_in_flight"
  | "scope_state_limit"
  | "worker_in_flight";

export interface AdaptiveErpAdmissionSnapshot {
  policyVersion: string;
  workerInFlight: number;
  workerInFlightCeiling: number;
  scopeCount: number;
  scope: null | {
    key: ErpAdmissionScope;
    targetRatePerSecond: number;
    generation: number;
    confirmationInFlight: number;
    confirmationInFlightCeiling: number;
    lookupInFlight: number;
    lookupInFlightCeiling: number;
    nextStartAtMs: number;
    cooldownUntilMs: number;
    availabilityRetryAtMs: number;
    availabilityFailureCount: number;
    availabilityCircuitOpen: boolean;
    circuitOpenUntilMs: number;
    nextProbeAtMs: number;
    probeInFlight: boolean;
  };
}

export type AdaptiveErpAdmissionDecision =
  | {
      admitted: true;
      reason: "admitted";
      nextEligibleAtMs: number;
      permit: AdaptiveErpPermit;
      snapshot: AdaptiveErpAdmissionSnapshot;
    }
  | {
      admitted: false;
      reason: Exclude<ErpAdmissionReason, "admitted">;
      nextEligibleAtMs: number;
      snapshot: AdaptiveErpAdmissionSnapshot;
    };

/** This is the complete task-09 persistence boundary; learned rate/window state is excluded. */
export interface AdaptiveErpAdmissionSafetyState {
  policyVersion: string;
  scopes: Array<{
    scope: ErpAdmissionScope;
    cooldownUntilMs: number;
    availabilityRetryAtMs: number;
    availabilityCircuitOpen: boolean;
    circuitOpenUntilMs: number;
    nextProbeAtMs: number;
  }>;
}

interface ScopeState {
  rate: number;
  generation: number;
  nextStartAtMs: number;
  observationStartedAtMs: number;
  usefulProgress: number;
  lastReductionAtMs: number;
  cooldownUntilMs: number;
  availabilityRetryAtMs: number;
  capacityBackoffAttempt: number;
  confirmationInFlight: number;
  lookupInFlight: number;
  availabilityFailureCount: number;
  availabilityCircuitOpen: boolean;
  circuitOpenUntilMs: number;
  nextProbeAtMs: number;
  probeInFlight: boolean;
  availabilityBackoffAttempt: number;
  lastUsedAtMs: number;
}

interface InternalPermit extends AdaptiveErpPermit {
  readonly configuredConcurrency: number;
}

export class AdaptiveErpAdmissionController {
  private readonly scopes = new Map<ErpAdmissionScope, ScopeState>();
  private readonly activePermits = new WeakSet<object>();
  private workerInFlight = 0;

  constructor(
    private readonly dependencies: {
      now: () => number;
      random: () => number;
      safetyState?: AdaptiveErpAdmissionSafetyState;
    },
  ) {
    const now = this.now();
    for (const safety of dependencies.safetyState?.scopes.slice(
      0,
      adaptiveErpAdmissionPolicy.maximumScopeStates,
    ) ?? []) {
      const state = this.newScopeState(now);
      state.cooldownUntilMs = safety.cooldownUntilMs > now ? safety.cooldownUntilMs : 0;
      state.availabilityRetryAtMs =
        safety.availabilityRetryAtMs > now ? safety.availabilityRetryAtMs : 0;
      state.availabilityCircuitOpen =
        safety.availabilityCircuitOpen &&
        Math.max(safety.availabilityRetryAtMs, safety.circuitOpenUntilMs, safety.nextProbeAtMs) >
          now;
      state.circuitOpenUntilMs = safety.circuitOpenUntilMs > now ? safety.circuitOpenUntilMs : 0;
      state.nextProbeAtMs = safety.nextProbeAtMs > now ? safety.nextProbeAtMs : 0;
      this.scopes.set(safety.scope, state);
    }
  }

  tryAcquire(input: {
    scope: ErpAdmissionScope;
    operation: ErpAdmissionOperation;
    configuredConcurrency: number;
  }): AdaptiveErpAdmissionDecision {
    const now = this.now();
    const state = this.getOrCreateScope(input.scope, now);
    if (!state) return this.deferred(input, null, "scope_state_limit", now, now);
    state.lastUsedAtMs = now;

    if (this.workerInFlight >= adaptiveErpAdmissionPolicy.workerInFlightCeiling) {
      return this.deferred(input, state, "worker_in_flight", now, now);
    }
    if (
      input.operation === "lookup" &&
      state.lookupInFlight >= adaptiveErpAdmissionPolicy.lookupInFlightCeiling
    ) {
      return this.deferred(input, state, "lookup_in_flight", now, now);
    }
    const confirmationLimit = this.confirmationLimit(input.configuredConcurrency);
    if (input.operation === "confirmation" && state.confirmationInFlight >= confirmationLimit) {
      return this.deferred(input, state, "scope_in_flight", now, now);
    }

    if (state.availabilityCircuitOpen) {
      if (state.probeInFlight) {
        return this.deferred(input, state, "availability_probe_in_flight", now, now);
      }
      const probeAt = Math.max(
        state.circuitOpenUntilMs,
        state.nextProbeAtMs,
        state.availabilityRetryAtMs,
        input.operation === "confirmation" ? state.cooldownUntilMs : 0,
      );
      if (now < probeAt) {
        return this.deferred(input, state, "availability_probe_wait", now, probeAt);
      }
      return this.admit(input, state, now, true);
    }

    if (now < state.availabilityRetryAtMs) {
      return this.deferred(input, state, "availability_backoff", now, state.availabilityRetryAtMs);
    }

    if (input.operation === "confirmation") {
      if (now < state.cooldownUntilMs) {
        return this.deferred(input, state, "capacity_cooldown", now, state.cooldownUntilMs);
      }
      if (now < state.nextStartAtMs) {
        return this.deferred(input, state, "pacing", now, state.nextStartAtMs);
      }
    }
    return this.admit(input, state, now, false);
  }

  feedback(
    permit: AdaptiveErpPermit,
    feedback: ErpAdmissionFeedback,
  ): AdaptiveErpAdmissionSnapshot {
    const internal = permit as InternalPermit;
    const state = this.scopes.get(internal.scope);
    if (!state || !this.activePermits.has(internal)) {
      throw new Error("ERP admission permit is not active.");
    }
    this.activePermits.delete(internal);
    this.workerInFlight -= 1;
    if (internal.operation === "lookup") state.lookupInFlight -= 1;
    else state.confirmationInFlight -= 1;
    if (internal.probe) state.probeInFlight = false;

    const now = this.now();
    state.lastUsedAtMs = now;
    if (feedback.outcome === "capacity_rejected") {
      if (internal.operation === "confirmation") {
        const currentGeneration = internal.generation === state.generation;
        this.recordCapacityGuidance(state, feedback, now, currentGeneration);
        if (currentGeneration) this.recordCapacityReduction(state, now);
      }
    } else if (
      feedback.outcome === "temporarily_unavailable" ||
      feedback.outcome === "uncertain_result"
    ) {
      const currentGeneration = internal.generation === state.generation;
      this.recordAvailabilityGuidance(state, feedback, now, currentGeneration);
      if (currentGeneration) {
        this.recordUnavailable(state, internal.probe, now);
      }
    } else if (
      internal.generation === state.generation &&
      internal.operation === "confirmation" &&
      (feedback.outcome === "succeeded" || feedback.outcome === "permanent_rejection") &&
      !feedback.replayed
    ) {
      this.recordUsefulProgress(state, internal.probe, now);
    }
    return this.snapshot(internal.scope, internal.configuredConcurrency);
  }

  safetyState(): AdaptiveErpAdmissionSafetyState {
    return {
      policyVersion: adaptiveErpAdmissionPolicy.version,
      scopes: [...this.scopes.entries()].map(([scope, state]) => ({
        scope,
        cooldownUntilMs: state.cooldownUntilMs,
        availabilityRetryAtMs: state.availabilityRetryAtMs,
        availabilityCircuitOpen: state.availabilityCircuitOpen,
        circuitOpenUntilMs: state.circuitOpenUntilMs,
        nextProbeAtMs: state.nextProbeAtMs,
      })),
    };
  }

  snapshot(scope: ErpAdmissionScope, configuredConcurrency: number): AdaptiveErpAdmissionSnapshot {
    return this.toSnapshot(scope, this.scopes.get(scope) ?? null, configuredConcurrency);
  }

  private admit(
    input: {
      scope: ErpAdmissionScope;
      operation: ErpAdmissionOperation;
      configuredConcurrency: number;
    },
    state: ScopeState,
    now: number,
    probe: boolean,
  ): AdaptiveErpAdmissionDecision {
    if (input.operation === "lookup") state.lookupInFlight += 1;
    else {
      state.confirmationInFlight += 1;
      state.nextStartAtMs = now + this.spacingMs(state.rate);
    }
    if (probe) {
      state.probeInFlight = true;
      state.nextProbeAtMs = now + adaptiveErpAdmissionPolicy.probeCadenceMs;
    }
    this.workerInFlight += 1;
    const permit: InternalPermit = {
      scope: input.scope,
      operation: input.operation,
      configuredConcurrency: input.configuredConcurrency,
      admittedAtMs: now,
      generation: state.generation,
      probe,
    };
    this.activePermits.add(permit);
    return {
      admitted: true,
      reason: "admitted",
      nextEligibleAtMs: now,
      permit,
      snapshot: this.toSnapshot(input.scope, state, input.configuredConcurrency),
    };
  }

  private deferred(
    input: { scope: ErpAdmissionScope; configuredConcurrency: number },
    state: ScopeState | null,
    reason: Exclude<ErpAdmissionReason, "admitted">,
    now: number,
    nextEligibleAtMs: number,
  ): AdaptiveErpAdmissionDecision {
    const futureEligibility =
      nextEligibleAtMs > now
        ? nextEligibleAtMs
        : now + adaptiveErpAdmissionPolicy.deferredRecheckMs;
    return {
      admitted: false,
      reason,
      nextEligibleAtMs: futureEligibility,
      snapshot: this.toSnapshot(input.scope, state, input.configuredConcurrency),
    };
  }

  private recordCapacityGuidance(
    state: ScopeState,
    feedback: Extract<ErpAdmissionFeedback, { outcome: "capacity_rejected" }>,
    now: number,
    advanceBackoff: boolean,
  ): void {
    const delay = this.boundedDelay(
      feedback.retryAfterMs,
      adaptiveErpAdmissionPolicy.fallbackCooldownMs,
      state.capacityBackoffAttempt,
      adaptiveErpAdmissionPolicy.maximumCooldownMs,
    );
    if (advanceBackoff) {
      state.capacityBackoffAttempt = Math.min(state.capacityBackoffAttempt + 1, 30);
    }
    state.cooldownUntilMs = Math.max(state.cooldownUntilMs, now + delay);
    state.observationStartedAtMs = now;
    state.usefulProgress = 0;
  }

  private recordCapacityReduction(state: ScopeState, now: number): void {
    if (now - state.lastReductionAtMs < adaptiveErpAdmissionPolicy.rejectionWaveWindowMs) return;

    state.rate = Math.max(
      adaptiveErpAdmissionPolicy.floorRatePerSecond,
      state.rate * adaptiveErpAdmissionPolicy.reductionFactor,
    );
    state.generation += 1;
    state.lastReductionAtMs = now;
    state.nextStartAtMs = Math.max(state.nextStartAtMs, now + this.spacingMs(state.rate));
  }

  private recordAvailabilityGuidance(
    state: ScopeState,
    feedback: Extract<
      ErpAdmissionFeedback,
      { outcome: "temporarily_unavailable" | "uncertain_result" }
    >,
    now: number,
    advanceBackoff: boolean,
  ): void {
    const delay = this.boundedDelay(
      feedback.retryAfterMs,
      adaptiveErpAdmissionPolicy.availabilityBackoffMs,
      state.availabilityBackoffAttempt,
      adaptiveErpAdmissionPolicy.maximumAvailabilityBackoffMs,
    );
    if (advanceBackoff) {
      state.availabilityBackoffAttempt = Math.min(state.availabilityBackoffAttempt + 1, 30);
    }
    state.availabilityRetryAtMs = Math.max(state.availabilityRetryAtMs, now + delay);
    if (state.availabilityCircuitOpen) {
      state.circuitOpenUntilMs = Math.max(state.circuitOpenUntilMs, state.availabilityRetryAtMs);
    }
  }

  private recordUnavailable(state: ScopeState, wasProbe: boolean, now: number): void {
    if (state.availabilityCircuitOpen && !wasProbe) return;
    state.availabilityFailureCount += 1;
    state.usefulProgress = 0;
    state.observationStartedAtMs = now;
    if (
      !wasProbe &&
      state.availabilityFailureCount < adaptiveErpAdmissionPolicy.availabilityFailuresToOpen
    ) {
      return;
    }
    state.availabilityCircuitOpen = true;
    state.circuitOpenUntilMs = Math.max(
      state.availabilityRetryAtMs,
      now + adaptiveErpAdmissionPolicy.probeCadenceMs,
    );
    state.nextProbeAtMs = Math.max(
      state.nextProbeAtMs,
      now + adaptiveErpAdmissionPolicy.probeCadenceMs,
    );
    state.rate = Math.min(state.rate, adaptiveErpAdmissionPolicy.initialRatePerSecond);
    state.nextStartAtMs = Math.max(state.nextStartAtMs, now + this.spacingMs(state.rate));
  }

  private recordUsefulProgress(state: ScopeState, wasProbe: boolean, now: number): void {
    if (state.availabilityCircuitOpen && !wasProbe) return;
    state.availabilityFailureCount = 0;
    state.capacityBackoffAttempt = 0;
    state.availabilityBackoffAttempt = 0;
    if (state.availabilityCircuitOpen) {
      state.availabilityCircuitOpen = false;
      state.circuitOpenUntilMs = 0;
      state.nextProbeAtMs = 0;
      state.observationStartedAtMs = now;
      state.usefulProgress = 0;
      return;
    }
    state.usefulProgress += 1;
    if (
      state.usefulProgress > 0 &&
      now - state.observationStartedAtMs >= adaptiveErpAdmissionPolicy.observationWindowMs
    ) {
      state.rate = Math.min(
        adaptiveErpAdmissionPolicy.ceilingRatePerSecond,
        state.rate + adaptiveErpAdmissionPolicy.additiveStepPerSecond,
      );
      state.observationStartedAtMs = now;
      state.usefulProgress = 0;
    }
  }

  private getOrCreateScope(scope: ErpAdmissionScope, now: number): ScopeState | null {
    const existing = this.scopes.get(scope);
    if (existing) return existing;
    if (this.scopes.size >= adaptiveErpAdmissionPolicy.maximumScopeStates) {
      const evictable = [...this.scopes.entries()]
        .filter(
          ([, state]) =>
            state.confirmationInFlight === 0 &&
            state.lookupInFlight === 0 &&
            !state.availabilityCircuitOpen &&
            state.nextStartAtMs <= now &&
            state.cooldownUntilMs <= now &&
            state.availabilityRetryAtMs <= now &&
            state.circuitOpenUntilMs <= now &&
            state.nextProbeAtMs <= now,
        )
        .sort((left, right) => left[1].lastUsedAtMs - right[1].lastUsedAtMs)[0];
      if (!evictable) return null;
      this.scopes.delete(evictable[0]);
    }
    const state = this.newScopeState(now);
    this.scopes.set(scope, state);
    return state;
  }

  private newScopeState(now: number): ScopeState {
    return {
      rate: adaptiveErpAdmissionPolicy.initialRatePerSecond,
      generation: 0,
      nextStartAtMs: now,
      observationStartedAtMs: now,
      usefulProgress: 0,
      lastReductionAtMs: Number.NEGATIVE_INFINITY,
      cooldownUntilMs: 0,
      availabilityRetryAtMs: 0,
      capacityBackoffAttempt: 0,
      confirmationInFlight: 0,
      lookupInFlight: 0,
      availabilityFailureCount: 0,
      availabilityCircuitOpen: false,
      circuitOpenUntilMs: 0,
      nextProbeAtMs: 0,
      probeInFlight: false,
      availabilityBackoffAttempt: 0,
      lastUsedAtMs: now,
    };
  }

  private toSnapshot(
    scope: ErpAdmissionScope,
    state: ScopeState | null,
    configuredConcurrency: number,
  ): AdaptiveErpAdmissionSnapshot {
    return {
      policyVersion: adaptiveErpAdmissionPolicy.version,
      workerInFlight: this.workerInFlight,
      workerInFlightCeiling: adaptiveErpAdmissionPolicy.workerInFlightCeiling,
      scopeCount: this.scopes.size,
      scope: state
        ? {
            key: scope,
            targetRatePerSecond: state.rate,
            generation: state.generation,
            confirmationInFlight: state.confirmationInFlight,
            confirmationInFlightCeiling: this.confirmationLimit(configuredConcurrency),
            lookupInFlight: state.lookupInFlight,
            lookupInFlightCeiling: adaptiveErpAdmissionPolicy.lookupInFlightCeiling,
            nextStartAtMs: state.nextStartAtMs,
            cooldownUntilMs: state.cooldownUntilMs,
            availabilityRetryAtMs: state.availabilityRetryAtMs,
            availabilityFailureCount: state.availabilityFailureCount,
            availabilityCircuitOpen: state.availabilityCircuitOpen,
            circuitOpenUntilMs: state.circuitOpenUntilMs,
            nextProbeAtMs: state.nextProbeAtMs,
            probeInFlight: state.probeInFlight,
          }
        : null,
    };
  }

  private boundedDelay(
    requestedMs: number | undefined,
    fallbackMs: number,
    attempt: number,
    maximumMs: number,
  ): number {
    if (requestedMs !== undefined && Number.isFinite(requestedMs) && requestedMs >= 0) {
      return Math.min(requestedMs, maximumMs);
    }
    const exponential = Math.min(maximumMs, fallbackMs * 2 ** Math.min(attempt, 30));
    const random = Math.min(1, Math.max(0, this.dependencies.random()));
    return Math.min(maximumMs, Math.floor(exponential * (0.5 + random / 2)));
  }

  private confirmationLimit(configuredConcurrency: number): number {
    return Math.min(
      Math.max(1, Math.floor(configuredConcurrency)),
      adaptiveErpAdmissionPolicy.perScopeInFlightCeiling,
    );
  }

  private spacingMs(rate: number): number {
    return Math.ceil(1_000 / rate);
  }

  private now(): number {
    return this.dependencies.now();
  }
}
