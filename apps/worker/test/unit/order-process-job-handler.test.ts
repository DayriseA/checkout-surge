import type { OrderProcessJob } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { ErpAcceptedConfirmationPersistenceError } from "../../src/application/erp-confirmation-client.js";
import {
  createOrderProcessJobHandler as createProductionOrderProcessJobHandler,
  OrderFailurePersistenceError,
  OrderProcessingPersistenceError,
  type OrderRecoveryHandoff,
  OrderRecoveryHandoffError,
  type OrderTransitionPersistence,
} from "../../src/application/order-process-job-handler.js";

const job: OrderProcessJob = {
  runId: "44444444-4444-4444-8444-444444444444",
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test",
  reservationId: "33333333-3333-4333-8333-333333333333",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  correlationId: "corr-worker-test",
  quantity: 1,
  queuedAt: "2026-06-21T00:00:00.000Z",
  processingGeneration: 0,
};
const runScopedJob: OrderProcessJob = {
  ...job,
  runId: "55555555-5555-4555-8555-555555555555",
};
const delivery = { attemptNumber: 3, attemptsMade: 2 };
const processingTransition = {
  changed: true as const,
  status: "processing" as const,
};
const confirmedTransition = {
  changed: true as const,
  status: "confirmed" as const,
  confirmedAt: new Date("2026-06-21T00:00:00.100Z"),
};
const failedTransition = {
  changed: true as const,
  status: "failed" as const,
};

function createPersistence(
  overrides: Partial<OrderTransitionPersistence> = {},
): OrderTransitionPersistence {
  return {
    transitionToProcessing: vi.fn().mockResolvedValue(processingTransition),
    transitionToConfirmed: vi.fn().mockResolvedValue(confirmedTransition),
    transitionToFailed: vi.fn().mockResolvedValue(failedTransition),
    ...overrides,
  };
}

type OrderProcessJobHandlerDependencies = Parameters<
  typeof createProductionOrderProcessJobHandler
>[0];

function createOrderProcessJobHandler(
  dependencies: Omit<
    OrderProcessJobHandlerDependencies,
    "publishBusinessOutcomeUpdate" | "notificationRecordPublisher" | "recovery"
  > &
    Partial<
      Pick<
        OrderProcessJobHandlerDependencies,
        "publishBusinessOutcomeUpdate" | "notificationRecordPublisher"
      >
    > & { recovery?: Partial<OrderRecoveryHandoff> },
) {
  const { recovery, ...overrides } = dependencies;
  return createProductionOrderProcessJobHandler({
    publishBusinessOutcomeUpdate: async () => undefined,
    notificationRecordPublisher: { publishForConfirmedOrder: async () => undefined },
    ...overrides,
    recovery: {
      handoff: async () => undefined,
      resolve: async () => undefined,
      ...recovery,
    },
  });
}

describe("order-process application workflow", () => {
  it("publishes aggregate dirty work and reuses confirmedAt for notification", async () => {
    const publishBusinessOutcomeUpdate = vi.fn().mockResolvedValue(undefined);
    const notificationRecordPublisher = {
      publishForConfirmedOrder: vi.fn().mockResolvedValue(undefined),
    };
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
      persistence: createPersistence(),
      logger: createSilentLogger("worker"),
      publishBusinessOutcomeUpdate,
      notificationRecordPublisher,
    });

    await handler.handle(job, delivery);

    expect(publishBusinessOutcomeUpdate).toHaveBeenNthCalledWith(1, job, "processing");
    expect(publishBusinessOutcomeUpdate).toHaveBeenNthCalledWith(2, job, "confirmed");
    expect(notificationRecordPublisher.publishForConfirmedOrder).toHaveBeenCalledWith(
      job,
      confirmedTransition.confirmedAt.toISOString(),
    );
  });

  it("hands processing-state persistence outages to recovery before ERP", async () => {
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

    await expect(handler.handle(job, { attemptNumber: 2, attemptsMade: 1 })).rejects.toBeInstanceOf(
      OrderProcessingPersistenceError,
    );
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

  it.each([
    "queue unavailable",
    "generated run is terminal after admin_reset",
  ])("does not fail a confirmed order when notification job publication fails: %s", async (message) => {
    const publishError = new Error(message);
    const transitionToConfirmed = vi.fn().mockResolvedValue(confirmedTransition);
    const logger = createSilentLogger("worker");
    vi.spyOn(logger, "child").mockReturnValue(logger as never);
    const logError = vi.spyOn(logger, "error").mockImplementation(() => {
      throw new Error("logging unavailable");
    });
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
      persistence: createPersistence({ transitionToConfirmed }),
      logger,
      notificationRecordPublisher: {
        publishForConfirmedOrder: vi.fn().mockRejectedValue(publishError),
      },
    });

    await handler.handle(job, delivery);

    expect(transitionToConfirmed).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith(
      {
        runId: "44444444-4444-4444-8444-444444444444",
        err: publishError,
        orderId: job.orderId,
        saleOfferId: job.saleOfferId,
        correlationId: job.correlationId,
      },
      "Order confirmed but notification-recording job publication failed.",
    );
  });

  it("includes run identity in non-fatal side-effect failure logs", async () => {
    const notificationError = new Error("notification queue unavailable");
    const outcomeError = new Error("dashboard publish unavailable");
    const logger = createSilentLogger("worker");
    vi.spyOn(logger, "child").mockReturnValue(logger as never);
    const logError = vi.spyOn(logger, "error").mockImplementation(() => {
      throw new Error("logging unavailable");
    });
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
      persistence: createPersistence(),
      logger,
      notificationRecordPublisher: {
        publishForConfirmedOrder: vi.fn().mockRejectedValue(notificationError),
      },
      publishBusinessOutcomeUpdate: vi.fn().mockRejectedValue(outcomeError),
    });

    await handler.handle(runScopedJob, delivery);

    expect(logError).toHaveBeenCalledWith(
      {
        err: notificationError,
        orderId: runScopedJob.orderId,
        saleOfferId: runScopedJob.saleOfferId,
        runId: runScopedJob.runId,
        correlationId: runScopedJob.correlationId,
      },
      "Order confirmed but notification-recording job publication failed.",
    );
    expect(logError).toHaveBeenCalledWith(
      {
        err: outcomeError,
        orderId: runScopedJob.orderId,
        saleOfferId: runScopedJob.saleOfferId,
        runId: runScopedJob.runId,
        correlationId: runScopedJob.correlationId,
        transition: "processing",
      },
      "Order transition succeeded but dashboard business outcome publication failed.",
    );
  });

  it("does not fail the job when business outcome publication fails", async () => {
    const publishError = new Error("redis unavailable");
    const logger = createSilentLogger("worker");
    vi.spyOn(logger, "child").mockReturnValue(logger as never);
    const logError = vi.spyOn(logger, "error").mockImplementation(() => {
      throw new Error("logging unavailable");
    });
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
      persistence: createPersistence(),
      logger,
      publishBusinessOutcomeUpdate: vi.fn().mockRejectedValue(publishError),
    });

    await handler.handle(job, delivery);

    expect(logError).toHaveBeenCalledWith(
      {
        runId: "44444444-4444-4444-8444-444444444444",
        err: publishError,
        orderId: job.orderId,
        saleOfferId: job.saleOfferId,
        correlationId: job.correlationId,
        transition: "processing",
      },
      "Order transition succeeded but dashboard business outcome publication failed.",
    );
  });

  it("resumes confirmation for an order already processing", async () => {
    const persistence = createPersistence({
      transitionToProcessing: vi.fn().mockResolvedValue({ changed: false, status: "processing" }),
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

  it("retries confirmed persistence after its first failure", async () => {
    const transitionToProcessing = vi
      .fn()
      .mockResolvedValueOnce(processingTransition)
      .mockResolvedValueOnce({ changed: false, status: "processing" });
    const persistenceError = new Error("confirmed persistence unavailable");
    const transitionToConfirmed = vi
      .fn()
      .mockRejectedValueOnce(persistenceError)
      .mockResolvedValueOnce(confirmedTransition);
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

  it("does not mark accepted ERP confirmations failed when local attempt persistence fails", async () => {
    const localPersistenceError = new Error("attempt persistence unavailable");
    const confirmationError = new ErpAcceptedConfirmationPersistenceError(localPersistenceError, {
      job,
      delivery: { attemptNumber: 3, attemptsMade: 2 },
      status: "succeeded",
      terminal: true,
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
    });

    await expect(handler.handle(job, { attemptNumber: 3, attemptsMade: 2 })).rejects.toBe(
      confirmationError,
    );

    expect(persistence.transitionToFailed).not.toHaveBeenCalled();
    expect(persistence.transitionToConfirmed).not.toHaveBeenCalled();
  });

  it("hands accepted ERP persistence failures to recovery", async () => {
    const confirmationError = new ErpAcceptedConfirmationPersistenceError(
      new Error("attempt persistence unavailable"),
      {
        job,
        delivery: { attemptNumber: 4, attemptsMade: 3 },
        status: "succeeded",
        terminal: true,
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

    await expect(handler.handle(job, { attemptNumber: 4, attemptsMade: 3 })).rejects.toBe(
      confirmationError,
    );

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
      terminal: true,
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

    await expect(handler.handle(job, { ...delivery })).rejects.toBe(transitionError);
    expect(recovery.handoff).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "confirmed_transition_persistence_unavailable",
        accepted: true,
      }),
    );
    expect(persistence.transitionToFailed).not.toHaveBeenCalled();
  });

  it.each([
    "confirmed",
    "failed",
  ] as const)("acknowledges a terminal %s replay without confirmation", async (status) => {
    const persistence = createPersistence({
      transitionToProcessing: vi.fn().mockResolvedValue({ changed: false, status }),
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

  it("terminally fails a non-transient ERP error as technical", async () => {
    const persistence = createPersistence();
    const handler = createOrderProcessJobHandler({
      confirmation: {
        confirm: vi.fn().mockResolvedValue({
          disposition: "technical_failure",
          errorCode: "erp_authentication_failed",
          errorMessage: "Authentication failed",
        }),
      },
      persistence,
      logger: createSilentLogger("worker"),
    });

    await handler.handle(job, delivery);

    expect(persistence.transitionToFailed).toHaveBeenCalledWith(
      job,
      {
        code: "erp_authentication_failed",
        message: "Authentication failed",
      },
      delivery,
    );
    expect(persistence.transitionToConfirmed).not.toHaveBeenCalled();
  });

  it("leaves processing orders retryable after temporary confirmation failures", async () => {
    const confirmationError = Object.assign(new Error("ERP temporarily unavailable"), {
      attemptRecorded: true,
    });
    const persistence = createPersistence();
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockRejectedValue(confirmationError) },
      persistence,
      logger: createSilentLogger("worker"),
    });

    await expect(handler.handle(job, { attemptNumber: 1, attemptsMade: 0 })).rejects.toBe(
      confirmationError,
    );

    expect(persistence.transitionToFailed).not.toHaveBeenCalled();
    expect(persistence.transitionToConfirmed).not.toHaveBeenCalled();
  });

  it("publishes a retrying business outcome update after durable deferral", async () => {
    const publishBusinessOutcomeUpdate = vi.fn().mockResolvedValue(undefined);
    const handler = createOrderProcessJobHandler({
      confirmation: {
        confirm: vi.fn().mockResolvedValue({ disposition: "deferred", reason: "erp_unavailable" }),
      },
      persistence: createPersistence(),
      logger: createSilentLogger("worker"),
      publishBusinessOutcomeUpdate,
    });

    await handler.handle(job, { attemptNumber: 1, attemptsMade: 0 });

    expect(publishBusinessOutcomeUpdate).toHaveBeenCalledWith(job, "retrying");
  });

  it("publishes a failed business outcome update after a technical failure", async () => {
    const publishBusinessOutcomeUpdate = vi.fn().mockResolvedValue(undefined);
    const handler = createOrderProcessJobHandler({
      confirmation: {
        confirm: vi.fn().mockResolvedValue({
          disposition: "technical_failure",
          errorCode: "erp_authentication_failed",
          errorMessage: "Authentication failed",
        }),
      },
      persistence: createPersistence(),
      logger: createSilentLogger("worker"),
      publishBusinessOutcomeUpdate,
    });

    await handler.handle(job, delivery);

    expect(publishBusinessOutcomeUpdate).toHaveBeenCalledWith(job, "processing");
    expect(publishBusinessOutcomeUpdate).toHaveBeenCalledWith(job, "failed");
  });

  it("does not dirty business outcomes for terminal persistence no-ops", async () => {
    const terminalPublish = vi.fn().mockResolvedValue(undefined);
    const terminalHandler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
      persistence: createPersistence({
        transitionToProcessing: vi.fn().mockResolvedValue({ changed: false, status: "processing" }),
        transitionToConfirmed: vi.fn().mockResolvedValue({ changed: false, status: "confirmed" }),
      }),
      logger: createSilentLogger("worker"),
      publishBusinessOutcomeUpdate: terminalPublish,
    });
    await terminalHandler.handle(job, delivery);
    expect(terminalPublish).not.toHaveBeenCalled();
  });

  it("retains temporary confirmation failures without an attempt budget", async () => {
    const persistence = createPersistence();
    const handler = createOrderProcessJobHandler({
      confirmation: {
        confirm: vi.fn().mockResolvedValue({ disposition: "deferred", reason: "erp_unavailable" }),
      },
      persistence,
      logger: createSilentLogger("worker"),
    });

    await handler.handle(job, { attemptNumber: 1, attemptsMade: 0 });
    expect(persistence.transitionToFailed).not.toHaveBeenCalled();
  });

  it("preserves confirmation and failure-persistence errors together", async () => {
    const confirmationError = {
      disposition: "technical_failure" as const,
      errorCode: "erp_authentication_failed",
      errorMessage: "Authentication failed",
    };
    const persistenceError = new Error("database unavailable");
    const persistence = createPersistence({
      transitionToFailed: vi.fn().mockRejectedValue(persistenceError),
    });
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue(confirmationError) },
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
