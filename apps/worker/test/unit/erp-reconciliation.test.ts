import type { ErpCallReference, ErpLookupResponse } from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import type {
  ErpConfirmationOutcome,
  ErpLookupOutcome,
} from "../../src/application/erp-confirmation-client.js";
import {
  ErpUnresolvedCallReconciler,
  ScheduledErpOrderConfirmation,
} from "../../src/application/erp-reconciliation.js";
import { AdaptiveErpRuntimeAdmission } from "../../src/application/order-process-admission.js";

const job = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_reconcile",
  reservationId: "22222222-2222-4222-8222-222222222222",
  saleOfferId: "33333333-3333-4333-8333-333333333333",
  correlationId: "corr-reconcile",
  quantity: 1,
  queuedAt: "2026-06-22T00:00:00.000Z",
  processingGeneration: 0,
};
const delivery = {
  attemptNumber: 2,
  attemptsMade: 1,
  maxAttempts: 1,
  processingGeneration: 3,
};
const call: ErpCallReference = {
  erpCallId: "99999999-9999-4999-8999-999999999999",
  orderId: job.orderId,
  idempotencyKey: `erp-confirmation:${job.orderId}`,
  processingGeneration: 3,
  dispatchedAt: "2026-06-22T00:00:00.000Z",
};
const context = { scope: "catalog" as const, configuredConcurrency: 2 };

describe("adaptive ERP reconciliation", () => {
  it("adopts lookup success without a confirmation permit or POST", async () => {
    const client = clientPort(lookupSucceeded());
    const resolution = { resolveDispatchedCall: vi.fn().mockResolvedValue(true) };
    const admission = runtimeAdmission();
    const reconciler = new ErpUnresolvedCallReconciler({
      client,
      callResolution: resolution,
      admission,
    });

    await expect(reconciler.reconcile({ job, delivery, call, context })).resolves.toMatchObject({
      operation: "status_lookup",
      disposition: "succeeded",
    });

    expect(client.dispatch).not.toHaveBeenCalled();
    expect(resolution.resolveDispatchedCall).toHaveBeenCalledWith({
      orderId: job.orderId,
      erpCallId: call.erpCallId,
    });
    expect(admission.state()).toMatchObject({
      available: true,
      counters: { admitted: 1, settled: 1 },
    });
  });

  it("routes unknown lookup through paced same-key replay with the adaptive deadline", async () => {
    const client = clientPort(lookupUnknown());
    client.dispatch.mockResolvedValue(dispatchedSuccess(true));
    const admission = runtimeAdmission();
    const reconciler = new ErpUnresolvedCallReconciler({
      client,
      callResolution: { resolveDispatchedCall: vi.fn() },
      admission,
    });

    await expect(reconciler.reconcile({ job, delivery, call, context })).resolves.toMatchObject({
      disposition: "succeeded",
      replayed: true,
    });
    expect(client.dispatch).toHaveBeenCalledWith(
      job,
      { ...delivery, supersedesErpCallId: call.erpCallId },
      2_000,
    );
    expect(admission.state()).toMatchObject({
      available: true,
      counters: { admitted: 2, settled: 2 },
    });
  });

  it("defers duplicate reconciliation without spending a second permit", async () => {
    let finishLookup!: (outcome: ErpLookupOutcome) => void;
    const pending = new Promise<ErpLookupOutcome>((resolve) => (finishLookup = resolve));
    const client = clientPort(lookupUnknown());
    client.lookup.mockReturnValueOnce(pending);
    const reconciler = new ErpUnresolvedCallReconciler({
      client,
      callResolution: { resolveDispatchedCall: vi.fn() },
      admission: runtimeAdmission(),
    });
    const first = reconciler.reconcile({ job, delivery, call, context });

    await expect(reconciler.reconcile({ job, delivery, call, context })).resolves.toMatchObject({
      operation: "non_call_deferral",
      reason: "order_reconciliation_in_flight",
    });
    finishLookup(lookupUnknown());
    await first;
    expect(client.lookup).toHaveBeenCalledOnce();
  });

  it("persists exact pacing denial on the single control record without dispatch", async () => {
    const nowMs = 0;
    const admission = runtimeAdmission(() => nowMs);
    const first = await admission.tryAcquire(context, "confirmation");
    if (!first.admitted) throw new Error("Expected first permit.");
    await admission.feedback(first.operation, dispatchedSuccess(false));
    const defer = vi.fn().mockResolvedValue(true);
    const client = {
      ...clientPort(lookupUnknown()),
      findUnresolvedCall: vi.fn().mockResolvedValue(null),
    };
    const scheduled = new ScheduledErpOrderConfirmation({
      client,
      reconciler: { reconcile: vi.fn() } as never,
      admission,
      control: { defer, openIntervention: vi.fn() },
      scopeState: { get: vi.fn().mockResolvedValue(null), openIntervention: vi.fn() },
      now: () => new Date(nowMs),
    });

    await expect(scheduled.confirm(job, delivery)).resolves.toMatchObject({
      disposition: "deferred",
      reason: "pacing",
      nextEligibleAt: new Date(500),
    });
    expect(client.dispatch).not.toHaveBeenCalled();
    expect(defer).toHaveBeenCalledWith({
      orderId: job.orderId,
      waitingReason: "local_admission",
      nextEligibleAt: new Date(500),
      processingGeneration: 3,
    });
  });

  it("opens a per-order intervention when a run snapshot is missing", async () => {
    const runJob = { ...job, runId: "44444444-4444-4444-8444-444444444444" };
    const control = { defer: vi.fn(), openIntervention: vi.fn().mockResolvedValue(true) };
    const scheduled = new ScheduledErpOrderConfirmation({
      client: {
        dispatch: vi.fn(),
        findSuccessfulAttempt: vi.fn().mockResolvedValue(null),
        findUnresolvedCall: vi.fn().mockResolvedValue(null),
      },
      reconciler: { reconcile: vi.fn() } as never,
      admission: runtimeAdmission(),
      control,
      scopeState: { get: vi.fn(), openIntervention: vi.fn() },
    });

    await expect(scheduled.confirm(runJob, delivery)).resolves.toEqual({
      disposition: "intervention_required",
      reason: "accepted_run_snapshot_missing",
    });
    expect(control.openIntervention).toHaveBeenCalledWith({
      orderId: job.orderId,
      reason: "accepted_run_snapshot_missing",
      processingGeneration: 3,
    });
  });

  it("refreshes the scope gate after parking an unresolved order intervention", async () => {
    const readReconciliationGate = vi.fn().mockResolvedValue({
      pending: false,
      nextEligibleAtMs: 0,
    });
    const admission = await AdaptiveErpRuntimeAdmission.restore({
      persistence: {
        listActive: async () => [],
        readActive: async () => null,
        listUnresolvedScopes: async () => ["catalog"],
        readReconciliationGate,
        save: async () => undefined,
      },
      runConfigReader: { read: async () => null },
      fallbackConcurrency: 2,
      now: () => 0,
    });
    const control = { defer: vi.fn(), openIntervention: vi.fn().mockResolvedValue(true) };
    const scheduled = new ScheduledErpOrderConfirmation({
      client: {
        dispatch: vi.fn(),
        findSuccessfulAttempt: vi.fn().mockResolvedValue(null),
        findUnresolvedCall: vi.fn().mockResolvedValue(call),
      },
      reconciler: {
        reconcile: vi.fn().mockResolvedValue({
          operation: "status_lookup",
          disposition: "intervention_required",
          errorCode: "erp_lookup_identity_contradiction",
          interventionScope: "order",
        }),
      } as never,
      admission,
      control,
      scopeState: { get: vi.fn().mockResolvedValue(null), openIntervention: vi.fn() },
    });

    await expect(scheduled.confirm(job, delivery)).resolves.toMatchObject({
      disposition: "intervention_required",
      reason: "erp_lookup_identity_contradiction",
    });
    expect(readReconciliationGate).toHaveBeenCalledWith("catalog");
    await expect(admission.tryAcquire(context, "confirmation")).resolves.toMatchObject({
      admitted: true,
    });
  });

  it("reuses a local accepted result without a POST permit", async () => {
    const readReconciliationGate = vi.fn().mockResolvedValue({
      pending: false,
      nextEligibleAtMs: 0,
    });
    const admission = await AdaptiveErpRuntimeAdmission.restore({
      persistence: {
        listActive: async () => [],
        readActive: async () => null,
        listUnresolvedScopes: async () => ["catalog"],
        readReconciliationGate,
        save: async () => undefined,
      },
      runConfigReader: { read: async () => null },
      fallbackConcurrency: 2,
      now: () => 0,
    });
    const client = {
      dispatch: vi.fn(),
      findSuccessfulAttempt: vi.fn().mockResolvedValue({ orderId: job.orderId }),
      findUnresolvedCall: vi.fn(),
    };
    const scheduled = new ScheduledErpOrderConfirmation({
      client,
      reconciler: { reconcile: vi.fn() } as never,
      admission,
      control: { defer: vi.fn(), openIntervention: vi.fn() },
      scopeState: { get: vi.fn().mockResolvedValue(null), openIntervention: vi.fn() },
    });

    await expect(scheduled.confirm(job, delivery)).resolves.toEqual({ disposition: "succeeded" });
    expect(client.dispatch).not.toHaveBeenCalled();
    expect(client.findUnresolvedCall).not.toHaveBeenCalled();
    expect(readReconciliationGate).toHaveBeenCalledWith("catalog");
    expect(admission.state()).toMatchObject({
      available: true,
      counters: { admitted: 0 },
    });
  });
});

function runtimeAdmission(now: () => number = () => 0): AdaptiveErpRuntimeAdmission {
  return AdaptiveErpRuntimeAdmission.create({
    persistence: {
      listActive: async () => [],
      readActive: async () => null,
      listUnresolvedScopes: async () => [],
      readReconciliationGate: async () => ({ pending: false, nextEligibleAtMs: 0 }),
      save: async () => undefined,
    },
    runConfigReader: { read: async () => null },
    fallbackConcurrency: 2,
    now,
    random: () => 0,
  });
}

function clientPort(lookup: ErpLookupOutcome) {
  return {
    findSuccessfulAttempt: vi.fn().mockResolvedValue(null),
    lookup: vi.fn().mockResolvedValue(lookup),
    dispatch: vi.fn().mockResolvedValue(dispatchedSuccess(false)),
    recordLookupResult: vi.fn().mockResolvedValue(true),
  };
}

function lookupSucceeded(): ErpLookupOutcome {
  const lookup: ErpLookupResponse = {
    lookup: {
      status: "succeeded",
      identity: {
        orderId: job.orderId,
        publicOrderId: job.publicOrderId,
        reservationId: job.reservationId,
        saleOfferId: job.saleOfferId,
        idempotencyKey: call.idempotencyKey,
        quantity: job.quantity,
      },
      result: {
        status: "succeeded",
        httpStatus: 200,
        confirmationId: "erp-confirmation-1",
        latencyMs: 10,
        timestamp: "2026-06-22T00:00:01.000Z",
      },
    },
    timestamp: "2026-06-22T00:00:01.000Z",
  };
  return {
    disposition: "succeeded",
    operation: "status_lookup",
    lookup,
    startedAt: new Date(0),
    finishedAt: new Date(10),
    latencyMs: 10,
  };
}

function lookupUnknown(): ErpLookupOutcome {
  return {
    disposition: "succeeded",
    operation: "status_lookup",
    lookup: {
      lookup: { status: "unknown", idempotencyKey: call.idempotencyKey },
      timestamp: "2026-06-22T00:00:01.000Z",
    },
    startedAt: new Date(0),
    finishedAt: new Date(10),
    latencyMs: 10,
  };
}

function dispatchedSuccess(replayed: boolean): ErpConfirmationOutcome {
  return {
    disposition: "succeeded",
    operation: "dispatched_confirmation",
    call,
    startedAt: new Date(0),
    finishedAt: new Date(10),
    latencyMs: 10,
    requestDeadlineMs: 2_000,
    replayed,
    httpStatus: 200,
  };
}
