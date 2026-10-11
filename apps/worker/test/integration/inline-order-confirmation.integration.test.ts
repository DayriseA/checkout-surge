import { randomUUID } from "node:crypto";
import {
  erpConfirmationLookupPath,
  erpConfirmationPath,
  notificationRecordBullMqQueueName,
} from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  demoRuns,
  orders,
  products,
  reservations,
  saleOffers,
} from "@checkout-surge/db";
import {
  createPurchaseRunFixture,
  requireTestDatabaseUrl,
  resetTestDatabase,
} from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { fastify } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpErpOrderConfirmation } from "../../src/application/erp-confirmation-client.js";
import { createErpDeclaredDispatchGate } from "../../src/application/erp-declared-dispatch-gate.js";
import {
  ErpUnresolvedCallReconciler,
  ScheduledErpOrderConfirmation,
} from "../../src/application/erp-reconciliation.js";
import { InlineOrderConfirmation } from "../../src/application/inline-order-confirmation.js";
import { AdaptiveErpRuntimeAdmission } from "../../src/application/order-process-admission.js";
import { createOrderProcessJobHandler } from "../../src/application/order-process-job-handler.js";
import { createOrderRecoveryHandoff } from "../../src/application/order-recovery-scanner.js";
import { PostgresErpAttemptPersistence } from "../../src/persistence/postgres-erp-attempt-persistence.js";
import { PostgresErpScopeResiliencePersistence } from "../../src/persistence/postgres-erp-scope-resilience-persistence.js";
import { PostgresGeneratedRunPublicationFence } from "../../src/persistence/postgres-generated-run-publication-fence.js";
import { PostgresInlineOrderConfirmationReader } from "../../src/persistence/postgres-inline-order-confirmation-reader.js";
import { PostgresOrderRecoveryPersistence } from "../../src/persistence/postgres-order-recovery-persistence.js";
import { PostgresOrderTransitionPersistence } from "../../src/persistence/postgres-order-transition-persistence.js";
import { PostgresRunConfigReader } from "../../src/persistence/postgres-run-config-reader.js";
import { createBullMqNotificationRecordPublisher } from "../../src/queue/bullmq-notification-record-publisher.js";

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

async function runtime(options: { holdPost?: boolean; holdConfirmation?: boolean } = {}) {
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
  cleanups.push(
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
    const service = new InlineOrderConfirmation({ reader, handler, control });
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
    notificationQueue,
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
