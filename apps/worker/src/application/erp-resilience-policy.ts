import {
  type ErpOutcomeDisposition,
  erpDispatchEnginePolicyIdentity,
} from "@checkout-surge/contracts";

export const erpResiliencePolicy = {
  // Derived from the shared engine-policy identity (D13).
  version: `${erpDispatchEnginePolicyIdentity.name}-v${erpDispatchEnginePolicyIdentity.version}`,
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
  initialRequestDeadlineMs: 2_000,
  requestDeadlineWindowSize: 100,
  requestDeadlinePercentile: 0.95,
  requestDeadlineFactor: 1.5,
  requestDeadlineMarginMs: 500,
  minimumRequestDeadlineMs: 500,
  maximumRequestDeadlineMs: 6_000,
  requestDeadlineLeaseHeadroomMs: 5_000,
} as const;

export type ErpAdmissionScope = `run:${string}` | "catalog";
export type ErpAdmissionOperation = "confirmation" | "lookup";

export type ErpLatencyObservationSource =
  | "confirmation_response"
  | "confirmation_timeout"
  | "lookup"
  | "replay";

interface DeadlineScopeState {
  samples: number[];
  lastUsedAtMs: number;
}

/** Process-local latency learning. Only task 09 will wire it into dispatch. */
export class AdaptiveErpRequestDeadlineController {
  private readonly scopes = new Map<ErpAdmissionScope, DeadlineScopeState>();

  constructor(private readonly dependencies: { now: () => number }) {}

  deadline(scope: ErpAdmissionScope): number {
    const state = this.scopes.get(scope);
    if (!state || state.samples.length === 0) return erpResiliencePolicy.initialRequestDeadlineMs;
    state.lastUsedAtMs = this.dependencies.now();
    const sorted = [...state.samples].sort((left, right) => left - right);
    const rank = Math.ceil(sorted.length * erpResiliencePolicy.requestDeadlinePercentile);
    const percentile = sorted[Math.max(0, rank - 1)] as number;
    return Math.min(
      erpResiliencePolicy.maximumRequestDeadlineMs,
      Math.max(
        erpResiliencePolicy.minimumRequestDeadlineMs,
        Math.ceil(
          percentile * erpResiliencePolicy.requestDeadlineFactor +
            erpResiliencePolicy.requestDeadlineMarginMs,
        ),
      ),
    );
  }

  record(input: {
    scope: ErpAdmissionScope;
    source: ErpLatencyObservationSource;
    durationMs: number;
    requestDeadlineMs: number;
  }): void {
    if (input.source !== "confirmation_response" && input.source !== "confirmation_timeout") return;
    const now = this.dependencies.now();
    const state = this.scope(input.scope, now);
    const sample =
      input.source === "confirmation_timeout" ? input.requestDeadlineMs : input.durationMs;
    state.samples.push(sample);
    if (state.samples.length > erpResiliencePolicy.requestDeadlineWindowSize) {
      state.samples.shift();
    }
  }

  snapshot(scope: ErpAdmissionScope): {
    policyVersion: string;
    deadlineMs: number;
    sampleCount: number;
    scopeCount: number;
  } {
    return {
      policyVersion: erpResiliencePolicy.version,
      deadlineMs: this.deadline(scope),
      sampleCount: this.scopes.get(scope)?.samples.length ?? 0,
      scopeCount: this.scopes.size,
    };
  }

  private scope(scope: ErpAdmissionScope, now: number): DeadlineScopeState {
    const existing = this.scopes.get(scope);
    if (existing) {
      existing.lastUsedAtMs = now;
      return existing;
    }
    if (this.scopes.size >= erpResiliencePolicy.maximumScopeStates) {
      const oldest = [...this.scopes].reduce((candidate, entry) =>
        entry[1].lastUsedAtMs < candidate[1].lastUsedAtMs ? entry : candidate,
      );
      this.scopes.delete(oldest[0]);
    }
    const created = { samples: [], lastUsedAtMs: now };
    this.scopes.set(scope, created);
    return created;
  }
}

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
  | { outcome: Extract<ErpOutcomeDisposition, "technical_failure"> };

export interface AdaptiveErpPermit {
  readonly scope: ErpAdmissionScope;
  readonly operation: ErpAdmissionOperation;
  readonly admittedAtMs: number;
  readonly probe: boolean;
}

export type ErpAdmissionReason =
  | "admitted"
  | "availability_probe_wait"
  | "availability_probe_in_flight"
  | "availability_backoff"
  | "capacity_cooldown"
  | "lookup_in_flight"
  | "reconciliation_pending"
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
    confirmationInFlight: number;
    confirmationInFlightCeiling: number;
    lookupInFlight: number;
    lookupInFlightCeiling: number;
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

/** This is the complete task-09 persistence boundary; latency samples are excluded. */
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
    for (const safety of dependencies.safetyState?.scopes ?? []) this.restoreSafety(safety);
  }

  hasScope(scope: ErpAdmissionScope): boolean {
    return this.scopes.has(scope);
  }

  restoreSafety(safety: AdaptiveErpAdmissionSafetyState["scopes"][number]): boolean {
    if (this.scopes.has(safety.scope)) return true;
    const now = this.now();
    const state = this.getOrCreateScope(safety.scope, now);
    if (!state) return false;
    state.cooldownUntilMs = safety.cooldownUntilMs > now ? safety.cooldownUntilMs : 0;
    state.availabilityRetryAtMs =
      safety.availabilityRetryAtMs > now ? safety.availabilityRetryAtMs : 0;
    state.availabilityCircuitOpen =
      safety.availabilityCircuitOpen &&
      Math.max(safety.availabilityRetryAtMs, safety.circuitOpenUntilMs, safety.nextProbeAtMs) > now;
    state.circuitOpenUntilMs = safety.circuitOpenUntilMs > now ? safety.circuitOpenUntilMs : 0;
    state.nextProbeAtMs = safety.nextProbeAtMs > now ? safety.nextProbeAtMs : 0;
    return true;
  }

  tryAcquire(input: {
    scope: ErpAdmissionScope;
    operation: ErpAdmissionOperation;
    configuredConcurrency: number;
    confirmationProbeContinuation?: boolean;
  }): AdaptiveErpAdmissionDecision {
    const now = this.now();
    const state = this.getOrCreateScope(input.scope, now);
    if (!state) return this.deferred(input, null, "scope_state_limit", now, now);
    state.lastUsedAtMs = now;

    if (this.workerInFlight >= erpResiliencePolicy.workerInFlightCeiling) {
      return this.deferred(input, state, "worker_in_flight", now, now);
    }
    if (
      input.operation === "lookup" &&
      state.lookupInFlight >= erpResiliencePolicy.lookupInFlightCeiling
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
      if (input.operation === "confirmation" && input.confirmationProbeContinuation) {
        const safetyDeadline = Math.max(
          state.cooldownUntilMs,
          state.availabilityRetryAtMs,
          state.circuitOpenUntilMs,
        );
        if (now < safetyDeadline) {
          return this.deferred(input, state, "availability_probe_wait", now, safetyDeadline);
        }
        return this.admit(input, state, now, true);
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
    const now = this.now();
    this.releasePermit(internal, state);
    if (feedback.outcome === "capacity_rejected") {
      if (internal.operation === "confirmation") {
        this.recordCapacityGuidance(state, feedback, now);
      }
    } else if (
      feedback.outcome === "temporarily_unavailable" ||
      feedback.outcome === "uncertain_result"
    ) {
      this.recordAvailabilityGuidance(state, feedback, now);
      this.recordUnavailable(state, internal.probe, now);
    } else if (
      internal.operation === "confirmation" &&
      (feedback.outcome === "succeeded" || feedback.outcome === "permanent_rejection") &&
      !feedback.replayed
    ) {
      this.recordUsefulProgress(state, internal.probe);
    }
    return this.snapshot(internal.scope, internal.configuredConcurrency);
  }

  release(permit: AdaptiveErpPermit): AdaptiveErpAdmissionSnapshot {
    const internal = permit as InternalPermit;
    const state = this.scopes.get(internal.scope);
    if (!state || !this.activePermits.has(internal)) {
      return this.snapshot(internal.scope, internal.configuredConcurrency);
    }
    this.releasePermit(internal, state);
    return this.snapshot(internal.scope, internal.configuredConcurrency);
  }

  safetyState(): AdaptiveErpAdmissionSafetyState {
    return {
      policyVersion: erpResiliencePolicy.version,
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

  scopeKeys(): ErpAdmissionScope[] {
    return [...this.scopes.keys()];
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
    }
    if (probe) {
      state.probeInFlight = true;
      state.nextProbeAtMs = now + erpResiliencePolicy.probeCadenceMs;
    }
    this.workerInFlight += 1;
    const permit: InternalPermit = {
      scope: input.scope,
      operation: input.operation,
      configuredConcurrency: input.configuredConcurrency,
      admittedAtMs: now,
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

  private releasePermit(internal: InternalPermit, state: ScopeState): void {
    this.activePermits.delete(internal);
    this.workerInFlight -= 1;
    if (internal.operation === "lookup") state.lookupInFlight -= 1;
    else state.confirmationInFlight -= 1;
    if (internal.probe) state.probeInFlight = false;
    state.lastUsedAtMs = this.now();
  }

  private deferred(
    input: { scope: ErpAdmissionScope; configuredConcurrency: number },
    state: ScopeState | null,
    reason: Exclude<ErpAdmissionReason, "admitted">,
    now: number,
    nextEligibleAtMs: number,
  ): AdaptiveErpAdmissionDecision {
    const futureEligibility =
      nextEligibleAtMs > now ? nextEligibleAtMs : now + erpResiliencePolicy.deferredRecheckMs;
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
  ): void {
    const delay = this.boundedDelay(
      feedback.retryAfterMs,
      erpResiliencePolicy.fallbackCooldownMs,
      state.capacityBackoffAttempt,
      erpResiliencePolicy.maximumCooldownMs,
    );
    state.capacityBackoffAttempt = Math.min(state.capacityBackoffAttempt + 1, 30);
    state.cooldownUntilMs = Math.max(state.cooldownUntilMs, now + delay);
  }

  private recordAvailabilityGuidance(
    state: ScopeState,
    feedback: Extract<
      ErpAdmissionFeedback,
      { outcome: "temporarily_unavailable" | "uncertain_result" }
    >,
    now: number,
  ): void {
    const delay = this.boundedDelay(
      feedback.retryAfterMs,
      erpResiliencePolicy.availabilityBackoffMs,
      state.availabilityBackoffAttempt,
      erpResiliencePolicy.maximumAvailabilityBackoffMs,
    );
    state.availabilityBackoffAttempt = Math.min(state.availabilityBackoffAttempt + 1, 30);
    state.availabilityRetryAtMs = Math.max(state.availabilityRetryAtMs, now + delay);
    if (state.availabilityCircuitOpen) {
      state.circuitOpenUntilMs = Math.max(state.circuitOpenUntilMs, state.availabilityRetryAtMs);
    }
  }

  private recordUnavailable(state: ScopeState, wasProbe: boolean, now: number): void {
    if (state.availabilityCircuitOpen && !wasProbe) return;
    state.availabilityFailureCount += 1;
    if (
      !wasProbe &&
      state.availabilityFailureCount < erpResiliencePolicy.availabilityFailuresToOpen
    ) {
      return;
    }
    state.availabilityCircuitOpen = true;
    state.circuitOpenUntilMs = Math.max(
      state.availabilityRetryAtMs,
      now + erpResiliencePolicy.probeCadenceMs,
    );
    state.nextProbeAtMs = Math.max(state.nextProbeAtMs, now + erpResiliencePolicy.probeCadenceMs);
  }

  private recordUsefulProgress(state: ScopeState, wasProbe: boolean): void {
    if (state.availabilityCircuitOpen && !wasProbe) return;
    state.availabilityFailureCount = 0;
    state.capacityBackoffAttempt = 0;
    state.availabilityBackoffAttempt = 0;
    if (state.availabilityCircuitOpen) {
      state.availabilityCircuitOpen = false;
      state.circuitOpenUntilMs = 0;
      state.nextProbeAtMs = 0;
    }
  }

  private getOrCreateScope(scope: ErpAdmissionScope, now: number): ScopeState | null {
    const existing = this.scopes.get(scope);
    if (existing) return existing;
    if (this.scopes.size >= erpResiliencePolicy.maximumScopeStates) {
      const evictable = [...this.scopes.entries()]
        .filter(
          ([, state]) =>
            state.confirmationInFlight === 0 &&
            state.lookupInFlight === 0 &&
            !state.availabilityCircuitOpen &&
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
      policyVersion: erpResiliencePolicy.version,
      workerInFlight: this.workerInFlight,
      workerInFlightCeiling: erpResiliencePolicy.workerInFlightCeiling,
      scopeCount: this.scopes.size,
      scope: state
        ? {
            key: scope,
            confirmationInFlight: state.confirmationInFlight,
            confirmationInFlightCeiling: this.confirmationLimit(configuredConcurrency),
            lookupInFlight: state.lookupInFlight,
            lookupInFlightCeiling: erpResiliencePolicy.lookupInFlightCeiling,
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
      erpResiliencePolicy.perScopeInFlightCeiling,
    );
  }

  private now(): number {
    return this.dependencies.now();
  }
}
