import type { ErpCallReference, ErpConfirmationResponse } from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import type {
  ErpConfirmationOutcome,
  ErpLookupOutcome,
} from "../../src/application/erp-confirmation-client.js";
import {
  type ErpReplayDispatchAdmission,
  ErpUnresolvedCallReconciler,
} from "../../src/application/erp-reconciliation.js";

const job = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_reconcile",
  reservationId: "22222222-2222-4222-8222-222222222222",
  saleOfferId: "33333333-3333-4333-8333-333333333333",
  correlationId: "corr-reconcile",
  quantity: 1,
  queuedAt: "2026-06-22T00:00:00.000Z",
};
const delivery = {
  attemptNumber: 2,
  attemptsMade: 1,
  maxAttempts: 4,
  processingGeneration: 3,
};
const call: ErpCallReference = {
  erpCallId: "99999999-9999-4999-8999-999999999999",
  orderId: job.orderId,
  idempotencyKey: `erp-confirmation:${job.orderId}`,
  processingGeneration: 3,
  dispatchedAt: "2026-06-22T00:00:00.000Z",
};

describe("ERP unresolved-call reconciliation", () => {
  it("adopts lookup success after a lost response without another confirmation call", async () => {
    const client = clientPort(lookupSucceeded());
    const resolution = { resolveDispatchedCall: vi.fn().mockResolvedValue(true) };
    const reconciler = createReconciler(client, resolution);

    await expect(
      reconciler.reconcile({ job, delivery, call, replayAdmission: rejectingAdmission() }),
    ).resolves.toMatchObject({ operation: "status_lookup", disposition: "succeeded" });

    expect(client.dispatch).not.toHaveBeenCalled();
    expect(client.recordLookupResult).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "status_lookup",
        status: "succeeded",
        delivery: expect.objectContaining({ deliveryId: `erp-lookup:${call.erpCallId}` }),
      }),
    );
    expect(resolution.resolveDispatchedCall).toHaveBeenCalledWith({
      orderId: job.orderId,
      erpCallId: call.erpCallId,
    });
  });

  it("sends unknown through caller-owned admission for one same-key replay", async () => {
    const client = clientPort(lookupUnknown());
    const replayOutcome = dispatchedSuccess(true);
    client.dispatch.mockResolvedValue(replayOutcome);
    const admission: ErpReplayDispatchAdmission = {
      dispatchReplay: vi.fn(async ({ dispatch }) => dispatch()),
    };
    const reconciler = createReconciler(client);

    await expect(
      reconciler.reconcile({ job, delivery, call, replayAdmission: admission }),
    ).resolves.toBe(replayOutcome);

    expect(admission.dispatchReplay).toHaveBeenCalledOnce();
    expect(client.dispatch).toHaveBeenCalledOnce();
    expect(client.dispatch).toHaveBeenCalledWith(job, delivery);
  });

  it("bypasses replay admission and capacity cooldown for the lookup itself", async () => {
    const client = clientPort(lookupSucceeded());
    const admission = rejectingAdmission();
    const reconciler = createReconciler(client);

    await reconciler.reconcile({ job, delivery, call, replayAdmission: admission });

    expect(client.lookup).toHaveBeenCalledOnce();
    expect(admission.dispatchReplay).not.toHaveBeenCalled();
  });

  it("obeys the availability circuit without using lookup success as circuit feedback", async () => {
    const client = clientPort(lookupSucceeded());
    const circuit = {
      assertAvailable: vi.fn(() => {
        throw new Error("circuit open");
      }),
    };
    const reconciler = createReconciler(client, undefined, circuit);

    await expect(
      reconciler.reconcile({ job, delivery, call, replayAdmission: rejectingAdmission() }),
    ).rejects.toThrow("circuit open");
    expect(client.lookup).not.toHaveBeenCalled();
    expect(Object.keys(circuit)).toEqual(["assertAvailable"]);
  });

  it("enforces a dedicated lookup bound and prevents parallel catch-up for one order", async () => {
    let finishLookup!: (value: ErpLookupOutcome) => void;
    const pending = new Promise<ErpLookupOutcome>((resolve) => {
      finishLookup = resolve;
    });
    const client = clientPort(lookupUnknown());
    client.lookup.mockReturnValueOnce(pending);
    const reconciler = createReconciler(client, undefined, undefined, 1);
    const first = reconciler.reconcile({
      job,
      delivery,
      call,
      replayAdmission: rejectingAdmission(),
    });

    await expect(
      reconciler.reconcile({
        job: { ...job, orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        delivery,
        call: {
          ...call,
          orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          erpCallId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        },
        replayAdmission: rejectingAdmission(),
      }),
    ).resolves.toEqual({
      operation: "non_call_deferral",
      disposition: "uncertain_result",
      reason: "lookup_limit",
    });
    await expect(
      reconciler.reconcile({ job, delivery, call, replayAdmission: rejectingAdmission() }),
    ).resolves.toMatchObject({ reason: "order_reconciliation_in_flight" });

    finishLookup(lookupUnknown());
    await first;
  });

  it("turns lookup identity mismatch into affected-order intervention", async () => {
    const lookup = lookupSucceeded();
    if (lookup.disposition !== "succeeded" || lookup.lookup.lookup.status !== "succeeded") {
      throw new Error("invalid fixture");
    }
    lookup.lookup.lookup.identity.publicOrderId = "another-order";
    const reconciler = createReconciler(clientPort(lookup));

    await expect(
      reconciler.reconcile({ job, delivery, call, replayAdmission: rejectingAdmission() }),
    ).resolves.toMatchObject({
      disposition: "intervention_required",
      interventionScope: "order",
      errorCode: "erp_lookup_identity_contradiction",
    });
  });

  it("turns a local contradiction while adopting lookup evidence into order intervention", async () => {
    const client = clientPort(lookupSucceeded());
    const contradiction = new Error("The ERP returned an invalid confirmation response.");
    contradiction.name = "ErpConfirmationInvalidResponseError";
    client.recordLookupResult.mockRejectedValue(contradiction);
    const reconciler = createReconciler(client);

    await expect(
      reconciler.reconcile({ job, delivery, call, replayAdmission: rejectingAdmission() }),
    ).resolves.toMatchObject({
      disposition: "intervention_required",
      interventionScope: "order",
      errorCode: "erp_attempt_contradiction",
    });
  });
});

function createReconciler(
  client: ReturnType<typeof clientPort>,
  callResolution = { resolveDispatchedCall: vi.fn().mockResolvedValue(true) },
  lookupAvailabilityCircuit = { assertAvailable: vi.fn() },
  lookupConcurrency = 2,
) {
  return new ErpUnresolvedCallReconciler({
    client,
    callResolution,
    lookupAvailabilityCircuit,
    lookupConcurrency,
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

function rejectingAdmission(): ErpReplayDispatchAdmission {
  return { dispatchReplay: vi.fn().mockResolvedValue(null) };
}

function lookupSucceeded(): ErpLookupOutcome {
  return {
    disposition: "succeeded",
    operation: "status_lookup",
    lookup: {
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
        result: successResponse(),
      },
      timestamp: "2026-06-22T00:00:01.000Z",
    },
    startedAt: new Date("2026-06-22T00:00:01.000Z"),
    finishedAt: new Date("2026-06-22T00:00:01.010Z"),
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
    startedAt: new Date("2026-06-22T00:00:01.000Z"),
    finishedAt: new Date("2026-06-22T00:00:01.010Z"),
    latencyMs: 10,
  };
}

function dispatchedSuccess(replayed: boolean): ErpConfirmationOutcome {
  return {
    disposition: "succeeded",
    operation: "dispatched_confirmation",
    call,
    startedAt: new Date("2026-06-22T00:00:01.000Z"),
    finishedAt: new Date("2026-06-22T00:00:01.010Z"),
    latencyMs: 10,
    replayed,
    httpStatus: 200,
    response: successResponse(),
  };
}

function successResponse(): Extract<ErpConfirmationResponse, { status: "succeeded" }> {
  return {
    status: "succeeded",
    confirmationId: "confirmation-reconciled",
    httpStatus: 200,
    latencyMs: 10,
    timestamp: "2026-06-22T00:00:01.010Z",
  };
}
