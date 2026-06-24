import type { OrderProcessJob } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import {
  createOrderProcessJobHandler,
  OrderFailurePersistenceError,
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

  it("can retry from processing when confirmed persistence fails after confirmation", async () => {
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
    const confirmation = { confirm: vi.fn().mockResolvedValue(undefined) };
    const handler = createOrderProcessJobHandler({
      confirmation,
      persistence,
      logger: createSilentLogger("worker"),
    });

    await expect(handler.handle(job, delivery)).rejects.toBe(persistenceError);
    await expect(
      handler.handle(job, { attemptNumber: 4, attemptsMade: 3 }),
    ).resolves.toBeUndefined();

    expect(confirmation.confirm).toHaveBeenCalledTimes(2);
    expect(transitionToConfirmed).toHaveBeenCalledTimes(2);
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
        code: "order_confirmation_failed",
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
