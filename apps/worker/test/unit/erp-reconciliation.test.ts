import type { ErpCallReference, ErpConfirmationResponse } from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ErpCircuitBreaker,
  ErpCircuitOpenError,
} from "../../src/application/erp-circuit-breaker.js";
import type {
  ErpConfirmationOutcome,
  ErpLookupOutcome,
} from "../../src/application/erp-confirmation-client.js";
import {
  type ErpLookupAvailabilityCircuit,
  type ErpReplayDispatchAdmission,
  ErpUnresolvedCallReconciler,
  ScheduledErpOrderConfirmation,
} from "../../src/application/erp-reconciliation.js";

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
    expect(client.dispatch).toHaveBeenCalledWith(job, {
      ...delivery,
      supersedesErpCallId: call.erpCallId,
    });
  });

  it("retains unknown call evidence after denied replay and looks up again next generation", async () => {
    const client = clientPort(lookupUnknown());
    const resolution = { resolveDispatchedCall: vi.fn().mockResolvedValue(true) };
    const reconciler = createReconciler(client, resolution);
    for (const processingGeneration of [3, 4]) {
      await expect(
        reconciler.reconcile({
          job,
          delivery: { ...delivery, processingGeneration },
          call,
          replayAdmission: rejectingAdmission(),
        }),
      ).resolves.toEqual({
        operation: "non_call_deferral",
        disposition: "uncertain_result",
        reason: "replay_not_admitted",
      });
    }
    expect(resolution.resolveDispatchedCall).not.toHaveBeenCalled();
    expect(client.dispatch).not.toHaveBeenCalled();
    expect(client.lookup).toHaveBeenCalledTimes(2);
    expect(client.lookup).toHaveBeenNthCalledWith(2, call.idempotencyKey, job.correlationId);
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

  it("converges unresolved-only work through half-open lookup and one POST probe", async () => {
    let now = new Date("2026-06-22T00:00:00.000Z");
    const outage = new Error("ERP unavailable");
    const breaker = new ErpCircuitBreaker({
      confirmation: {
        confirm: vi.fn().mockRejectedValueOnce(outage).mockResolvedValue(dispatchedSuccess(false)),
      },
      failureThreshold: 1,
      resetTimeoutMs: 1_000,
      isCountedFailure: (error) => error === outage,
      now: () => now,
    });
    const client = clientPort(lookupUnknown());
    const reconciler = createReconciler(client, undefined, breaker);
    const replayAdmission: ErpReplayDispatchAdmission = {
      dispatchReplay: vi.fn(
        async () => breaker.confirm(job, delivery) as Promise<ErpConfirmationOutcome>,
      ),
    };

    await expect(breaker.confirm(job, delivery)).rejects.toBe(outage);
    await expect(
      reconciler.reconcile({ job, delivery, call, replayAdmission }),
    ).rejects.toBeInstanceOf(ErpCircuitOpenError);

    now = new Date("2026-06-22T00:00:01.000Z");
    await expect(
      reconciler.reconcile({ job, delivery, call, replayAdmission }),
    ).resolves.toMatchObject({ disposition: "succeeded", replayed: false });
    const secondJob = { ...job, orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const secondCall = {
      ...call,
      orderId: secondJob.orderId,
      erpCallId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    await expect(
      reconciler.reconcile({ job: secondJob, delivery, call: secondCall, replayAdmission }),
    ).resolves.toMatchObject({ disposition: "succeeded", replayed: false });
    expect(client.lookup).toHaveBeenCalledTimes(2);
    expect(replayAdmission.dispatchReplay).toHaveBeenCalledTimes(2);
    expect(breaker.snapshot().state).toBe("closed");
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

describe("durable ERP scheduling", () => {
  it("persists local admission denial and releases ownership without a call", async () => {
    const defer = vi.fn().mockResolvedValue(true);
    const dispatch = vi.fn();
    const scheduled = scheduledConfirmation({
      admission: { tryAcquire: vi.fn().mockResolvedValue(null), close: vi.fn() },
      control: { defer, openIntervention: vi.fn() },
      dispatch: { confirm: dispatch },
    });

    await expect(scheduled.confirm(job, delivery)).resolves.toMatchObject({
      disposition: "deferred",
      reason: "local_admission",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(defer).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: job.orderId,
        processingGeneration: 3,
        waitingReason: "local_admission",
      }),
    );
  });

  it("passes the unresolved call identity through the admitted circuit dispatch", async () => {
    const client = clientPort(lookupUnknown());
    const dispatch = vi.fn().mockResolvedValue(dispatchedSuccess(true));
    const scheduled = scheduledConfirmation({
      client: { ...client, findUnresolvedCall: vi.fn().mockResolvedValue(call) },
      reconciler: createReconciler(client),
      dispatch: { confirm: dispatch },
    });
    await expect(scheduled.confirm(job, delivery)).resolves.toEqual({ disposition: "succeeded" });
    expect(dispatch).toHaveBeenCalledWith(job, {
      ...delivery,
      supersedesErpCallId: call.erpCallId,
    });
  });

  it("blocks a marked scope without admission, HTTP, or per-order intervention", async () => {
    const admission = { tryAcquire: vi.fn(), close: vi.fn() };
    const control = { defer: vi.fn().mockResolvedValue(true), openIntervention: vi.fn() };
    const scheduled = scheduledConfirmation({
      admission,
      control,
      scopeState: {
        get: vi.fn().mockResolvedValue({ interventionReason: "erp_http_401" }),
        openIntervention: vi.fn(),
      },
    });

    await expect(scheduled.confirm(job, delivery)).resolves.toMatchObject({
      disposition: "intervention_required",
      reason: "scope_intervention",
    });
    expect(admission.tryAcquire).not.toHaveBeenCalled();
    expect(control.openIntervention).not.toHaveBeenCalled();
  });

  it("opens order intervention for a corrupt accepted run snapshot", async () => {
    const corruption = new Error("invalid snapshot");
    corruption.name = "PersistedRunConfigCorruptionError";
    const control = {
      defer: vi.fn(),
      openIntervention: vi.fn().mockResolvedValue(true),
    };
    const scheduled = scheduledConfirmation({
      admission: { tryAcquire: vi.fn().mockRejectedValue(corruption), close: vi.fn() },
      control,
    });

    await expect(scheduled.confirm(job, delivery)).resolves.toEqual({
      disposition: "intervention_required",
      reason: "accepted_run_snapshot_invalid",
    });
    expect(control.openIntervention).toHaveBeenCalledWith({
      orderId: job.orderId,
      reason: "accepted_run_snapshot_invalid",
      processingGeneration: 3,
    });
  });
});

function scheduledConfirmation(overrides: Record<string, unknown> = {}) {
  const permit = { release: vi.fn().mockResolvedValue(undefined) };
  return new ScheduledErpOrderConfirmation({
    client: {
      findSuccessfulAttempt: vi.fn().mockResolvedValue(null),
      findUnresolvedCall: vi.fn().mockResolvedValue(null),
    },
    reconciler: { reconcile: vi.fn() } as never,
    dispatch: { confirm: vi.fn().mockResolvedValue(dispatchedSuccess(false)) },
    admission: { tryAcquire: vi.fn().mockResolvedValue(permit), close: vi.fn() },
    control: {
      defer: vi.fn().mockResolvedValue(true),
      openIntervention: vi.fn().mockResolvedValue(true),
    },
    scopeState: {
      get: vi.fn().mockResolvedValue(null),
      openIntervention: vi.fn().mockResolvedValue(undefined),
    },
    now: () => new Date("2026-06-22T00:00:02.000Z"),
    random: () => 0,
    ...overrides,
  } as never);
}

function createReconciler(
  client: ReturnType<typeof clientPort>,
  callResolution = { resolveDispatchedCall: vi.fn().mockResolvedValue(true) },
  lookupAvailabilityCircuit: ErpLookupAvailabilityCircuit = { assertAvailable: vi.fn() },
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
    requestDeadlineMs: 2_000,
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
