import type {
  ErpCallReference,
  ErpConfirmationResponse,
  ErpLookupIdentity,
  ErpOutcomeDisposition,
  OrderProcessJob,
} from "@checkout-surge/contracts";
import { ErpCircuitOpenError } from "./erp-circuit-breaker.js";
import type {
  ErpAttemptRecord,
  ErpConfirmationOutcome,
  ErpLookupOutcome,
  HttpErpOrderConfirmation,
} from "./erp-confirmation-client.js";
import type {
  OrderProcessAdmission,
  OrderProcessAdmissionPermit,
} from "./order-process-admission.js";
import type { OrderProcessDeliveryMetadata } from "./order-process-job-handler.js";
import type { OrderRecoveryPersistence } from "./order-recovery-scanner.js";
import { acceptedRunSnapshotInterventionReason } from "./run-backpressure.js";

export interface ErpReplayDispatchAdmission {
  dispatchReplay(input: {
    job: OrderProcessJob;
    delivery: OrderProcessDeliveryMetadata;
    dispatch: () => Promise<ErpConfirmationOutcome>;
  }): Promise<ErpConfirmationOutcome | null>;
}

export interface ErpLookupAvailabilityCircuit {
  assertAvailable(job: OrderProcessJob): void | Promise<void>;
}

export type ErpReconciliationResult =
  | {
      operation: "local_result" | "status_lookup";
      disposition: "succeeded" | "permanent_rejection";
      response?: ErpConfirmationResponse;
    }
  | ErpConfirmationOutcome
  | Exclude<ErpLookupOutcome, { disposition: "succeeded" }>
  | {
      operation: "non_call_deferral";
      disposition: "uncertain_result";
      reason: "lookup_limit" | "order_reconciliation_in_flight" | "replay_not_admitted";
    };

export type ScheduledErpOutcome =
  | { disposition: "succeeded" }
  | { disposition: "permanent_rejection"; errorCode: string; errorMessage: string }
  | {
      disposition: "deferred" | "intervention_required";
      reason: string;
      nextEligibleAt?: Date;
    };

export class ScheduledErpOrderConfirmation {
  constructor(
    private readonly options: {
      client: Pick<HttpErpOrderConfirmation, "findSuccessfulAttempt" | "findUnresolvedCall">;
      reconciler: ErpUnresolvedCallReconciler;
      dispatch: {
        confirm(
          job: OrderProcessJob,
          delivery: OrderProcessDeliveryMetadata,
        ): Promise<ErpConfirmationOutcome>;
      };
      admission: OrderProcessAdmission;
      control: Pick<OrderRecoveryPersistence, "defer" | "openIntervention">;
      scopeState: {
        get(scope: string): Promise<{ interventionReason: string | null } | null>;
        openIntervention(input: { scope: string; reason: string; openedAt: Date }): Promise<void>;
      };
      now?: () => Date;
      random?: () => number;
    },
  ) {}

  async confirm(
    job: OrderProcessJob,
    delivery: OrderProcessDeliveryMetadata,
  ): Promise<ScheduledErpOutcome> {
    const generation = delivery.processingGeneration;
    if (generation === undefined) throw new Error("Order delivery has no processing generation.");
    const scope = job.runId ? `run:${job.runId}` : "catalog";
    const scopeState = await this.options.scopeState.get(scope);
    if (scopeState?.interventionReason) {
      return this.defer(job, generation, "scope_intervention", "intervention_required");
    }
    if (await this.options.client.findSuccessfulAttempt(job)) return { disposition: "succeeded" };

    const unresolved = await this.options.client.findUnresolvedCall(job.orderId);
    if (unresolved) {
      try {
        const result = await this.options.reconciler.reconcile({
          job,
          delivery,
          call: unresolved,
          replayAdmission: {
            dispatchReplay: async ({ delivery: replayDelivery }) => {
              const permit = await this.options.admission.tryAcquire(job);
              if (!permit) return null;
              try {
                return await this.options.dispatch.confirm(job, replayDelivery);
              } finally {
                await permit.release();
              }
            },
          },
        });
        return this.scheduleResult(job, generation, scope, result);
      } catch (error) {
        const snapshotReason = acceptedRunSnapshotInterventionReason(error);
        if (snapshotReason) return this.openSnapshotIntervention(job, generation, snapshotReason);
        if (error instanceof ErpCircuitOpenError) {
          return this.defer(
            job,
            generation,
            "erp_circuit_open",
            "erp_unavailable",
            error.retryAfterMs,
          );
        }
        throw error;
      }
    }

    let permit: OrderProcessAdmissionPermit | null;
    try {
      permit = await this.options.admission.tryAcquire(job);
    } catch (error) {
      const snapshotReason = acceptedRunSnapshotInterventionReason(error);
      if (snapshotReason) return this.openSnapshotIntervention(job, generation, snapshotReason);
      throw error;
    }
    if (!permit) return this.defer(job, generation, "local_admission", "local_admission");
    try {
      const outcome = await this.options.dispatch.confirm(job, delivery);
      return this.scheduleResult(job, generation, scope, outcome);
    } catch (error) {
      const outcome = dispatchedOutcomeFromError(error);
      if (outcome) return this.scheduleResult(job, generation, scope, outcome);
      const snapshotReason = acceptedRunSnapshotInterventionReason(error);
      if (snapshotReason) return this.openSnapshotIntervention(job, generation, snapshotReason);
      if (error instanceof ErpCircuitOpenError) {
        return this.defer(
          job,
          generation,
          "erp_circuit_open",
          "erp_unavailable",
          error.retryAfterMs,
        );
      }
      throw error;
    } finally {
      await permit.release();
    }
  }

  private async openSnapshotIntervention(
    job: OrderProcessJob,
    generation: number,
    reason: string,
  ): Promise<ScheduledErpOutcome> {
    await this.options.control.openIntervention({
      orderId: job.orderId,
      reason,
      processingGeneration: generation,
    });
    return { disposition: "intervention_required", reason };
  }

  private async scheduleResult(
    job: OrderProcessJob,
    generation: number,
    scope: string,
    result: ErpReconciliationResult,
  ): Promise<ScheduledErpOutcome> {
    if (result.disposition === "succeeded") return { disposition: "succeeded" };
    if (result.disposition === "permanent_rejection") {
      const errorCode = "errorCode" in result ? result.errorCode : undefined;
      const errorMessage = "errorMessage" in result ? result.errorMessage : undefined;
      return {
        disposition: "permanent_rejection",
        errorCode: errorCode ?? "erp_permanent_rejection",
        errorMessage: errorMessage ?? "The ERP permanently rejected the order.",
      };
    }
    if (result.disposition === "intervention_required") {
      const reason =
        ("errorCode" in result ? result.errorCode : undefined) ?? "erp_intervention_required";
      if (result.interventionScope === "scope") {
        await this.options.scopeState.openIntervention({
          scope,
          reason,
          openedAt: this.now(),
        });
        return this.defer(job, generation, reason, "intervention_required");
      }
      await this.options.control.openIntervention({
        orderId: job.orderId,
        reason,
        processingGeneration: generation,
      });
      return { disposition: "intervention_required", reason };
    }
    const reason =
      result.operation === "non_call_deferral"
        ? result.reason
        : (("errorCode" in result ? result.errorCode : undefined) ?? result.disposition);
    const waitingReason =
      result.disposition === "capacity_rejected"
        ? "erp_capacity"
        : result.disposition === "uncertain_result"
          ? "uncertain_result"
          : "erp_unavailable";
    return this.defer(
      job,
      generation,
      reason,
      waitingReason,
      "retryAfterMs" in result ? result.retryAfterMs : undefined,
    );
  }

  private async defer(
    job: OrderProcessJob,
    generation: number,
    reason: string,
    waitingReason:
      | "local_admission"
      | "erp_capacity"
      | "erp_unavailable"
      | "uncertain_result"
      | "intervention_required",
    minimumDelayMs = 0,
  ): Promise<ScheduledErpOutcome> {
    const now = this.now();
    // ponytail: task 09 replaces this bounded local adapter with the engine policy.
    const jitteredBackoffMs = Math.floor(
      1_000 * 2 ** Math.min(generation, 6) * (0.5 + this.random() / 2),
    );
    const nextEligibleAt = new Date(
      now.getTime() + Math.min(60_000, Math.max(minimumDelayMs, jitteredBackoffMs)),
    );
    const deferred = await this.options.control.defer({
      orderId: job.orderId,
      waitingReason,
      nextEligibleAt,
      processingGeneration: generation,
    });
    if (!deferred)
      throw new Error(`Order ${job.orderId} lost scheduling ownership while deferring.`);
    return {
      disposition: waitingReason === "intervention_required" ? "intervention_required" : "deferred",
      reason,
      nextEligibleAt,
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private random(): number {
    return this.options.random?.() ?? Math.random();
  }
}

function dispatchedOutcomeFromError(error: unknown): ErpConfirmationOutcome | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "outcome" in error &&
    typeof error.outcome === "object" &&
    error.outcome !== null &&
    "operation" in error.outcome &&
    error.outcome.operation === "dispatched_confirmation"
  ) {
    return error.outcome as ErpConfirmationOutcome;
  }
  return null;
}

/** Narrow task-04 boundary. Task 05 wires it into durable scheduling. */
export class ErpUnresolvedCallReconciler {
  private activeLookups = 0;
  private readonly activeOrders = new Set<string>();

  constructor(
    private readonly options: {
      client: Pick<
        HttpErpOrderConfirmation,
        "dispatch" | "findSuccessfulAttempt" | "lookup" | "recordLookupResult"
      >;
      callResolution: {
        resolveDispatchedCall(input: { orderId: string; erpCallId: string }): Promise<boolean>;
      };
      lookupAvailabilityCircuit: ErpLookupAvailabilityCircuit;
      lookupConcurrency: number;
    },
  ) {}

  async reconcile(input: {
    job: OrderProcessJob;
    delivery: OrderProcessDeliveryMetadata;
    call: ErpCallReference;
    replayAdmission: ErpReplayDispatchAdmission;
  }): Promise<ErpReconciliationResult> {
    if (this.activeOrders.has(input.job.orderId)) {
      return nonCallDeferral("order_reconciliation_in_flight");
    }
    this.activeOrders.add(input.job.orderId);
    try {
      if (await this.options.client.findSuccessfulAttempt(input.job)) {
        await this.resolve(input.call);
        return { operation: "local_result", disposition: "succeeded" };
      }
      await this.options.lookupAvailabilityCircuit.assertAvailable(input.job);
      if (this.activeLookups >= this.options.lookupConcurrency) {
        return nonCallDeferral("lookup_limit");
      }
      this.activeLookups += 1;
      let lookup: ErpLookupOutcome;
      try {
        lookup = await this.options.client.lookup(
          input.call.idempotencyKey,
          input.job.correlationId,
        );
      } finally {
        this.activeLookups -= 1;
      }
      if (lookup.disposition !== "succeeded") return lookup;
      if (lookup.lookup.lookup.status === "unknown") {
        const replayDelivery = { ...input.delivery, supersedesErpCallId: input.call.erpCallId };
        const replay = await input.replayAdmission.dispatchReplay({
          job: input.job,
          delivery: replayDelivery,
          dispatch: () => this.options.client.dispatch(input.job, replayDelivery),
        });
        return replay ?? nonCallDeferral("replay_not_admitted");
      }
      if (!sameIdentity(lookup.lookup.lookup.identity, input.job, input.call.idempotencyKey)) {
        return {
          disposition: "intervention_required",
          operation: "status_lookup",
          startedAt: lookup.startedAt,
          finishedAt: lookup.finishedAt,
          latencyMs: lookup.latencyMs,
          errorCode: "erp_lookup_identity_contradiction",
          errorMessage: "The ERP lookup result contradicted the immutable order identity.",
          interventionScope: "order",
        };
      }
      const response = lookup.lookup.lookup.result;
      const disposition: Extract<ErpOutcomeDisposition, "succeeded" | "permanent_rejection"> =
        lookup.lookup.lookup.status === "succeeded" ? "succeeded" : "permanent_rejection";
      try {
        await this.options.client.recordLookupResult(
          lookupAttempt(input.job, input.delivery, input.call, lookup, response, disposition),
        );
      } catch (error) {
        if (error instanceof Error && error.name === "ErpConfirmationInvalidResponseError") {
          return {
            disposition: "intervention_required",
            operation: "status_lookup",
            startedAt: lookup.startedAt,
            finishedAt: lookup.finishedAt,
            latencyMs: lookup.latencyMs,
            errorCode: "erp_attempt_contradiction",
            errorMessage: error.message,
            interventionScope: "order",
          };
        }
        throw error;
      }
      await this.resolve(input.call);
      return { operation: "status_lookup", disposition, response };
    } finally {
      this.activeOrders.delete(input.job.orderId);
    }
  }

  private async resolve(call: ErpCallReference): Promise<void> {
    await this.options.callResolution.resolveDispatchedCall({
      orderId: call.orderId,
      erpCallId: call.erpCallId,
    });
  }
}

function lookupAttempt(
  job: OrderProcessJob,
  delivery: OrderProcessDeliveryMetadata,
  call: ErpCallReference,
  lookup: Extract<ErpLookupOutcome, { disposition: "succeeded" }>,
  response: ErpConfirmationResponse,
  disposition: "succeeded" | "permanent_rejection",
): ErpAttemptRecord {
  return {
    job,
    delivery: { ...delivery, deliveryId: `erp-lookup:${call.erpCallId}` },
    operation: "status_lookup",
    disposition,
    status: disposition === "succeeded" ? "succeeded" : "failed",
    terminal: true,
    httpStatus: response.httpStatus,
    ...(response.errorCode ? { errorCode: response.errorCode } : {}),
    ...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
    latencyMs: lookup.latencyMs,
    startedAt: lookup.startedAt,
    finishedAt: lookup.finishedAt,
    response,
  };
}

function sameIdentity(
  identity: ErpLookupIdentity,
  job: OrderProcessJob,
  idempotencyKey: string,
): boolean {
  return (
    identity.orderId === job.orderId &&
    identity.publicOrderId === job.publicOrderId &&
    identity.reservationId === job.reservationId &&
    identity.saleOfferId === job.saleOfferId &&
    (identity.runId ?? null) === (job.runId ?? null) &&
    identity.idempotencyKey === idempotencyKey &&
    identity.quantity === job.quantity
  );
}

function nonCallDeferral(
  reason: Extract<ErpReconciliationResult, { operation: "non_call_deferral" }>["reason"],
): ErpReconciliationResult {
  return { operation: "non_call_deferral", disposition: "uncertain_result", reason };
}
