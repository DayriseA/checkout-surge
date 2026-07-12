import type { OrderProcessJob } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { ErpCircuitOpenError } from "../../src/application/erp-circuit-breaker.js";
import {
  ErpAcceptedConfirmationPersistenceError,
  isErpAttemptPersistenceError,
} from "../../src/application/erp-confirmation-client.js";
import {
  createOrderProcessJobHandler,
  OrderFailurePersistenceError,
  OrderProcessingPersistenceError,
  OrderRecoveryHandoffError,
  type OrderTransitionPersistence,
} from "../../src/application/order-process-job-handler.js";

const job: OrderProcessJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test",
  reservationId: "33333333-3333-4333-8333-333333333333",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  correlationId: "corr-worker-test",
  quantity: 1,
  queuedAt: "2026-06-21T00:00:00.000Z",
};
const runScopedJob: OrderProcessJob = {
  ...job,
  runId: "55555555-5555-4555-8555-555555555555",
};
const delivery = { attemptNumber: 3, attemptsMade: 2 };

function createPersistence(
  overrides: Partial<OrderTransitionPersistence> = {},
): OrderTransitionPersistence {
  return {
    transitionToProcessing: vi.fn().mockResolvedValue({ status: "processing", resumed: false }),
    transitionToConfirmed: vi.fn().mockResolvedValue(undefined),
    transitionToFailed: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("order-process application workflow", () => {
  it("classifies processing-state persistence outages before ERP and hands off the final delivery", async () => {
    const confirmation = { confirm: vi.fn() };
    const recovery = { handoff: vi.fn().mockResolvedValue(undefined) };
    const persistence = createPersistence({
      transitionToProcessing: vi.fn().mockRejectedValue(new Error("database unavailable")),
    });
    const handler = createOrderProcessJobHandler({
      confirmation,
      persistence,
      logger: createSilentLogger("worker"),
      recovery,
    });

    await expect(
      handler.handle(job, { attemptNumber: 1, attemptsMade: 0, maxAttempts: 2 }),
    ).rejects.toBeInstanceOf(OrderProcessingPersistenceError);
    expect(confirmation.confirm).not.toHaveBeenCalled();
    expect(recovery.handoff).not.toHaveBeenCalled();

    await expect(
      handler.handle(job, { attemptNumber: 2, attemptsMade: 1, maxAttempts: 2 }),
    ).rejects.toBeInstanceOf(OrderProcessingPersistenceError);
    expect(confirmation.confirm).not.toHaveBeenCalled();
    expect(recovery.handoff).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "order_processing_persistence_unavailable" }),
    );
  });
  it("moves a queued order through confirmation with delivery metadata", async () => {
    const persistence = createPersistence();
    const confirmation = { confirm: vi.fn().mockResolvedValue(undefined) };
    const handler = createOrderProcessJobHandler({
      confirmation,
      persistence,
      logger: createSilentLogger("worker"),
    });

    await handler.handle(job, delivery);

    expect(persistence.transitionToProcessing).toHaveBeenCalledWith(job, delivery);
    expect(confirmation.confirm).toHaveBeenCalledWith(job, delivery);
    expect(persistence.transitionToConfirmed).toHaveBeenCalledWith(job, delivery);
    expect(persistence.transitionToFailed).not.toHaveBeenCalled();
  });

  it("publishes a simulated notification job after confirmation", async () => {
    const notificationRecordPublisher = {
      publishForConfirmedOrder: vi.fn().mockResolvedValue(undefined),
    };
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
      persistence: createPersistence(),
      logger: createSilentLogger("worker"),
      notificationRecordPublisher,
    });

    await handler.handle(job, delivery);

    expect(notificationRecordPublisher.publishForConfirmedOrder).toHaveBeenCalledWith(
      job,
      expect.any(String),
    );
  });

  it("preserves run identity when publishing notification and business outcome updates", async () => {
    const notificationRecordPublisher = {
      publishForConfirmedOrder: vi.fn().mockResolvedValue(undefined),
    };
    const publishBusinessOutcomeUpdate = vi.fn().mockResolvedValue(undefined);
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
      persistence: createPersistence(),
      logger: createSilentLogger("worker"),
      notificationRecordPublisher,
      publishBusinessOutcomeUpdate,
    });

    await handler.handle(runScopedJob, delivery);

    expect(notificationRecordPublisher.publishForConfirmedOrder).toHaveBeenCalledWith(
      runScopedJob,
      expect.any(String),
    );
    expect(publishBusinessOutcomeUpdate).toHaveBeenCalledWith(runScopedJob, "processing");
    expect(publishBusinessOutcomeUpdate).toHaveBeenCalledWith(runScopedJob, "confirmed");
  });

  it("does not fail a confirmed order when notification job publication fails", async () => {
    const publishError = new Error("queue unavailable");
    const transitionToConfirmed = vi.fn().mockResolvedValue(undefined);
    const reportNotificationRecordPublishFailure = vi.fn();
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
      persistence: createPersistence({ transitionToConfirmed }),
      logger: createSilentLogger("worker"),
      notificationRecordPublisher: {
        publishForConfirmedOrder: vi.fn().mockRejectedValue(publishError),
      },
      reportNotificationRecordPublishFailure,
    });

    await handler.handle(job, delivery);

    expect(transitionToConfirmed).toHaveBeenCalledOnce();
    expect(reportNotificationRecordPublishFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: publishError,
        orderId: job.orderId,
        saleOfferId: job.saleOfferId,
        correlationId: job.correlationId,
      }),
    );
  });

  it("includes run identity in non-fatal side-effect failure reports", async () => {
    const notificationError = new Error("notification queue unavailable");
    const outcomeError = new Error("dashboard publish unavailable");
    const reportNotificationRecordPublishFailure = vi.fn();
    const reportBusinessOutcomeUpdateFailure = vi.fn();
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
      persistence: createPersistence(),
      logger: createSilentLogger("worker"),
      notificationRecordPublisher: {
        publishForConfirmedOrder: vi.fn().mockRejectedValue(notificationError),
      },
      reportNotificationRecordPublishFailure,
      publishBusinessOutcomeUpdate: vi.fn().mockRejectedValue(outcomeError),
      reportBusinessOutcomeUpdateFailure,
    });

    await handler.handle(runScopedJob, delivery);

    expect(reportNotificationRecordPublishFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: notificationError,
        orderId: runScopedJob.orderId,
        saleOfferId: runScopedJob.saleOfferId,
        runId: runScopedJob.runId,
        correlationId: runScopedJob.correlationId,
      }),
    );
    expect(reportBusinessOutcomeUpdateFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: outcomeError,
        orderId: runScopedJob.orderId,
        saleOfferId: runScopedJob.saleOfferId,
        runId: runScopedJob.runId,
        correlationId: runScopedJob.correlationId,
        transition: "processing",
      }),
    );
  });

  it("publishes business outcome updates for processing and confirmation transitions", async () => {
    const publishBusinessOutcomeUpdate = vi.fn().mockResolvedValue(undefined);
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
      persistence: createPersistence(),
      logger: createSilentLogger("worker"),
      publishBusinessOutcomeUpdate,
    });

    await handler.handle(job, delivery);

    expect(publishBusinessOutcomeUpdate).toHaveBeenCalledWith(job, "processing");
    expect(publishBusinessOutcomeUpdate).toHaveBeenCalledWith(job, "confirmed");
  });

  it("does not fail the job when business outcome publication fails", async () => {
    const publishError = new Error("redis unavailable");
    const reportBusinessOutcomeUpdateFailure = vi.fn();
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
      persistence: createPersistence(),
      logger: createSilentLogger("worker"),
      publishBusinessOutcomeUpdate: vi.fn().mockRejectedValue(publishError),
      reportBusinessOutcomeUpdateFailure,
    });

    await handler.handle(job, delivery);

    expect(reportBusinessOutcomeUpdateFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: publishError,
        orderId: job.orderId,
        saleOfferId: job.saleOfferId,
        correlationId: job.correlationId,
      }),
    );
  });

  it("resumes confirmation for an order already processing", async () => {
    const persistence = createPersistence({
      transitionToProcessing: vi.fn().mockResolvedValue({ status: "processing", resumed: true }),
    });
    const confirmation = { confirm: vi.fn().mockResolvedValue(undefined) };
    const handler = createOrderProcessJobHandler({
      confirmation,
      persistence,
      logger: createSilentLogger("worker"),
    });

    await handler.handle(job, delivery);

    expect(confirmation.confirm).toHaveBeenCalledOnce();
    expect(persistence.transitionToConfirmed).toHaveBeenCalledOnce();
  });

  it("reuses a successful ERP confirmation when confirmed persistence fails", async () => {
    const transitionToProcessing = vi
      .fn()
      .mockResolvedValueOnce({ status: "processing", resumed: false })
      .mockResolvedValueOnce({ status: "processing", resumed: true });
    const persistenceError = new Error("confirmed persistence unavailable");
    const transitionToConfirmed = vi
      .fn()
      .mockRejectedValueOnce(persistenceError)
      .mockResolvedValueOnce(undefined);
    const persistence = createPersistence({ transitionToProcessing, transitionToConfirmed });
    const confirmDownstreamErp = vi.fn().mockResolvedValue(undefined);
    let hasReusableSuccessfulConfirmation = false;
    const confirmation = {
      confirm: vi.fn(async () => {
        if (hasReusableSuccessfulConfirmation) {
          return;
        }

        await confirmDownstreamErp();
        hasReusableSuccessfulConfirmation = true;
      }),
    };
    const handler = createOrderProcessJobHandler({
      confirmation,
      persistence,
      logger: createSilentLogger("worker"),
    });

    await expect(handler.handle(job, delivery)).rejects.toBe(persistenceError);
    await expect(
      handler.handle(job, { attemptNumber: 4, attemptsMade: 3 }),
    ).resolves.toBeUndefined();

    expect(confirmDownstreamErp).toHaveBeenCalledOnce();
    expect(transitionToConfirmed).toHaveBeenCalledTimes(2);
  });

  it("does not mark accepted ERP confirmations failed when local attempt persistence fails", async () => {
    const localPersistenceError = new Error("attempt persistence unavailable");
    const confirmationError = new ErpAcceptedConfirmationPersistenceError(localPersistenceError, {
      job,
      delivery: { attemptNumber: 3, attemptsMade: 2, maxAttempts: 3 },
      status: "succeeded",
      httpStatus: 200,
      latencyMs: 35,
      startedAt: new Date("2026-06-21T00:00:00.000Z"),
      finishedAt: new Date("2026-06-21T00:00:00.035Z"),
    });
    const persistence = createPersistence();
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockRejectedValue(confirmationError) },
      persistence,
      logger: createSilentLogger("worker"),
      isTemporaryConfirmationFailure: () => true,
      shouldRetryWithoutFailingOrder: isErpAttemptPersistenceError,
    });

    await expect(
      handler.handle(job, { attemptNumber: 3, attemptsMade: 2, maxAttempts: 3 }),
    ).rejects.toBe(confirmationError);

    expect(persistence.transitionToFailed).not.toHaveBeenCalled();
    expect(persistence.transitionToConfirmed).not.toHaveBeenCalled();
  });

  it("hands accepted ERP persistence failures to recovery on the final delivery", async () => {
    const confirmationError = new ErpAcceptedConfirmationPersistenceError(
      new Error("attempt persistence unavailable"),
      {
        job,
        delivery: { attemptNumber: 4, attemptsMade: 3, maxAttempts: 4 },
        status: "succeeded",
        httpStatus: 200,
        latencyMs: 20,
        startedAt: new Date("2026-06-21T00:00:00.000Z"),
        finishedAt: new Date("2026-06-21T00:00:00.020Z"),
      },
    );
    const recovery = { handoff: vi.fn().mockResolvedValue(undefined) };
    const persistence = createPersistence();
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockRejectedValue(confirmationError) },
      persistence,
      logger: createSilentLogger("worker"),
      recovery,
    });

    await expect(
      handler.handle(job, { attemptNumber: 4, attemptsMade: 3, maxAttempts: 4 }),
    ).rejects.toBe(confirmationError);

    expect(recovery.handoff).toHaveBeenCalledWith(
      expect.objectContaining({
        job,
        reason: "erp_accepted_local_persistence_incomplete",
        accepted: true,
      }),
    );
    expect(persistence.transitionToFailed).not.toHaveBeenCalled();
  });

  it("preserves the accepted source error when recovery handoff fails", async () => {
    const sourceError = new ErpAcceptedConfirmationPersistenceError(new Error("db down"), {
      job,
      delivery,
      status: "succeeded",
      httpStatus: 200,
      latencyMs: 1,
      startedAt: new Date("2026-06-21T00:00:00.000Z"),
      finishedAt: new Date("2026-06-21T00:00:00.001Z"),
    });
    const handoffError = new Error("recovery db also down");
    const persistence = createPersistence();
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockRejectedValue(sourceError) },
      persistence,
      logger: createSilentLogger("worker"),
      recovery: { handoff: vi.fn().mockRejectedValue(handoffError) },
    });

    const rejection = await handler.handle(job, delivery).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(OrderRecoveryHandoffError);
    expect(rejection).toMatchObject({ sourceError, handoffError });
    expect(persistence.transitionToFailed).not.toHaveBeenCalled();
  });

  it("hands a confirmed-transition persistence failure to recovery without failing the order", async () => {
    const transitionError = new Error("confirmed write unavailable");
    const persistence = createPersistence({
      transitionToConfirmed: vi.fn().mockRejectedValue(transitionError),
    });
    const recovery = { handoff: vi.fn().mockResolvedValue(undefined) };
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue({ status: "succeeded" }) },
      persistence,
      logger: createSilentLogger("worker"),
      recovery,
    });

    await expect(handler.handle(job, { ...delivery, maxAttempts: 4 })).rejects.toBe(
      transitionError,
    );
    expect(recovery.handoff).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "confirmed_transition_persistence_unavailable",
        accepted: true,
      }),
    );
    expect(persistence.transitionToFailed).not.toHaveBeenCalled();
  });

  it("does not mark circuit-open deliveries failed when the BullMQ attempt budget is reached", async () => {
    const circuitOpenError = new ErpCircuitOpenError(1000);
    const persistence = createPersistence();
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockRejectedValue(circuitOpenError) },
      persistence,
      logger: createSilentLogger("worker"),
      isTemporaryConfirmationFailure: (error) => error instanceof ErpCircuitOpenError,
      shouldRetryWithoutFailingOrder: (error) => error instanceof ErpCircuitOpenError,
    });

    await expect(
      handler.handle(job, { attemptNumber: 3, attemptsMade: 2, maxAttempts: 3 }),
    ).rejects.toBe(circuitOpenError);

    expect(persistence.transitionToFailed).not.toHaveBeenCalled();
    expect(persistence.transitionToConfirmed).not.toHaveBeenCalled();
  });

  it.each([
    "confirmed",
    "failed",
  ] as const)("acknowledges a terminal %s replay without confirmation", async (status) => {
    const persistence = createPersistence({
      transitionToProcessing: vi.fn().mockResolvedValue({ status, resumed: false }),
    });
    const confirmation = { confirm: vi.fn() };
    const handler = createOrderProcessJobHandler({
      confirmation,
      persistence,
      logger: createSilentLogger("worker"),
    });

    await handler.handle(job, delivery);

    expect(confirmation.confirm).not.toHaveBeenCalled();
    expect(persistence.transitionToConfirmed).not.toHaveBeenCalled();
    expect(persistence.transitionToFailed).not.toHaveBeenCalled();
  });

  it("persists stable failure details and propagates the original confirmation error", async () => {
    const confirmationError = new Error("Local confirmation rejected the order");
    const persistence = createPersistence();
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockRejectedValue(confirmationError) },
      persistence,
      logger: createSilentLogger("worker"),
    });

    let thrown: unknown;
    try {
      await handler.handle(job, delivery);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(confirmationError);
    expect(persistence.transitionToFailed).toHaveBeenCalledWith(
      job,
      {
        code: "order_confirmation_failed",
        message: "Local confirmation rejected the order",
      },
      delivery,
    );
    expect(persistence.transitionToConfirmed).not.toHaveBeenCalled();
  });

  it("leaves processing orders retryable after temporary confirmation failures with attempts remaining", async () => {
    const confirmationError = new Error("ERP temporarily unavailable");
    const persistence = createPersistence();
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockRejectedValue(confirmationError) },
      persistence,
      logger: createSilentLogger("worker"),
      isTemporaryConfirmationFailure: () => true,
    });

    await expect(
      handler.handle(job, { attemptNumber: 1, attemptsMade: 0, maxAttempts: 3 }),
    ).rejects.toBe(confirmationError);

    expect(persistence.transitionToFailed).not.toHaveBeenCalled();
    expect(persistence.transitionToConfirmed).not.toHaveBeenCalled();
  });

  it("publishes a retrying business outcome update before retrying temporary confirmation failures", async () => {
    const confirmationError = new Error("ERP temporarily unavailable");
    const publishBusinessOutcomeUpdate = vi.fn().mockResolvedValue(undefined);
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockRejectedValue(confirmationError) },
      persistence: createPersistence(),
      logger: createSilentLogger("worker"),
      isTemporaryConfirmationFailure: () => true,
      publishBusinessOutcomeUpdate,
    });

    await expect(
      handler.handle(job, { attemptNumber: 1, attemptsMade: 0, maxAttempts: 3 }),
    ).rejects.toBe(confirmationError);

    expect(publishBusinessOutcomeUpdate).toHaveBeenCalledWith(job, "retrying");
  });

  it("publishes a failed business outcome update after terminal confirmation failures", async () => {
    const confirmationError = new Error("ERP rejected the order");
    const publishBusinessOutcomeUpdate = vi.fn().mockResolvedValue(undefined);
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockRejectedValue(confirmationError) },
      persistence: createPersistence(),
      logger: createSilentLogger("worker"),
      publishBusinessOutcomeUpdate,
    });

    await expect(handler.handle(job, delivery)).rejects.toBe(confirmationError);

    expect(publishBusinessOutcomeUpdate).toHaveBeenCalledWith(job, "processing");
    expect(publishBusinessOutcomeUpdate).toHaveBeenCalledWith(job, "failed");
  });

  it("marks exhausted temporary confirmation failures as terminal order failures", async () => {
    const confirmationError = new Error("ERP still unavailable");
    const persistence = createPersistence();
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockRejectedValue(confirmationError) },
      persistence,
      logger: createSilentLogger("worker"),
      isTemporaryConfirmationFailure: () => true,
    });

    await expect(
      handler.handle(job, { attemptNumber: 3, attemptsMade: 2, maxAttempts: 3 }),
    ).rejects.toBe(confirmationError);

    expect(persistence.transitionToFailed).toHaveBeenCalledWith(
      job,
      {
        code: "erp_retries_exhausted",
        message: "ERP still unavailable",
      },
      { attemptNumber: 3, attemptsMade: 2, maxAttempts: 3 },
    );
  });

  it("preserves confirmation and failure-persistence errors together", async () => {
    const confirmationError = new Error("confirmation unavailable");
    const persistenceError = new Error("database unavailable");
    const persistence = createPersistence({
      transitionToFailed: vi.fn().mockRejectedValue(persistenceError),
    });
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockRejectedValue(confirmationError) },
      persistence,
      logger: createSilentLogger("worker"),
    });

    const rejection = await handler.handle(job, delivery).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(OrderFailurePersistenceError);
    expect(rejection).toMatchObject({
      confirmationError,
      persistenceError,
      errors: [confirmationError, persistenceError],
      cause: confirmationError,
    });
  });
});
