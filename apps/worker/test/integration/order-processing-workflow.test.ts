import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type NotificationRecordJob,
  type OrderProcessJob,
  orderProcessBullMqQueueName,
  orderProcessJobName,
} from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  erpAttempts,
  orderEvents,
  orders,
  products,
  reservations,
  saleOffers,
  simulatedNotifications,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { Queue } from "bullmq";
import { and, asc, eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HttpErpOrderConfirmation,
  isTemporaryErpConfirmationError,
} from "../../src/application/erp-confirmation-client.js";
import {
  createOrderProcessJobHandler,
  type OrderConfirmation,
  type OrderTransitionPersistence,
} from "../../src/application/order-process-job-handler.js";
import { PostgresErpAttemptPersistence } from "../../src/persistence/postgres-erp-attempt-persistence.js";
import {
  NotificationBeforeConfirmationError,
  PostgresNotificationRecordPersistence,
} from "../../src/persistence/postgres-notification-record-persistence.js";
import {
  OrderJobIdentityMismatchError,
  OrderNotFoundError,
  PostgresOrderTransitionPersistence,
} from "../../src/persistence/postgres-order-transition-persistence.js";
import {
  createBullMqOrderProcessConsumer,
  type OrderProcessJobFailureReport,
} from "../../src/queue/bullmq-order-process-consumer.js";
import type { OrderProcessConsumer } from "../../src/queue/order-process-consumer.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = path.resolve(packageRoot, "../../packages/db/drizzle");
const ids = {
  product: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
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
};

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

  it("atomically persists processing and confirmation with exact durable history", async () => {
    const times = [new Date("2026-06-21T00:00:01.000Z"), new Date("2026-06-21T00:00:02.000Z")];
    const persistence = new PostgresOrderTransitionPersistence(connection.db, () => {
      const time = times.shift();
      if (!time) throw new Error("Unexpected clock read");
      return time;
    });

    await expect(
      persistence.transitionToProcessing(job, { attemptNumber: 2, attemptsMade: 1 }),
    ).resolves.toEqual({ status: "processing", resumed: false });
    await persistence.transitionToConfirmed(job, { attemptNumber: 2, attemptsMade: 1 });

    const [order] = await connection.db.select().from(orders).where(eq(orders.id, ids.order));
    const events = await readOrderEvents(connection, ids.order);

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
        payload: { orderStatus: "processing", attemptNumber: 2, attemptsMade: 1 },
      },
      {
        orderId: ids.order,
        reservationId: ids.reservation,
        saleOfferId: ids.saleOffer,
        runId: null,
        correlationId: job.correlationId,
        source: "worker",
        occurredAt: new Date("2026-06-21T00:00:02.000Z"),
        payload: { orderStatus: "confirmed", attemptNumber: 2, attemptsMade: 1 },
      },
    ]);
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
        persistence.transitionToProcessing(job, { attemptNumber: 1, attemptsMade: 0 }),
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
    const delivery = { attemptNumber: 1, attemptsMade: 0 };

    const processingResults = await Promise.all([
      persistence.transitionToProcessing(job, delivery),
      persistence.transitionToProcessing(job, delivery),
    ]);
    await Promise.all([
      persistence.transitionToConfirmed(job, delivery),
      persistence.transitionToConfirmed(job, delivery),
    ]);
    const events = await readOrderEvents(connection, ids.order);

    expect(processingResults).toEqual(
      expect.arrayContaining([
        { status: "processing", resumed: false },
        { status: "processing", resumed: true },
      ]),
    );
    expect(events.filter((event) => event.eventName === "order.processing")).toHaveLength(1);
    expect(events.filter((event) => event.eventName === "order.confirmed")).toHaveLength(1);

    await expect(persistence.transitionToProcessing(job, delivery)).resolves.toEqual({
      status: "confirmed",
      resumed: false,
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
      channel: "email",
      recipientPlaceholder: "simulated-buyer:ord_worker_integration",
      confirmedAt: "2026-06-21T00:00:02.000Z",
    };

    await expect(notificationPersistence.record(notificationJob)).rejects.toBeInstanceOf(
      NotificationBeforeConfirmationError,
    );
    await transitionPersistence.transitionToProcessing(job, { attemptNumber: 1, attemptsMade: 0 });
    await transitionPersistence.transitionToConfirmed(job, { attemptNumber: 1, attemptsMade: 0 });

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
        channel: "email",
        recipientPlaceholder: "simulated-buyer:ord_worker_integration",
        status: "recorded",
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
        channel: "email",
        recipientPlaceholder: "simulated-buyer:ord_worker_integration",
        notificationStatus: "recorded",
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
    const delivery = { attemptNumber: 4, attemptsMade: 3 };

    await persistence.transitionToProcessing(job, delivery);
    await persistence.transitionToFailed(
      job,
      { code: "order_confirmation_failed", message: "placeholder confirmation failed" },
      delivery,
    );
    await persistence.transitionToFailed(
      job,
      { code: "different", message: "must not overwrite" },
      { attemptNumber: 5, attemptsMade: 4 },
    );

    const [order] = await connection.db.select().from(orders).where(eq(orders.id, ids.order));
    const failedEvents = (await readOrderEvents(connection, ids.order)).filter(
      (event) => event.eventName === "order.failed",
    );
    expect(order).toMatchObject({
      status: "failed",
      failedAt,
      failureCode: "order_confirmation_failed",
      failureMessage: "placeholder confirmation failed",
    });
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.payload).toEqual({
      orderStatus: "failed",
      attemptNumber: 4,
      attemptsMade: 3,
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
      delivery: { attemptNumber: 3, attemptsMade: 2 },
      status: "failed",
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
        attemptNumber: 3,
        attemptsMade: 2,
        httpStatus: 503,
        errorCode: "erp_unavailable",
        errorMessage: "The ERP is temporarily unavailable.",
        latencyMs: 75,
      },
    });
  });

  it("reuses a successful ERP attempt after confirmed-state persistence fails", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "succeeded",
          confirmationId: "erp_confirmation_reused",
          httpStatus: 200,
          latencyMs: 20,
          timestamp: "2026-06-21T00:00:02.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const confirmedPersistenceError = new Error("confirmed persistence unavailable");
    const innerPersistence = new PostgresOrderTransitionPersistence(connection.db);
    let failNextConfirmation = true;
    const transitionToConfirmed = vi.fn(
      async (...args: Parameters<OrderTransitionPersistence["transitionToConfirmed"]>) => {
        if (failNextConfirmation) {
          failNextConfirmation = false;
          throw confirmedPersistenceError;
        }

        await innerPersistence.transitionToConfirmed(...args);
      },
    );
    const persistence: OrderTransitionPersistence = {
      transitionToProcessing: (...args) => innerPersistence.transitionToProcessing(...args),
      transitionToConfirmed,
      transitionToFailed: (...args) => innerPersistence.transitionToFailed(...args),
    };
    const handler = createOrderProcessJobHandler({
      confirmation: new HttpErpOrderConfirmation({
        baseUrl: "http://mock-erp:4100",
        requestTimeoutMs: 1000,
        attemptPersistence: new PostgresErpAttemptPersistence(connection.db),
        fetch,
        now: sequenceClock(
          new Date("2026-06-21T00:00:01.000Z"),
          new Date("2026-06-21T00:00:01.020Z"),
        ),
      }),
      persistence,
      logger: createSilentLogger("worker"),
      isTemporaryConfirmationFailure: isTemporaryErpConfirmationError,
    });

    await expect(
      handler.handle(job, { attemptNumber: 1, attemptsMade: 0, maxAttempts: 2 }),
    ).rejects.toBe(confirmedPersistenceError);
    await expect(
      handler.handle(job, { attemptNumber: 2, attemptsMade: 1, maxAttempts: 2 }),
    ).resolves.toBeUndefined();

    const [order] = await connection.db.select().from(orders).where(eq(orders.id, ids.order));
    const attempts = await connection.db
      .select()
      .from(erpAttempts)
      .where(eq(erpAttempts.orderId, ids.order))
      .orderBy(asc(erpAttempts.attemptNumber));

    expect(fetch).toHaveBeenCalledOnce();
    expect(transitionToConfirmed).toHaveBeenCalledTimes(2);
    expect(order?.status).toBe("confirmed");
    expect(attempts).toMatchObject([
      {
        attemptNumber: 1,
        status: "succeeded",
        httpStatus: 200,
      },
    ]);
  });

  it("fails missing and materially mismatched jobs without fabricating events", async () => {
    const persistence = new PostgresOrderTransitionPersistence(connection.db);
    const eventCountBefore = (await readOrderEvents(connection, ids.order)).length;

    await expect(
      persistence.transitionToProcessing(
        { ...job, orderId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
        { attemptNumber: 1, attemptsMade: 0 },
      ),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
    const mismatch = await persistence
      .transitionToProcessing(
        { ...job, correlationId: "wrong-correlation", quantity: 2 },
        { attemptNumber: 1, attemptsMade: 0 },
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
      httpStatus: 200,
      latencyMs: 20,
      startedAt: new Date("2026-06-21T00:00:01.000Z"),
      finishedAt: new Date("2026-06-21T00:00:01.020Z"),
    });
    expect(attemptEvent?.payload).toMatchObject({
      erpAttemptStatus: "succeeded",
      attemptNumber: 1,
      attemptsMade: 0,
      httpStatus: 200,
      latencyMs: 20,
    });
  });

  it("retries temporary ERP failures without terminally failing the order", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "failed",
            httpStatus: 503,
            errorCode: "erp_unavailable",
            errorMessage: "The ERP is temporarily unavailable.",
            latencyMs: 10,
            timestamp: "2026-06-21T00:00:01.010Z",
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "succeeded",
            confirmationId: "erp_confirmation_retry_success",
            httpStatus: 200,
            latencyMs: 20,
            timestamp: "2026-06-21T00:00:02.020Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    consumer = buildConsumer(
      connection,
      new HttpErpOrderConfirmation({
        baseUrl: "http://mock-erp:4100",
        requestTimeoutMs: 1000,
        attemptPersistence: new PostgresErpAttemptPersistence(connection.db),
        fetch,
        now: sequenceClock(
          new Date("2026-06-21T00:00:01.000Z"),
          new Date("2026-06-21T00:00:01.010Z"),
          new Date("2026-06-21T00:00:02.000Z"),
          new Date("2026-06-21T00:00:02.020Z"),
        ),
      }),
      undefined,
      isTemporaryErpConfirmationError,
    );
    consumer.start();

    await queue.add(orderProcessJobName, job, {
      attempts: 2,
      backoff: { type: "exponential", delay: 10 },
      jobId: job.orderId,
    });
    await waitForOrderStatus(connection, "confirmed");
    const attempts = await connection.db
      .select()
      .from(erpAttempts)
      .where(eq(erpAttempts.orderId, ids.order))
      .orderBy(asc(erpAttempts.attemptNumber));
    const failedEvents = (await readOrderEvents(connection, ids.order)).filter(
      (event) => event.eventName === "order.failed",
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(attempts).toMatchObject([
      {
        attemptNumber: 1,
        status: "failed",
        httpStatus: 503,
        errorCode: "erp_unavailable",
        latencyMs: 10,
      },
      {
        attemptNumber: 2,
        status: "succeeded",
        httpStatus: 200,
        latencyMs: 20,
      },
    ]);
    expect(failedEvents).toHaveLength(0);
  });

  it("persists terminal order failure after the ERP retry budget is exhausted", async () => {
    const failed = deferred<OrderProcessJobFailureReport>();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "failed",
          httpStatus: 503,
          errorCode: "erp_unavailable",
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
        attemptPersistence: new PostgresErpAttemptPersistence(connection.db),
        fetch,
        now: sequenceClock(
          new Date("2026-06-21T00:00:01.000Z"),
          new Date("2026-06-21T00:00:01.015Z"),
        ),
      }),
      failed.resolve,
      isTemporaryErpConfirmationError,
    );
    consumer.start();

    await queue.add(orderProcessJobName, job, {
      attempts: 1,
      backoff: { type: "exponential", delay: 10 },
      jobId: job.orderId,
    });
    const report = await failed.promise;
    await waitForOrderStatus(connection, "failed");
    const [attempt] = await connection.db
      .select()
      .from(erpAttempts)
      .where(eq(erpAttempts.orderId, ids.order));
    const [order] = await connection.db.select().from(orders).where(eq(orders.id, ids.order));
    const failedEvent = (await readOrderEvents(connection, ids.order)).find(
      (event) => event.eventName === "order.failed",
    );

    expect(report).toMatchObject({ jobId: job.orderId, attemptsMade: 1 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(attempt).toMatchObject({
      attemptNumber: 1,
      status: "failed",
      httpStatus: 503,
      errorCode: "erp_unavailable",
      latencyMs: 15,
    });
    expect(order).toMatchObject({
      status: "failed",
      failureCode: "order_confirmation_failed",
      failureMessage: "The ERP is temporarily unavailable.",
    });
    expect(failedEvent?.payload).toMatchObject({
      orderStatus: "failed",
      attemptNumber: 1,
      attemptsMade: 0,
      failureCode: "order_confirmation_failed",
    });
  });

  it("persists an injected failure and leaves the BullMQ job failed with attempt metadata", async () => {
    const confirmationError = new Error("injected confirmation failure");
    const failed = deferred<OrderProcessJobFailureReport>();
    consumer = buildConsumer(
      connection,
      { confirm: vi.fn().mockRejectedValue(confirmationError) },
      failed.resolve,
    );
    consumer.start();

    await queue.add(orderProcessJobName, job, { jobId: job.orderId });
    const report = await failed.promise;
    await waitForOrderStatus(connection, "failed");
    const bullJob = await queue.getJob(job.orderId);
    const failedEvent = (await readOrderEvents(connection, ids.order)).find(
      (event) => event.eventName === "order.failed",
    );

    expect(report).toMatchObject({
      jobId: job.orderId,
      attemptNumber: 1,
      attemptsMade: 1,
      error: confirmationError,
    });
    expect(await bullJob?.getState()).toBe("failed");
    expect(bullJob?.attemptsMade).toBe(1);
    expect(failedEvent?.payload).toMatchObject({ attemptNumber: 1, attemptsMade: 0 });
  });
});

function buildConsumer(
  connection: ReturnType<typeof createDatabaseConnection>,
  confirmation: OrderConfirmation,
  reportFailure?: (report: OrderProcessJobFailureReport) => void,
  isTemporaryConfirmationFailure?: (error: unknown) => boolean,
): OrderProcessConsumer {
  const logger = createSilentLogger("worker");
  return createBullMqOrderProcessConsumer({
    connection: { url: requireTestEnv("TEST_REDIS_URL"), maxRetriesPerRequest: null },
    concurrency: 2,
    handler: createOrderProcessJobHandler({
      confirmation,
      persistence: new PostgresOrderTransitionPersistence(connection.db),
      logger,
      ...(isTemporaryConfirmationFailure ? { isTemporaryConfirmationFailure } : {}),
    }),
    logger,
    ...(reportFailure ? { reportFailure } : {}),
  });
}

async function seedQueuedOrder(
  connection: ReturnType<typeof createDatabaseConnection>,
): Promise<void> {
  await connection.db.insert(products).values({
    id: ids.product,
    sku: "WORKER-TEST-SKU",
    slug: "worker-test-product",
    name: "Worker Test Product",
  });
  await connection.db.insert(saleOffers).values({
    id: ids.saleOffer,
    productId: ids.product,
    name: "Worker Test Offer",
    allocatedStock: 1,
    saleStartsAt: new Date("2026-01-01T00:00:00.000Z"),
    saleEndsAt: new Date("2030-01-01T00:00:00.000Z"),
  });
  await connection.db.insert(reservations).values({
    id: ids.reservation,
    saleOfferId: ids.saleOffer,
    correlationId: job.correlationId,
    quantity: job.quantity,
    status: "secured",
    reservationToken: "worker-test-reservation-token",
    securedAt: queuedAt,
    expiresAt: new Date("2026-06-21T00:15:00.000Z"),
  });
  await connection.db.insert(orders).values({
    id: ids.order,
    publicOrderId: job.publicOrderId,
    saleOfferId: ids.saleOffer,
    reservationId: ids.reservation,
    correlationId: job.correlationId,
    quantity: job.quantity,
    status: "queued",
    queuedAt,
  });
  await connection.db.insert(orderEvents).values([
    {
      orderId: ids.order,
      reservationId: ids.reservation,
      saleOfferId: ids.saleOffer,
      correlationId: job.correlationId,
      eventName: "reservation.secured",
      payload: { quantity: 1, reservationStatus: "secured" },
      source: "api",
      occurredAt: queuedAt,
    },
    {
      orderId: ids.order,
      reservationId: ids.reservation,
      saleOfferId: ids.saleOffer,
      correlationId: job.correlationId,
      eventName: "order.queued",
      payload: { quantity: 1, orderStatus: "queued" },
      source: "api",
      occurredAt: queuedAt,
    },
  ]);
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
): Promise<void> {
  await vi.waitFor(
    async () => {
      const [order] = await connection.db.select().from(orders).where(eq(orders.id, ids.order));
      expect(order?.status).toBe(status);
    },
    { timeout: 10_000, interval: 25 },
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
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
