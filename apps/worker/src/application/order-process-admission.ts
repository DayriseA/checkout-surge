import type { OrderProcessJob } from "@checkout-surge/contracts";
import type { ErpConfirmationOutcome, ErpLookupOutcome } from "./erp-confirmation-client.js";
import {
  AdaptiveErpAdmissionController,
  type AdaptiveErpAdmissionDecision,
  type AdaptiveErpAdmissionSafetyState,
  type AdaptiveErpAdmissionSnapshot,
  type AdaptiveErpPermit,
  AdaptiveErpRequestDeadlineController,
  type ErpAdmissionFeedback,
  type ErpAdmissionOperation,
  type ErpAdmissionScope,
  type ErpLatencyObservationSource,
  erpResiliencePolicy,
} from "./erp-resilience-policy.js";
import { MissingAcceptedRunSnapshotError, type RunConfigReader } from "./run-config.js";

export interface AdaptiveErpSafetyRecord {
  scope: ErpAdmissionScope;
  cooldownUntilMs: number;
  availabilityRetryAtMs: number;
  availabilityCircuitOpen: boolean;
  circuitOpenUntilMs: number;
  nextProbeAtMs: number;
}

export interface AdaptiveErpSafetyPersistence {
  listActive(nowMs: number): Promise<AdaptiveErpSafetyRecord[]>;
  readActive(scope: ErpAdmissionScope, nowMs: number): Promise<AdaptiveErpSafetyRecord | null>;
  listUnresolvedScopes(limit: number): Promise<ErpAdmissionScope[]>;
  readReconciliationGate(scope: ErpAdmissionScope): Promise<{
    pending: boolean;
    nextEligibleAtMs: number;
  }>;
  save(record: AdaptiveErpSafetyRecord): Promise<void>;
}

export interface ErpAdmissionContext {
  scope: ErpAdmissionScope;
  configuredConcurrency: number;
}

export interface AdmittedErpOperation {
  context: ErpAdmissionContext;
  permit: AdaptiveErpPermit;
  requestDeadlineMs: number;
  settled: boolean;
}

export type ErpOperationAdmission =
  | { admitted: true; operation: AdmittedErpOperation; decision: AdaptiveErpAdmissionDecision }
  | { admitted: false; decision: Extract<AdaptiveErpAdmissionDecision, { admitted: false }> };

interface AvailableAdaptiveErpRuntimeState {
  available: true;
  policyVersion: string;
  counters: { admitted: number; deferred: number; settled: number; released: number };
  scopes: Array<{
    admission: AdaptiveErpAdmissionSnapshot;
    deadline: ReturnType<AdaptiveErpRequestDeadlineController["snapshot"]>;
  }>;
}

export type AdaptiveErpRuntimeState =
  | AvailableAdaptiveErpRuntimeState
  | { available: false; error: string };

export class AdaptiveErpSafetyPersistenceError extends Error {
  override readonly name = "AdaptiveErpSafetyPersistenceError";

  constructor(cause: unknown) {
    super("Adaptive ERP restart-safety state could not be persisted.", { cause });
  }
}

export class AdaptiveErpRuntimeAdmission {
  private readonly configuredConcurrency = new Map<ErpAdmissionScope, number>();
  private readonly unresolvedScopes = new Set<ErpAdmissionScope>();
  private readonly unresolvedNextEligibleAt = new Map<ErpAdmissionScope, number>();
  private readonly reconciliationRefreshAfter = new Map<ErpAdmissionScope, number>();
  private readonly reconciliationRefreshes = new Map<
    ErpAdmissionScope,
    { generation: number; promise: Promise<boolean> }
  >();
  private readonly reconciliationErrors = new Map<ErpAdmissionScope, string>();
  private reconciliationRefreshGeneration = 0;
  private readonly safetyWrites = new Map<ErpAdmissionScope, Promise<void>>();
  private readonly active = new Set<AdmittedErpOperation>();
  private closing = false;
  private admitted = 0;
  private deferred = 0;
  private settled = 0;
  private released = 0;
  private stateError: string | null = null;

  private constructor(
    private readonly options: {
      controller: AdaptiveErpAdmissionController;
      deadlines: AdaptiveErpRequestDeadlineController;
      pauseDelivery: (durationMs: number) => Promise<void>;
      persistence: AdaptiveErpSafetyPersistence;
      runConfigReader: RunConfigReader;
      reconciliationConcurrency: number;
      now: () => number;
    },
  ) {}

  static async restore(options: {
    pauseDelivery: (durationMs: number) => Promise<void>;
    persistence: AdaptiveErpSafetyPersistence;
    runConfigReader: RunConfigReader;
    reconciliationConcurrency: number;
    now?: () => number;
    random?: () => number;
  }): Promise<AdaptiveErpRuntimeAdmission> {
    const now = options.now ?? Date.now;
    const records = await options.persistence.listActive(now());
    if (records.length > erpResiliencePolicy.maximumScopeStates) {
      throw new Error("Active ERP restart-safety state exceeds the bounded controller capacity.");
    }
    const admission = AdaptiveErpRuntimeAdmission.create({
      ...options,
      now,
      safetyState: {
        policyVersion: erpResiliencePolicy.version,
        scopes: records,
      },
    });
    const unresolvedScopes = await options.persistence.listUnresolvedScopes(
      erpResiliencePolicy.maximumScopeStates + 1,
    );
    if (unresolvedScopes.length > erpResiliencePolicy.maximumScopeStates) {
      throw new Error("Unresolved ERP scope gates exceed the bounded controller capacity.");
    }
    for (const scope of unresolvedScopes) {
      admission.unresolvedScopes.add(scope);
    }
    return admission;
  }

  static create(options: {
    pauseDelivery: (durationMs: number) => Promise<void>;
    persistence: AdaptiveErpSafetyPersistence;
    runConfigReader: RunConfigReader;
    reconciliationConcurrency: number;
    safetyState?: AdaptiveErpAdmissionSafetyState;
    now?: () => number;
    random?: () => number;
  }): AdaptiveErpRuntimeAdmission {
    const now = options.now ?? Date.now;
    const safetyState: AdaptiveErpAdmissionSafetyState = options.safetyState ?? {
      policyVersion: erpResiliencePolicy.version,
      scopes: [],
    };
    return new AdaptiveErpRuntimeAdmission({
      controller: new AdaptiveErpAdmissionController({
        now,
        random: options.random ?? Math.random,
        safetyState,
      }),
      deadlines: new AdaptiveErpRequestDeadlineController({ now }),
      pauseDelivery: options.pauseDelivery,
      persistence: options.persistence,
      runConfigReader: options.runConfigReader,
      reconciliationConcurrency: options.reconciliationConcurrency,
      now,
    });
  }

  async context(job: OrderProcessJob): Promise<ErpAdmissionContext> {
    const snapshot = await this.options.runConfigReader.read(job.runId);
    if (!snapshot) throw new MissingAcceptedRunSnapshotError(job.runId);
    return {
      scope: `run:${job.runId}`,
      configuredConcurrency: snapshot.backpressureConfig.orderProcessConcurrency,
    };
  }

  // Lookup/restart coordination can proceed without constructing a confirmation request.
  // Fresh confirmation always requires context() and its frozen run configuration.
  reconciliationContext(job: OrderProcessJob): ErpAdmissionContext {
    return {
      scope: `run:${job.runId}`,
      configuredConcurrency: this.options.reconciliationConcurrency,
    };
  }

  async tryAcquire(
    context: ErpAdmissionContext,
    operation: ErpAdmissionOperation,
    options: { confirmationProbeContinuation?: boolean; reconciliation?: boolean } = {},
  ): Promise<ErpOperationAdmission> {
    await this.hydrate(context.scope);
    if (this.closing) {
      this.deferred += 1;
      return {
        admitted: false,
        decision: {
          admitted: false,
          reason: "worker_in_flight",
          nextEligibleAtMs: this.options.now() + erpResiliencePolicy.deferredRecheckMs,
          snapshot: this.options.controller.snapshot(context.scope, context.configuredConcurrency),
        },
      };
    }
    if (
      operation === "confirmation" &&
      !options.reconciliation &&
      this.unresolvedScopes.has(context.scope)
    ) {
      const refreshed = await this.refreshReconciliationGate(context.scope, false).catch(
        () => false,
      );
      if (this.unresolvedScopes.has(context.scope)) {
        return this.deferredDecision(context, "reconciliation_pending", refreshed);
      }
    }
    const decision = this.options.controller.tryAcquire({ ...context, operation, ...options });
    if (this.options.controller.hasScope(context.scope)) {
      this.configuredConcurrency.set(context.scope, context.configuredConcurrency);
      this.pruneConfiguredConcurrency();
    }
    if (!decision.admitted) {
      this.deferred += 1;
      return { admitted: false, decision };
    }
    const admitted: AdmittedErpOperation = {
      context,
      permit: decision.permit,
      requestDeadlineMs: this.options.deadlines.deadline(context.scope),
      settled: false,
    };
    this.admitted += 1;
    this.active.add(admitted);
    if (decision.permit.probe) {
      try {
        await this.persist(context.scope);
      } catch (error) {
        this.release(admitted);
        throw error;
      }
    }
    return { admitted: true, operation: admitted, decision };
  }

  async feedback(
    operation: AdmittedErpOperation,
    outcome: ErpConfirmationOutcome | ErpLookupOutcome,
  ): Promise<{ snapshot: AdaptiveErpAdmissionSnapshot; nextEligibleAtMs: number }> {
    if (operation.settled) {
      const snapshot = this.options.controller.snapshot(
        operation.context.scope,
        operation.context.configuredConcurrency,
      );
      return { snapshot, nextEligibleAtMs: this.nextEligibleAt(snapshot) };
    }
    operation.settled = true;
    this.active.delete(operation);
    this.recordDeadline(operation, outcome);
    const snapshot = this.options.controller.feedback(operation.permit, toFeedback(outcome));
    this.settled += 1;
    await this.persist(operation.context.scope);
    if (outcome.disposition === "capacity_rejected") {
      const cooldownUntil = Math.max(
        ...this.options.controller.safetyState().scopes.map((scope) => scope.cooldownUntilMs),
      );
      const pauseMs = cooldownUntil - this.options.now();
      if (pauseMs > 0) await this.options.pauseDelivery(pauseMs);
    }
    return { snapshot, nextEligibleAtMs: this.nextEligibleAt(snapshot) };
  }

  release(operation: AdmittedErpOperation): void {
    if (operation.settled) return;
    operation.settled = true;
    this.active.delete(operation);
    this.options.controller.release(operation.permit);
    this.released += 1;
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const operation of [...this.active]) this.release(operation);
  }

  nextRecheckAt(): number {
    return this.options.now() + erpResiliencePolicy.deferredRecheckMs;
  }

  async reconciliationSettled(scope: ErpAdmissionScope): Promise<void> {
    await this.refreshReconciliationGate(scope, true).catch(() => undefined);
  }

  state(): AdaptiveErpRuntimeState {
    const error = [this.stateError, ...this.reconciliationErrors.values()]
      .filter(Boolean)
      .join("; ");
    if (error) return { available: false, error };
    this.pruneConfiguredConcurrency();
    return {
      available: true,
      policyVersion: erpResiliencePolicy.version,
      counters: {
        admitted: this.admitted,
        deferred: this.deferred,
        settled: this.settled,
        released: this.released,
      },
      scopes: this.options.controller.scopeKeys().map((scope) => ({
        admission: this.options.controller.snapshot(
          scope,
          this.configuredConcurrency.get(scope) ?? this.options.reconciliationConcurrency,
        ),
        deadline: this.options.deadlines.snapshot(scope),
      })),
    };
  }

  private async persist(scope: ErpAdmissionScope): Promise<void> {
    const previous = this.safetyWrites.get(scope) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        const state = this.options.controller
          .safetyState()
          .scopes.find((item) => item.scope === scope);
        if (!state) return;
        await this.options.persistence.save(state);
      });
    this.safetyWrites.set(scope, write);
    try {
      await write;
      this.stateError = null;
    } catch (error) {
      this.stateError = error instanceof Error ? error.message : String(error);
      throw new AdaptiveErpSafetyPersistenceError(error);
    } finally {
      if (this.safetyWrites.get(scope) === write) this.safetyWrites.delete(scope);
    }
  }

  private async hydrate(scope: ErpAdmissionScope): Promise<void> {
    if (this.options.controller.hasScope(scope)) return;
    const record = await this.options.persistence.readActive(scope, this.options.now());
    if (!record) return;
    if (!this.options.controller.restoreSafety(record)) {
      throw new Error("Active ERP restart-safety state exceeds the bounded controller capacity.");
    }
  }

  private deferredDecision(
    context: ErpAdmissionContext,
    reason: "reconciliation_pending",
    gateRefreshSucceeded = true,
  ): ErpOperationAdmission {
    this.deferred += 1;
    const snapshot = this.options.controller.snapshot(context.scope, context.configuredConcurrency);
    const nextEligibleAtMs = Math.max(
      this.nextRecheckAt(),
      gateRefreshSucceeded ? (this.unresolvedNextEligibleAt.get(context.scope) ?? 0) : 0,
      snapshot.scope?.cooldownUntilMs ?? 0,
      snapshot.scope?.availabilityRetryAtMs ?? 0,
      snapshot.scope?.circuitOpenUntilMs ?? 0,
      snapshot.scope?.nextProbeAtMs ?? 0,
    );
    return {
      admitted: false,
      decision: {
        admitted: false,
        reason,
        nextEligibleAtMs,
        snapshot,
      },
    };
  }

  private refreshReconciliationGate(scope: ErpAdmissionScope, force: boolean): Promise<boolean> {
    // Only startup can close a scope gate; live dispatch intents must not reopen it.
    if (!this.unresolvedScopes.has(scope)) return Promise.resolve(true);
    const now = this.options.now();
    const active = this.reconciliationRefreshes.get(scope);
    if (!force) {
      if (active) return active.promise;
      if (now < (this.reconciliationRefreshAfter.get(scope) ?? 0)) {
        return Promise.resolve(!this.reconciliationErrors.has(scope));
      }
    }
    const generation = ++this.reconciliationRefreshGeneration;
    const promise = this.options.persistence
      .readReconciliationGate(scope)
      .then((gate) => {
        if (this.reconciliationRefreshes.get(scope)?.generation !== generation) return true;
        this.reconciliationErrors.delete(scope);
        if (gate.pending) {
          this.unresolvedNextEligibleAt.set(scope, gate.nextEligibleAtMs);
          this.reconciliationRefreshAfter.set(
            scope,
            this.options.now() + erpResiliencePolicy.deferredRecheckMs,
          );
        } else {
          this.unresolvedScopes.delete(scope);
          this.unresolvedNextEligibleAt.delete(scope);
          this.reconciliationRefreshAfter.delete(scope);
        }
        return true;
      })
      .catch((error) => {
        if (this.reconciliationRefreshes.get(scope)?.generation === generation) {
          this.reconciliationErrors.set(
            scope,
            error instanceof Error ? error.message : String(error),
          );
          this.reconciliationRefreshAfter.set(
            scope,
            this.options.now() + erpResiliencePolicy.deferredRecheckMs,
          );
        }
        throw error;
      })
      .finally(() => {
        if (this.reconciliationRefreshes.get(scope)?.generation === generation) {
          this.reconciliationRefreshes.delete(scope);
        }
      });
    this.reconciliationRefreshes.set(scope, { generation, promise });
    return promise;
  }

  private pruneConfiguredConcurrency(): void {
    const retained = new Set(this.options.controller.scopeKeys());
    for (const scope of this.configuredConcurrency.keys()) {
      if (!retained.has(scope)) this.configuredConcurrency.delete(scope);
    }
  }

  private recordDeadline(
    operation: AdmittedErpOperation,
    outcome: ErpConfirmationOutcome | ErpLookupOutcome,
  ): void {
    let source: ErpLatencyObservationSource;
    if (outcome.operation !== "dispatched_confirmation") source = "lookup";
    else if (outcome.replayed) source = "replay";
    else if (outcome.errorCode === "erp_request_timeout") source = "confirmation_timeout";
    else if (outcome.httpStatus !== undefined) source = "confirmation_response";
    else return;
    this.options.deadlines.record({
      scope: operation.context.scope,
      source,
      durationMs: outcome.latencyMs,
      requestDeadlineMs: operation.requestDeadlineMs,
    });
  }

  private nextEligibleAt(snapshot: AdaptiveErpAdmissionSnapshot): number {
    const scope = snapshot.scope;
    if (!scope) return this.options.now() + erpResiliencePolicy.deferredRecheckMs;
    return Math.max(
      this.options.now() + erpResiliencePolicy.deferredRecheckMs,
      scope.cooldownUntilMs,
      scope.availabilityRetryAtMs,
      scope.circuitOpenUntilMs,
      scope.nextProbeAtMs,
    );
  }
}

function toFeedback(outcome: ErpConfirmationOutcome | ErpLookupOutcome): ErpAdmissionFeedback {
  if (outcome.disposition === "succeeded") {
    return {
      outcome: outcome.disposition,
      replayed: outcome.operation === "status_lookup" || outcome.replayed,
    };
  }
  if (outcome.disposition === "capacity_rejected") {
    return {
      outcome: outcome.disposition,
      ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
    };
  }
  if (
    outcome.disposition === "temporarily_unavailable" ||
    outcome.disposition === "uncertain_result"
  ) {
    return {
      outcome: outcome.disposition,
      ...(outcome.operation === "dispatched_confirmation" && outcome.retryAfterMs !== undefined
        ? { retryAfterMs: outcome.retryAfterMs }
        : {}),
    };
  }
  return { outcome: "technical_failure" };
}
