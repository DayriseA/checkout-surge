import type { OrderProcessJob } from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { AdaptiveErpRuntimeAdmission } from "../../src/application/order-process-admission.js";
import { processJob } from "../../src/queue/bullmq-order-process-consumer.js";

const data: OrderProcessJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test",
  reservationId: "33333333-3333-4333-8333-333333333333",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  correlationId: "corr-admission",
  quantity: 1,
  queuedAt: "2026-07-13T00:00:00.000Z",
  processingGeneration: 0,
};

describe("adaptive ERP runtime admission", () => {
  it("restores durable safety, isolates scopes, and exposes bounded live counters", async () => {
    let now = 1_000;
    const runId = "55555555-5555-4555-8555-555555555555";
    const admission = await AdaptiveErpRuntimeAdmission.restore({
      pauseDelivery: async () => {},
      persistence: {
        listActive: async () => [
          {
            scope: "catalog",
            cooldownUntilMs: 5_000,
            availabilityRetryAtMs: 0,
            availabilityCircuitOpen: false,
            circuitOpenUntilMs: 0,
            nextProbeAtMs: 0,
          },
        ],
        readActive: async () => null,
        listUnresolvedScopes: async () => [],
        readReconciliationGate: async () => ({ pending: false, nextEligibleAtMs: 0 }),
        save: vi.fn(),
      },
      runConfigReader: {
        read: async () => ({
          ...previewRunConfigSnapshotFixture(),
          backpressureConfig: {
            ...previewRunConfigSnapshotFixture().backpressureConfig,
            orderProcessConcurrency: 1,
          },
        }),
      },
      fallbackConcurrency: 2,
      now: () => now,
      random: () => 0,
    });

    const catalog = await admission.tryAcquire(await admission.context(data), "confirmation");
    expect(catalog).toMatchObject({ admitted: false, decision: { reason: "capacity_cooldown" } });
    const run = await admission.tryAcquire(
      await admission.context({ ...data, runId }),
      "confirmation",
    );
    expect(run.admitted).toBe(true);
    if (run.admitted) admission.release(run.operation);
    now = 5_000;
    const state = admission.state();
    expect(state).toMatchObject({
      available: true,
      counters: { admitted: 1, deferred: 1, released: 1 },
    });
    if (!state.available) throw new Error(state.error);
    expect(state.scopes).toHaveLength(2);
  });

  it("persists capacity safety then pauses native delivery without failing the operation", async () => {
    const events: string[] = [];
    const pauseDelivery = vi.fn(async () => {
      events.push("pause");
    });
    let now = 0;
    const admission = AdaptiveErpRuntimeAdmission.create({
      pauseDelivery,
      persistence: {
        ...noSafetyPersistence(),
        save: async () => {
          events.push("persist");
        },
      },
      runConfigReader: { read: async () => null },
      fallbackConcurrency: 2,
      now: () => now,
    });
    const context = await admission.context(data);
    const acquired = await admission.tryAcquire(context, "confirmation");
    if (!acquired.admitted) throw new Error("Expected permit.");
    await admission.feedback(acquired.operation, {
      disposition: "capacity_rejected",
      operation: "dispatched_confirmation",
      call: {
        erpCallId: "99999999-9999-4999-8999-999999999999",
        orderId: data.orderId,
        idempotencyKey: `erp-confirmation:${data.orderId}`,
        processingGeneration: 0,
        dispatchedAt: new Date(0).toISOString(),
      },
      startedAt: new Date(0),
      finishedAt: new Date(0),
      latencyMs: 1,
      requestDeadlineMs: 2_000,
      replayed: false,
      httpStatus: 429,
      retryAfterMs: 1_000,
    });
    expect(events).toEqual(["persist", "pause"]);
    expect(pauseDelivery).toHaveBeenCalledExactlyOnceWith(1_000);
    await expect(admission.tryAcquire(context, "confirmation")).resolves.toMatchObject({
      admitted: false,
      decision: { reason: "capacity_cooldown", nextEligibleAtMs: 1_000 },
    });
    now = 1_000;
    const resumed = await admission.tryAcquire(context, "confirmation");
    expect(resumed.admitted).toBe(true);
    if (resumed.admitted) admission.release(resumed.operation);
    // No learned-rate delay after the pause.
    await expect(admission.tryAcquire(context, "confirmation")).resolves.toMatchObject({
      admitted: true,
    });
    await admission.close();
  });

  it("rejects a missing accepted run snapshot instead of falling back to catalog", async () => {
    const admission = AdaptiveErpRuntimeAdmission.create({
      pauseDelivery: async () => {},
      persistence: noSafetyPersistence(),
      runConfigReader: { read: async () => null },
      fallbackConcurrency: 2,
    });
    await expect(
      admission.context({ ...data, runId: "55555555-5555-4555-8555-555555555555" }),
    ).rejects.toThrow("snapshot was not found");
  });

  it("releases active permits on shutdown and admits no new work", async () => {
    const admission = AdaptiveErpRuntimeAdmission.create({
      pauseDelivery: async () => {},
      persistence: noSafetyPersistence(),
      runConfigReader: { read: async () => null },
      fallbackConcurrency: 2,
      now: () => 0,
    });
    const context = await admission.context(data);
    const active = await admission.tryAcquire(context, "confirmation");
    expect(active.admitted).toBe(true);

    await admission.close();

    expect(admission.state()).toMatchObject({
      available: true,
      counters: { admitted: 1, released: 1 },
      scopes: [{ admission: { workerInFlight: 0 } }],
    });
    await expect(admission.tryAcquire(context, "confirmation")).resolves.toMatchObject({
      admitted: false,
    });
  });

  it("reports safety persistence failure as unavailable instead of zero state", async () => {
    const admission = AdaptiveErpRuntimeAdmission.create({
      pauseDelivery: async () => {},
      persistence: {
        listActive: async () => [],
        readActive: async () => null,
        listUnresolvedScopes: async () => [],
        readReconciliationGate: async () => ({ pending: false, nextEligibleAtMs: 0 }),
        save: async () => {
          throw new Error("PostgreSQL unavailable");
        },
      },
      runConfigReader: { read: async () => null },
      fallbackConcurrency: 2,
      now: () => 0,
    });
    const acquired = await admission.tryAcquire(await admission.context(data), "confirmation");
    if (!acquired.admitted) throw new Error("Expected permit.");

    await expect(
      admission.feedback(acquired.operation, {
        disposition: "capacity_rejected",
        operation: "dispatched_confirmation",
        call: {
          erpCallId: "99999999-9999-4999-8999-999999999999",
          orderId: data.orderId,
          idempotencyKey: `erp-confirmation:${data.orderId}`,
          processingGeneration: 0,
          dispatchedAt: new Date(0).toISOString(),
        },
        startedAt: new Date(0),
        finishedAt: new Date(1),
        latencyMs: 1,
        requestDeadlineMs: 2_000,
        replayed: false,
        httpStatus: 429,
      }),
    ).rejects.toThrow("restart-safety state could not be persisted");
    expect(admission.state()).toEqual({
      available: false,
      error: "PostgreSQL unavailable",
    });
  });

  it("serializes per-scope safety writes and snapshots the latest restriction", async () => {
    let now = 0;
    let finishFirstSave: (() => void) | undefined;
    const firstSave = new Promise<void>((resolve) => {
      finishFirstSave = resolve;
    });
    const saved: Array<{ cooldownUntilMs: number }> = [];
    const admission = AdaptiveErpRuntimeAdmission.create({
      pauseDelivery: async () => {},
      persistence: {
        ...noSafetyPersistence(),
        save: async (record) => {
          saved.push(record);
          if (saved.length === 1) await firstSave;
        },
      },
      runConfigReader: { read: async () => null },
      fallbackConcurrency: 2,
      now: () => now,
    });
    const context = await admission.context(data);
    const first = await admission.tryAcquire(context, "confirmation");
    if (!first.admitted) throw new Error("Expected first permit.");
    now = 500;
    const second = await admission.tryAcquire(context, "confirmation");
    if (!second.admitted) throw new Error("Expected second permit.");

    const healthyWrite = admission.feedback(first.operation, confirmationOutcome("succeeded"));
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    const restrictedWrite = admission.feedback(
      second.operation,
      confirmationOutcome("capacity_rejected"),
    );
    await Promise.resolve();
    expect(saved).toHaveLength(1);
    finishFirstSave?.();
    await Promise.all([healthyWrite, restrictedWrite]);

    expect(saved).toHaveLength(2);
    expect(saved[1]?.cooldownUntilMs).toBe(60_500);
  });

  it("blocks fresh confirmations for a restored unresolved scope", async () => {
    const admission = await AdaptiveErpRuntimeAdmission.restore({
      pauseDelivery: async () => {},
      persistence: {
        ...noSafetyPersistence(),
        listUnresolvedScopes: async () => ["catalog"],
        readReconciliationGate: async () => ({ pending: true, nextEligibleAtMs: 60_000 }),
      },
      runConfigReader: { read: async () => null },
      fallbackConcurrency: 2,
      now: () => 1_000,
    });
    const context = await admission.context(data);

    await expect(admission.tryAcquire(context, "confirmation")).resolves.toMatchObject({
      admitted: false,
      decision: { reason: "reconciliation_pending", nextEligibleAtMs: 60_000 },
    });
    await expect(
      admission.tryAcquire(context, "confirmation", { reconciliation: true }),
    ).resolves.toMatchObject({ admitted: true });
  });

  it("recovers a stale gate on denial and ignores an older overlapping refresh", async () => {
    let now = 1_000;
    let finishOlder: ((value: { pending: boolean; nextEligibleAtMs: number }) => void) | undefined;
    let finishNewer: ((value: { pending: boolean; nextEligibleAtMs: number }) => void) | undefined;
    const older = new Promise<{ pending: boolean; nextEligibleAtMs: number }>((resolve) => {
      finishOlder = resolve;
    });
    const newer = new Promise<{ pending: boolean; nextEligibleAtMs: number }>((resolve) => {
      finishNewer = resolve;
    });
    const readReconciliationGate = vi.fn().mockReturnValueOnce(older).mockReturnValueOnce(newer);
    const admission = await AdaptiveErpRuntimeAdmission.restore({
      pauseDelivery: async () => {},
      persistence: {
        ...noSafetyPersistence(),
        listUnresolvedScopes: async () => ["catalog"],
        readReconciliationGate,
      },
      runConfigReader: { read: async () => null },
      fallbackConcurrency: 2,
      now: () => now,
    });
    const context = await admission.context(data);

    const deniedRefresh = admission.tryAcquire(context, "confirmation");
    await vi.waitFor(() => expect(readReconciliationGate).toHaveBeenCalledOnce());
    const settledRefresh = admission.reconciliationSettled("catalog");
    await vi.waitFor(() => expect(readReconciliationGate).toHaveBeenCalledTimes(2));
    finishNewer?.({ pending: false, nextEligibleAtMs: 0 });
    await settledRefresh;
    finishOlder?.({ pending: true, nextEligibleAtMs: 60_000 });

    const admitted = await deniedRefresh;
    expect(admitted).toMatchObject({ admitted: true });
    if (admitted.admitted) admission.release(admitted.operation);
    now = 1_500;
    await expect(admission.tryAcquire(context, "confirmation")).resolves.toMatchObject({
      admitted: true,
    });
  });

  it("keeps gate-read and safety-write failures independent until each recovers", async () => {
    let now = 1_000;
    const readReconciliationGate = vi
      .fn()
      .mockResolvedValueOnce({ pending: true, nextEligibleAtMs: 60_000 })
      .mockRejectedValueOnce(new Error("gate read failed"))
      .mockResolvedValue({ pending: false, nextEligibleAtMs: 0 });
    const save = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("safety write failed"))
      .mockResolvedValue(undefined);
    const admission = await AdaptiveErpRuntimeAdmission.restore({
      pauseDelivery: async () => {},
      persistence: {
        ...noSafetyPersistence(),
        listUnresolvedScopes: async () => ["catalog"],
        readReconciliationGate,
        save,
      },
      runConfigReader: { read: async () => null },
      fallbackConcurrency: 2,
      now: () => now,
    });
    const context = await admission.context(data);
    await admission.tryAcquire(context, "confirmation");
    now = 1_100;
    await admission.reconciliationSettled("catalog");
    expect(admission.state()).toEqual({ available: false, error: "gate read failed" });
    await expect(admission.tryAcquire(context, "confirmation")).resolves.toMatchObject({
      admitted: false,
      decision: { nextEligibleAtMs: 1_200 },
    });
    const first = await admission.tryAcquire(context, "confirmation", { reconciliation: true });
    if (!first.admitted) throw new Error("Expected recovery permit.");
    await admission.feedback(first.operation, confirmationOutcome("succeeded"));
    expect(admission.state()).toEqual({ available: false, error: "gate read failed" });
    now = 1_600;
    const second = await admission.tryAcquire(context, "confirmation", { reconciliation: true });
    if (!second.admitted) throw new Error("Expected recovery permit.");
    await expect(
      admission.feedback(second.operation, confirmationOutcome("succeeded")),
    ).rejects.toThrow("restart-safety state could not be persisted");
    expect(admission.state()).toEqual({
      available: false,
      error: "safety write failed; gate read failed",
    });
    await admission.reconciliationSettled("catalog");
    expect(admission.state()).toEqual({ available: false, error: "safety write failed" });
    now = 2_100;
    const third = await admission.tryAcquire(context, "confirmation");
    if (!third.admitted) throw new Error("Expected fresh permit.");
    await admission.feedback(third.operation, confirmationOutcome("succeeded"));
    expect(admission.state()).toMatchObject({ available: true });
  });

  it("throttles failed gate refreshes while keeping the short recovery recheck", async () => {
    let now = 1_000;
    const readReconciliationGate = vi
      .fn()
      .mockRejectedValueOnce(new Error("PostgreSQL unavailable"))
      .mockResolvedValue({ pending: false, nextEligibleAtMs: 0 });
    const admission = await AdaptiveErpRuntimeAdmission.restore({
      pauseDelivery: async () => {},
      persistence: {
        ...noSafetyPersistence(),
        listUnresolvedScopes: async () => ["catalog"],
        readReconciliationGate,
      },
      runConfigReader: { read: async () => null },
      fallbackConcurrency: 2,
      now: () => now,
    });
    const context = await admission.context(data);

    await expect(admission.tryAcquire(context, "confirmation")).resolves.toMatchObject({
      admitted: false,
      decision: { reason: "reconciliation_pending", nextEligibleAtMs: 1_100 },
    });
    expect(admission.state()).toEqual({ available: false, error: "PostgreSQL unavailable" });
    await admission.tryAcquire(context, "confirmation");
    expect(readReconciliationGate).toHaveBeenCalledOnce();
    now = 1_100;
    await expect(admission.tryAcquire(context, "confirmation")).resolves.toMatchObject({
      admitted: true,
    });
    expect(readReconciliationGate).toHaveBeenCalledTimes(2);
    expect(admission.state()).toMatchObject({ available: true });
  });
});

function noSafetyPersistence() {
  return {
    listActive: async () => [],
    readActive: async () => null,
    listUnresolvedScopes: async () => [],
    readReconciliationGate: async () => ({ pending: false, nextEligibleAtMs: 0 }),
    save: async () => undefined,
  };
}

function confirmationOutcome(disposition: "succeeded" | "capacity_rejected") {
  return {
    disposition,
    operation: "dispatched_confirmation" as const,
    call: {
      erpCallId: "99999999-9999-4999-8999-999999999999",
      orderId: data.orderId,
      idempotencyKey: `erp-confirmation:${data.orderId}`,
      processingGeneration: 0,
      dispatchedAt: new Date(0).toISOString(),
    },
    startedAt: new Date(0),
    finishedAt: new Date(1),
    latencyMs: 1,
    requestDeadlineMs: 2_000,
    replayed: false,
    httpStatus: disposition === "capacity_rejected" ? 429 : 200,
    ...(disposition === "capacity_rejected" ? { retryAfterMs: 60_000 } : {}),
  };
}

describe("order process consumer boundary", () => {
  it("leaves ERP admission inside the claimed handler workflow", async () => {
    const handler = { handle: vi.fn().mockRejectedValue(new Error("handler failed")) };
    await expect(
      processJob(bullJob(), {
        connection: {},
        concurrency: 10,
        handler,
        recovery: { recordRecoverable: vi.fn(), recordDeadLetter: vi.fn() },
        logger: createSilentLogger("worker"),
      }),
    ).rejects.toThrow("handler failed");
    expect(handler.handle).toHaveBeenCalledOnce();
    expect(bullJob().moveToDelayed).not.toHaveBeenCalled();
  });
});

function bullJob() {
  return {
    id: data.orderId,
    name: "order.process",
    data,
    attemptsMade: 0,
    opts: { attempts: 1 },
    moveToDelayed: vi.fn(),
  } as unknown as Job<OrderProcessJob, void, "order.process">;
}
