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

  it("persists exact capacity cooldown denial on the single control record without dispatch", async () => {
    const nowMs = 0;
    const admission = runtimeAdmission(() => nowMs);
    const first = await admission.tryAcquire(context, "confirmation");
    if (!first.admitted) throw new Error("Expected first permit.");
    await admission.feedback(first.operation, {
      ...dispatchedSuccess(false),
      disposition: "capacity_rejected",
      retryAfterMs: 500,
    });
    const defer = vi.fn().mockResolvedValue(true);
    const client = {
      ...clientPort(lookupUnknown()),
      findUnresolvedCall: vi.fn().mockResolvedValue(null),
    };
    const scheduled = new ScheduledErpOrderConfirmation({
      client,
      reconciler: { reconcile: vi.fn() } as never,
      admission,
      control: { defer },
      now: () => new Date(nowMs),
    });

    await expect(scheduled.confirm(job, delivery)).resolves.toMatchObject({
      disposition: "deferred",
      reason: "capacity_cooldown",
      nextEligibleAt: new Date(500),
    });
    expect(client.dispatch).not.toHaveBeenCalled();
    expect(defer).toHaveBeenCalledWith({
      orderId: job.orderId,
      waitingReason: "erp_capacity",
      nextEligibleAt: new Date(500),
      processingGeneration: 3,
    });
  });

  it("returns a technical failure when a run snapshot is missing", async () => {
    const runJob = { ...job, runId: "44444444-4444-4444-8444-444444444444" };
    const scheduled = new ScheduledErpOrderConfirmation({
      client: {
        dispatch: vi.fn(),
        findTechnicalFailure: vi.fn().mockResolvedValue(null),
        findSuccessfulAttempt: vi.fn().mockResolvedValue(null),
        findUnresolvedCall: vi.fn().mockResolvedValue(null),
      },
      reconciler: { reconcile: vi.fn() } as never,
      admission: runtimeAdmission(),
      control: { defer: vi.fn() },
    });

    await expect(scheduled.confirm(runJob, delivery)).resolves.toMatchObject({
      disposition: "technical_failure",
      errorCode: "accepted_run_snapshot_missing",
    });
  });

  it("lets an earlier canonical success win before a missing-snapshot failure", async () => {
    const runId = "44444444-4444-4444-8444-444444444444";
    const runJob = { ...job, runId };
    const lookup = lookupSucceeded();
    if (lookup.disposition !== "succeeded" || lookup.lookup.lookup.status !== "succeeded") {
      throw new Error("Expected successful lookup fixture.");
    }
    lookup.lookup.lookup.identity.runId = runId;
    const client = {
      ...clientPort(lookup),
      findUnresolvedCall: vi.fn().mockResolvedValue(call),
    };
    const admission = runtimeAdmission();
    const scheduled = new ScheduledErpOrderConfirmation({
      client,
      reconciler: new ErpUnresolvedCallReconciler({
        client,
        callResolution: { resolveDispatchedCall: vi.fn().mockResolvedValue(true) },
        admission,
      }),
      admission,
      control: { defer: vi.fn() },
    });

    await expect(scheduled.confirm(runJob, delivery)).resolves.toEqual({
      disposition: "succeeded",
    });
    expect(client.dispatch).not.toHaveBeenCalled();
    expect(client.recordLookupResult).toHaveBeenCalledOnce();
  });

  it("refreshes the scope gate after an unresolved order fails technically", async () => {
    const readReconciliationGate = vi.fn().mockResolvedValue({
      pending: false,
      nextEligibleAtMs: 0,
    });
    const admission = await AdaptiveErpRuntimeAdmission.restore({
      pauseDelivery: async () => {},
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
    const scheduled = new ScheduledErpOrderConfirmation({
      client: {
        dispatch: vi.fn(),
        findTechnicalFailure: vi.fn().mockResolvedValue(null),
        findSuccessfulAttempt: vi.fn().mockResolvedValue(null),
        findUnresolvedCall: vi.fn().mockResolvedValue(call),
      },
      reconciler: {
        reconcile: vi.fn().mockResolvedValue({
          operation: "status_lookup",
          disposition: "technical_failure",
          errorCode: "erp_lookup_identity_contradiction",
          errorMessage: "Identity mismatch.",
        }),
      } as never,
      admission,
      control: { defer: vi.fn() },
    });

    await expect(scheduled.confirm(job, delivery)).resolves.toMatchObject({
      disposition: "technical_failure",
      errorCode: "erp_lookup_identity_contradiction",
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
      pauseDelivery: async () => {},
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
      findTechnicalFailure: vi.fn().mockResolvedValue(null),
      findSuccessfulAttempt: vi.fn().mockResolvedValue({ orderId: job.orderId }),
      findUnresolvedCall: vi.fn(),
    };
    const scheduled = new ScheduledErpOrderConfirmation({
      client,
      reconciler: { reconcile: vi.fn() } as never,
      admission,
      control: { defer: vi.fn() },
    });

    await expect(scheduled.confirm(job, delivery)).resolves.toEqual({ disposition: "succeeded" });
    expect(client.dispatch).not.toHaveBeenCalled();
    expect(client.findUnresolvedCall).not.toHaveBeenCalled();
    expect(readReconciliationGate).not.toHaveBeenCalled();
    expect(admission.state()).toMatchObject({
      available: true,
      counters: { admitted: 0 },
    });
  });
});

function runtimeAdmission(now: () => number = () => 0): AdaptiveErpRuntimeAdmission {
  return AdaptiveErpRuntimeAdmission.create({
    pauseDelivery: async () => {},
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
    findTechnicalFailure: vi.fn().mockResolvedValue(null),
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
