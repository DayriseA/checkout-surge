import { randomUUID } from "node:crypto";
import type { OrderProcessJob } from "@checkout-surge/contracts";
import { emptyServerReservationTimingSummary } from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import {
  createDatabaseConnection,
  createRedisClient,
  dashboardProjectionScopeKey,
  deleteGeneratedRunDurable,
  demoRunSummaries,
  demoRuns,
  initializeDashboardProjectionScope,
  inspectGeneratedRunTeardown,
  orders,
  PostgresOrderDelivery,
  products,
  readBusinessOutcomeSummary,
  reservations,
  saleOffers,
} from "@checkout-surge/db";
import {
  createPurchaseRunFixture,
  requireTestDatabaseUrl,
  resetTestDatabase,
} from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PostgresTerminalDemoRunSummaryWriter } from "../../../api/src/services/terminal-demo-run-transition.js";
import { syntheticFailedTrafficSummary } from "../../../api/src/services/traffic-delivery-plan.js";
import { HttpErpOrderConfirmation } from "../../src/application/erp-confirmation-client.js";
import { createErpDeclaredDispatchGate } from "../../src/application/erp-declared-dispatch-gate.js";
import {
  ErpUnresolvedCallReconciler,
  ScheduledErpOrderConfirmation,
} from "../../src/application/erp-reconciliation.js";
import { createNotificationRecordJobHandler } from "../../src/application/notification-record-job-handler.js";
import { AdaptiveErpRuntimeAdmission } from "../../src/application/order-process-admission.js";
import { createOrderProcessJobHandler } from "../../src/application/order-process-job-handler.js";
import {
  createOrderRecoveryHandoff,
  createOrderRecoveryScanner,
} from "../../src/application/order-recovery-scanner.js";
import { PostgresErpAttemptPersistence } from "../../src/persistence/postgres-erp-attempt-persistence.js";
import { PostgresErpScopeResiliencePersistence } from "../../src/persistence/postgres-erp-scope-resilience-persistence.js";
import { PostgresGeneratedRunPublicationFence } from "../../src/persistence/postgres-generated-run-publication-fence.js";
import { PostgresNotificationRecordPersistence } from "../../src/persistence/postgres-notification-record-persistence.js";
import { PostgresOrderDispatchPersistence } from "../../src/persistence/postgres-order-dispatch-persistence.js";
import { PostgresOrderRecoveryPersistence } from "../../src/persistence/postgres-order-recovery-persistence.js";
import { PostgresOrderTransitionPersistence } from "../../src/persistence/postgres-order-transition-persistence.js";
import { PostgresRunConfigReader } from "../../src/persistence/postgres-run-config-reader.js";
import { createBullMqNotificationRecordConsumer } from "../../src/queue/bullmq-notification-record-consumer.js";
import {
  createBullMqNotificationRecordPublisher,
  createNotificationRecordPublisher,
} from "../../src/queue/bullmq-notification-record-publisher.js";
import { createPostgresOrderProcessConsumer } from "../../src/queue/postgres-order-process-consumer.js";
import { createPostgresOrderProcessJobPublisher } from "../../src/queue/postgres-order-process-job-publisher.js";

let connection: ReturnType<typeof createDatabaseConnection>;
let delivery: PostgresOrderDelivery;
const logger = createSilentLogger("worker");
const consumers: ReturnType<typeof createPostgresOrderProcessConsumer>[] = [];
beforeEach(async () => {
  await resetTestDatabase({ migrationsFolder: "../../packages/db/drizzle" });
  connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
  delivery = new PostgresOrderDelivery(connection.sql);
});
afterEach(async () => {
  for (const consumer of consumers.splice(0)) await consumer.close();
  await connection.close();
});

async function seed(mode: "demo" | "without_redis"): Promise<OrderProcessJob> {
  const productId = randomUUID();
  const saleOfferId = randomUUID();
  const runId = randomUUID();
  const reservationId = randomUUID();
  const orderId = randomUUID();
  const now = new Date(Date.now() - 1000);
  await connection.db
    .insert(products)
    .values({ id: productId, sku: productId, slug: productId, name: "PG worker test" });
  await connection.db.insert(saleOffers).values({
    id: saleOfferId,
    productId,
    name: "PG worker test",
    allocatedStock: 10,
    saleStartsAt: now,
    saleEndsAt: new Date(Date.now() + 60_000),
  });
  await createPurchaseRunFixture(connection.db, { runId, saleOfferId, status: "draining" });
  await connection.db.update(demoRuns).set({ executionMode: mode }).where(eq(demoRuns.id, runId));
  const job = {
    runId,
    orderId,
    reservationId,
    saleOfferId,
    publicOrderId: `ord_${orderId}`,
    correlationId: "pg-worker-test",
    quantity: 1,
    queuedAt: now.toISOString(),
    processingGeneration: 0,
  };
  await connection.db.insert(reservations).values({
    id: reservationId,
    runId,
    saleOfferId,
    correlationId: job.correlationId,
    quantity: 1,
    reservationToken: reservationId,
    securedAt: now,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await connection.db.insert(orders).values({
    id: orderId,
    publicOrderId: job.publicOrderId,
    reservationId,
    runId,
    saleOfferId,
    correlationId: job.correlationId,
    quantity: 1,
    status: "queued",
    queuedAt: now,
  });
  return job;
}
function publisher() {
  return createPostgresOrderProcessJobPublisher({
    sql: connection.sql,
    delivery,
    publicationFence: new PostgresGeneratedRunPublicationFence(connection.db),
  });
}
function consumer(handler: Parameters<typeof createPostgresOrderProcessConsumer>[0]["handler"]) {
  const result = createPostgresOrderProcessConsumer({
    delivery,
    sql: connection.sql,
    handler,
    recovery: new PostgresOrderRecoveryPersistence(connection.db, undefined, "without_redis"),
    logger,
    concurrency: 1,
    scanIntervalMs: 10,
    leaseSeconds: 30,
    closeDeadlineMs: 1000,
  });
  consumers.push(result);
  return result;
}

it("publishes on the real admitted backend with a pool of one and exposes pending ownership", async () => {
  const job = await seed("without_redis");
  let admittedPid: unknown;
  let publicationPid: unknown;
  const realPublish = delivery.publish.bind(delivery);
  vi.spyOn(delivery, "publish").mockImplementation(async (session, ...args) => {
    publicationPid = (await session`select pg_backend_pid() as pid`)[0]?.pid;
    await realPublish(session, ...args);
  });
  const fence = new PostgresGeneratedRunPublicationFence(connection.db);
  const pgPublisher = createPostgresOrderProcessJobPublisher({
    sql: connection.sql,
    delivery,
    publicationFence: {
      publish: (input) =>
        fence.publish({
          ...input,
          operation: async (session) => {
            admittedPid = (await session`select pg_backend_pid() as pid`)[0]?.pid;
            return input.operation(session);
          },
        }),
    },
  });
  await pgPublisher.enqueue(job);
  expect(publicationPid).toBe(admittedPid);
  expect(typeof admittedPid).toBe("number");
  expect(await pgPublisher.isDeliveryPending(job.orderId)).toBe(true);
  const [claim] = await delivery.claim({ limit: 1, leaseSeconds: 30 });
  if (!claim) throw new Error("Expected delivery claim");
  expect(await pgPublisher.isDeliveryPending(job.orderId)).toBe(true);
  await delivery.settle(claim);
  expect(await pgPublisher.isDeliveryPending(job.orderId)).toBe(false);
  await connection.db
    .update(demoRuns)
    .set({ status: "completed" })
    .where(eq(demoRuns.id, job.runId));
  await expect(pgPublisher.enqueue(await seed("demo"))).rejects.toThrow(
    "does not use PostgreSQL order delivery",
  );
});

it.each([
  "demo",
  "without_redis",
] as const)("partitions %s queued and recoverable SQL batches before their limit", async (mode) => {
  const otherMode = mode === "demo" ? "without_redis" : "demo";
  const previous = await seed(otherMode);
  await connection.db
    .update(demoRuns)
    .set({ status: "completed" })
    .where(eq(demoRuns.id, previous.runId));
  const current = await seed(mode);
  expect(
    await new PostgresOrderDispatchPersistence(connection.db, mode).findQueuedOrdersForDispatch({
      queuedBefore: new Date(),
      limit: 1,
    }),
  ).toEqual([current]);
  expect(
    await new PostgresOrderDispatchPersistence(
      connection.db,
      otherMode,
    ).findQueuedOrdersForDispatch({ queuedBefore: new Date(), limit: 1 }),
  ).toEqual([]);
  for (const job of [previous, current]) {
    const recovery = new PostgresOrderRecoveryPersistence(connection.db, undefined, mode);
    await recovery.recordRecoverable({
      job,
      delivery: { attemptNumber: 1, attemptsMade: 0 },
      reason: "test_dispatch_failure",
      error: new Error("publish failed"),
    });
  }
  const rows = await new PostgresOrderRecoveryPersistence(
    connection.db,
    undefined,
    mode,
  ).findRecoverable({ limit: 1, now: new Date() });
  expect(rows.map((row) => row.job.orderId)).toEqual([current.orderId]);
  expect(
    await new PostgresOrderRecoveryPersistence(connection.db, undefined, otherMode).findRecoverable(
      { limit: 1, now: new Date() },
    ),
  ).toEqual([]);
});

it("renews a recovery publication owner while its real PG delivery remains pending", async () => {
  const job = await seed("without_redis");
  const control = new PostgresOrderRecoveryPersistence(connection.db, undefined, "without_redis");
  await control.recordRecoverable({
    job,
    delivery: { attemptNumber: 1, attemptsMade: 0 },
    reason: "publish_failure",
    error: new Error("publish failed"),
  });
  const pgPublisher = publisher();
  const scanner = createOrderRecoveryScanner({
    persistence: control,
    handler: { handle: vi.fn() },
    publisher: pgPublisher,
    deliveryStateReader: pgPublisher,
    logger,
    scanIntervalMs: 10,
    batchSize: 1,
  });
  expect((await scanner.scanOnce()).enqueued).toBe(1);
  const before = await control.readControlRecord({ orderId: job.orderId });
  await connection.sql`update order_recovery_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where order_id=${job.orderId}`;
  expect((await scanner.scanOnce()).enqueued).toBe(0);
  expect(await control.readControlRecord({ orderId: job.orderId })).toMatchObject({
    processingGeneration: before?.processingGeneration,
    publicationOwner: before?.publicationOwner,
  });
  await scanner.close();
});

it("durably defers then republishes through PG recovery into the existing business and notification publishers", async () => {
  const job = await seed("without_redis");
  await connection.sql`update demo_runs set config_snapshot=jsonb_set(config_snapshot,'{erpConfig,maxTps}','1'::jsonb) where id=${job.runId}`;
  const reader = new PostgresRunConfigReader(connection.db);
  const control = new PostgresOrderRecoveryPersistence(connection.db, undefined, "without_redis");
  const admission = await AdaptiveErpRuntimeAdmission.restore({
    pauseDelivery: async () => {},
    persistence: new PostgresErpScopeResiliencePersistence(connection.db),
    runConfigReader: reader,
    reconciliationConcurrency: 1,
  });
  const gate = createErpDeclaredDispatchGate();
  const dispatchContext = await admission.context(job);
  expect(dispatchContext.dispatch).toEqual({ executionMode: "without_redis", maxTps: 1 });
  await gate.tryAcquire(dispatchContext);
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
    Response.json({
      status: "succeeded",
      confirmationId: "erp_pg",
      httpStatus: 200,
      latencyMs: 1,
      timestamp: new Date().toISOString(),
    }),
  );
  const client = new HttpErpOrderConfirmation({
    baseUrl: "http://mock-erp:4100",
    lookupTimeoutMs: 2000,
    retryAfterPolicy: { fallbackDelayMs: 1000, maximumDelayMs: 60000 },
    attemptPersistence: new PostgresErpAttemptPersistence(connection.db),
    runConfigReader: reader,
    fetch,
  });
  const addNotification = vi.fn().mockResolvedValue(undefined);
  const notifications = createNotificationRecordPublisher(
    { add: addNotification, close: async () => {} },
    { publicationFence: new PostgresGeneratedRunPublicationFence(connection.db) },
  );
  const handler = createOrderProcessJobHandler({
    confirmation: new ScheduledErpOrderConfirmation({
      client,
      admission,
      declaredDispatchGate: gate,
      reconciler: new ErpUnresolvedCallReconciler({
        client,
        admission,
        declaredDispatchGate: gate,
        callResolution: control,
      }),
      control,
    }),
    persistence: new PostgresOrderTransitionPersistence(connection.db),
    logger,
    recovery: createOrderRecoveryHandoff(control),
    notificationRecordPublisher: notifications,
    publishBusinessOutcomeUpdate: async () => {},
  });
  const pgPublisher = publisher();
  await pgPublisher.enqueue(job);
  const pgConsumer = consumer(handler);
  pgConsumer.start();
  await vi.waitFor(
    async () =>
      expect(await control.readControlRecord({ orderId: job.orderId })).toMatchObject({
        waitingReason: "local_admission",
        processingGeneration: 0,
      }),
    { interval: 10 },
  );
  expect(fetch).not.toHaveBeenCalled();
  const scanner = createOrderRecoveryScanner({
    persistence: control,
    handler,
    publisher: pgPublisher,
    deliveryStateReader: pgPublisher,
    logger,
    scanIntervalMs: 10,
    batchSize: 1,
  });
  await vi.waitFor(async () => expect((await scanner.scanOnce()).enqueued).toBe(1), {
    interval: 20,
    timeout: 2500,
  });
  await vi.waitFor(
    async () => {
      expect(
        (await connection.db.select().from(orders).where(eq(orders.id, job.orderId)))[0]?.status,
      ).toBe("confirmed");
      expect(addNotification).toHaveBeenCalledOnce();
    },
    { interval: 10 },
  );
  expect(fetch).toHaveBeenCalledOnce();
  expect(addNotification.mock.calls[0]?.[1]).toMatchObject({
    orderId: job.orderId,
    runId: job.runId,
  });
  expect(await control.readControlRecord({ orderId: job.orderId })).toMatchObject({
    status: "resolved",
    processingGeneration: 1,
  });
  // A settled initial publication can be replayed; terminal business state prevents another POST or notification.
  await pgPublisher.enqueue(job);
  await vi.waitFor(
    async () => expect(await pgPublisher.isDeliveryPending(job.orderId)).toBe(false),
    { interval: 10 },
  );
  expect(fetch).toHaveBeenCalledOnce();
  expect(addNotification).toHaveBeenCalledOnce();
  await pgConsumer.close();
  await scanner.close();
  await admission.close();
});

it("cannot acknowledge a newer claim after its old delivery lease expires", async () => {
  const job = await seed("without_redis");
  await publisher().enqueue(job);
  let finish!: () => void;
  const handle = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pgConsumer = consumer({ handle });
  pgConsumer.start();
  await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce(), { interval: 10 });
  await connection.sql`update postgres_order_deliveries set lease_until=clock_timestamp()-interval '1 second' where publication_id=${job.orderId}`;
  const [newClaim] = await delivery.claim({ limit: 1, leaseSeconds: 30 });
  if (!newClaim) throw new Error("Expected reclaimed delivery");
  finish();
  await pgConsumer.close();
  const [row] =
    await connection.sql`select delivery_generation,settled_at from postgres_order_deliveries where publication_id=${job.orderId}`;
  expect(row).toMatchObject({ delivery_generation: newClaim.deliveryGeneration, settled_at: null });
});

it.each([
  "confirmed",
  "failed",
] as const)("settles a lost ACK for a terminal %s order without repeating business work", async (outcome) => {
  const job = await seed("without_redis");
  const redisUrl = process.env.TEST_REDIS_URL;
  if (!redisUrl) throw new Error("TEST_REDIS_URL is required for the real notification transport.");
  const redis = createRedisClient(redisUrl, { lazyConnect: true });
  await initializeDashboardProjectionScope(redis, job);
  const projectionScope = await redis.get(dashboardProjectionScopeKey(job.runId));
  const notificationConnection = { url: redisUrl, maxRetriesPerRequest: null };
  const notifications = createBullMqNotificationRecordPublisher({
    connection: notificationConnection,
    publicationFence: new PostgresGeneratedRunPublicationFence(connection.db),
  });
  const notificationHandler = createNotificationRecordJobHandler({
    persistence: new PostgresNotificationRecordPersistence(connection.db),
    logger,
    publishBusinessOutcomeUpdate: async () => {},
  });
  const record = vi.spyOn(notificationHandler, "handle");
  const notificationConsumer = createBullMqNotificationRecordConsumer({
    connection: notificationConnection,
    concurrency: 1,
    handler: notificationHandler,
    logger,
  });
  const confirmation = vi.fn().mockResolvedValue(
    outcome === "confirmed"
      ? { disposition: "succeeded" }
      : {
          disposition: "technical_failure",
          errorCode: "erp_response_contract_invalid",
          errorMessage: "Invalid ERP response",
        },
  );
  const publish = vi.spyOn(notifications, "publishForConfirmedOrder");
  const businessUpdates = vi.fn().mockResolvedValue(undefined);
  const handler = createOrderProcessJobHandler({
    confirmation: { confirm: confirmation },
    persistence: new PostgresOrderTransitionPersistence(connection.db),
    recovery: createOrderRecoveryHandoff(
      new PostgresOrderRecoveryPersistence(connection.db, undefined, "without_redis"),
    ),
    logger,
    notificationRecordPublisher: notifications,
    publishBusinessOutcomeUpdate: businessUpdates,
  });
  let release!: () => void;
  let businessDone = false;
  const afterBusiness = new Promise<void>((resolve) => {
    release = resolve;
  });
  const oldConsumer = consumer({
    handle: async (...args) => {
      await handler.handle(...args);
      businessDone = true;
      await afterBusiness;
    },
  });
  notificationConsumer.start();
  try {
    await publisher().enqueue(job);
    oldConsumer.start();
    await vi.waitFor(() => expect(businessDone).toBe(true), { interval: 10 });
    await vi.waitFor(async () => {
      expect(await readBusinessOutcomeSummary(connection.db, job)).toMatchObject({
        confirmedOrders: outcome === "confirmed" ? 1 : 0,
        failedOrders: outcome === "failed" ? 1 : 0,
        notificationsRecorded: outcome === "confirmed" ? 1 : 0,
      });
    });
    const writer = new PostgresTerminalDemoRunSummaryWriter(connection.db, {
      synchronize: async () => {},
    });
    expect(
      await writer.writePrepared(job.runId, async (tx) => {
        const [run] = await tx.select().from(demoRuns).where(eq(demoRuns.id, job.runId));
        if (!run) throw new Error("Missing run");
        return {
          run,
          terminalStatus: "failed",
          failureReason: "traffic_failed",
          replayPossible: false,
          finalizedAt: new Date(),
          allowedCurrentStatuses: ["draining"],
          terminalTrafficStatus: "failed",
          ...syntheticFailedTrafficSummary(
            previewRunConfigSnapshotFixture(),
            ["Traffic completion unavailable after runner failure"],
            "unavailable",
          ),
          httpTimingBreakdownSummary: {},
          serverReservationTimingSummary: emptyServerReservationTimingSummary,
          loadRunDiagnosticsSummary: {},
          businessOutcome: await readBusinessOutcomeSummary(tx, job),
          terminalInventorySnapshot: null,
          runSignalTimelineSummary: null,
        };
      }),
    ).toBe(true);
    const before = {
      summaries: await connection.db.select().from(demoRunSummaries),
      events: await connection.sql`select * from order_events order by id`,
      order: await connection.db.select().from(orders),
      control: await connection.sql`select * from order_recovery_jobs`,
    };
    expect(await inspectGeneratedRunTeardown(connection.db, job.runId)).toEqual({
      outcome: "outstanding_work",
    });
    expect(await deleteGeneratedRunDurable(connection.db, job)).toEqual({
      outcome: "outstanding_work",
    });
    await oldConsumer.close(); // The handler is still alive past the forced-close deadline.
    expect(await delivery.claim({ limit: 1, leaseSeconds: 30 })).toEqual([]);
    await connection.sql`update postgres_order_deliveries set lease_until=clock_timestamp()-interval '1 second' where publication_id=${job.orderId}`;
    const fresh = consumer(handler);
    fresh.start();
    await vi.waitFor(
      async () => expect(await publisher().isDeliveryPending(job.orderId)).toBe(false),
      { interval: 10 },
    );
    await fresh.close();
    release();
    await afterBusiness;
    expect(confirmation).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledTimes(outcome === "confirmed" ? 1 : 0);
    expect(record).toHaveBeenCalledTimes(outcome === "confirmed" ? 1 : 0);
    expect(businessUpdates).toHaveBeenCalledTimes(2);
    expect({
      summaries: await connection.db.select().from(demoRunSummaries),
      events: await connection.sql`select * from order_events order by id`,
      order: await connection.db.select().from(orders),
      control: await connection.sql`select * from order_recovery_jobs`,
    }).toEqual(before);
    expect(await redis.get(dashboardProjectionScopeKey(job.runId))).toBe(projectionScope);
    expect(await inspectGeneratedRunTeardown(connection.db, job.runId)).toMatchObject({
      outcome: "ready",
    });
    expect(await deleteGeneratedRunDurable(connection.db, job)).toEqual({ outcome: "deleted" });
  } finally {
    release();
    await oldConsumer.close();
    await notificationConsumer.close();
    await notifications.close();
    redis.disconnect();
  }
});
