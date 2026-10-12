import { randomUUID } from "node:crypto";
import {
  erpConfirmationLookupPath,
  erpConfirmationPath,
  notificationRecordBullMqQueueName,
  orderProcessBullMqQueueName,
} from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  demoRuns,
  orders,
  products,
  reservations,
  saleOffers,
  terminalDemoRunTransitionLockKey,
} from "@checkout-surge/db";
import {
  createPurchaseRunFixture,
  requireTestDatabaseUrl,
  resetTestDatabase,
} from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { Queue } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { fastify } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  HttpErpOrderConfirmation,
  toConfirmationIdempotencyKey,
} from "../../src/application/erp-confirmation-client.js";
import { createErpDeclaredDispatchGate } from "../../src/application/erp-declared-dispatch-gate.js";
import {
  ErpUnresolvedCallReconciler,
  ScheduledErpOrderConfirmation,
} from "../../src/application/erp-reconciliation.js";
import { InlineOrderConfirmation } from "../../src/application/inline-order-confirmation.js";
import { createInlineOrderRecoveryScanner } from "../../src/application/inline-order-recovery-scanner.js";
import { createNotificationRecordJobHandler } from "../../src/application/notification-record-job-handler.js";
import { AdaptiveErpRuntimeAdmission } from "../../src/application/order-process-admission.js";
import { createOrderProcessJobHandler } from "../../src/application/order-process-job-handler.js";
import { createOrderRecoveryHandoff } from "../../src/application/order-recovery-scanner.js";
import { PostgresErpAttemptPersistence } from "../../src/persistence/postgres-erp-attempt-persistence.js";
import { PostgresErpScopeResiliencePersistence } from "../../src/persistence/postgres-erp-scope-resilience-persistence.js";
import { PostgresGeneratedRunPublicationFence } from "../../src/persistence/postgres-generated-run-publication-fence.js";
import { PostgresInlineOrderConfirmationReader } from "../../src/persistence/postgres-inline-order-confirmation-reader.js";
import { PostgresNotificationRecordPersistence } from "../../src/persistence/postgres-notification-record-persistence.js";
import { PostgresOrderDispatchPersistence } from "../../src/persistence/postgres-order-dispatch-persistence.js";
import { PostgresOrderRecoveryPersistence } from "../../src/persistence/postgres-order-recovery-persistence.js";
import { PostgresOrderTransitionPersistence } from "../../src/persistence/postgres-order-transition-persistence.js";
import { PostgresRunConfigReader } from "../../src/persistence/postgres-run-config-reader.js";
import { createBullMqNotificationRecordConsumer } from "../../src/queue/bullmq-notification-record-consumer.js";
import { createBullMqNotificationRecordPublisher } from "../../src/queue/bullmq-notification-record-publisher.js";
import { buildWorkerHealthServer } from "../../src/server.js";

let db: ReturnType<typeof createDatabaseConnection>;
const lookupTimeoutMs = 1000;
const cleanups: Array<() => Promise<unknown> | undefined> = [];
beforeEach(async () => {
  await resetTestDatabase({ migrationsFolder: "../../packages/db/drizzle" });
  db = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
});
afterEach(async () => {
  for (const close of cleanups.reverse()) await close();
  cleanups.length = 0;
  await db.close();
});

async function seed(securedAt = new Date()) {
  const productId = randomUUID(),
    saleOfferId = randomUUID(),
    runId = randomUUID(),
    reservationId = randomUUID(),
    orderId = randomUUID();
  await db.db
    .insert(products)
    .values({ id: productId, sku: productId, slug: productId, name: "Inline worker" });
  await db.db.insert(saleOffers).values({
    id: saleOfferId,
    productId,
    name: "Inline worker",
    allocatedStock: 10,
    saleStartsAt: securedAt,
    saleEndsAt: new Date(Date.now() + 60_000),
  });
  await createPurchaseRunFixture(db.db, { runId, saleOfferId, status: "draining" });
  await db.db
    .update(demoRuns)
    .set({ executionMode: "without_order_queue" })
    .where(eq(demoRuns.id, runId));
  const request = { orderId, reservationId, saleOfferId, runId, correlationId: "buyer-retry" };
  await db.db.insert(reservations).values({
    id: reservationId,
    runId,
    saleOfferId,
    correlationId: "original",
    quantity: 1,
    reservationToken: reservationId,
    securedAt,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await db.db.insert(orders).values({
    id: orderId,
    publicOrderId: `ord_${orderId}`,
    reservationId,
    runId,
    saleOfferId,
    correlationId: "original",
    quantity: 1,
    status: "queued",
    queuedAt: new Date(),
  });
  return request;
}

async function runtime(
  options: { holdPost?: boolean; holdConfirmation?: boolean; knownLookup?: boolean } = {},
) {
  const erp = fastify();
  let posts = 0,
    lookups = 0,
    confirmations = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  erp.post(erpConfirmationPath, async () => {
    posts++;
    // Pool=1 proves the processing path released its DB connection before HTTP.
    await db.sql`select 1`;
    if (options.holdPost) await held;
    return {
      status: "succeeded",
      confirmationId: "erp_inline",
      httpStatus: 200,
      latencyMs: 1,
      timestamp: new Date().toISOString(),
    };
  });
  erp.get(erpConfirmationLookupPath, async (request) => {
    lookups++;
    const query = request.params as { idempotencyKey: string };
    if (options.knownLookup) {
      const [order] = await db.db.select().from(orders).limit(1);
      if (!order) throw new Error("Expected durable order");
      return {
        lookup: {
          status: "succeeded",
          identity: {
            orderId: order.id,
            publicOrderId: order.publicOrderId,
            reservationId: order.reservationId,
            saleOfferId: order.saleOfferId,
            runId: order.runId,
            quantity: order.quantity,
            idempotencyKey: query.idempotencyKey,
          },
          result: {
            status: "succeeded",
            confirmationId: "erp-recovered",
            httpStatus: 200,
            latencyMs: 1,
            timestamp: new Date().toISOString(),
          },
        },
        timestamp: new Date().toISOString(),
      };
    }
    return {
      lookup: { status: "unknown", idempotencyKey: query.idempotencyKey },
      timestamp: new Date().toISOString(),
    };
  });
  const baseUrl = await erp.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    release();
    await erp.close();
  });
  const reader = new PostgresInlineOrderConfirmationReader(db.db);
  const runConfigReader = new PostgresRunConfigReader(db.db);
  const control = new PostgresOrderRecoveryPersistence(db.db, undefined, "without_order_queue");
  const attempts = new PostgresErpAttemptPersistence(db.db);
  const admission = await AdaptiveErpRuntimeAdmission.restore({
    pauseDelivery: async () => {},
    persistence: new PostgresErpScopeResiliencePersistence(db.db),
    runConfigReader,
    reconciliationConcurrency: 1,
  });
  cleanups.push(() => admission.close());
  const gate = createErpDeclaredDispatchGate();
  const client = new HttpErpOrderConfirmation({
    baseUrl,
    lookupTimeoutMs,
    retryAfterPolicy: { fallbackDelayMs: 100, maximumDelayMs: 1000 },
    attemptPersistence: attempts,
    runConfigReader,
  });
  const redisUrl = process.env.TEST_REDIS_URL;
  if (!redisUrl) throw new Error("TEST_REDIS_URL is required");
  const connection = { url: redisUrl, maxRetriesPerRequest: null };
  const notifications = createBullMqNotificationRecordPublisher({
    connection,
    publicationFence: new PostgresGeneratedRunPublicationFence(db.db),
  });
  const notificationQueue = new Queue(notificationRecordBullMqQueueName, { connection });
  const orderQueue = new Queue(orderProcessBullMqQueueName, { connection });
  cleanups.push(
    () => orderQueue.close(),
    () => notifications.close(),
    () => notificationQueue.close(),
  );
  const persistence = new PostgresOrderTransitionPersistence(db.db);
  const transitionToConfirmed = persistence.transitionToConfirmed.bind(persistence);
  persistence.transitionToConfirmed = async (...args) => {
    confirmations++;
    if (options.holdConfirmation) await held;
    return transitionToConfirmed(...args);
  };
  const handler = createOrderProcessJobHandler({
    confirmation: new ScheduledErpOrderConfirmation({
      client,
      admission,
      declaredDispatchGate: gate,
      control,
      reconciler: new ErpUnresolvedCallReconciler({
        client,
        admission,
        declaredDispatchGate: gate,
        callResolution: control,
      }),
    }),
    persistence,
    logger: createSilentLogger("worker"),
    recovery: createOrderRecoveryHandoff(control),
    notificationRecordPublisher: notifications,
    publishBusinessOutcomeUpdate: async () => {},
  });
  const createService = () => {
    const service = new InlineOrderConfirmation({ reader, handler, control, expiry: persistence });
    cleanups.push(() => {
      service.close();
      return undefined;
    });
    return service;
  };
  return {
    service: createService(),
    createService,
    reader,
    gate,
    admission,
    attempts,
    control,
    persistence,
    notificationQueue,
    orderQueue,
    connection,
    release,
    posts: () => posts,
    lookups: () => lookups,
    confirmations: () => confirmations,
  };
}

it("uses original durable acceptance, validates identity and reads terminal replay after expiry without HTTP", async () => {
  const request = await seed(new Date(Date.now() - 60_000));
  const r = await runtime();
  await expect(r.service.confirm(request)).resolves.toMatchObject({
    outcome: "order_confirmation_timed_out",
  });
  expect(r.posts()).toBe(0);
  expect((await r.reader.read(request))?.job.correlationId).toBe("original");
  await expect(r.reader.read({ ...request, reservationId: randomUUID() })).rejects.toThrow(
    "identity",
  );
  await db.db
    .update(orders)
    .set({ status: "confirmed", processingAt: new Date(), confirmedAt: new Date() })
    .where(eq(orders.id, request.orderId));
  await expect(r.service.confirm(request)).resolves.toMatchObject({ outcome: "order_confirmed" });
  await expect(r.service.status(request)).resolves.toMatchObject({ outcome: "order_confirmed" });
  expect(r.posts()).toBe(0);
  expect(r.lookups()).toBe(0);
});

it("retries due capacity using durable generations, shared quota, real HTTP and common BullMQ notification with pool=1", async () => {
  const request = await seed();
  await db.sql`update demo_runs set config_snapshot=jsonb_set(config_snapshot,'{erpConfig,maxTps}','1'::jsonb) where id=${request.runId}`;
  const r = await runtime();
  const snapshot = await r.reader.read(request);
  if (!snapshot) throw new Error("Expected canonical order");
  await r.gate.tryAcquire(await r.admission.context(snapshot.job));
  const results = await Promise.all([r.service.confirm(request), r.service.confirm(request)]);
  expect(results.map((result) => result.outcome)).toEqual(["order_confirmed", "order_confirmed"]);
  expect(r.posts()).toBe(1);
  expect(
    (await r.control.readControlRecord({ orderId: request.orderId }))?.processingGeneration,
  ).toBeGreaterThan(0);
  expect((await r.notificationQueue.getJob(`${request.orderId}-email`))?.data).toMatchObject({
    orderId: request.orderId,
    runId: request.runId,
    correlationId: "original",
  });
  expect(await db.sql`select * from postgres_order_deliveries`).toHaveLength(0);
}, 10_000);

function scanner(service: InlineOrderConfirmation) {
  const recovery = createInlineOrderRecoveryScanner({
    service,
    recovery: new PostgresOrderRecoveryPersistence(db.db, undefined, "without_order_queue"),
    dispatch: new PostgresOrderDispatchPersistence(db.db, "without_order_queue"),
    scanIntervalMs: 1000,
    batchSize: 10,
    minimumQueuedAgeMs: 0,
    logger: createSilentLogger("worker"),
  });
  cleanups.push(() => recovery.close());
  return recovery;
}

it("restarts scanner recovery after the buyer window using only real HTTP lookup and common notifications", async () => {
  const request = await seed(new Date(Date.now() - 60_000));
  const r = await runtime({ knownLookup: true });
  const snapshot = await r.reader.read(request);
  if (!snapshot) throw new Error("Expected order");
  const delivery = {
    attemptNumber: 1,
    attemptsMade: 0,
    deliveryId: "crashed",
    processingGeneration: 0,
  };
  await r.persistence.transitionToProcessing(snapshot.job, delivery);
  await r.attempts.recordDispatchIntent({
    job: snapshot.job,
    idempotencyKey: toConfirmationIdempotencyKey(snapshot.job),
    dispatchedAt: new Date(Date.now() - 60_000),
    expectedProcessingGeneration: 0,
  });
  await db.sql`update order_recovery_jobs set lease_expires_at=null, next_attempt_at=null where order_id=${request.orderId}`;
  r.service.close();
  await scanner(r.createService()).scanOnce();
  expect(r.lookups()).toBe(1);
  expect(r.posts()).toBe(0);
  expect((await r.reader.read(request))?.result.outcome).toBe("order_confirmed");
  const control = await r.control.readControlRecord({ orderId: request.orderId });
  expect(control).toMatchObject({ status: "resolved", processingGeneration: 1 });
  expect((await r.notificationQueue.getJob(`${request.orderId}-email`))?.data).toMatchObject({
    orderId: request.orderId,
  });
  expect(await db.sql`select * from postgres_order_deliveries`).toHaveLength(0);
  expect(await db.sql`select * from erp_dispatch_calls`).toHaveLength(1);
  expect(await r.orderQueue.getJob(request.orderId)).toBeUndefined();
  const consumer = createBullMqNotificationRecordConsumer({
    connection: r.connection,
    concurrency: 1,
    handler: createNotificationRecordJobHandler({
      persistence: new PostgresNotificationRecordPersistence(db.db),
      logger: createSilentLogger("worker"),
      publishBusinessOutcomeUpdate: async () => {},
    }),
    logger: createSilentLogger("worker"),
  });
  cleanups.push(() => consumer.close());
  consumer.start();
  await vi.waitFor(async () =>
    expect(
      await db.sql`select * from simulated_notifications where order_id=${request.orderId}`,
    ).toHaveLength(1),
  );
});

it("expires crash-left queued orders once without dispatch or fabricated ERP evidence", async () => {
  const request = await seed(new Date(Date.now() - 60_000));
  const r = await runtime();
  const recovery = scanner(r.service);
  await recovery.scanOnce();
  expect(r.posts()).toBe(0);
  expect(r.lookups()).toBe(0);
  expect((await r.reader.read(request))?.result).toMatchObject({
    outcome: "order_confirmation_failed",
    order: { failureCode: "inline_confirmation_window_expired" },
  });
  await recovery.scanOnce();
  expect(
    await db.sql`select * from order_events where order_id=${request.orderId} and event_name='order.failed'`,
  ).toHaveLength(1);
  expect(await db.sql`select * from erp_attempts`).toHaveLength(0);
  expect(await r.notificationQueue.getJob(`${request.orderId}-email`)).toBeUndefined();
  expect(await db.sql`select * from erp_dispatch_calls`).toHaveLength(0);
  expect(await db.sql`select * from postgres_order_deliveries`).toHaveLength(0);
  expect(await r.orderQueue.getJob(request.orderId)).toBeUndefined();
});

it("settles cancelled persisted-but-unsent inline intent through unchanged expiry proof", async () => {
  const request = await seed();
  const r = await runtime();
  const buyer = new AbortController();
  const recordIntent = r.attempts.recordDispatchIntent.bind(r.attempts);
  vi.spyOn(r.attempts, "recordDispatchIntent").mockImplementation(async (input) => {
    const call = await recordIntent(input);
    buyer.abort();
    return call;
  });
  await r.service.confirm(request, buyer.signal);
  // Buyer cancellation returns before the owned handler finishes its durable cleanup.
  await vi.waitFor(async () => {
    expect(await r.control.readControlRecord({ orderId: request.orderId })).toMatchObject({
      unresolvedErpCallId: null,
      leaseExpiresAt: null,
    });
  });
  expect(r.posts()).toBe(0);
  expect(await db.sql`select * from erp_dispatch_calls`).toHaveLength(0);
  expect(await db.sql`select * from erp_attempts`).toHaveLength(0);
  await db.db
    .update(reservations)
    .set({ securedAt: new Date(Date.now() - 60_000) })
    .where(eq(reservations.id, request.reservationId));
  await expect(r.service.recover(request)).resolves.toMatchObject({
    outcome: "order_confirmation_failed",
    order: { failureCode: "inline_confirmation_window_expired" },
  });
  expect(await r.control.readControlRecord({ orderId: request.orderId })).toMatchObject({
    status: "resolved",
  });
  expect(r.posts()).toBe(0);
  expect(r.lookups()).toBe(0);
});

it("acknowledges authenticated HTTP cancellation while the registered handler is still unsettled", async () => {
  const request = await seed();
  const r = await runtime({ holdConfirmation: true });
  const app = buildWorkerHealthServer({
    logger: createSilentLogger("worker"),
    readiness: { checks: async () => [] },
    inlineConfirmation: { service: r.service, controlServiceToken: "private-test-token" },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    r.release();
    await app.close();
  });
  const headers = {
    "content-type": "application/json",
    "x-control-service-token": "private-test-token",
  };
  const buyer = fetch(`${address}/internal/orders/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  await vi.waitFor(() => expect(r.confirmations()).toBe(1));
  const cancel = await fetch(`${address}/internal/orders/cancel-run`, {
    method: "POST",
    headers,
    body: JSON.stringify({ runId: request.runId }),
    signal: AbortSignal.timeout(1000),
  });
  expect(cancel.status).toBe(204);
  expect(await (await buyer).json()).toMatchObject({ outcome: "order_confirmation_pending" });
  expect((await r.reader.read(request))?.result.outcome).toBe("order_confirmation_pending");
  r.release();
  await vi.waitFor(async () =>
    expect((await r.reader.read(request))?.result.outcome).toBe("order_confirmed"),
  );
});

it("adopts a disconnected handler's late durable confirmation before the original deadline without waiting for its lease", async () => {
  const securedAt = new Date(Date.now() - 26_000);
  const request = await seed(securedAt);
  const r = await runtime({ holdConfirmation: true });
  const cancellation = new AbortController();
  const first = r.service.confirm(request, cancellation.signal);
  await vi.waitFor(() => expect(r.confirmations()).toBe(1), { timeout: 2000 });
  cancellation.abort();
  await expect(first).resolves.toMatchObject({ outcome: "order_confirmation_pending" });
  const control = await r.control.readControlRecord({ orderId: request.orderId });
  expect(control?.leaseExpiresAt?.getTime()).toBeGreaterThan(securedAt.getTime() + 55_000);
  const claims = vi.spyOn(r.control, "claimForPublication");
  const retry = r.service.confirm(request);
  await vi.waitFor(() => expect(claims).toHaveBeenCalledOnce());
  r.release();
  await expect(retry).resolves.toMatchObject({
    outcome: "order_confirmed",
    order: { id: request.orderId, correlationId: "original" },
  });
  expect(Date.now()).toBeLessThan(securedAt.getTime() + 55_000);
  expect(claims).toHaveBeenCalledOnce();
  expect(r.posts()).toBe(1);
  expect(r.lookups()).toBe(0);
  expect(await r.control.readControlRecord({ orderId: request.orderId })).toMatchObject({
    status: "resolved",
    leaseExpiresAt: null,
  });
  await vi.waitFor(async () =>
    expect(await r.notificationQueue.getJob(`${request.orderId}-email`)).not.toBeUndefined(),
  );
  expect(await db.sql`select * from postgres_order_deliveries`).toHaveLength(0);
}, 10_000);

it("registers cancellation immediately, retains dispatch uncertainty and keeps restarted buyer retries lookup-only", async () => {
  const request = await seed();
  const r = await runtime({ holdPost: true });
  const first = r.service.confirm(request);
  await vi.waitFor(() => expect(r.posts()).toBe(1), { timeout: 2000 });
  r.service.cancelRun(request.runId);
  await expect(first).resolves.toMatchObject({ outcome: "order_confirmation_pending" });
  await vi.waitFor(async () =>
    expect(await r.attempts.findUnresolvedCall(request.orderId)).not.toBeNull(),
  );
  await vi.waitFor(async () =>
    expect(await r.control.readControlRecord({ orderId: request.orderId })).toMatchObject({
      waitingReason: "uncertain_result",
      leaseExpiresAt: null,
    }),
  );
  const deferred = await r.control.readControlRecord({ orderId: request.orderId });
  if (!deferred?.nextAttemptAt) throw new Error("Expected a durable uncertainty retry deadline");
  const original = await r.reader.read(request);
  if (!original) throw new Error("Expected the original durable reservation");
  const lookupAllowanceMs =
    Math.max(0, deferred.nextAttemptAt.getTime() - Date.now()) + lookupTimeoutMs + 250;
  expect(Date.now() + lookupAllowanceMs).toBeLessThan(original.securedAt.getTime() + 55_000);
  r.release();
  // A fresh service models process-local state loss; durable uncertainty is authoritative.
  const restarted = r.createService();
  const cancellation = new AbortController();
  const retry = restarted.confirm(request, cancellation.signal);
  await vi.waitFor(
    async () => {
      if (r.lookups() === 0) {
        throw new Error(
          `Lookup has not reached the ERP: ${JSON.stringify({ control: await r.control.readControlRecord({ orderId: request.orderId }), admission: r.admission.state() })}`,
        );
      }
    },
    { timeout: lookupAllowanceMs },
  );
  cancellation.abort();
  await expect(retry).resolves.toMatchObject({ outcome: "order_confirmation_pending" });
  expect(r.posts()).toBe(1);
  expect(await r.attempts.findUnresolvedCall(request.orderId)).not.toBeNull();
  expect((await r.service.status(request)).outcome).toBe("order_confirmation_pending");
}, 10_000);

it("preserves a live processing owner and settles its undispatched order after lease expiry", async () => {
  const request = await seed(new Date(Date.now() - 60_000));
  const r = await runtime();
  const snapshot = await r.reader.read(request);
  if (!snapshot) throw new Error("Expected canonical order");
  await r.persistence.transitionToProcessing(snapshot.job, {
    attemptNumber: 1,
    attemptsMade: 0,
    deliveryId: `inline:${request.orderId}`,
    processingGeneration: 0,
  });
  await r.service.recover(request);
  expect((await r.reader.read(request))?.result.outcome).toBe("order_confirmation_pending");
  expect(r.posts()).toBe(0);
  await db.sql`update order_recovery_jobs set lease_expires_at=now()-interval '1 second' where order_id=${request.orderId}`;
  await r.service.recover(request);
  expect((await r.reader.read(request))?.result.outcome).toBe("order_confirmation_failed");
  expect(await r.control.readControlRecord({ orderId: request.orderId })).toMatchObject({
    status: "resolved",
    leaseExpiresAt: null,
    publicationOwner: null,
    processingGeneration: 0,
    unresolvedErpCallId: null,
  });
  await r.service.recover(request);
  expect(
    await db.sql`select * from order_events where order_id=${request.orderId} and event_name='order.failed'`,
  ).toHaveLength(1);
  expect(await db.sql`select * from erp_attempts`).toHaveLength(0);
});

it("keeps unexpired and accepted recovery evidence outside local expiry", async () => {
  const request = await seed();
  const r = await runtime();
  const snapshot = await r.reader.read(request);
  if (!snapshot) throw new Error("Expected canonical order");
  expect(await r.persistence.expireUndispatched(snapshot.job)).toBe(false);
  await r.control.recordRecoverable({
    job: snapshot.job,
    delivery: { attemptNumber: 1, attemptsMade: 0 },
    reason: "erp_accepted_local_persistence_incomplete",
    error: new Error("Accepted result awaiting local persistence"),
    accepted: true,
    attempt: { disposition: "succeeded" },
  });
  await db.sql`update reservations set secured_at=now()-interval '60 seconds' where id=${request.reservationId}`;
  expect(await r.persistence.expireUndispatched(snapshot.job)).toBe(false);
  expect((await r.reader.read(request))?.result.outcome).toBe("order_confirmation_pending");
});

it.each([
  "expiry",
  "dispatch",
] as const)("serializes %s-first expiry against a delayed dispatch intent under the order lock", async (first) => {
  const request = await seed();
  const r = await runtime();
  const snapshot = await r.reader.read(request);
  if (!snapshot) throw new Error("Expected canonical order");
  await r.persistence.transitionToProcessing(snapshot.job, {
    attemptNumber: 1,
    attemptsMade: 0,
    deliveryId: `inline:${request.orderId}`,
    processingGeneration: 0,
  });
  const before = new Date();
  // A dispatch captures eligibility before awaiting a connection/order lock.
  // Expiry's later clock observes that owner's lease as expired.
  const concurrent = createDatabaseConnection(requireTestDatabaseUrl(), { max: 3 });
  cleanups.push(() => concurrent.close());
  const expiry = new PostgresOrderTransitionPersistence(
    concurrent.db,
    () => new Date(before.getTime() + 60_000),
  );
  const attempts = new PostgresErpAttemptPersistence(concurrent.db, () => before);
  let release = () => {};
  let locked = () => {};
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = db.db.transaction(async (tx) => {
    await tx.execute(sql`select id from orders where id=${request.orderId} for update`);
    locked();
    await held;
  });
  await acquired;
  const expire = () => expiry.expireUndispatched(snapshot.job);
  const dispatch = () =>
    attempts.recordDispatchIntent({
      job: snapshot.job,
      idempotencyKey: toConfirmationIdempotencyKey(snapshot.job),
      dispatchedAt: before,
      expectedProcessingGeneration: 0,
    });
  const firstResult = (first === "expiry" ? expire() : dispatch()).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const waiters = async () => {
    const [row] =
      await concurrent.sql`select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%orders%'`;
    return row?.count ?? 0;
  };
  try {
    await vi.waitFor(async () => expect(await waiters()).toBe(1));
    const secondResult = (first === "expiry" ? dispatch() : expire()).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.waitFor(async () => expect(await waiters()).toBe(2));
    release();
    await blocker;
    const [one, two] = await Promise.all([firstResult, secondResult]);
    const expiryResult = first === "expiry" ? one : two;
    const dispatchResult = first === "dispatch" ? one : two;
    if (first === "dispatch" && "error" in dispatchResult) throw dispatchResult.error;
    expect(expiryResult).toEqual({ value: first === "expiry" });
    if (first === "expiry") {
      expect(dispatchResult).toHaveProperty("error");
      expect(
        await concurrent.sql`select * from erp_dispatch_calls where order_id=${request.orderId}`,
      ).toHaveLength(0);
      expect((await r.reader.read(request))?.result.outcome).toBe("order_confirmation_failed");
    } else {
      expect(dispatchResult).toHaveProperty("value");
      expect((await r.reader.read(request))?.result.outcome).toBe("order_confirmation_pending");
      expect(
        await concurrent.sql`select * from order_events where order_id=${request.orderId} and event_name='order.failed'`,
      ).toHaveLength(0);
    }
    expect(r.posts()).toBe(0);
    expect(await concurrent.sql`select * from erp_attempts`).toHaveLength(0);
  } finally {
    release();
    await blocker;
  }
});

it("waits behind the shared terminal fence and refuses expiry after reset wins", async () => {
  const request = await seed(new Date(Date.now() - 60_000));
  const r = await runtime();
  const snapshot = await r.reader.read(request);
  if (!snapshot) throw new Error("Expected canonical order");
  const concurrent = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
  cleanups.push(() => concurrent.close());
  let release = () => {};
  let locked = () => {};
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reset = concurrent.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${terminalDemoRunTransitionLockKey(request.runId)}))`,
    );
    await tx.update(demoRuns).set({ status: "failed" }).where(eq(demoRuns.id, request.runId));
    locked();
    await held;
  });
  await acquired;
  let settled = false;
  const expiry = r.persistence.expireUndispatched(snapshot.job).finally(() => {
    settled = true;
  });
  try {
    // Query the separate observer pool while expiry waits on the fence.
    const observer = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    try {
      await vi.waitFor(async () => {
        const [row] =
          await observer.sql`select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%pg_advisory_xact_lock_shared%'`;
        expect(row?.count).toBe(1);
      });
      expect(settled).toBe(false);
    } finally {
      await observer.close();
    }
    release();
    await reset;
    expect(await expiry).toBe(false);
    expect(
      await db.sql`select * from order_events where order_id=${request.orderId} and event_name='order.failed'`,
    ).toHaveLength(0);
  } finally {
    release();
    await reset;
    await expiry;
  }
});
