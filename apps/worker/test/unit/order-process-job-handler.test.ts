import type { OrderProcessJob } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { ErpCircuitOpenError } from "../../src/application/erp-circuit-breaker.js";
import {
  ErpAcceptedConfirmationPersistenceError,
  isErpAttemptPersistenceError,
} from "../../src/application/erp-confirmation-client.js";
import {
  createOrderProcessJobHandler as createProductionOrderProcessJobHandler,
  hasRemainingAttempts,
  OrderFailurePersistenceError,
  OrderProcessingPersistenceError,
  type OrderRecoveryHandoff,
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
const processingTransition = {
  changed: true as const,
  eventId: "66666666-6666-4666-8666-666666666666",
  previousStatus: "queued" as const,
  status: "processing" as const,
  occurredAt: new Date("2026-06-21T00:00:00.010Z"),
  queuedAt: new Date(job.queuedAt),
};
const confirmedTransition = {
  changed: true as const,
  eventId: "77777777-7777-4777-8777-777777777777",
  previousStatus: "processing" as const,
  status: "confirmed" as const,
  occurredAt: new Date("2026-06-21T00:00:00.100Z"),
  confirmedAt: new Date("2026-06-21T00:00:00.100Z"),
  queuedAt: new Date(job.queuedAt),
};
const failedTransition = {
  changed: true as const,
  eventId: "88888888-8888-4888-8888-888888888888",
  previousStatus: "processing" as const,
  status: "failed" as const,
  occurredAt: new Date("2026-06-21T00:00:00.100Z"),
  queuedAt: new Date(job.queuedAt),
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
    | "publishBusinessOutcomeUpdate"
    | "notificationRecordPublisher"
    | "recovery"
    | "realtimePublisher"
  > &
    Partial<
      Pick<
        OrderProcessJobHandlerDependencies,
        "publishBusinessOutcomeUpdate" | "notificationRecordPublisher" | "realtimePublisher"
      >
    > & { recovery?: Partial<OrderRecoveryHandoff> },
) {
  const { recovery, ...overrides } = dependencies;
  return createProductionOrderProcessJobHandler({
    publishBusinessOutcomeUpdate: async () => undefined,
    notificationRecordPublisher: { publishForConfirmedOrder: async () => undefined },
    realtimePublisher: { enqueue: () => undefined },
    ...overrides,
    recovery: {
      handoff: async () => undefined,
      resolve: async () => undefined,
      ...recovery,
    },
  });
}

describe("order-process application workflow", () => {
  it("proves remaining attempts only when a known maximum exceeds the current attempt", () => {
    expect(hasRemainingAttempts({ attemptNumber: 1, attemptsMade: 0, maxAttempts: 2 })).toBe(true);
    expect(hasRemainingAttempts({ attemptNumber: 2, attemptsMade: 1, maxAttempts: 2 })).toBe(false);
    expect(hasRemainingAttempts({ attemptNumber: 1, attemptsMade: 0 })).toBe(false);
  });

  it("enqueues durable processing plus a linked confirmation/lag pair and reuses confirmedAt for notification", async () => {
    const enqueue = vi.fn();
    const notificationRecordPublisher = {
      publishForConfirmedOrder: vi.fn().mockResolvedValue(undefined),
    };
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
      persistence: createPersistence(),
      logger: createSilentLogger("worker"),
      realtimePublisher: { enqueue },
      notificationRecordPublisher,
    });

    await handler.handle(job, delivery);

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        eventId: processingTransition.eventId,
        eventName: "order.processing",
        occurredAt: processingTransition.occurredAt.toISOString(),
      }),
    ]);
    expect(enqueue.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({
        eventId: confirmedTransition.eventId,
        eventName: "order.confirmed",
        occurredAt: confirmedTransition.confirmedAt.toISOString(),
      }),
      expect.objectContaining({
        confirmedTransitionEventId: confirmedTransition.eventId,
        value: 100,
        startedAt: job.queuedAt,
        confirmedAt: confirmedTransition.confirmedAt.toISOString(),
      }),
    ]);
    expect(notificationRecordPublisher.publishForConfirmedOrder).toHaveBeenCalledWith(
      job,
      confirmedTransition.confirmedAt.toISOString(),
    );
  });

  it("clamps and reports a backwards durable clock while retaining a zero-valued point", async () => {
    const backwards = {
      ...confirmedTransition,
      occurredAt: new Date("2026-06-20T23:59:59.000Z"),
      confirmedAt: new Date("2026-06-20T23:59:59.000Z"),
    };
    const enqueue = vi.fn();
    const reportConsistencyLagClockAnomaly = vi.fn();
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
      persistence: createPersistence({
        transitionToConfirmed: vi.fn().mockResolvedValue(backwards),
      }),
      logger: createSilentLogger("worker"),
      realtimePublisher: { enqueue },
      reportConsistencyLagClockAnomaly,
    });

    await expect(handler.handle(job, delivery)).resolves.toBeUndefined();
    expect(reportConsistencyLagClockAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({ rawLagMs: -1_000, clampedLagMs: 0 }),
    );
    expect(enqueue.mock.calls[1]?.[0]?.[1]).toEqual(expect.objectContaining({ value: 0 }));
  });

  it("emits zero for equal timestamps with a stable unique metric identity", async () => {
    const equal = {
      ...confirmedTransition,
      occurredAt: new Date(job.queuedAt),
      confirmedAt: new Date(job.queuedAt),
    };
    type PublishedEvent = {
      eventId: string;
      confirmedTransitionEventId?: string;
      value?: number;
    };
    const eventGroups: Array<readonly PublishedEvent[]> = [];
    for (let index = 0; index < 2; index += 1) {
      const enqueue = vi.fn((events: readonly PublishedEvent[]) => eventGroups.push(events));
      await createOrderProcessJobHandler({
        confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
        persistence: createPersistence({ transitionToConfirmed: vi.fn().mockResolvedValue(equal) }),
        logger: createSilentLogger("worker"),
        realtimePublisher: { enqueue },
      }).handle(job, delivery);
    }
    const firstPair = eventGroups[1];
    const secondPair = eventGroups[3];
    if (!firstPair || !secondPair) throw new Error("Expected two realtime event pairs.");
    expect(firstPair[1]).toMatchObject({ value: 0, confirmedTransitionEventId: equal.eventId });
    expect(firstPair[1]?.eventId).not.toBe(equal.eventId);
    expect(secondPair[1]?.eventId).toBe(firstPair[1]?.eventId);
  });

  it("contains realtime enqueue failure without changing a confirmed job outcome", async () => {
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
      persistence: createPersistence(),
      logger: createSilentLogger("worker"),
      realtimePublisher: {
        enqueue: vi.fn(() => {
          throw new Error("queue unavailable");
        }),
      },
    });
    await expect(handler.handle(job, delivery)).resolves.toBeUndefined();
  });

  it("does not enqueue realtime events when the initial transition rolls back", async () => {
    const enqueue = vi.fn();
    const persistenceError = new Error("transaction rolled back");
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn() },
      persistence: createPersistence({
        transitionToProcessing: vi.fn().mockRejectedValue(persistenceError),
      }),
      logger: createSilentLogger("worker"),
      realtimePublisher: { enqueue },
    });

    await expect(handler.handle(job, delivery)).rejects.toBeInstanceOf(
      OrderProcessingPersistenceError,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("completes after confirmed enqueue failure and terminal redelivery emits nothing", async () => {
    const confirmation = { confirm: vi.fn().mockResolvedValue(undefined) };
    const transitionToProcessing = vi
      .fn()
      .mockResolvedValueOnce(processingTransition)
      .mockResolvedValueOnce({ changed: false, status: "confirmed" });
    const transitionToConfirmed = vi.fn().mockResolvedValue(confirmedTransition);
    const enqueue = vi.fn((events: readonly unknown[]) => {
      if (events.length === 2) throw new Error("publication boundary unavailable");
    });
    const handler = createOrderProcessJobHandler({
      confirmation,
      persistence: createPersistence({ transitionToProcessing, transitionToConfirmed }),
      logger: createSilentLogger("worker"),
      realtimePublisher: { enqueue },
    });

    await expect(handler.handle(job, delivery)).resolves.toBeUndefined();
    await expect(handler.handle(job, delivery)).resolves.toBeUndefined();
    expect(confirmation.confirm).toHaveBeenCalledOnce();
    expect(transitionToConfirmed).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(
      enqueue.mock.calls
        .flatMap(([events]) => events)
        .map((event) => (event as { eventId: string }).eventId),
    ).toEqual([
      processingTransition.eventId,
      confirmedTransition.eventId,
      expect.not.stringMatching(`^${confirmedTransition.eventId}$`),
    ]);
  });

  it("emits exactly one failed status for a fresh terminal failure", async () => {
    const confirmationError = new Error("ERP rejected");
    const enqueue = vi.fn();
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockRejectedValue(confirmationError) },
      persistence: createPersistence(),
      logger: createSilentLogger("worker"),
      realtimePublisher: { enqueue },
    });
    await expect(handler.handle(job, delivery)).rejects.toBe(confirmationError);
    expect(
      enqueue.mock.calls
        .flatMap(([events]) => events)
        .filter((event) => event.eventName === "order.failed"),
    ).toHaveLength(1);
  });

  it("does not emit status for resumed retryable processing or terminal redelivery", async () => {
    const retryError = new Error("temporary ERP failure");
    const retryEnqueue = vi.fn();
    await expect(
      createOrderProcessJobHandler({
        confirmation: { confirm: vi.fn().mockRejectedValue(retryError) },
        persistence: createPersistence({
          transitionToProcessing: vi
            .fn()
            .mockResolvedValue({ changed: false, status: "processing" }),
        }),
        logger: createSilentLogger("worker"),
        realtimePublisher: { enqueue: retryEnqueue },
        isTemporaryConfirmationFailure: () => true,
      }).handle(job, { ...delivery, maxAttempts: 4 }),
    ).rejects.toBe(retryError);
    expect(retryEnqueue).not.toHaveBeenCalled();

    const terminalEnqueue = vi.fn();
    const confirmation = { confirm: vi.fn() };
    await createOrderProcessJobHandler({
      confirmation,
      persistence: createPersistence({
        transitionToProcessing: vi.fn().mockResolvedValue({ changed: false, status: "confirmed" }),
      }),
      logger: createSilentLogger("worker"),
      realtimePublisher: { enqueue: terminalEnqueue },
    }).handle(job, delivery);
    expect(confirmation.confirm).not.toHaveBeenCalled();
    expect(terminalEnqueue).not.toHaveBeenCalled();
  });

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
    const transitionToConfirmed = vi.fn().mockResolvedValue(confirmedTransition);
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

  it("reuses a successful ERP confirmation when confirmed persistence fails", async () => {
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
    const confirmationError = Object.assign(new Error("ERP temporarily unavailable"), {
      attemptRecorded: true,
    });
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

  it("fails temporary confirmation conservatively when the maximum attempt count is unknown", async () => {
    const confirmationError = new Error("ERP maximum attempt count unavailable");
    const unknownMaximumDelivery = { attemptNumber: 1, attemptsMade: 0 };
    const persistence = createPersistence();
    const handler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockRejectedValue(confirmationError) },
      persistence,
      logger: createSilentLogger("worker"),
      isTemporaryConfirmationFailure: () => true,
    });

    await expect(handler.handle(job, unknownMaximumDelivery)).rejects.toBe(confirmationError);

    expect(persistence.transitionToFailed).toHaveBeenCalledWith(
      job,
      {
        code: "erp_retries_exhausted",
        message: "ERP maximum attempt count unavailable",
      },
      unknownMaximumDelivery,
    );
    expect(persistence.transitionToConfirmed).not.toHaveBeenCalled();
  });

  it("publishes a retrying business outcome update before retrying temporary confirmation failures", async () => {
    const confirmationError = Object.assign(new Error("ERP temporarily unavailable"), {
      attemptRecorded: true,
    });
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

  it("does not dirty business outcomes for detected retry and terminal persistence no-ops", async () => {
    const retryError = Object.assign(new Error("replayed attempt"), { attemptRecorded: false });
    const retryPublish = vi.fn().mockResolvedValue(undefined);
    const retryHandler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockRejectedValue(retryError) },
      persistence: createPersistence({
        transitionToProcessing: vi.fn().mockResolvedValue({ changed: false, status: "processing" }),
      }),
      logger: createSilentLogger("worker"),
      shouldRetryWithoutFailingOrder: () => true,
      publishBusinessOutcomeUpdate: retryPublish,
    });
    await expect(retryHandler.handle(job, { ...delivery, maxAttempts: 4 })).rejects.toBe(
      retryError,
    );
    expect(retryPublish).not.toHaveBeenCalled();

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
