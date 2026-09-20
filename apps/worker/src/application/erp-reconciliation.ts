import type {
  ErpCallReference,
  ErpConfirmationResponse,
  ErpLookupIdentity,
  ErpOutcomeDisposition,
  OrderProcessJob,
  OrderWaitingReason,
} from "@checkout-surge/contracts";
import type { ErpAdmissionScope } from "./adaptive-erp-admission-policy.js";
import type {
  ErpAttemptRecord,
  ErpConfirmationOutcome,
  ErpLookupOutcome,
  HttpErpOrderConfirmation,
} from "./erp-confirmation-client.js";
import type {
  AdaptiveErpRuntimeAdmission,
  AdmittedErpOperation,
  ErpAdmissionContext,
} from "./order-process-admission.js";
import type { OrderProcessDeliveryMetadata } from "./order-process-job-handler.js";
import type { OrderRecoveryPersistence } from "./order-recovery-scanner.js";
import { acceptedRunSnapshotInterventionReason } from "./run-config.js";

type ScheduledReconciliationResult = (
  | {
      operation: "local_result" | "status_lookup";
      disposition: "succeeded" | "permanent_rejection";
      response?: ErpConfirmationResponse;
    }
  | ErpConfirmationOutcome
  | Exclude<ErpLookupOutcome, { disposition: "succeeded" }>
) & { nextEligibleAtMs?: number };

export type ErpReconciliationResult =
  | ScheduledReconciliationResult
  | {
      operation: "non_call_deferral";
      disposition: "uncertain_result";
      reason: string;
      nextEligibleAtMs: number;
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
      client: Pick<
        HttpErpOrderConfirmation,
        "dispatch" | "findSuccessfulAttempt" | "findUnresolvedCall"
      >;
      reconciler: ErpUnresolvedCallReconciler;
      admission: AdaptiveErpRuntimeAdmission;
      control: Pick<OrderRecoveryPersistence, "defer" | "openIntervention">;
      scopeState: {
        get(scope: string): Promise<{ interventionReason: string | null } | null>;
        openIntervention(input: { scope: string; reason: string; openedAt: Date }): Promise<void>;
      };
      now?: () => Date;
    },
  ) {}

  async confirm(
    job: OrderProcessJob,
    delivery: OrderProcessDeliveryMetadata,
  ): Promise<ScheduledErpOutcome> {
    const generation = delivery.processingGeneration;
    if (generation === undefined) throw new Error("Order delivery has no processing generation.");

    let context: ErpAdmissionContext;
    try {
      context = await this.options.admission.context(job);
    } catch (error) {
      const reason = acceptedRunSnapshotInterventionReason(error);
      if (reason) return this.openSnapshotIntervention(job, generation, reason);
      throw error;
    }

    const scopeState = await this.options.scopeState.get(context.scope);
    if (scopeState?.interventionReason) {
      return this.deferAt(
        job,
        generation,
        "scope_intervention",
        "intervention_required",
        this.options.admission.nextInterventionRecheckAt(),
      );
    }
    if (await this.options.client.findSuccessfulAttempt(job)) {
      await this.options.admission.reconciliationSettled(context.scope);
      return { disposition: "succeeded" };
    }

    const unresolved = await this.options.client.findUnresolvedCall(job.orderId);
    if (unresolved) {
      const result = await this.options.reconciler.reconcile({
        job,
        delivery,
        call: unresolved,
        context,
      });
      return this.scheduleResult(job, generation, context.scope, result);
    }

    const admission = await this.options.admission.tryAcquire(context, "confirmation");
    if (!admission.admitted) {
      return this.deferAt(
        job,
        generation,
        admission.decision.reason,
        waitingReasonForAdmission(admission.decision.reason),
        admission.decision.nextEligibleAtMs,
      );
    }
    const result = await this.dispatch(job, delivery, admission.operation);
    return this.scheduleResult(job, generation, context.scope, result);
  }

  private async dispatch(
    job: OrderProcessJob,
    delivery: OrderProcessDeliveryMetadata,
    operation: AdmittedErpOperation,
  ): Promise<ScheduledReconciliationResult> {
    try {
      const outcome = await this.options.client.dispatch(
        job,
        delivery,
        operation.requestDeadlineMs,
      );
      const settlement = await this.options.admission.feedback(operation, outcome);
      return { ...outcome, nextEligibleAtMs: settlement.nextEligibleAtMs };
    } catch (error) {
      const outcome = dispatchedOutcomeFromError(error);
      if (!outcome) throw error;
      const settlement = await this.options.admission.feedback(operation, outcome);
      return { ...outcome, nextEligibleAtMs: settlement.nextEligibleAtMs };
    } finally {
      this.options.admission.release(operation);
      await this.options.admission.reconciliationSettled(operation.context.scope);
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
    scope: ErpAdmissionScope,
    result: ErpReconciliationResult,
  ): Promise<ScheduledErpOutcome> {
    if (result.disposition === "succeeded") return { disposition: "succeeded" };
    if (result.disposition === "permanent_rejection") {
      return {
        disposition: "permanent_rejection",
        errorCode:
          "errorCode" in result
            ? (result.errorCode ?? "erp_permanent_rejection")
            : "erp_permanent_rejection",
        errorMessage:
          "errorMessage" in result
            ? (result.errorMessage ?? "The ERP permanently rejected the order.")
            : "The ERP permanently rejected the order.",
      };
    }
    if (result.disposition === "intervention_required") {
      const reason =
        ("errorCode" in result ? result.errorCode : undefined) ?? "erp_intervention_required";
      if (result.interventionScope === "scope") {
        await this.options.scopeState.openIntervention({ scope, reason, openedAt: this.now() });
        return this.deferAt(
          job,
          generation,
          reason,
          "intervention_required",
          this.options.admission.nextInterventionRecheckAt(),
        );
      }
      await this.options.control.openIntervention({
        orderId: job.orderId,
        reason,
        processingGeneration: generation,
      });
      await this.options.admission.reconciliationSettled(scope);
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
    return this.deferAt(
      job,
      generation,
      reason,
      waitingReason,
      result.nextEligibleAtMs ?? this.now().getTime(),
    );
  }

  private async deferAt(
    job: OrderProcessJob,
    generation: number,
    reason: string,
    waitingReason: OrderWaitingReason,
    nextEligibleAtMs: number,
  ): Promise<ScheduledErpOutcome> {
    const nextEligibleAt = new Date(nextEligibleAtMs);
    const deferred = await this.options.control.defer({
      orderId: job.orderId,
      waitingReason,
      nextEligibleAt,
      processingGeneration: generation,
    });
    if (!deferred) {
      throw new Error(`Order ${job.orderId} lost scheduling ownership while deferring.`);
    }
    return {
      disposition: waitingReason === "intervention_required" ? "intervention_required" : "deferred",
      reason,
      nextEligibleAt,
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export class ErpUnresolvedCallReconciler {
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
      admission: AdaptiveErpRuntimeAdmission;
    },
  ) {}

  async reconcile(input: {
    job: OrderProcessJob;
    delivery: OrderProcessDeliveryMetadata;
    call: ErpCallReference;
    context: ErpAdmissionContext;
  }): Promise<ErpReconciliationResult> {
    if (this.activeOrders.has(input.job.orderId)) {
      return nonCallDeferral(
        "order_reconciliation_in_flight",
        this.options.admission.nextRecheckAt(),
      );
    }
    this.activeOrders.add(input.job.orderId);
    try {
      if (await this.options.client.findSuccessfulAttempt(input.job)) {
        await this.resolve(input.call, input.context.scope);
        return { operation: "local_result", disposition: "succeeded" };
      }

      const lookupAdmission = await this.options.admission.tryAcquire(input.context, "lookup");
      if (!lookupAdmission.admitted) {
        return nonCallDeferral(
          lookupAdmission.decision.reason,
          lookupAdmission.decision.nextEligibleAtMs,
        );
      }
      const lookupOperation = lookupAdmission.operation;
      let lookup: ErpLookupOutcome;
      try {
        lookup = await this.options.client.lookup(
          input.call.idempotencyKey,
          input.job.correlationId,
        );
        const settlement = await this.options.admission.feedback(lookupOperation, lookup);
        if (lookup.disposition !== "succeeded") {
          return { ...lookup, nextEligibleAtMs: settlement.nextEligibleAtMs };
        }
      } finally {
        this.options.admission.release(lookupOperation);
      }

      if (lookup.lookup.lookup.status === "unknown") {
        return this.replay(input, lookupOperation.permit.probe);
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
      await this.resolve(input.call, input.context.scope);
      return { operation: "status_lookup", disposition, response };
    } finally {
      this.activeOrders.delete(input.job.orderId);
    }
  }

  private async replay(
    input: {
      job: OrderProcessJob;
      delivery: OrderProcessDeliveryMetadata;
      call: ErpCallReference;
      context: ErpAdmissionContext;
    },
    confirmationProbeContinuation: boolean,
  ): Promise<ErpReconciliationResult> {
    const admission = await this.options.admission.tryAcquire(input.context, "confirmation", {
      confirmationProbeContinuation,
      reconciliation: true,
    });
    if (!admission.admitted) {
      return nonCallDeferral(admission.decision.reason, admission.decision.nextEligibleAtMs);
    }
    const operation = admission.operation;
    const delivery = { ...input.delivery, supersedesErpCallId: input.call.erpCallId };
    try {
      const outcome = await this.options.client.dispatch(
        input.job,
        delivery,
        operation.requestDeadlineMs,
      );
      const settlement = await this.options.admission.feedback(operation, outcome);
      return { ...outcome, nextEligibleAtMs: settlement.nextEligibleAtMs };
    } catch (error) {
      const outcome = dispatchedOutcomeFromError(error);
      if (!outcome) throw error;
      const settlement = await this.options.admission.feedback(operation, outcome);
      return { ...outcome, nextEligibleAtMs: settlement.nextEligibleAtMs };
    } finally {
      this.options.admission.release(operation);
      await this.options.admission.reconciliationSettled(input.context.scope);
    }
  }

  private async resolve(
    call: ErpCallReference,
    scope: ErpAdmissionContext["scope"],
  ): Promise<void> {
    await this.options.callResolution.resolveDispatchedCall({
      orderId: call.orderId,
      erpCallId: call.erpCallId,
    });
    await this.options.admission.reconciliationSettled(scope);
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

function waitingReasonForAdmission(reason: string): OrderWaitingReason {
  if (reason === "capacity_cooldown") return "erp_capacity";
  if (reason.startsWith("availability_")) return "erp_unavailable";
  return "local_admission";
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

function nonCallDeferral(reason: string, nextEligibleAtMs: number): ErpReconciliationResult {
  return {
    operation: "non_call_deferral",
    disposition: "uncertain_result",
    reason,
    nextEligibleAtMs,
  };
}
