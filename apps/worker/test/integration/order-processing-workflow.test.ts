import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AcceptedRunConfigSnapshot,
  destructiveResetReasonValues,
  emptyHttpTimingBreakdownSummary,
  emptyRequestArrivalSummary,
  erpAttemptHistoryRetentionLimit,
  type NotificationRecordJob,
  notificationRecordBullMqQueueName,
  type notificationRecordJobName,
  type OrderProcessJob,
  orderProcessBullMqQueueName,
  orderProcessJobName,
  type TrafficCompletionReport,
  trafficDeliverySummarySchema,
} from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  demoPresets,
  demoRunFinalizations,
  demoRunSaleContexts,
  demoRunSummaries,
  demoRuns,
  erpAttempts,
  erpDispatchCalls,
  getInventoryStatus,
  initializeInventory,
  inventoryKeys,
  markReservationPendingPersistence,
  orderDeadLetters,
  orderEvents,
  orderRecoveryJobs,
  orders,
  products,
  promoteReservationIdempotencyToAccepted,
  purgeResetRunDurable,
  reservations,
  reserveInventoryStock,
  runSaleEligibilityKey,
  saleOffers,
  simulatedNotifications,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { Queue } from "bullmq";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoRunFinalizationService } from "../../../api/src/services/demo-run-finalization-service.js";
import { PostgresBuyPersistence } from "../../../api/src/services/postgres-buy-persistence.js";
import { ReserveOrderService } from "../../../api/src/services/reserve-order-service.js";
import { PostgresTerminalDemoRunSummaryWriter } from "../../../api/src/services/terminal-demo-run-transition.js";
import { HttpErpOrderConfirmation } from "../../src/application/erp-confirmation-client.js";
import {
  ErpUnresolvedCallReconciler,
  ScheduledErpOrderConfirmation,
} from "../../src/application/erp-reconciliation.js";
import { createNotificationRecordJobHandler as createProductionNotificationRecordJobHandler } from "../../src/application/notification-record-job-handler.js";
import { createNotificationRecoveryScanner } from "../../src/application/notification-recovery-scanner.js";
import { createOrderDispatchScanner } from "../../src/application/order-dispatch-scanner.js";
import { AdaptiveErpRuntimeAdmission } from "../../src/application/order-process-admission.js";
import {
  createOrderProcessJobHandler as createProductionOrderProcessJobHandler,
  type OrderConfirmation,
} from "../../src/application/order-process-job-handler.js";
import { createOrderRecoveryScanner } from "../../src/application/order-recovery-scanner.js";
import { PostgresErpAttemptPersistence } from "../../src/persistence/postgres-erp-attempt-persistence.js";
import { PostgresErpScopeResiliencePersistence } from "../../src/persistence/postgres-erp-scope-resilience-persistence.js";
import { PostgresGeneratedRunPublicationFence } from "../../src/persistence/postgres-generated-run-publication-fence.js";
import {
  NotificationBeforeConfirmationError,
  PostgresNotificationRecordPersistence,
} from "../../src/persistence/postgres-notification-record-persistence.js";
import { PostgresNotificationRecoveryPersistence } from "../../src/persistence/postgres-notification-recovery-persistence.js";
import { PostgresOrderDispatchPersistence } from "../../src/persistence/postgres-order-dispatch-persistence.js";
import { PostgresOrderRecoveryPersistence } from "../../src/persistence/postgres-order-recovery-persistence.js";
import {
  OrderJobIdentityMismatchError,
  OrderNotFoundError,
  PostgresOrderTransitionPersistence,
} from "../../src/persistence/postgres-order-transition-persistence.js";
import { PostgresRunConfigReader } from "../../src/persistence/postgres-run-config-reader.js";
import { createBullMqNotificationRecordConsumer } from "../../src/queue/bullmq-notification-record-consumer.js";
import { createBullMqNotificationRecordPublisher } from "../../src/queue/bullmq-notification-record-publisher.js";
import { createBullMqOrderProcessJobPublisher } from "../../src/queue/bullmq-order-process-job-publisher.js";
import type { OrderProcessConsumer } from "../../src/queue/order-process-consumer.js";
import { createBullMqOrderProcessConsumer } from "./order-process-consumer-test-helper.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = path.resolve(packageRoot, "../../packages/db/drizzle");
const ids = {
  product: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  preset: "33333333-3333-4333-8333-333333333331",
  run: "55555555-5555-4555-8555-555555555555",
  saleOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  reservation: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  order: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
} as const;
const queuedAt = new Date("2026-06-21T00:00:00.000Z");
const job: OrderProcessJob = {
  orderId: ids.order,
  publicOrderId: "ord_worker_integration",
  reservationId: ids.reservation,
  saleOfferId: ids.saleOffer,
  correlationId: "corr-worker-integration",
  quantity: 1,
  queuedAt: queuedAt.toISOString(),
  processingGeneration: 0,
};
const runScopedJob: OrderProcessJob = {
  ...job,
  runId: ids.run,
};
const freshIds = {
  reservation: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  order: "ffffffff-ffff-4fff-8fff-ffffffffffff",
} as const;
const freshJob: OrderProcessJob = {
  ...job,
  orderId: freshIds.order,
  reservationId: freshIds.reservation,
  publicOrderId: "ord_worker_fresh",
  correlationId: "corr-worker-fresh",
};
const capacityJobs: OrderProcessJob[] = [
  job,
  ...[1, 2, 3].map((index) => ({
    ...job,
    orderId: `10000000-0000-4000-8000-00000000000${index}`,
    reservationId: `20000000-0000-4000-8000-00000000000${index}`,
    publicOrderId: `ord_worker_capacity_${index}`,
    correlationId: `corr-worker-capacity-${index}`,
  })),
];

type HandlerDependencies = Parameters<typeof createProductionOrderProcessJobHandler>[0];

function createOrderProcessJobHandler(
  dependencies: Omit<
    HandlerDependencies,
    "publishBusinessOutcomeUpdate" | "notificationRecordPublisher" | "recovery"
  > &
    Partial<
      Pick<HandlerDependencies, "publishBusinessOutcomeUpdate" | "notificationRecordPublisher">
    >,
) {
  return createProductionOrderProcessJobHandler({
    publishBusinessOutcomeUpdate: async () => undefined,
    notificationRecordPublisher: { publishForConfirmedOrder: async () => undefined },
    recovery: { handoff: async () => undefined, resolve: async () => undefined },
    ...dependencies,
  });
}

function createNotificationRecordJobHandler(
  dependencies: Omit<
    Parameters<typeof createProductionNotificationRecordJobHandler>[0],
    "publishBusinessOutcomeUpdate"
  > &
    Partial<
      Pick<
        Parameters<typeof createProductionNotificationRecordJobHandler>[0],
        "publishBusinessOutcomeUpdate"
      >
    >,
) {
  return createProductionNotificationRecordJobHandler({
    publishBusinessOutcomeUpdate: async () => undefined,
    ...dependencies,
  });
}

function requireTestEnv(name: "TEST_DATABASE_URL" | "TEST_REDIS_URL"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for worker integration tests.`);
  }
  return value;
}

describe("PostgreSQL worker order transitions", () => {
  const databaseUrl = requireTestEnv("TEST_DATABASE_URL");
  let connection!: ReturnType<typeof createDatabaseConnection>;

  beforeAll(async () => {
    await resetTestDatabase({ databaseUrl, migrationsFolder });
    connection = createDatabaseConnection(databaseUrl, { max: 8 });
  });

  beforeEach(async () => {
    await resetTestDatabase({ databaseUrl, migrationsFolder });
    await seedQueuedOrder(connection);
  });

  afterAll(async () => {
    await connection?.close();
  });

  it.each([
    "succeeded",
    "unknown",
  ] as const)("settles a %s lookup when recovery publication loses the accepted snapshot", async (lookupStatus) => {
    await resetTestDatabase({ databaseUrl, migrationsFolder });
    await seedQueuedOrder(connection, { runScoped: true });
    const control = new PostgresOrderRecoveryPersistence(connection.db);
    const transitions = new PostgresOrderTransitionPersistence(connection.db);
    const attempts = new PostgresErpAttemptPersistence(connection.db);
    const delivery = { attemptNumber: 1, attemptsMade: 0, maxAttempts: 1 };
    await transitions.transitionToProcessing(runScopedJob, delivery);
    await attempts.recordDispatchIntent({
      job: runScopedJob,
      idempotencyKey: `erp-confirmation:${job.orderId}`,
      dispatchedAt: new Date(),
      expectedProcessingGeneration: 0,
    });
    await control.defer({
      orderId: job.orderId,
      waitingReason: "uncertain_result",
      nextEligibleAt: new Date(),
      processingGeneration: 0,
    });
    await connection.db
      .update(demoRuns)
      .set({ configSnapshot: sql`'{}'::jsonb` })
      .where(eq(demoRuns.id, ids.run));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        lookup:
          lookupStatus === "unknown"
            ? { status: "unknown", idempotencyKey: `erp-confirmation:${job.orderId}` }
            : {
                status: "succeeded",
                identity: {
                  orderId: job.orderId,
                  publicOrderId: job.publicOrderId,
                  reservationId: job.reservationId,
                  saleOfferId: job.saleOfferId,
                  runId: ids.run,
                  quantity: job.quantity,
                  idempotencyKey: `erp-confirmation:${job.orderId}`,
                },
                result: {
                  status: "succeeded",
                  confirmationId: "erp_recovered",
                  httpStatus: 200,
                  latencyMs: 1,
                  timestamp: new Date().toISOString(),
                },
              },
        timestamp: new Date().toISOString(),
      }),
    );
    const client = new HttpErpOrderConfirmation({
      baseUrl: "http://mock-erp:4100",
      requestTimeoutMs: 1000,
      retryAfterPolicy: { fallbackDelayMs: 1000, maximumDelayMs: 60000 },
      attemptPersistence: attempts,
      fetch,
    });
    const publishForConfirmedOrder = vi.fn().mockResolvedValue(undefined);
    const handler = createOrderProcessJobHandler({
      confirmation: scheduledConfirmation(connection, client, 2),
      persistence: transitions,
      logger: createSilentLogger("worker"),
      notificationRecordPublisher: { publishForConfirmedOrder },
    });
    const corruption = new Error("invalid snapshot");
    corruption.name = "PersistedRunConfigCorruptionError";
    const scanner = createOrderRecoveryScanner({
      persistence: control,
      handler,
      publisher: { enqueue: vi.fn().mockRejectedValue(corruption) },
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1000,
      batchSize: 10,
      failedJobReader: { findFailedOrderJobs: async () => [] },
    });

    await scanner.scanOnce();
    await scanner.scanOnce();
    const [order] = await connection.db.select().from(orders).where(eq(orders.id, job.orderId));
    if (lookupStatus === "unknown") {
      expect(order).toMatchObject({
        status: "failed",
        failureCategory: "technical",
        failureCode: "accepted_run_snapshot_invalid",
      });
      expect(await control.readControlRecord({ orderId: job.orderId })).toMatchObject({
        status: "resolved",
        unresolvedErpCallId: null,
        nextAttemptAt: null,
      });
      expect(await attempts.findUnresolvedCall(job.orderId)).toBeNull();
      expect(
        await control.findRecoverable({ limit: 10, now: new Date(Date.now() + 60000) }),
      ).toEqual([]);
    } else {
      expect(order?.status).toBe("confirmed");
    }
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(publishForConfirmedOrder).toHaveBeenCalledTimes(lookupStatus === "succeeded" ? 1 : 0);
  });

  it.each([
    "authentication",
    "authorization",
    "contract",
    "identity",
    "attempt",
  ])("settles durable uncertainty after a terminal lookup %s failure", async (failure) => {
    const control = new PostgresOrderRecoveryPersistence(connection.db);
    const transitions = new PostgresOrderTransitionPersistence(connection.db);
    const attempts = new PostgresErpAttemptPersistence(connection.db);
    const delivery = { attemptNumber: 1, attemptsMade: 0, maxAttempts: 1 };
    await transitions.transitionToProcessing(job, delivery);
    const call = await attempts.recordDispatchIntent({
      job,
      idempotencyKey: `erp-confirmation:${job.orderId}`,
      dispatchedAt: new Date(),
      expectedProcessingGeneration: 0,
    });
    await control.defer({
      orderId: job.orderId,
      waitingReason: "uncertain_result",
      nextEligibleAt: new Date(),
      processingGeneration: 0,
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      failure === "authentication" || failure === "authorization"
        ? new Response("denied", { status: failure === "authentication" ? 401 : 403 })
        : failure === "contract"
          ? Response.json({ invalid: true })
          : Response.json({
              lookup: {
                status: "succeeded",
                identity: {
                  orderId: job.orderId,
                  publicOrderId: job.publicOrderId,
                  reservationId: job.reservationId,
                  saleOfferId: job.saleOfferId,
                  quantity: failure === "identity" ? 2 : job.quantity,
                  idempotencyKey: call.idempotencyKey,
                },
                result: {
                  status: "succeeded",
                  confirmationId: "erp_lookup",
                  httpStatus: 200,
                  latencyMs: 1,
                  timestamp: new Date().toISOString(),
                },
              },
              timestamp: new Date().toISOString(),
            }),
    );
    const client = new HttpErpOrderConfirmation({
      baseUrl: "http://mock-erp:4100",
      requestTimeoutMs: 1000,
      retryAfterPolicy: { fallbackDelayMs: 1000, maximumDelayMs: 60000 },
      attemptPersistence: attempts,
      fetch,
    });
    if (failure === "attempt") {
      await attempts.recordAttempt({
        job,
        delivery: { ...delivery, attemptNumber: 1, deliveryId: `erp-lookup:${call.erpCallId}` },
        operation: "status_lookup",
        disposition: "temporarily_unavailable",
        status: "failed",
        terminal: false,
        latencyMs: 1,
        startedAt: new Date(),
        finishedAt: new Date(),
      });
    }
    const claim = await control.claimForPublication({
      recoveryKey: `order:${job.orderId}`,
      now: new Date(),
      leaseMs: 30000,
    });
    if (!claim) throw new Error("Expected recovery claim");
    const handler = createOrderProcessJobHandler({
      confirmation: scheduledConfirmation(connection, client, 2),
      persistence: transitions,
      logger: createSilentLogger("worker"),
    });
    await handler.handle(
      { ...job, processingGeneration: claim.processingGeneration },
      { ...delivery, deliveryId: claim.jobId, processingGeneration: claim.processingGeneration },
    );

    expect(
      (await connection.db.select().from(orders).where(eq(orders.id, job.orderId)))[0],
    ).toMatchObject({
      status: "failed",
      failureCategory: "technical",
      failureCode: {
        authentication: "erp_authentication_failed",
        authorization: "erp_authorization_failed",
        contract: "erp_response_contract_invalid",
        identity: "erp_lookup_identity_contradiction",
        attempt: "erp_attempt_contradiction",
      }[failure],
    });
    expect(await control.readControlRecord({ orderId: job.orderId })).toMatchObject({
      status: "resolved",
      unresolvedErpCallId: null,
    });
    expect(await attempts.findUnresolvedCall(job.orderId)).toBeNull();
    expect(
      (
        await connection.db
          .select()
          .from(erpDispatchCalls)
          .where(eq(erpDispatchCalls.id, call.erpCallId))
      )[0]?.resolvedAt,
    ).toBeInstanceOf(Date);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reuses a persisted technical failure after the terminal transition fails", async () => {
    const control = new PostgresOrderRecoveryPersistence(connection.db);
    const transitions = new PostgresOrderTransitionPersistence(connection.db);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("denied", { status: 401 }));
    const client = new HttpErpOrderConfirmation({
      baseUrl: "http://mock-erp:4100",
      requestTimeoutMs: 1000,
      retryAfterPolicy: { fallbackDelayMs: 1000, maximumDelayMs: 60000 },
      attemptPersistence: new PostgresErpAttemptPersistence(connection.db),
      fetch,
    });
    const handler = createProductionOrderProcessJobHandler({
      confirmation: scheduledConfirmation(connection, client, 2),
      persistence: transitions,
      logger: createSilentLogger("worker"),
      recovery: {
        handoff: (input) => control.recordRecoverable(input),
        resolve: (input) => control.markResolved(input),
      },
      publishBusinessOutcomeUpdate: async () => undefined,
      notificationRecordPublisher: { publishForConfirmedOrder: vi.fn() },
    });
    vi.spyOn(transitions, "transitionToFailed").mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const delivery = { attemptNumber: 1, attemptsMade: 0, maxAttempts: 1 };
    await expect(handler.handle(job, delivery)).rejects.toThrow(
      "terminal failure could not be persisted",
    );
    const persisted = await new PostgresErpAttemptPersistence(connection.db).findTechnicalFailure(
      job,
    );
    expect(persisted?.errorCode).toBe("erp_authentication_failed");
    const claim = await control.claimForPublication({
      recoveryKey: `order:${job.orderId}`,
      now: new Date(Date.now() + 60000),
      leaseMs: 30000,
    });
    if (!claim) throw new Error("Expected recovery claim");
    await handler.handle(
      { ...job, processingGeneration: claim.processingGeneration },
      { ...delivery, deliveryId: claim.jobId, processingGeneration: claim.processingGeneration },
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      (await connection.db.select().from(orders).where(eq(orders.id, job.orderId)))[0],
    ).toMatchObject({
      status: "failed",
      failureCode: persisted?.errorCode,
      failureMessage: persisted?.errorMessage,
    });
  });

  it("atomically persists processing and confirmation with exact durable history", async () => {
    const times = [new Date("2026-06-21T00:00:01.000Z"), new Date("2026-06-21T00:00:02.000Z")];
    const persistence = new PostgresOrderTransitionPersistence(connection.db, () => {
      const time = times.shift();
      if (!time) throw new Error("Unexpected clock read");
      return time;
    });

    const processingTransition = await persistence.transitionToProcessing(job, {
      attemptNumber: 2,
      attemptsMade: 1,
      maxAttempts: 4,
    });
    expect(processingTransition).toMatchObject({
      changed: true,
      status: "processing",
    });
    const confirmedTransition = await persistence.transitionToConfirmed(job, {
      attemptNumber: 2,
      attemptsMade: 1,
      maxAttempts: 4,
    });
    expect(confirmedTransition).toMatchObject({
      changed: true,
      status: "confirmed",
      confirmedAt: new Date("2026-06-21T00:00:02.000Z"),
    });

    const [order] = await connection.db.select().from(orders).where(eq(orders.id, ids.order));
    const events = await readOrderEvents(connection, ids.order);
    if (!processingTransition.changed || !confirmedTransition.changed) {
      throw new Error("Expected fresh durable transitions.");
    }

    expect(order).toMatchObject({
      status: "confirmed",
      processingAt: new Date("2026-06-21T00:00:01.000Z"),
      confirmedAt: new Date("2026-06-21T00:00:02.000Z"),
      failedAt: null,
      failureCode: null,
      failureMessage: null,
    });
    expect(events.map((event) => event.eventName)).toEqual([
      "reservation.secured",
      "order.queued",
      "order.processing",
      "order.confirmed",
    ]);
    expect(events.slice(2)).toMatchObject([
      {
        orderId: ids.order,
        reservationId: ids.reservation,
        saleOfferId: ids.saleOffer,
        runId: null,
        correlationId: job.correlationId,
        source: "worker",
        occurredAt: new Date("2026-06-21T00:00:01.000Z"),
        payload: { attemptNumber: 2, attemptsMade: 1 },
      },
      {
        orderId: ids.order,
        reservationId: ids.reservation,
        saleOfferId: ids.saleOffer,
        runId: null,
        correlationId: job.correlationId,
        source: "worker",
        occurredAt: new Date("2026-06-21T00:00:02.000Z"),
        payload: { attemptNumber: 2, attemptsMade: 1 },
      },
    ]);
    expect(confirmedTransition.confirmedAt).toEqual(order?.confirmedAt);
  });

  it("rolls back the status when matching event insertion fails", async () => {
    await connection.sql.unsafe(`
      CREATE FUNCTION reject_processing_event() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_name = 'order.processing' THEN
          RAISE EXCEPTION 'processing event rejected';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_processing_event_trigger
      BEFORE INSERT ON order_events
      FOR EACH ROW EXECUTE FUNCTION reject_processing_event();
    `);
    const persistence = new PostgresOrderTransitionPersistence(connection.db);

    try {
      await expect(
        persistence.transitionToProcessing(job, {
          attemptNumber: 1,
          attemptsMade: 0,
          maxAttempts: 1,
        }),
      ).rejects.toThrow();
      const [order] = await connection.db.select().from(orders).where(eq(orders.id, ids.order));
      const processingEvents = await connection.db
        .select()
        .from(orderEvents)
        .where(
          and(eq(orderEvents.orderId, ids.order), eq(orderEvents.eventName, "order.processing")),
        );

      expect(order?.status).toBe("queued");
      expect(order?.processingAt).toBeNull();
      expect(processingEvents).toHaveLength(0);
    } finally {
      await connection.sql.unsafe(`
        DROP TRIGGER IF EXISTS reject_processing_event_trigger ON order_events;
        DROP FUNCTION IF EXISTS reject_processing_event();
      `);
    }
  });

  it("serializes concurrent duplicate deliveries without duplicate lifecycle events", async () => {
    const persistence = new PostgresOrderTransitionPersistence(connection.db);
    const delivery = { attemptNumber: 1, attemptsMade: 0, maxAttempts: 4 };

    const processingResults = await Promise.all([
      persistence.transitionToProcessing(job, delivery),
      persistence.transitionToProcessing(job, delivery),
    ]);
    const confirmationResults = await Promise.all([
      persistence.transitionToConfirmed(job, delivery),
      persistence.transitionToConfirmed(job, delivery),
    ]);
    const events = await readOrderEvents(connection, ids.order);

    expect(processingResults.map((result) => result.changed).sort()).toEqual([false, true]);
    expect(processingResults.find((result) => !result.changed)).toEqual({
      changed: false,
      status: "processing",
      executionClaimed: false,
    });
    expect(confirmationResults.map((result) => result.changed).sort()).toEqual([false, true]);
    expect(events.filter((event) => event.eventName === "order.processing")).toHaveLength(1);
    expect(events.filter((event) => event.eventName === "order.confirmed")).toHaveLength(1);

    await expect(persistence.transitionToProcessing(job, delivery)).resolves.toEqual({
      changed: false,
      status: "confirmed",
    });
    expect(await readOrderEvents(connection, ids.order)).toHaveLength(4);
  });

  it("records simulated notifications only after confirmation and keeps replay idempotent", async () => {
    const transitionPersistence = new PostgresOrderTransitionPersistence(
      connection.db,
      sequenceClock(new Date("2026-06-21T00:00:01.000Z"), new Date("2026-06-21T00:00:02.000Z")),
    );
    const notificationPersistence = new PostgresNotificationRecordPersistence(
      connection.db,
      sequenceClock(new Date("2026-06-21T00:00:03.000Z"), new Date("2026-06-21T00:00:04.000Z")),
    );
    const notificationJob: NotificationRecordJob = {
      orderId: ids.order,
      saleOfferId: ids.saleOffer,
      correlationId: job.correlationId,
      recipientPlaceholder: "simulated-buyer:ord_worker_integration",
      confirmedAt: "2026-06-21T00:00:02.000Z",
    };

    await expect(notificationPersistence.record(notificationJob)).rejects.toBeInstanceOf(
      NotificationBeforeConfirmationError,
    );
    await transitionPersistence.transitionToProcessing(job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
    });
    await transitionPersistence.transitionToConfirmed(job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 4,
    });

    await expect(notificationPersistence.record(notificationJob)).resolves.toEqual({
      recorded: true,
    });
    await expect(notificationPersistence.record(notificationJob)).resolves.toEqual({
      recorded: false,
    });

    const notifications = await connection.db
      .select()
      .from(simulatedNotifications)
      .where(eq(simulatedNotifications.orderId, ids.order));
    const notificationEvents = (await readOrderEvents(connection, ids.order)).filter(
      (event) => event.eventName === "notification.recorded",
    );

    expect(notifications).toMatchObject([
      {
        orderId: ids.order,
        saleOfferId: ids.saleOffer,
        correlationId: job.correlationId,
        runId: null,
        recipientPlaceholder: "simulated-buyer:ord_worker_integration",
        recordedAt: new Date("2026-06-21T00:00:03.000Z"),
      },
    ]);
    expect(notificationEvents).toHaveLength(1);
    expect(notificationEvents[0]).toMatchObject({
      orderId: ids.order,
      reservationId: ids.reservation,
      saleOfferId: ids.saleOffer,
      correlationId: job.correlationId,
      eventName: "notification.recorded",
      source: "worker",
      occurredAt: new Date("2026-06-21T00:00:03.000Z"),
      payload: {
        recipientPlaceholder: "simulated-buyer:ord_worker_integration",
      },
    });
  });

  it("persists one terminal failure and treats failed replay as a no-op", async () => {
    const failedAt = new Date("2026-06-21T00:00:03.000Z");
    const times = [new Date("2026-06-21T00:00:01.000Z"), failedAt];
    const persistence = new PostgresOrderTransitionPersistence(connection.db, () => {
      const time = times.shift();
      if (!time) throw new Error("Unexpected clock read");
      return time;
    });
    const delivery = { attemptNumber: 4, attemptsMade: 3, maxAttempts: 4 };

    await persistence.transitionToProcessing(job, delivery);
    const failedTransition = await persistence.transitionToFailed(
      job,
      {
        category: "business_rejection",
        code: "order_confirmation_failed",
        message: "placeholder confirmation failed",
      },
      delivery,
    );
    const replay = await persistence.transitionToFailed(
      job,
      { category: "business_rejection", code: "different", message: "must not overwrite" },
      { attemptNumber: 5, attemptsMade: 4, maxAttempts: 5 },
    );

    const [order] = await connection.db.select().from(orders).where(eq(orders.id, ids.order));
    const failedEvents = (await readOrderEvents(connection, ids.order)).filter(
      (event) => event.eventName === "order.failed",
    );
    expect(order).toMatchObject({
      status: "failed",
      failedAt,
      failureCategory: "business_rejection",
      failureCode: "order_confirmation_failed",
      failureMessage: "placeholder confirmation failed",
    });
    expect(failedEvents).toHaveLength(1);
    expect(replay).toEqual({ changed: false, status: "failed" });
    if (!failedTransition.changed) throw new Error("Expected a fresh failed transition.");
    expect(failedEvents[0]?.payload).toEqual({
      attemptNumber: 4,
      attemptsMade: 3,
      failureCategory: "business_rejection",
      failureCode: "order_confirmation_failed",
      failureMessage: "placeholder confirmation failed",
    });
  });

  it("persists failed ERP attempt details with reconstructable event history", async () => {
    const startedAt = new Date("2026-06-21T00:00:04.000Z");
    const finishedAt = new Date("2026-06-21T00:00:04.075Z");
    const persistence = new PostgresErpAttemptPersistence(connection.db);

    await persistence.recordAttempt({
      job,
      delivery: { attemptNumber: 3, attemptsMade: 2, maxAttempts: 3 },
      status: "failed",
      terminal: true,
      httpStatus: 503,
      errorCode: "erp_unavailable",
      errorMessage: "The ERP is temporarily unavailable.",
      latencyMs: 75,
      startedAt,
      finishedAt,
    });

    const [attempt] = await connection.db
      .select()
      .from(erpAttempts)
      .where(eq(erpAttempts.orderId, ids.order));
    const [event] = await connection.db
      .select()
      .from(orderEvents)
      .where(
        and(eq(orderEvents.orderId, ids.order), eq(orderEvents.eventName, "erp.attempt.failed")),
      );

    expect(attempt).toMatchObject({
      orderId: ids.order,
      correlationId: job.correlationId,
      attemptNumber: 3,
      status: "failed",
      terminal: true,
      httpStatus: 503,
      errorCode: "erp_unavailable",
      errorMessage: "The ERP is temporarily unavailable.",
      latencyMs: 75,
      startedAt,
      finishedAt,
    });
    expect(event).toMatchObject({
      orderId: ids.order,
      reservationId: ids.reservation,
      saleOfferId: ids.saleOffer,
      correlationId: job.correlationId,
      source: "worker",
      occurredAt: finishedAt,
      payload: {
        erpAttemptStatus: "failed",
        terminal: true,
        attemptNumber: 3,
        attemptsMade: 2,
        httpStatus: 503,
        errorCode: "erp_unavailable",
        errorMessage: "The ERP is temporarily unavailable.",
        latencyMs: 75,
      },
    });
  });

  it.each([
    { status: "succeeded" as const, terminal: true },
    { status: "failed" as const, terminal: false },
    { status: "failed" as const, terminal: true },
    { status: "timed_out" as const, terminal: false },
    { status: "timed_out" as const, terminal: true },
  ])("keeps $status terminal=$terminal attempt rows and events in parity", async ({
    status,
    terminal,
  }) => {
    const persistence = new PostgresErpAttemptPersistence(connection.db);
    await persistence.recordAttempt({
      job,
      delivery: {
        attemptNumber: 1,
        attemptsMade: 0,
        // Terminal retryable failures only occur on an exhausted budget.
        maxAttempts: terminal ? 1 : 2,
        deliveryId: `${status}-${terminal}`,
      },
      status,
      terminal,
      latencyMs: 10,
      startedAt: new Date("2026-06-21T00:00:01.000Z"),
      finishedAt: new Date("2026-06-21T00:00:01.010Z"),
    });

    const [attempt] = await connection.db
      .select()
      .from(erpAttempts)
      .where(eq(erpAttempts.orderId, ids.order));
    const [event] = await connection.db
      .select()
      .from(orderEvents)
      .where(
        and(
          eq(orderEvents.orderId, ids.order),
          eq(
            orderEvents.eventName,
            status === "succeeded" ? "erp.attempt.succeeded" : "erp.attempt.failed",
          ),
        ),
      );
    expect(attempt).toMatchObject({ status, terminal });
    expect(event?.payload).toMatchObject({ erpAttemptStatus: status, terminal });
  });

  it("rolls back the ERP attempt when its matching event cannot be inserted", async () => {
    await connection.sql.unsafe(`
      CREATE FUNCTION reject_erp_attempt_event() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_name = 'erp.attempt.failed' THEN
          RAISE EXCEPTION 'ERP attempt event rejected';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_erp_attempt_event_trigger
      BEFORE INSERT ON order_events
      FOR EACH ROW EXECUTE FUNCTION reject_erp_attempt_event();
    `);
    const persistence = new PostgresErpAttemptPersistence(connection.db);

    try {
      await expect(
        persistence.recordAttempt({
          job,
          delivery: { attemptNumber: 1, attemptsMade: 0, maxAttempts: 2 },
          status: "failed",
          terminal: false,
          httpStatus: 503,
          latencyMs: 10,
          startedAt: new Date("2026-06-21T00:00:01.000Z"),
          finishedAt: new Date("2026-06-21T00:00:01.010Z"),
        }),
      ).rejects.toThrow();
      const attempts = await connection.db
        .select()
        .from(erpAttempts)
        .where(eq(erpAttempts.orderId, ids.order));
      const attemptEvents = await connection.db
        .select()
        .from(orderEvents)
        .where(
          and(eq(orderEvents.orderId, ids.order), eq(orderEvents.eventName, "erp.attempt.failed")),
        );
      expect(attempts).toHaveLength(0);
      expect(attemptEvents).toHaveLength(0);
    } finally {
      await connection.sql.unsafe(`
        DROP TRIGGER IF EXISTS reject_erp_attempt_event_trigger ON order_events;
        DROP FUNCTION IF EXISTS reject_erp_attempt_event();
      `);
    }
  });

  it("fails missing and materially mismatched jobs without fabricating events", async () => {
    const persistence = new PostgresOrderTransitionPersistence(connection.db);
    const eventCountBefore = (await readOrderEvents(connection, ids.order)).length;

    await expect(
      persistence.transitionToProcessing(
        { ...job, orderId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
        { attemptNumber: 1, attemptsMade: 0, maxAttempts: 1 },
      ),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
    const mismatch = await persistence
      .transitionToProcessing(
        { ...job, correlationId: "wrong-correlation", quantity: 2 },
        { attemptNumber: 1, attemptsMade: 0, maxAttempts: 1 },
      )
      .catch((error: unknown) => error);
    expect(mismatch).toBeInstanceOf(OrderJobIdentityMismatchError);
    expect(mismatch).toMatchObject({
      name: "OrderJobIdentityMismatchError",
      mismatchedFields: ["correlationId", "quantity"],
    });

    const [order] = await connection.db.select().from(orders).where(eq(orders.id, ids.order));
    expect(order?.status).toBe("queued");
    expect(await readOrderEvents(connection, ids.order)).toHaveLength(eventCountBefore);
  });
});

describe("BullMQ and PostgreSQL worker workflow", () => {
  const databaseUrl = requireTestEnv("TEST_DATABASE_URL");
  const redisUrl = requireTestEnv("TEST_REDIS_URL");
  let connection: ReturnType<typeof createDatabaseConnection>;
  let redis: Redis;
  let queue: Queue<OrderProcessJob, void, typeof orderProcessJobName>;
  let consumer: OrderProcessConsumer | null = null;

  beforeAll(async () => {
    connection = createDatabaseConnection(databaseUrl, { max: 4 });
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
    queue = new Queue(orderProcessBullMqQueueName, {
      connection: { url: redisUrl, maxRetriesPerRequest: 3 },
    });
  });

  beforeEach(async () => {
    await consumer?.close();
    consumer = null;
    await redis.flushdb();
    await resetTestDatabase({ databaseUrl, migrationsFolder });
    await seedQueuedOrder(connection);
  });

  afterAll(async () => {
    await consumer?.close();
    await queue.close();
    await redis.quit();
    await connection.close();
  });

  it("picks up a real queued job and durably confirms it", async () => {
    consumer = buildConsumer(connection, { confirm: vi.fn().mockResolvedValue(undefined) });
    consumer.start();

    await queue.add(orderProcessJobName, job, { jobId: job.orderId });
    await waitForOrderStatus(connection, "confirmed");

    const events = await readOrderEvents(connection, ids.order);
    expect(events.map((event) => event.eventName)).toEqual([
      "reservation.secured",
      "order.queued",
      "order.processing",
      "order.confirmed",
    ]);
  });

  it("confirms accepted run work after sale eligibility expires", async () => {
    await resetTestDatabase({ databaseUrl, migrationsFolder });
    await seedQueuedOrder(connection, { runScoped: true });
    await connection.db.delete(orderEvents);
    await connection.db.delete(orders);
    await connection.db.delete(reservations);
    await initializeInventory(redis, {
      saleOfferId: ids.saleOffer,
      allocatedStock: 1,
      run: { runId: ids.run, status: "accepting" },
    });
    const accepted = await new ReserveOrderService({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: {
        reserve: (input) => reserveInventoryStock(redis, input),
        markPendingPersistence: (input) => markReservationPendingPersistence(redis, input),
        promoteAccepted: (input) =>
          promoteReservationIdempotencyToAccepted(redis, input).then(() => undefined),
      },
      orderProcessJobPublisher: { enqueue: async () => undefined },
      reservationHoldMinutes: 5,
      idempotencyTtlSeconds: 1_800,
      pendingPersistenceRetryAfterSeconds: 5,
      pendingPersistenceRecovery: { recoverReservation: async () => null },
    }).reserve({
      request: {
        saleOfferId: ids.saleOffer,
        runId: ids.run,
        idempotencyKey: "accepted-before-expiry",
        quantity: 1,
      },
      correlationId: job.correlationId,
      now: queuedAt,
    });
    expect(accepted.outcome).toBe("reservation_secured");
    if (!accepted.order || !accepted.reservation) {
      throw new Error("Expected a durable accepted reservation and order.");
    }

    await redis.del(runSaleEligibilityKey(ids.run));
    const afterExpiry = new Date(Date.parse(accepted.reservation.expiresAt) + 1);
    const notificationRecordPublisher = createBullMqNotificationRecordPublisher({
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      attempts: 1,
      publicationFence: new PostgresGeneratedRunPublicationFence(connection.db),
    });
    const notificationRecordConsumer = createBullMqNotificationRecordConsumer({
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      concurrency: 1,
      handler: createNotificationRecordJobHandler({
        persistence: new PostgresNotificationRecordPersistence(connection.db),
        logger: createSilentLogger("worker"),
      }),
      logger: createSilentLogger("worker"),
    });
    const orderPublisher = createBullMqOrderProcessJobPublisher(
      {
        url: redisUrl,
        maxRetriesPerRequest: null,
      },
      undefined,
      new PostgresGeneratedRunPublicationFence(connection.db),
    );
    const scanner = createOrderDispatchScanner({
      persistence: new PostgresOrderDispatchPersistence(connection.db),
      publisher: orderPublisher,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 10_000,
      batchSize: 10,
      minimumQueuedAgeMs: 0,
      now: () => afterExpiry,
    });
    consumer = buildConsumer(
      connection,
      { confirm: vi.fn().mockResolvedValue(undefined) },
      { notificationRecordPublisher },
    );

    try {
      notificationRecordConsumer.start();
      consumer.start();
      await expect(scanner.scanOnce()).resolves.toEqual({
        candidates: 1,
        published: 1,
        failed: 0,
      });
      await waitForOrderStatus(connection, "confirmed", accepted.order.id);
      await waitForNotificationCount(connection, 1, accepted.order.id);

      const inventory = await getInventoryStatus(redis, ids.saleOffer, afterExpiry);
      expect(inventory).toMatchObject({
        remainingStock: 0,
        reservedStock: 1,
        expiredReservationCount: 1,
      });
      const redisReservation = JSON.parse(
        (await redis.hget(inventoryKeys(ids.saleOffer).reservations, accepted.reservation.id)) ??
          "{}",
      );
      expect(redisReservation).toMatchObject({
        id: accepted.reservation.id,
        runId: ids.run,
        reservationToken: accepted.reservation.reservationToken,
      });
      const [durableReservation] = await connection.db
        .select()
        .from(reservations)
        .where(eq(reservations.id, accepted.reservation.id));
      expect(durableReservation).toMatchObject({
        id: accepted.reservation.id,
        runId: ids.run,
        reservationToken: accepted.reservation.reservationToken,
      });

      await expect(
        reserveInventoryStock(redis, {
          idempotencyKey: "rejected-after-expiry",
          idempotencyTtlSeconds: 1_800,
          reservation: {
            id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
            saleOfferId: ids.saleOffer,
            runId: ids.run,
            correlationId: "corr-after-expiry",
            quantity: 1,
            reservationToken: "res_after_expiry",
            securedAt: afterExpiry.toISOString(),
            expiresAt: new Date(afterExpiry.getTime() + 300_000).toISOString(),
          },
        }),
      ).resolves.toMatchObject({ outcome: "run_not_accepting_traffic" });
      await expect(getInventoryStatus(redis, ids.saleOffer, afterExpiry)).resolves.toMatchObject({
        remainingStock: 0,
        reservedStock: 1,
      });
    } finally {
      await scanner.close();
      await orderPublisher.close();
      await notificationRecordConsumer.close();
      await notificationRecordPublisher.close();
    }

    expect(await redis.exists(runSaleEligibilityKey(ids.run))).toBe(0);
    expect(await redis.hget(inventoryKeys(ids.saleOffer).state, "runSaleStatus")).toBe("accepting");
  });

  it("filters terminal notification work before applying the recovery batch limit", async () => {
    await resetTestDatabase({ databaseUrl, migrationsFolder });
    await seedQueuedOrder(connection, { runScoped: true });
    await seedAdditionalQueuedOrder(connection, freshJob);
    await connection.db
      .update(orders)
      .set({
        status: "confirmed",
        processingAt: new Date("2026-06-21T00:00:01.000Z"),
        confirmedAt: new Date("2026-06-21T00:00:02.000Z"),
      })
      .where(eq(orders.id, ids.order));
    await connection.db
      .update(orders)
      .set({
        status: "confirmed",
        processingAt: new Date("2026-06-21T00:00:02.000Z"),
        confirmedAt: new Date("2026-06-21T00:00:03.000Z"),
      })
      .where(eq(orders.id, freshIds.order));
    await connection.db
      .update(demoRuns)
      .set({
        status: "completed",
        finalizedAt: new Date("2026-06-21T00:00:04.000Z"),
      })
      .where(eq(demoRuns.id, ids.run));

    const candidates = await new PostgresNotificationRecoveryPersistence(
      connection.db,
    ).findConfirmedOrdersMissingNotifications({ limit: 1 });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.job.orderId).toBe(freshIds.order);
  });

  it("completes a purged reset job without dead-lettering and preserves genuine missing-order evidence", async () => {
    await resetTestDatabase({ databaseUrl, migrationsFolder });
    await seedQueuedOrder(connection, { runScoped: true });
    const entered = releaseBarrier();
    const release = releaseBarrier();
    const logger = createSilentLogger("worker");
    const recovery = new PostgresOrderRecoveryPersistence(connection.db);
    const publishForConfirmedOrder = vi.fn();
    const confirmation = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const handler = createProductionOrderProcessJobHandler({
      confirmation: {
        confirm: confirmation,
      },
      persistence: new PostgresOrderTransitionPersistence(connection.db),
      logger,
      publishBusinessOutcomeUpdate: async () => undefined,
      notificationRecordPublisher: { publishForConfirmedOrder },
      recovery: {
        handoff: (input) => recovery.recordRecoverable(input),
        resolve: (input) => recovery.markResolved(input),
      },
    });
    consumer = createBullMqOrderProcessConsumer({
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      concurrency: 1,
      handler,
      logger,
      recovery,
    });
    consumer.start();
    await queue.add(orderProcessJobName, runScopedJob, {
      jobId: "purged-reset-order",
      attempts: 2,
      backoff: { type: "fixed", delay: 10 },
    });
    try {
      const signal = AbortSignal.timeout(5_000);
      await Promise.race([
        entered.promise,
        new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
      ]);
      await new PostgresTerminalDemoRunSummaryWriter(connection.db).claimTerminalRun({
        runId: ids.run,
        terminalStatus: "failed",
        failureReason: "admin_reset",
        finalizedAt: new Date(),
        allowedCurrentStatuses: ["draining"],
        terminalTrafficStatus: "failed",
      });
      await purgeResetRunDurable(connection.db, {
        runId: ids.run,
        failureReason: "admin_reset",
      });
      release.resolve();
      await vi.waitFor(
        async () => {
          expect(await (await queue.getJob("purged-reset-order"))?.getState()).toBe("completed");
        },
        { timeout: 5_000 },
      );
      expect((await queue.getJob("purged-reset-order"))?.attemptsMade).toBe(1);
      expect(confirmation).toHaveBeenCalledOnce();
      expect(await connection.db.select().from(orders).where(eq(orders.id, ids.order))).toEqual([]);
      expect(await connection.db.select().from(orderRecoveryJobs)).toHaveLength(0);
      expect(await connection.db.select().from(simulatedNotifications)).toHaveLength(0);
      expect(await connection.db.select().from(orderDeadLetters)).toHaveLength(0);
      expect(publishForConfirmedOrder).not.toHaveBeenCalled();
      expect(
        await connection.db
          .select({ status: demoRuns.status })
          .from(demoRuns)
          .where(eq(demoRuns.id, ids.run)),
      ).toEqual([{ status: "failed" }]);

      await queue.add(orderProcessJobName, freshJob, {
        jobId: "genuine-missing-order",
        attempts: 2,
        backoff: { type: "fixed", delay: 10 },
      });
      await vi.waitFor(async () => {
        expect(await connection.db.select().from(orderDeadLetters)).toEqual([
          expect.objectContaining({
            jobId: "genuine-missing-order",
            claimedOrderId: freshIds.order,
            reason: "order_not_found",
          }),
        ]);
      });
      expect(await (await queue.getJob("genuine-missing-order"))?.getState()).toBe("completed");
    } finally {
      release.resolve();
      await consumer?.close();
      consumer = null;
    }
  });

  it.each(
    destructiveResetReasonValues,
  )("fences recovery and notification recording for %s", async (reason) => {
    await resetTestDatabase({ databaseUrl, migrationsFolder });
    await seedQueuedOrder(connection, { runScoped: true });
    const recovery = new PostgresOrderRecoveryPersistence(connection.db);
    const notifications = new PostgresNotificationRecordPersistence(connection.db);
    expect(await recovery.isTerminalResetRun(ids.run)).toBe(false);
    expect(await notifications.isTerminalResetRun(ids.run)).toBe(false);
    await connection.db
      .update(demoRuns)
      .set({ status: "failed", failureReason: reason })
      .where(eq(demoRuns.id, ids.run));
    expect(await recovery.isTerminalResetRun(ids.run)).toBe(true);
    expect(await notifications.isTerminalResetRun(ids.run)).toBe(true);
  });

  it("waits for an in-flight order transaction before purging run rows", async () => {
    await resetTestDatabase({ databaseUrl, migrationsFolder });
    await seedQueuedOrder(connection, { runScoped: true });
    await new PostgresTerminalDemoRunSummaryWriter(connection.db).claimTerminalRun({
      runId: ids.run,
      terminalStatus: "failed",
      failureReason: "admin_reset",
      finalizedAt: new Date(),
      allowedCurrentStatuses: ["draining"],
      terminalTrafficStatus: "failed",
    });

    const workerConnection = createDatabaseConnection(databaseUrl, { max: 1 });
    const purgeConnection = createDatabaseConnection(databaseUrl, { max: 1 });
    const orderLocked = releaseBarrier();
    const releaseWorker = releaseBarrier();
    let workerWrite: Promise<void> | undefined;
    let purge: Promise<void> | undefined;
    try {
      const [purgeBackend] = await purgeConnection.sql`SELECT pg_backend_pid() AS pid`;
      workerWrite = workerConnection.db.transaction(async (tx) => {
        await tx.select().from(orders).where(eq(orders.id, ids.order)).for("update");
        orderLocked.resolve();
        await releaseWorker.promise;
        // Same run lock a run-scoped foreign-key insert (ERP attempt, dispatch call) takes.
        await tx.select().from(demoRuns).where(eq(demoRuns.id, ids.run)).for("key share");
        await tx.insert(orderEvents).values({
          orderId: ids.order,
          reservationId: ids.reservation,
          saleOfferId: ids.saleOffer,
          runId: ids.run,
          correlationId: runScopedJob.correlationId,
          eventName: "order.confirmed",
          payload: { source: "held-worker" },
          source: "worker",
          occurredAt: new Date(),
        });
      });
      await orderLocked.promise;

      purge = purgeResetRunDurable(purgeConnection.db, {
        runId: ids.run,
        failureReason: "admin_reset",
      });
      await vi.waitFor(async () => {
        const [activity] = await connection.sql`
          SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${purgeBackend?.pid}
        `;
        expect(activity?.wait_event_type).toBe("Lock");
      });

      releaseWorker.resolve();
      await workerWrite;
      await purge;

      const [remaining] = await connection.sql`
        SELECT
          (SELECT count(*)::int FROM simulated_notifications WHERE run_id = ${ids.run}) AS notifications,
          (SELECT count(*)::int FROM erp_attempts WHERE run_id = ${ids.run}) AS attempts,
          (SELECT count(*)::int FROM erp_confirmation_ledger WHERE run_id = ${ids.run}) AS ledger,
          (SELECT count(*)::int FROM erp_dispatch_calls WHERE run_id = ${ids.run}) AS dispatch_calls,
          (SELECT count(*)::int FROM order_events WHERE run_id = ${ids.run}) AS events,
          (SELECT count(*)::int FROM orders WHERE run_id = ${ids.run}) AS orders,
          (SELECT count(*)::int FROM reservations WHERE run_id = ${ids.run}) AS reservations,
          (SELECT count(*)::int FROM reservation_pending_persistence WHERE run_id = ${ids.run}) AS pending_reservations,
          (SELECT count(*)::int FROM demo_run_sold_out_counts WHERE run_id = ${ids.run}) AS sold_out_counts,
          (SELECT count(*)::int FROM demo_run_finalizations WHERE run_id = ${ids.run}) AS finalizations,
          (SELECT count(*)::int FROM erp_scope_resilience_state WHERE scope = ${`run:${ids.run}`}) AS resilience,
          (SELECT count(*)::int FROM order_recovery_jobs) AS recovery_jobs
      `;
      expect(remaining).toEqual({
        notifications: 0,
        attempts: 0,
        ledger: 0,
        dispatch_calls: 0,
        events: 0,
        orders: 0,
        reservations: 0,
        pending_reservations: 0,
        sold_out_counts: 0,
        finalizations: 0,
        resilience: 0,
        recovery_jobs: 0,
      });
    } finally {
      releaseWorker.resolve();
      await Promise.allSettled([workerWrite, purge].filter(Boolean));
      await Promise.all([workerConnection.close(), purgeConnection.close()]);
    }
  });

  it("recovers a terminally failed notification job so the run can finalize", async () => {
    await redis.flushdb();
    await resetTestDatabase({ databaseUrl, migrationsFolder });
    await seedQueuedOrder(connection, { runScoped: true });
    await seedTrafficCompleteRunArtifacts(connection, redis);

    const logger = createSilentLogger("worker");
    const notificationRecordPublisher = createBullMqNotificationRecordPublisher({
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      attempts: 1,
      publicationFence: new PostgresGeneratedRunPublicationFence(connection.db),
    });
    const notificationQueue = new Queue<
      NotificationRecordJob,
      void,
      typeof notificationRecordJobName
    >(notificationRecordBullMqQueueName, {
      connection: { url: redisUrl, maxRetriesPerRequest: 3 },
    });
    const durableNotificationPersistence = new PostgresNotificationRecordPersistence(connection.db);
    let persistenceAvailable = false;
    const notificationRecordConsumer = createBullMqNotificationRecordConsumer({
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      concurrency: 1,
      handler: createNotificationRecordJobHandler({
        persistence: {
          record: (notificationJob) => {
            if (!persistenceAvailable) {
              throw new Error("temporary notification persistence failure");
            }
            return durableNotificationPersistence.record(notificationJob);
          },
        },
        logger,
      }),
      logger,
    });
    const orderHandler = createOrderProcessJobHandler({
      confirmation: { confirm: vi.fn().mockResolvedValue(undefined) },
      persistence: new PostgresOrderTransitionPersistence(connection.db),
      logger,
      notificationRecordPublisher,
    });

    try {
      notificationRecordConsumer.start();
      await orderHandler.handle(runScopedJob, {
        attemptNumber: 1,
        attemptsMade: 0,
        maxAttempts: 1,
      });
      await vi.waitFor(async () => {
        expect(await notificationQueue.getJob(`${ids.order}-email`)).toBeUndefined();
      });
      await expect(readNotificationCount(connection)).resolves.toBe(0);

      const finalizationService = createFinalizationService(connection, redis);
      await expect(
        finalizationService.finalizeRun(ids.run, job.correlationId),
      ).resolves.toMatchObject({
        status: "draining",
      });

      persistenceAvailable = true;
      const scanner = createNotificationRecoveryScanner({
        persistence: new PostgresNotificationRecoveryPersistence(connection.db),
        publisher: notificationRecordPublisher,
        logger,
        scanIntervalMs: 1000,
        batchSize: 10,
      });

      const scanResult = await scanner.scanOnce();
      expect(scanResult).toEqual({
        candidates: 1,
        published: 1,
        failed: 0,
      });
      await waitForNotificationCount(connection, 1);

      const notificationEvents = (await readOrderEvents(connection, ids.order)).filter(
        (event) => event.eventName === "notification.recorded",
      );
      expect(notificationEvents).toHaveLength(1);

      await expect(
        finalizationService.finalizeRun(ids.run, job.correlationId),
      ).resolves.toMatchObject({
        status: "completed",
      });
      const summaries = await connection.db
        .select()
        .from(demoRunSummaries)
        .where(eq(demoRunSummaries.runId, ids.run));

      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.businessOutcomeSummary).toMatchObject({
        confirmedOrders: 1,
        notificationsRecorded: 1,
      });
    } finally {
      await notificationRecordConsumer.close();
      await notificationRecordPublisher.close();
      await notificationQueue.close();
    }
  });

  it("calls the ERP adapter and records durable attempt history", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "succeeded",
          confirmationId: "erp_confirmation_integration",
          httpStatus: 200,
          latencyMs: 20,
          timestamp: "2026-06-21T00:00:02.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    consumer = buildConsumer(
      connection,
      new HttpErpOrderConfirmation({
        baseUrl: "http://mock-erp:4100",
        requestTimeoutMs: 1000,
        retryAfterPolicy: { fallbackDelayMs: 1_000, maximumDelayMs: 60_000 },
        attemptPersistence: new PostgresErpAttemptPersistence(connection.db),
        fetch,
        now: sequenceClock(
          new Date("2026-06-21T00:00:01.000Z"),
          new Date("2026-06-21T00:00:01.020Z"),
        ),
      }),
    );
    consumer.start();

    await queue.add(orderProcessJobName, job, { jobId: job.orderId });
    await waitForOrderStatus(connection, "confirmed");
    const [attempt] = await connection.db
      .select()
      .from(erpAttempts)
      .where(eq(erpAttempts.orderId, ids.order));
    const [attemptEvent] = await connection.db
      .select()
      .from(orderEvents)
      .where(
        and(eq(orderEvents.orderId, ids.order), eq(orderEvents.eventName, "erp.attempt.succeeded")),
      );

    expect(fetch).toHaveBeenCalledOnce();
    expect(attempt).toMatchObject({
      orderId: ids.order,
      correlationId: job.correlationId,
      attemptNumber: 1,
      status: "succeeded",
      terminal: true,
      httpStatus: 200,
      latencyMs: 20,
      startedAt: new Date("2026-06-21T00:00:01.000Z"),
      finishedAt: new Date("2026-06-21T00:00:01.020Z"),
    });
    expect(attemptEvent?.payload).toMatchObject({
      erpAttemptStatus: "succeeded",
      terminal: true,
      attemptNumber: 1,
      attemptsMade: 0,
      httpStatus: 200,
      latencyMs: 20,
    });
  });

  it("keeps business totals stable across concurrency after a real capacity rejection", async () => {
    const serial = await runCapacityFixture(1);
    const parallel = await runCapacityFixture(10);

    for (const result of [serial, parallel]) {
      expect(result.confirmed).toBe(capacityJobs.length);
      expect(result.capacityRejected).toBeGreaterThanOrEqual(1);
      expect(result.peakInFlight).toBeLessThanOrEqual(1);
      expect(result.minimumStartSpacingMs).toBeGreaterThanOrEqual(400);
      expect(result.publications).toBeLessThanOrEqual(12);
      expect(result.scans).toBeLessThanOrEqual(6);
    }
    expect(parallel.confirmed).toBe(serial.confirmed);
    expect(parallel.capacityRejected).toBe(serial.capacityRejected);
  }, 30_000);

  it("reconciles a restarted scope before fresh queued traffic can dispatch", async () => {
    await seedAdditionalQueuedOrder(connection, freshJob);
    let policyNow = new Date();
    const transition = new PostgresOrderTransitionPersistence(connection.db, () => policyNow);
    await transition.transitionToProcessing(job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 1,
      deliveryId: "crashed-delivery",
    });
    const attempts = new PostgresErpAttemptPersistence(connection.db, () => policyNow);
    const call = await attempts.recordDispatchIntent({
      job,
      idempotencyKey: `erp-confirmation:${job.orderId}`,
      dispatchedAt: policyNow,
      expectedProcessingGeneration: 0,
    });
    const control = new PostgresOrderRecoveryPersistence(connection.db, () => policyNow);
    await control.defer({
      orderId: job.orderId,
      waitingReason: "uncertain_result",
      nextEligibleAt: policyNow,
      processingGeneration: 0,
    });
    const operations: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_input, init) => {
      const method = init?.method ?? "GET";
      operations.push(method);
      if (method === "GET") {
        return Response.json({
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
              confirmationId: "erp_recovered",
              httpStatus: 200,
              latencyMs: 1,
              timestamp: policyNow.toISOString(),
            },
          },
          timestamp: policyNow.toISOString(),
        });
      }
      return Response.json({
        status: "succeeded",
        confirmationId: "erp_fresh",
        httpStatus: 200,
        latencyMs: 1,
        timestamp: policyNow.toISOString(),
      });
    });
    const client = new HttpErpOrderConfirmation({
      baseUrl: "http://mock-erp:4100",
      requestTimeoutMs: 1_000,
      retryAfterPolicy: { fallbackDelayMs: 1_000, maximumDelayMs: 60_000 },
      attemptPersistence: attempts,
      fetch,
      now: () => policyNow,
    });
    const scopeState = new PostgresErpScopeResiliencePersistence(connection.db);
    const admission = await AdaptiveErpRuntimeAdmission.restore({
      persistence: scopeState,
      runConfigReader: new PostgresRunConfigReader(connection.db),
      fallbackConcurrency: 2,
      now: () => policyNow.getTime(),
      random: () => 0,
    });
    const scheduled = new ScheduledErpOrderConfirmation({
      client,
      reconciler: new ErpUnresolvedCallReconciler({
        client,
        callResolution: control,
        admission,
      }),
      admission,
      control,
      now: () => policyNow,
    });
    consumer = createBullMqOrderProcessConsumer({
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      concurrency: 2,
      handler: createOrderProcessJobHandler({
        confirmation: scheduled,
        persistence: transition,
        logger: createSilentLogger("worker"),
      }),
      logger: createSilentLogger("worker"),
    });
    const publisher = createBullMqOrderProcessJobPublisher({
      url: redisUrl,
      maxRetriesPerRequest: null,
    });
    const scanner = createOrderRecoveryScanner({
      persistence: control,
      handler: { handle: vi.fn() },
      publisher,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 60_000,
      batchSize: 10,
      failedJobReader: { findFailedOrderJobs: async () => [] },
      now: () => policyNow,
    });
    try {
      await queue.add(orderProcessJobName, freshJob, { jobId: freshJob.orderId });
      await expect(scanner.scanOnce()).resolves.toMatchObject({ enqueued: 1 });
      consumer.start();
      await waitForOrderStatus(connection, "confirmed", ids.order);
      expect(operations).toEqual(["GET"]);
      const [freshControl] = await connection.db
        .select({ nextAttemptAt: orderRecoveryJobs.nextAttemptAt })
        .from(orderRecoveryJobs)
        .where(eq(orderRecoveryJobs.orderId, freshIds.order));
      if (!freshControl?.nextAttemptAt) throw new Error("Fresh traffic was not gated.");
      policyNow = new Date(freshControl.nextAttemptAt.getTime() + 1);
      await expect(scanner.scanOnce()).resolves.toMatchObject({ enqueued: 1 });
      await waitForOrderStatus(connection, "confirmed", freshIds.order);
      expect(operations).toEqual(["GET", "POST"]);
    } finally {
      await scanner.close();
      await publisher.close();
    }
  }, 20_000);

  it("does not gate fresh orders behind overlapping healthy dispatch leases", async () => {
    const secondJob = capacityJobs[1];
    if (!secondJob) throw new Error("Missing overlap fixture order.");
    await seedAdditionalQueuedOrder(connection, secondJob);
    await seedAdditionalQueuedOrder(connection, freshJob);
    const baseTime = Date.now();
    let now = baseTime;
    const responses: Array<(response: Response) => void> = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => new Promise<Response>((resolve) => responses.push(resolve)));
    const control = new PostgresOrderRecoveryPersistence(connection.db, () => new Date(now));
    const scopeState = new PostgresErpScopeResiliencePersistence(connection.db);
    const admission = await AdaptiveErpRuntimeAdmission.restore({
      persistence: scopeState,
      runConfigReader: new PostgresRunConfigReader(connection.db),
      fallbackConcurrency: 10,
      now: () => now,
      random: () => 0,
    });
    const client = new HttpErpOrderConfirmation({
      baseUrl: "http://mock-erp:4100",
      requestTimeoutMs: 1_000,
      retryAfterPolicy: { fallbackDelayMs: 1_000, maximumDelayMs: 60_000 },
      attemptPersistence: new PostgresErpAttemptPersistence(connection.db, () => new Date(now)),
      fetch,
      now: () => new Date(now),
    });
    const handler = createOrderProcessJobHandler({
      confirmation: new ScheduledErpOrderConfirmation({
        client,
        reconciler: new ErpUnresolvedCallReconciler({ client, callResolution: control, admission }),
        admission,
        control,
        now: () => new Date(now),
      }),
      persistence: new PostgresOrderTransitionPersistence(connection.db, () => new Date(now)),
      logger: createSilentLogger("worker"),
    });
    const delivery = { attemptNumber: 1, attemptsMade: 0, maxAttempts: 1, processingGeneration: 0 };
    const succeed = (index: number) =>
      responses[index]?.(
        Response.json({
          status: "succeeded",
          confirmationId: `erp_overlap_${index}`,
          httpStatus: 200,
          latencyMs: 1_500,
          timestamp: new Date(now).toISOString(),
        }),
      );
    const first = handler.handle(job, { ...delivery, deliveryId: "overlap-a" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    now = baseTime + 500;
    const second = handler.handle(secondJob, { ...delivery, deliveryId: "overlap-b" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    now = baseTime + 1_500;
    succeed(0);
    await first;
    // B still owns a durable dispatch intent and an unexpired lease.
    expect(await scopeState.readReconciliationGate("catalog")).toMatchObject({
      pending: true,
      nextEligibleAtMs: baseTime + 30_500,
    });
    const fresh = handler.handle(freshJob, { ...delivery, deliveryId: "overlap-c" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    now = baseTime + 2_000;
    succeed(1);
    await second;
    now = baseTime + 3_000;
    succeed(2);
    await fresh;
    const [freshOrder] = await connection.db
      .select()
      .from(orders)
      .where(eq(orders.id, freshJob.orderId));
    expect(freshOrder?.status).toBe("confirmed");
    expect(admission.state()).toMatchObject({ available: true, counters: { deferred: 0 } });
  });

  it("does not republish gated fresh traffic before the unresolved scope due time", async () => {
    await seedAdditionalQueuedOrder(connection, freshJob);
    let policyNow = new Date();
    const dueAt = new Date(policyNow.getTime() + 60_000);
    const transition = new PostgresOrderTransitionPersistence(connection.db, () => policyNow);
    await transition.transitionToProcessing(job, {
      attemptNumber: 1,
      attemptsMade: 0,
      maxAttempts: 1,
      deliveryId: "delayed-reconciliation",
    });
    const attempts = new PostgresErpAttemptPersistence(connection.db, () => policyNow);
    await attempts.recordDispatchIntent({
      job,
      idempotencyKey: `erp-confirmation:${job.orderId}`,
      dispatchedAt: policyNow,
      expectedProcessingGeneration: 0,
    });
    const control = new PostgresOrderRecoveryPersistence(connection.db, () => policyNow);
    await control.defer({
      orderId: job.orderId,
      waitingReason: "erp_unavailable",
      nextEligibleAt: dueAt,
      processingGeneration: 0,
    });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new HttpErpOrderConfirmation({
      baseUrl: "http://mock-erp:4100",
      requestTimeoutMs: 1_000,
      retryAfterPolicy: { fallbackDelayMs: 1_000, maximumDelayMs: 60_000 },
      attemptPersistence: attempts,
      fetch,
      now: () => policyNow,
    });
    const scopeState = new PostgresErpScopeResiliencePersistence(connection.db);
    const admission = await AdaptiveErpRuntimeAdmission.restore({
      persistence: scopeState,
      runConfigReader: new PostgresRunConfigReader(connection.db),
      fallbackConcurrency: 10,
      now: () => policyNow.getTime(),
      random: () => 0,
    });
    const scheduled = new ScheduledErpOrderConfirmation({
      client,
      reconciler: new ErpUnresolvedCallReconciler({ client, callResolution: control, admission }),
      admission,
      control,
      now: () => policyNow,
    });
    consumer = createBullMqOrderProcessConsumer({
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      concurrency: 10,
      handler: createOrderProcessJobHandler({
        confirmation: scheduled,
        persistence: transition,
        logger: createSilentLogger("worker"),
      }),
      logger: createSilentLogger("worker"),
    });
    const publisher = createBullMqOrderProcessJobPublisher({
      url: redisUrl,
      maxRetriesPerRequest: null,
    });
    const scanner = createOrderRecoveryScanner({
      persistence: control,
      handler: { handle: vi.fn() },
      publisher,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 60_000,
      batchSize: 10,
      failedJobReader: { findFailedOrderJobs: async () => [] },
      now: () => policyNow,
    });
    try {
      consumer.start();
      await queue.add(orderProcessJobName, freshJob, { jobId: freshJob.orderId });
      await waitForQueueToSettle(queue);
      const [freshControl] = await connection.db
        .select({ nextAttemptAt: orderRecoveryJobs.nextAttemptAt })
        .from(orderRecoveryJobs)
        .where(eq(orderRecoveryJobs.orderId, freshJob.orderId));
      expect(freshControl?.nextAttemptAt).toEqual(dueAt);
      expect(fetch).not.toHaveBeenCalled();
      await expect(scanner.scanOnce()).resolves.toMatchObject({ candidates: 0, enqueued: 0 });
      policyNow = new Date(policyNow.getTime() + 1_000);
      await expect(scanner.scanOnce()).resolves.toMatchObject({ candidates: 0, enqueued: 0 });
    } finally {
      await scanner.close();
      await publisher.close();
    }
  }, 20_000);

  it("restores cooldown and open-circuit timing before BullMQ traffic", async () => {
    let policyNow = new Date();
    const safetyUntil = policyNow.getTime() + 1_000;
    const scopeState = new PostgresErpScopeResiliencePersistence(connection.db);
    await scopeState.save({
      scope: "catalog",
      cooldownUntilMs: safetyUntil,
      availabilityRetryAtMs: safetyUntil,
      availabilityCircuitOpen: true,
      circuitOpenUntilMs: safetyUntil,
      nextProbeAtMs: safetyUntil,
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        status: "succeeded",
        confirmationId: "erp_after_restart_safety",
        httpStatus: 200,
        latencyMs: 1,
        timestamp: policyNow.toISOString(),
      }),
    );
    const control = new PostgresOrderRecoveryPersistence(connection.db, () => policyNow);
    const client = new HttpErpOrderConfirmation({
      baseUrl: "http://mock-erp:4100",
      requestTimeoutMs: 1_000,
      retryAfterPolicy: { fallbackDelayMs: 1_000, maximumDelayMs: 60_000 },
      attemptPersistence: new PostgresErpAttemptPersistence(connection.db, () => policyNow),
      fetch,
      now: () => policyNow,
    });
    const admission = await AdaptiveErpRuntimeAdmission.restore({
      persistence: scopeState,
      runConfigReader: new PostgresRunConfigReader(connection.db),
      fallbackConcurrency: 10,
      now: () => policyNow.getTime(),
      random: () => 0,
    });
    const scheduled = new ScheduledErpOrderConfirmation({
      client,
      reconciler: new ErpUnresolvedCallReconciler({
        client,
        callResolution: control,
        admission,
      }),
      admission,
      control,
      now: () => policyNow,
    });
    consumer = createBullMqOrderProcessConsumer({
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      concurrency: 10,
      handler: createOrderProcessJobHandler({
        confirmation: scheduled,
        persistence: new PostgresOrderTransitionPersistence(connection.db, () => policyNow),
        logger: createSilentLogger("worker"),
      }),
      logger: createSilentLogger("worker"),
    });
    const publisher = createBullMqOrderProcessJobPublisher({
      url: redisUrl,
      maxRetriesPerRequest: null,
    });
    const scanner = createOrderRecoveryScanner({
      persistence: control,
      handler: { handle: vi.fn() },
      publisher,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 60_000,
      batchSize: 10,
      failedJobReader: { findFailedOrderJobs: async () => [] },
      now: () => policyNow,
    });
    try {
      consumer.start();
      await queue.add(orderProcessJobName, job, { jobId: job.orderId });
      await vi.waitFor(async () => {
        expect(await (await queue.getJob(job.orderId))?.getState()).toBe("completed");
      });
      expect(fetch).not.toHaveBeenCalled();
      const [waiting] = await connection.db
        .select({
          nextAttemptAt: orderRecoveryJobs.nextAttemptAt,
          leaseExpiresAt: orderRecoveryJobs.leaseExpiresAt,
          status: orderRecoveryJobs.status,
          waitingReason: orderRecoveryJobs.waitingReason,
          unresolvedErpCallId: orderRecoveryJobs.unresolvedErpCallId,
        })
        .from(orderRecoveryJobs)
        .where(eq(orderRecoveryJobs.orderId, ids.order));
      expect(waiting?.nextAttemptAt?.getTime()).toBe(safetyUntil);

      policyNow = new Date(safetyUntil);
      await expect(scanner.scanOnce()).resolves.toMatchObject({ enqueued: 1 });
      await waitForOrderStatus(connection, "confirmed");
      expect(fetch).toHaveBeenCalledOnce();
      expect((await queue.getJobCounts()).delayed).toBe(0);
    } finally {
      await scanner.close();
      await publisher.close();
    }
  }, 20_000);

  async function runCapacityFixture(concurrency: number) {
    await consumer?.close();
    consumer = null;
    await redis.flushdb();
    await resetTestDatabase({ databaseUrl, migrationsFolder });
    await seedQueuedOrder(connection);
    for (const capacityJob of capacityJobs.slice(1)) {
      await seedAdditionalQueuedOrder(connection, capacityJob);
    }
    const confirmationStarts: number[] = [];
    let lastAcceptedStart = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      const startedAt = Date.now();
      confirmationStarts.push(startedAt);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      inFlight -= 1;
      if (lastAcceptedStart > 0 && startedAt - lastAcceptedStart < 650) {
        return Response.json(
          {
            status: "failed",
            httpStatus: 429,
            errorCode: "erp_capacity_exceeded",
            errorMessage: "ERP capacity is temporarily exhausted.",
            latencyMs: 1,
            timestamp: new Date().toISOString(),
          },
          { status: 429, headers: { "retry-after": "1" } },
        );
      }
      lastAcceptedStart = startedAt;
      return Response.json({
        status: "succeeded",
        confirmationId: `erp_capacity_${concurrency}`,
        httpStatus: 200,
        latencyMs: 1,
        timestamp: new Date().toISOString(),
      });
    });
    const client = new HttpErpOrderConfirmation({
      baseUrl: "http://mock-erp:4100",
      requestTimeoutMs: 1_000,
      retryAfterPolicy: { fallbackDelayMs: 1_000, maximumDelayMs: 60_000 },
      attemptPersistence: new PostgresErpAttemptPersistence(connection.db),
      fetch,
    });
    consumer = buildConsumer(connection, client, {
      concurrency,
    });
    const publisher = createBullMqOrderProcessJobPublisher({
      url: redisUrl,
      maxRetriesPerRequest: null,
    });
    const scanner = createOrderRecoveryScanner({
      persistence: new PostgresOrderRecoveryPersistence(connection.db),
      handler: { handle: vi.fn() },
      publisher,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 60_000,
      batchSize: 20,
      failedJobReader: { findFailedOrderJobs: async () => [] },
      now: () => new Date(),
    });
    try {
      consumer.start();
      await Promise.all(
        capacityJobs.map((capacityJob) =>
          queue.add(orderProcessJobName, capacityJob, {
            attempts: 1,
            jobId: capacityJob.orderId,
          }),
        ),
      );
      await waitForQueueToSettle(queue);
      let publications = 0;
      let scans = 0;
      while (scans < 12) {
        const currentOrders = await connection.db
          .select({ status: orders.status })
          .from(orders)
          .where(
            inArray(
              orders.id,
              capacityJobs.map((capacityJob) => capacityJob.orderId),
            ),
          );
        if (currentOrders.every((order) => order.status === "confirmed")) break;
        const pending = await connection.db
          .select({ nextAttemptAt: orderRecoveryJobs.nextAttemptAt })
          .from(orderRecoveryJobs)
          .where(inArray(orderRecoveryJobs.status, ["pending", "enqueued"]));
        const nextAttemptAt = Math.min(
          ...pending.flatMap((record) =>
            record.nextAttemptAt ? [record.nextAttemptAt.getTime()] : [Date.now()],
          ),
        );
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, nextAttemptAt - Date.now() + 20)),
        );
        const scan = await scanner.scanOnce();
        publications += scan.enqueued;
        scans += 1;
        await waitForQueueToSettle(queue);
      }
      const attempts = await connection.db
        .select({ disposition: erpAttempts.disposition })
        .from(erpAttempts)
        .where(
          inArray(
            erpAttempts.orderId,
            capacityJobs.map((capacityJob) => capacityJob.orderId),
          ),
        )
        .orderBy(asc(erpAttempts.startedAt));
      const confirmed = await connection.db
        .select({ status: orders.status })
        .from(orders)
        .where(
          inArray(
            orders.id,
            capacityJobs.map((capacityJob) => capacityJob.orderId),
          ),
        );
      expect((await queue.getJobCounts()).delayed).toBe(0);
      const spacings = confirmationStarts
        .slice(1)
        .map((startedAt, index) => startedAt - (confirmationStarts[index] ?? startedAt));
      return {
        confirmed: confirmed.filter((order) => order.status === "confirmed").length,
        capacityRejected: attempts.filter((attempt) => attempt.disposition === "capacity_rejected")
          .length,
        publications,
        scans,
        peakInFlight,
        minimumStartSpacingMs: Math.min(...spacings),
      };
    } finally {
      await scanner.close();
      await publisher.close();
      await consumer?.close();
      consumer = null;
    }
  }

  it("converges after transient failures beyond former execution and publication limits", async () => {
    const transientFailures = 101;
    let policyNow = new Date("2026-06-21T00:00:00.000Z");
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      if (fetch.mock.calls.length <= transientFailures) {
        return Response.json(
          {
            status: "failed",
            httpStatus: 503,
            errorCode: "erp_forced_outage",
            errorMessage: "The ERP is temporarily unavailable.",
            latencyMs: 1,
            timestamp: new Date().toISOString(),
          },
          { status: 503 },
        );
      }
      return Response.json({
        status: "succeeded",
        confirmationId: "erp_confirmation_retry_success",
        httpStatus: 200,
        latencyMs: 1,
        timestamp: new Date().toISOString(),
      });
    });
    const notificationRecordPublisher = { publishForConfirmedOrder: vi.fn() };
    const client = new HttpErpOrderConfirmation({
      baseUrl: "http://mock-erp:4100",
      requestTimeoutMs: 1000,
      retryAfterPolicy: { fallbackDelayMs: 1_000, maximumDelayMs: 60_000 },
      attemptPersistence: new PostgresErpAttemptPersistence(connection.db),
      fetch,
    });
    consumer = buildConsumer(connection, client, {
      scheduledNow: () => policyNow,
      notificationRecordPublisher,
    });
    consumer.start();
    const publisher = createBullMqOrderProcessJobPublisher({
      url: requireTestEnv("TEST_REDIS_URL"),
      maxRetriesPerRequest: null,
    });
    const scanner = createOrderRecoveryScanner({
      persistence: new PostgresOrderRecoveryPersistence(connection.db),
      handler: { handle: vi.fn() },
      publisher,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 60_000,
      batchSize: 1,
      recoveryLeaseMs: 30_000,
      failedJobReader: { findFailedOrderJobs: async () => [] },
      now: () => policyNow,
    });
    try {
      await queue.add(orderProcessJobName, job, { attempts: 1, jobId: job.orderId });
      for (let attempt = 0; attempt < transientFailures; attempt += 1) {
        const jobId = attempt === 0 ? job.orderId : `recovery-${job.orderId}-${attempt}`;
        await vi.waitFor(async () => {
          expect(await (await queue.getJob(jobId))?.getState()).toBe("completed");
        });
        const [control] = await connection.db
          .select({ nextAttemptAt: orderRecoveryJobs.nextAttemptAt })
          .from(orderRecoveryJobs)
          .where(eq(orderRecoveryJobs.orderId, ids.order));
        if (control?.nextAttemptAt) {
          policyNow = new Date(control.nextAttemptAt.getTime() + 1);
        }
        await expect(scanner.scanOnce()).resolves.toMatchObject({ enqueued: 1 });
      }
      await waitForOrderStatus(connection, "confirmed");

      const attempts = await connection.db
        .select()
        .from(erpAttempts)
        .where(eq(erpAttempts.orderId, ids.order));
      const calls = await connection.db
        .select({ id: erpDispatchCalls.id })
        .from(erpDispatchCalls)
        .where(eq(erpDispatchCalls.orderId, ids.order));
      const retainedEvents = await readOrderEvents(connection, ids.order);
      const confirmedEvents = retainedEvents.filter(
        (event) => event.eventName === "order.confirmed",
      );
      const attemptEvents = retainedEvents.filter((event) =>
        event.eventName.startsWith("erp.attempt."),
      );
      const [control] = await connection.db
        .select({ attemptCounts: orderRecoveryJobs.attemptCounts })
        .from(orderRecoveryJobs)
        .where(eq(orderRecoveryJobs.orderId, ids.order));

      expect(fetch).toHaveBeenCalledTimes(transientFailures + 1);
      expect(attempts).toHaveLength(erpAttemptHistoryRetentionLimit);
      expect(attemptEvents).toHaveLength(erpAttemptHistoryRetentionLimit);
      expect(new Set(calls.map((call) => call.id)).size).toBe(erpAttemptHistoryRetentionLimit);
      expect(attempts.some((attempt) => attempt.idempotencyKey !== null)).toBe(true);
      expect(control?.attemptCounts).toMatchObject({
        temporarily_unavailable: transientFailures,
        succeeded: 1,
      });
      expect(confirmedEvents).toHaveLength(1);
      expect(notificationRecordPublisher.publishForConfirmedOrder).toHaveBeenCalledOnce();
    } finally {
      await scanner.close();
      await publisher.close();
    }
  }, 20_000);

  it("retains recognized unavailability after the delivery budget is exhausted", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "failed",
          httpStatus: 503,
          errorCode: "erp_forced_outage",
          errorMessage: "The ERP is temporarily unavailable.",
          latencyMs: 15,
          timestamp: "2026-06-21T00:00:01.015Z",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
    );
    consumer = buildConsumer(
      connection,
      new HttpErpOrderConfirmation({
        baseUrl: "http://mock-erp:4100",
        requestTimeoutMs: 1000,
        retryAfterPolicy: { fallbackDelayMs: 1_000, maximumDelayMs: 60_000 },
        attemptPersistence: new PostgresErpAttemptPersistence(connection.db),
        fetch,
        now: sequenceClock(
          new Date("2026-06-21T00:00:01.000Z"),
          new Date("2026-06-21T00:00:01.015Z"),
        ),
      }),
    );
    consumer.start();

    await queue.add(orderProcessJobName, job, {
      attempts: 1,
      backoff: { type: "exponential", delay: 10 },
      jobId: job.orderId,
    });
    await vi.waitFor(
      async () => {
        const bullJob = await queue.getJob(job.orderId);
        const [order] = await connection.db.select().from(orders).where(eq(orders.id, ids.order));
        expect(await bullJob?.getState()).toBe("completed");
        expect(order?.status).toBe("processing");
      },
      { timeout: 10_000, interval: 25 },
    );
    const bullJob = await queue.getJob(job.orderId);
    const [attempt] = await connection.db
      .select()
      .from(erpAttempts)
      .where(eq(erpAttempts.orderId, ids.order));
    const [order] = await connection.db.select().from(orders).where(eq(orders.id, ids.order));
    const failedEvent = (await readOrderEvents(connection, ids.order)).find(
      (event) => event.eventName === "order.failed",
    );

    expect(await bullJob?.getState()).toBe("completed");
    expect(bullJob?.attemptsMade).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(attempt).toMatchObject({
      attemptNumber: 1,
      status: "failed",
      terminal: false,
      httpStatus: 503,
      errorCode: "erp_forced_outage",
      latencyMs: 15,
    });
    expect(order).toMatchObject({
      status: "processing",
      failureCode: null,
      failureMessage: null,
    });
    expect(failedEvent).toBeUndefined();
  });

  it("leaves an unattributed technical exception nonterminal", async () => {
    const confirmationError = new Error("injected confirmation failure");
    consumer = buildConsumer(connection, { confirm: vi.fn().mockRejectedValue(confirmationError) });
    consumer.start();

    await queue.add(orderProcessJobName, job, { jobId: job.orderId });
    await vi.waitFor(async () => {
      expect(await (await queue.getJob(job.orderId))?.getState()).toBe("failed");
    });
    const bullJob = await queue.getJob(job.orderId);
    const failedEvent = (await readOrderEvents(connection, ids.order)).find(
      (event) => event.eventName === "order.failed",
    );

    expect(await bullJob?.getState()).toBe("failed");
    expect(bullJob?.attemptsMade).toBe(1);
    expect(bullJob?.failedReason).toBe(confirmationError.message);
    expect(failedEvent).toBeUndefined();
    const [order] = await connection.db.select().from(orders).where(eq(orders.id, ids.order));
    expect(order?.status).toBe("processing");
  });
});

function buildConsumer(
  connection: ReturnType<typeof createDatabaseConnection>,
  confirmation: OrderConfirmation | HttpErpOrderConfirmation,
  options: {
    scheduledNow?: () => Date;
    concurrency?: number;
    notificationRecordPublisher?: HandlerDependencies["notificationRecordPublisher"];
  } = {},
): OrderProcessConsumer {
  const logger = createSilentLogger("worker");
  const orderConfirmation =
    confirmation instanceof HttpErpOrderConfirmation
      ? scheduledConfirmation(
          connection,
          confirmation,
          options.concurrency ?? 2,
          options.scheduledNow,
        )
      : confirmation;
  return createBullMqOrderProcessConsumer({
    connection: { url: requireTestEnv("TEST_REDIS_URL"), maxRetriesPerRequest: null },
    concurrency: options.concurrency ?? 2,
    handler: createOrderProcessJobHandler({
      confirmation: orderConfirmation,
      persistence: new PostgresOrderTransitionPersistence(connection.db),
      logger,
      ...(options.notificationRecordPublisher
        ? { notificationRecordPublisher: options.notificationRecordPublisher }
        : {}),
    }),
    logger,
  });
}

function scheduledConfirmation(
  connection: ReturnType<typeof createDatabaseConnection>,
  client: HttpErpOrderConfirmation,
  concurrency: number,
  now?: () => Date,
) {
  const control = new PostgresOrderRecoveryPersistence(connection.db);
  const scopeState = new PostgresErpScopeResiliencePersistence(connection.db);
  const admission = AdaptiveErpRuntimeAdmission.create({
    persistence: scopeState,
    runConfigReader: new PostgresRunConfigReader(connection.db),
    fallbackConcurrency: concurrency,
    ...(now ? { now: () => now().getTime() } : {}),
    random: () => 0,
  });
  return new ScheduledErpOrderConfirmation({
    client,
    reconciler: new ErpUnresolvedCallReconciler({
      client,
      callResolution: control,
      admission,
    }),
    admission,
    control,
    ...(now ? { now } : {}),
  });
}

async function waitForQueueToSettle(queue: Queue): Promise<void> {
  await vi.waitFor(
    async () => {
      const counts = await queue.getJobCounts("active", "waiting");
      expect((counts.active ?? 0) + (counts.waiting ?? 0)).toBe(0);
    },
    { timeout: 5_000 },
  );
}

async function seedQueuedOrder(
  connection: ReturnType<typeof createDatabaseConnection>,
  options: { runScoped?: boolean } = {},
): Promise<void> {
  const testJob = options.runScoped ? runScopedJob : job;
  const configSnapshot = configSnapshotFixture();

  await connection.db.insert(products).values({
    id: ids.product,
    sku: "WORKER-TEST-SKU",
    slug: "worker-test-product",
    name: "Worker Test Product",
  });
  if (options.runScoped) {
    await connection.db.insert(demoPresets).values({
      id: ids.preset,
      slug: "worker-recovery-preset",
      visibility: "public",
      isEditable: false,
      isCustom: false,
      display: {
        name: "Worker Recovery Preset",
        description: "Worker recovery fixture.",
        sortOrder: 1,
        outcomeFocus: ["run_history"],
      },
      ...configSnapshot,
      createdAt: queuedAt,
      updatedAt: queuedAt,
    });
  }
  await connection.db.insert(saleOffers).values({
    id: ids.saleOffer,
    productId: ids.product,
    name: "Worker Test Offer",
    allocatedStock: configSnapshot.inventoryConfig.startingStock,
    saleStartsAt: new Date("2026-01-01T00:00:00.000Z"),
    saleEndsAt: new Date("2030-01-01T00:00:00.000Z"),
    purpose: options.runScoped ? "generated_run" : "catalog",
  });
  if (options.runScoped) {
    await connection.db.insert(demoRuns).values({
      id: ids.run,
      presetId: ids.preset,
      presetName: "Worker Recovery Preset",
      operatorMode: "public",
      status: "draining",
      trafficStatus: "succeeded",
      configSnapshot,
      saleOfferId: ids.saleOffer,
      startedAt: new Date("2026-06-21T00:00:00.000Z"),
      trafficStartedAt: new Date("2026-06-21T00:00:01.000Z"),
      trafficEndedAt: new Date("2026-06-21T00:00:03.000Z"),
      createdAt: queuedAt,
      updatedAt: new Date("2026-06-21T00:00:03.000Z"),
    });
    await connection.db.insert(demoRunSaleContexts).values({
      runId: ids.run,
      saleOfferId: ids.saleOffer,
      createdAt: queuedAt,
      updatedAt: queuedAt,
    });
  }
  await connection.db.insert(reservations).values({
    id: ids.reservation,
    saleOfferId: ids.saleOffer,
    ...(testJob.runId ? { runId: testJob.runId } : {}),
    correlationId: testJob.correlationId,
    quantity: testJob.quantity,
    reservationToken: "worker-test-reservation-token",
    securedAt: queuedAt,
    expiresAt: new Date("2026-06-21T00:15:00.000Z"),
  });
  await connection.db.insert(orders).values({
    id: ids.order,
    publicOrderId: testJob.publicOrderId,
    saleOfferId: ids.saleOffer,
    reservationId: ids.reservation,
    ...(testJob.runId ? { runId: testJob.runId } : {}),
    correlationId: testJob.correlationId,
    quantity: testJob.quantity,
    status: "queued",
    queuedAt,
  });
  await connection.db.insert(orderEvents).values([
    {
      orderId: ids.order,
      reservationId: ids.reservation,
      saleOfferId: ids.saleOffer,
      ...(testJob.runId ? { runId: testJob.runId } : {}),
      correlationId: testJob.correlationId,
      eventName: "reservation.secured",
      payload: { quantity: 1 },
      source: "api",
      occurredAt: queuedAt,
    },
    {
      orderId: ids.order,
      reservationId: ids.reservation,
      saleOfferId: ids.saleOffer,
      ...(testJob.runId ? { runId: testJob.runId } : {}),
      correlationId: testJob.correlationId,
      eventName: "order.queued",
      payload: { quantity: 1 },
      source: "api",
      occurredAt: queuedAt,
    },
  ]);
}

async function seedAdditionalQueuedOrder(
  connection: ReturnType<typeof createDatabaseConnection>,
  additionalJob: OrderProcessJob,
): Promise<void> {
  await connection.db.insert(reservations).values({
    id: additionalJob.reservationId,
    saleOfferId: additionalJob.saleOfferId,
    correlationId: additionalJob.correlationId,
    quantity: additionalJob.quantity,
    reservationToken: `token-${additionalJob.orderId}`,
    securedAt: queuedAt,
    expiresAt: new Date("2026-06-21T00:15:00.000Z"),
  });
  await connection.db.insert(orders).values({
    id: additionalJob.orderId,
    publicOrderId: additionalJob.publicOrderId,
    saleOfferId: additionalJob.saleOfferId,
    reservationId: additionalJob.reservationId,
    correlationId: additionalJob.correlationId,
    quantity: additionalJob.quantity,
    status: "queued",
    queuedAt,
  });
  await connection.db.insert(orderEvents).values([
    {
      orderId: additionalJob.orderId,
      reservationId: additionalJob.reservationId,
      saleOfferId: additionalJob.saleOfferId,
      correlationId: additionalJob.correlationId,
      eventName: "reservation.secured",
      payload: { quantity: additionalJob.quantity },
      source: "api",
      occurredAt: queuedAt,
    },
    {
      orderId: additionalJob.orderId,
      reservationId: additionalJob.reservationId,
      saleOfferId: additionalJob.saleOfferId,
      correlationId: additionalJob.correlationId,
      eventName: "order.queued",
      payload: { quantity: additionalJob.quantity },
      source: "api",
      occurredAt: queuedAt,
    },
  ]);
}

async function seedTrafficCompleteRunArtifacts(
  connection: ReturnType<typeof createDatabaseConnection>,
  redis: Redis,
): Promise<void> {
  const report = trafficCompletionReportFixture();
  await connection.db.insert(demoRunFinalizations).values({
    runId: ids.run,
    exitCode: 0,
    transportAttemptCounts: report.transportAttemptCounts,
    httpSummary: report.httpSummary,
    trafficOutcomeSummary: report.trafficOutcomeSummary,
    trafficDeliverySummary: trafficDeliverySummarySchema.parse({
      ...report.trafficDeliverySummary,
      completedIterations: report.trafficDeliverySummary.completedIterations ?? null,
      trafficDeliveryStatus: "complete",
    }),
    httpTimingBreakdownSummary: report.httpTimingBreakdownSummary,
    loadRunDiagnosticsSummary: report.loadRunDiagnosticsSummary,
    trafficSummaryReceivedAt: new Date(report.completedAt),
    createdAt: new Date(report.completedAt),
    updatedAt: new Date(report.completedAt),
  });
  await initializeInventory(redis, {
    saleOfferId: ids.saleOffer,
    allocatedStock: configSnapshotFixture().inventoryConfig.startingStock,
    initializedAt: queuedAt,
    run: { runId: ids.run, status: "closed" },
  });
}

function createFinalizationService(
  connection: ReturnType<typeof createDatabaseConnection>,
  redis: Redis,
): DemoRunFinalizationService {
  return new DemoRunFinalizationService({
    db: connection.db,
    redis,
    logger: createSilentLogger("api"),
    terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(connection.db),
    terminalInventoryRead: {
      read: ({ saleOfferId, observedAt }) => getInventoryStatus(redis, saleOfferId, observedAt),
    },
    terminalInventoryReadTimeoutMs: 2_000,
    drainTimeoutSeconds: 300,
    now: () => new Date("2026-06-21T00:00:10.000Z"),
  });
}

async function readOrderEvents(
  connection: ReturnType<typeof createDatabaseConnection>,
  orderId: string,
) {
  return connection.db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(asc(orderEvents.occurredAt), asc(orderEvents.createdAt));
}

async function waitForOrderStatus(
  connection: ReturnType<typeof createDatabaseConnection>,
  status: "confirmed" | "failed",
  orderId: string = ids.order,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const [order] = await connection.db.select().from(orders).where(eq(orders.id, orderId));
      expect(order?.status).toBe(status);
    },
    { timeout: 10_000, interval: 25 },
  );
}

async function waitForNotificationCount(
  connection: ReturnType<typeof createDatabaseConnection>,
  expectedCount: number,
  orderId: string = ids.order,
): Promise<void> {
  await vi.waitFor(
    async () => {
      await expect(readNotificationCount(connection, orderId)).resolves.toBe(expectedCount);
    },
    { timeout: 10_000, interval: 25 },
  );
}

async function readNotificationCount(
  connection: ReturnType<typeof createDatabaseConnection>,
  orderId: string = ids.order,
): Promise<number> {
  const notifications = await connection.db
    .select()
    .from(simulatedNotifications)
    .where(eq(simulatedNotifications.orderId, orderId));

  return notifications.length;
}

function configSnapshotFixture(): AcceptedRunConfigSnapshot {
  return {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 1,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 1,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 1,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 10,
      maxTps: 10,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 1000,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 1,
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
    },
  };
}

function trafficCompletionReportFixture(): TrafficCompletionReport {
  return {
    runId: ids.run,
    status: "succeeded",
    exitCode: 0,
    transportAttemptCounts: {
      plannedRequests: 1,
      startedRequests: 1,
      completedRequests: 1,
      interruptedRequests: 0,
      unstartedRequests: 0,
    },
    httpSummary: {
      failedRequests: 0,
      acceptedResponses: 1,
      soldOutResponses: 0,
      transportFailures: 0,
      unexpectedResponses: 0,
      p95LatencyMs: 25,
      failureRate: 0,
    },
    trafficOutcomeSummary: {},
    trafficDeliverySummary: {
      trafficMode: "buyer-spike",
      plannedBuyers: 1,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      requestArrivalSummary: emptyRequestArrivalSummary,
      notes: [],
    },
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    loadRunDiagnosticsSummary: {
      startedAt: "2026-06-20T00:00:00.000Z",
      completedAt: "2026-06-21T00:00:03.000Z",
      nproc: null,
      ulimitNofile: null,
      processMaxOpenFiles: null,
      generatorCapacity: null,
      generatorUtilisation: null,
      networkDiagnostics: null,
      k6Version: null,
      executionPlan: {
        trafficMode: "buyer-spike",
        buyerCount: 1,
        duplicateEachBuyerAttempt: false,
        iterationsPerVu: 1,
        plannedEmittedAttempts: 1,
        startDelaySeconds: 0,
        maxDurationSeconds: 1,
      },
      stderrLines: [],
      stderrLineCountObserved: 0,
      stderrLineCountRetained: 0,
      stderrRetainedLineLimit: 50,
      stderrLineTruncationLength: 500,
      stderrLineTruncatedCount: 0,
      terminalMetricSources: {
        startedRequests: "summary_export",
        completedRequests: "summary_export",
        acceptedResponses: "summary_export",
        soldOutResponses: "summary_export",
        transportFailures: "summary_export" as const,
        unexpectedResponses: "summary_export",
        droppedIterations: "summary_export",
        completedIterations: "summary_export",
      },
      summaryExportWarnings: [],
    },
    completedAt: "2026-06-21T00:00:03.000Z",
    correlationId: job.correlationId,
  };
}

function sequenceClock(...dates: Date[]): () => Date {
  let index = 0;

  return () => {
    const date = dates[index];
    index += 1;

    if (!date) {
      throw new Error("Test clock exhausted.");
    }

    return date;
  };
}

function releaseBarrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
