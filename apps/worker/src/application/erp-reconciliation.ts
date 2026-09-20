import type {
  ErpCallReference,
  ErpConfirmationResponse,
  ErpLookupIdentity,
  ErpOutcomeDisposition,
  OrderProcessJob,
} from "@checkout-surge/contracts";
import type {
  ErpAttemptRecord,
  ErpConfirmationOutcome,
  ErpLookupOutcome,
  HttpErpOrderConfirmation,
} from "./erp-confirmation-client.js";
import type { OrderProcessDeliveryMetadata } from "./order-process-job-handler.js";

export interface ErpReplayDispatchAdmission {
  dispatchReplay(input: {
    job: OrderProcessJob;
    delivery: OrderProcessDeliveryMetadata;
    dispatch: () => Promise<ErpConfirmationOutcome>;
  }): Promise<ErpConfirmationOutcome | null>;
}

export interface ErpLookupAvailabilityCircuit {
  assertAvailable(): void;
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
      this.options.lookupAvailabilityCircuit.assertAvailable();
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
        const replay = await input.replayAdmission.dispatchReplay({
          job: input.job,
          delivery: input.delivery,
          dispatch: () => this.options.client.dispatch(input.job, input.delivery),
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
