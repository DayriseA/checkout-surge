import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AcceptedRunConfigSnapshot,
  emptyHttpTimingBreakdownSummary,
  emptyRequestArrivalSummary,
  notificationRecordBullMqQueueName,
  orderProcessBullMqQueueName,
  type TrafficCompletionReport,
} from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createRedisClient,
  demoRunFinalizations,
  demoRunSummaries,
  demoRuns,
  getInventoryStatus,
  markReservationPendingPersistence,
  orders,
  products,
  promoteReservationIdempotencyToAccepted,
  readBusinessOutcomeSummary,
  reservations,
  reserveInventoryStock,
  reverseReservation,
  saleOffers,
  simulatedNotifications,
  terminalDemoRunTransitionLockKey,
} from "@checkout-surge/db";
import {
  createPurchaseRunFixture,
  requireTestDatabaseUrl,
  resetTestDatabase,
} from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChaosConfirmationDecisionProvider } from "../../mock-erp/src/application/chaos-control-service.js";
import { ConfirmationService } from "../../mock-erp/src/application/confirmation-service.js";
import { SlidingWindowTpsLimiter } from "../../mock-erp/src/application/tps-limiter.js";
import { PostgresConfirmationLedger } from "../../mock-erp/src/persistence/postgres-confirmation-ledger.js";
import { buildMockErpServer } from "../../mock-erp/src/server.js";
import { HttpErpOrderConfirmation } from "../../worker/src/application/erp-confirmation-client.js";
import { createErpDeclaredDispatchGate } from "../../worker/src/application/erp-declared-dispatch-gate.js";
import {
  ErpUnresolvedCallReconciler,
  ScheduledErpOrderConfirmation,
} from "../../worker/src/application/erp-reconciliation.js";
import { InlineOrderConfirmation } from "../../worker/src/application/inline-order-confirmation.js";
import { createInlineOrderRecoveryScanner } from "../../worker/src/application/inline-order-recovery-scanner.js";
import { createNotificationRecordJobHandler } from "../../worker/src/application/notification-record-job-handler.js";
import { AdaptiveErpRuntimeAdmission } from "../../worker/src/application/order-process-admission.js";
import { createOrderProcessJobHandler } from "../../worker/src/application/order-process-job-handler.js";
import { createOrderRecoveryHandoff } from "../../worker/src/application/order-recovery-scanner.js";
import { PostgresErpAttemptPersistence } from "../../worker/src/persistence/postgres-erp-attempt-persistence.js";
import { PostgresErpScopeResiliencePersistence } from "../../worker/src/persistence/postgres-erp-scope-resilience-persistence.js";
import { PostgresGeneratedRunPublicationFence } from "../../worker/src/persistence/postgres-generated-run-publication-fence.js";
import { PostgresInlineOrderConfirmationReader } from "../../worker/src/persistence/postgres-inline-order-confirmation-reader.js";
import { PostgresNotificationRecordPersistence } from "../../worker/src/persistence/postgres-notification-record-persistence.js";
import { PostgresOrderDispatchPersistence } from "../../worker/src/persistence/postgres-order-dispatch-persistence.js";
import { PostgresOrderRecoveryPersistence } from "../../worker/src/persistence/postgres-order-recovery-persistence.js";
import { PostgresOrderTransitionPersistence } from "../../worker/src/persistence/postgres-order-transition-persistence.js";
import { PostgresRunConfigReader } from "../../worker/src/persistence/postgres-run-config-reader.js";
import { createBullMqNotificationRecordConsumer } from "../../worker/src/queue/bullmq-notification-record-consumer.js";
import { createBullMqNotificationRecordPublisher } from "../../worker/src/queue/bullmq-notification-record-publisher.js";
import { buildWorkerHealthServer } from "../../worker/src/server.js";
import { registerBuyRoutes } from "../src/routes/buy-routes.js";
import { buildApiHttpServer } from "../src/runtime/api-http-server.js";
import { loadApiConfig } from "../src/runtime/config.js";
import { createReserveOrderService } from "../src/runtime/create-reserve-order-service.js";
import { createPendingPersistenceRecoveryOperations } from "../src/runtime/pending-persistence-operation-factory.js";
import { createRunInventoryLifecycle } from "../src/runtime/run-inventory-lifecycle.js";
import {
  ActiveBuyingRunContext,
  PostgresBuyingRunContextReader,
} from "../src/services/active-buying-run-context.js";
import { AdminDemoResetService } from "../src/services/admin-demo-reset-service.js";
import { ProcessLocalDemoMaintenanceAuthority } from "../src/services/demo-maintenance-authority.js";
import { DemoRunFinalizationService } from "../src/services/demo-run-finalization-service.js";
import { HttpInlineOrderConfirmation } from "../src/services/http-inline-order-confirmation.js";
import { PendingPersistenceRecoveryService } from "../src/services/pending-persistence-recovery-service.js";
import { PostgresBuyPersistence } from "../src/services/postgres-buy-persistence.js";
import { PostgresDemoResetWorkflowFence } from "../src/services/postgres-demo-reset-workflow-fence.js";
import { PostgresTerminalDemoRunSummaryWriter } from "../src/services/terminal-demo-run-transition.js";
import { TrafficCompletionEnrichmentService } from "../src/services/traffic-completion-enrichment-service.js";
import { TrafficCompletionService } from "../src/services/traffic-completion-service.js";

const logger = createSilentLogger("api");
const token = "private-inline-runtime-token";
let db: ReturnType<typeof createDatabaseConnection>;
let redis: ReturnType<typeof createRedisClient>;
const cleanups: Array<() => Promise<unknown> | undefined> = [];
beforeEach(async () => {
  await resetTestDatabase();
  db = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
  const redisUrl = process.env.TEST_REDIS_URL;
  if (!redisUrl) throw new Error("TEST_REDIS_URL is required");
  redis = createRedisClient(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0 });
  await redis.flushdb();
});
afterEach(async () => {
  for (const close of cleanups.reverse()) await close();
  cleanups.length = 0;
  redis.disconnect();
  await db.close();
});

async function seedRun(stock = 1, startedAt = new Date(Date.now() - 100)) {
  const productId = randomUUID(),
    saleOfferId = randomUUID(),
    runId = randomUUID();
  await db.db
    .insert(products)
    .values({ id: productId, sku: productId, slug: productId, name: "Inline runtime" });
  await db.db.insert(saleOffers).values({
    id: saleOfferId,
    productId,
    name: "Inline runtime",
    allocatedStock: stock,
    saleStartsAt: startedAt,
    saleEndsAt: new Date(Date.now() + 60_000),
  });
  await createPurchaseRunFixture(db.db, { runId, saleOfferId });
  const [run] = await db.db.select().from(demoRuns).where(eq(demoRuns.id, runId));
  if (!run) throw new Error("Expected run");
  const snapshot = run.configSnapshot as unknown as AcceptedRunConfigSnapshot;
  snapshot.trafficConfig = {
    mode: "buyer-spike",
    buyerCount: 2,
    duplicateEachBuyerAttempt: false,
    startDelaySeconds: 0,
    maxDurationSeconds: 5,
    quantityPerAttempt: 1,
  };
  snapshot.erpConfig.latencyMs = 200;
  await db.db
    .update(demoRuns)
    .set({
      executionMode: "without_order_queue",
      configSnapshot: snapshot,
      startedAt,
      trafficStartedAt: startedAt,
    })
    .where(eq(demoRuns.id, runId));
  await createRunInventoryLifecycle(db.db, redis).initialize(
    { runId, saleOfferId, executionMode: "without_order_queue" },
    stock,
    startedAt,
  );
  return { runId, saleOfferId, startedAt, snapshot };
}

async function runtime(
  options: {
    holdConfirmation?: boolean;
    holdDecision?: boolean;
    lostResponse?: boolean;
    technicalFailure?: boolean;
  } = {},
) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let postCount = 0,
    lookupCount = 0,
    confirmationCount = 0,
    decisionCount = 0,
    ledgerSaveCount = 0;
  const chaos = new ChaosConfirmationDecisionProvider({
    tpsLimiter: new SlidingWindowTpsLimiter(),
  });
  const ledger = new PostgresConfirmationLedger(db.sql);
  const save = ledger.save.bind(ledger);
  ledger.save = async (entry) => {
    try {
      return await save(entry);
    } finally {
      ledgerSaveCount++;
    }
  };
  const erp = buildMockErpServer({
    logger,
    confirmationService: new ConfirmationService({
      ledger,
      decisionProvider: options.technicalFailure
        ? {
            decide: async () => ({
              status: "failed",
              httpStatus: 400,
              errorCode: "erp_bad_order",
              errorMessage: "Injected rejection",
            }),
          }
        : {
            decide: async (request) => {
              decisionCount++;
              if (options.holdDecision) await held;
              return chaos.decide(request);
            },
          },
    }),
  });
  erp.addHook("onRequest", async (request) => {
    if (request.method === "POST") postCount++;
    else lookupCount++;
    // ERP uses the same one-connection pool. A retained caller connection would deadlock.
    await db.sql`select 1`;
  });
  erp.addHook("onSend", async (request, _reply, payload) => {
    if (options.lostResponse && request.method === "POST") await held;
    return payload;
  });
  const erpUrl = await erp.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    release();
    await erp.close();
  });
  const control = new PostgresOrderRecoveryPersistence(db.db, undefined, "without_order_queue");
  const reader = new PostgresInlineOrderConfirmationReader(db.db);
  const runConfigReader = new PostgresRunConfigReader(db.db);
  const admission = await AdaptiveErpRuntimeAdmission.restore({
    pauseDelivery: async () => {},
    persistence: new PostgresErpScopeResiliencePersistence(db.db),
    runConfigReader,
    reconciliationConcurrency: 1,
  });
  cleanups.push(() => admission.close());
  const gate = createErpDeclaredDispatchGate();
  const client = new HttpErpOrderConfirmation({
    baseUrl: erpUrl,
    lookupTimeoutMs: 1000,
    retryAfterPolicy: { fallbackDelayMs: 100, maximumDelayMs: 1000 },
    attemptPersistence: new PostgresErpAttemptPersistence(db.db),
    runConfigReader,
  });
  const connection = { url: process.env.TEST_REDIS_URL ?? "", maxRetriesPerRequest: null };
  const notifications = createBullMqNotificationRecordPublisher({
    connection,
    publicationFence: new PostgresGeneratedRunPublicationFence(db.db),
  });
  cleanups.push(() => notifications.close());
  const transitions = new PostgresOrderTransitionPersistence(db.db);
  const confirm = transitions.transitionToConfirmed.bind(transitions);
  transitions.transitionToConfirmed = async (...args) => {
    confirmationCount++;
    if (options.holdConfirmation) await held;
    return confirm(...args);
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
    persistence: transitions,
    recovery: createOrderRecoveryHandoff(control),
    notificationRecordPublisher: notifications,
    logger,
    publishBusinessOutcomeUpdate: async () => {},
  });
  let inline = new InlineOrderConfirmation({ reader, handler, control });
  cleanups.push(() => {
    inline.close();
    return undefined;
  });
  const worker = buildWorkerHealthServer({
    logger,
    readiness: { checks: async () => [] },
    inlineConfirmation: {
      service: {
        confirm: (...args) => inline.confirm(...args),
        status: (...args) => inline.status(...args),
        recover: (...args) => inline.recover(...args),
        cancelRun: (...args) => inline.cancelRun(...args),
      },
      controlServiceToken: token,
    },
  });
  const workerUrl = await worker.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    inline.close();
    release();
    await worker.close();
  });
  const adapter = new HttpInlineOrderConfirmation({
    baseUrl: workerUrl,
    controlServiceToken: token,
  });
  const stockReservations = {
    reserve: (input: Parameters<typeof reserveInventoryStock>[1]) =>
      reserveInventoryStock(redis, input),
    markPendingPersistence: (input: Parameters<typeof markReservationPendingPersistence>[1]) =>
      markReservationPendingPersistence(redis, input),
    promoteAccepted: (input: Parameters<typeof promoteReservationIdempotencyToAccepted>[1]) =>
      promoteReservationIdempotencyToAccepted(redis, input).then(() => undefined),
    reverse: (input: Parameters<typeof reverseReservation>[1]) => reverseReservation(redis, input),
  };
  const reserve = createReserveOrderService(
    {
      persistence: new PostgresBuyPersistence(db.db),
      stockReservations,
      inlineConfirmation: adapter,
      pendingPersistenceRecovery: { recoverReservation: async () => null },
      reservationHoldMinutes: 15,
      idempotencyTtlSeconds: 1800,
      pendingPersistenceRetryAfterSeconds: 1,
    },
    logger,
  );
  const context = new ActiveBuyingRunContext({
    reader: new PostgresBuyingRunContextReader(db.db),
    services: {
      demo: {
        reserve: async () => {
          throw new Error("Expected trusted inline activation");
        },
      },
      without_order_queue: reserve,
    },
  });
  await context.hydrate();
  const api = await buildApiHttpServer({
    logger,
    config: loadApiConfig({
      NODE_ENV: "test",
      DATABASE_URL: requireTestDatabaseUrl(),
      REDIS_URL: connection.url,
      CONTROL_SERVICE_TOKEN: token,
      PUBLIC_CLIENT_COOKIE_SECRET: "test-cookie-secret-for-inline-runtime",
    }),
  });
  registerBuyRoutes(api, { reserveOrderService: context });
  const apiUrl = await api.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    inline.close();
    release();
    await api.close();
  });
  const notificationConsumer = createBullMqNotificationRecordConsumer({
    connection,
    concurrency: 1,
    logger,
    handler: createNotificationRecordJobHandler({
      persistence: new PostgresNotificationRecordPersistence(db.db),
      logger,
      publishBusinessOutcomeUpdate: async () => {},
    }),
  });
  notificationConsumer.start();
  cleanups.push(() => notificationConsumer.close());
  const orderQueue = new Queue(orderProcessBullMqQueueName, { connection });
  const notificationQueue = new Queue(notificationRecordBullMqQueueName, { connection });
  cleanups.push(
    () => orderQueue.close(),
    () => notificationQueue.close(),
  );
  return {
    apiUrl,
    adapter,
    context,
    stockReservations,
    orderQueue,
    notificationQueue,
    control,
    release,
    posts: () => postCount,
    lookups: () => lookupCount,
    confirmations: () => confirmationCount,
    decisions: () => decisionCount,
    ledgerSaves: () => ledgerSaveCount,
    scanOnce: async () => {
      const scanner = createInlineOrderRecoveryScanner({
        service: inline,
        recovery: control,
        dispatch: new PostgresOrderDispatchPersistence(db.db, "without_order_queue"),
        logger,
        scanIntervalMs: 1000,
        batchSize: 10,
        minimumQueuedAgeMs: 0,
      });
      try {
        await scanner.scanOnce();
      } finally {
        await scanner.close();
      }
    },
    restartAndScan: async (allowanceMs: number) => {
      inline.close();
      inline = new InlineOrderConfirmation({ reader, handler, control });
      const scanner = createInlineOrderRecoveryScanner({
        service: inline,
        recovery: control,
        dispatch: new PostgresOrderDispatchPersistence(db.db, "without_order_queue"),
        logger,
        scanIntervalMs: 1000,
        batchSize: 10,
        minimumQueuedAgeMs: 0,
      });
      try {
        scanner.start();
        await vi.waitFor(() => expect(lookupCount).toBeGreaterThan(0), { timeout: allowanceMs });
      } finally {
        await scanner.close();
      }
    },
  };
}

async function buy(apiUrl: string, scope: Awaited<ReturnType<typeof seedRun>>, key = "buyer-one") {
  const response = await fetch(`${apiUrl}/buy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: scope.runId,
      saleOfferId: scope.saleOfferId,
      quantity: 1,
      idempotencyKey: key,
      correlationId: key,
    }),
  });
  return { status: response.status, body: await response.json() };
}

it("waits for real ERP confirmation, preserves canonical retry and completes immutable cohort evidence without ORDER delivery", async () => {
  const scope = await seedRun();
  const r = await runtime();
  const start = Date.now();
  const accepted = await buy(r.apiUrl, scope);
  expect(Date.now() - start).toBeGreaterThanOrEqual(180);
  expect(accepted).toMatchObject({
    status: 200,
    body: { outcome: "order_confirmed", order: { status: "confirmed" } },
  });
  const retry = await buy(r.apiUrl, scope);
  expect(retry.body.order.id).toBe(accepted.body.order.id);
  expect(r.posts()).toBe(1);
  expect((await buy(r.apiUrl, scope, "buyer-two")).body.outcome).toBe("sold_out");
  await vi.waitFor(async () =>
    expect(await db.db.select().from(simulatedNotifications)).toHaveLength(1),
  );
  expect(await r.orderQueue.getJobs()).toHaveLength(0);
  expect(await db.sql`select * from postgres_order_deliveries`).toHaveLength(0);
  const cohorts = {
    accepted: { sampleCount: 1, averageMs: 234, p95Ms: 234 },
    soldOut: { sampleCount: 1, averageMs: 3, p95Ms: 3 },
  };
  const report = completionReport(scope, cohorts);
  const inventory = createRunInventoryLifecycle(db.db, redis);
  const queueLimits = { synchronize: async () => {} };
  const finalization = new DemoRunFinalizationService({
    db: db.db,
    redis,
    inventory,
    logger,
    queueLimits,
    terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db.db, queueLimits),
    runnerOperations: { releaseAfterRun: () => {} },
    terminalInventoryRead: {
      read: ({ saleOfferId, observedAt }) => getInventoryStatus(redis, saleOfferId, observedAt),
    },
    terminalInventoryReadTimeoutMs: 2000,
  });
  const completion = new TrafficCompletionService({
    db: db.db,
    redis,
    logger,
    finalizationService: finalization,
    completionEnrichmentService: new TrafficCompletionEnrichmentService({
      db: db.db,
      redis,
      inventory,
      logger,
      businessOutcomeReader: { read: (input) => readBusinessOutcomeSummary(db.db, input) },
    }),
  });
  await expect(completion.recordTrafficCompletion(report)).resolves.toMatchObject({
    status: "completed",
  });
  const [evidence] = await db.db.select().from(demoRunFinalizations);
  const [summary] = await db.db.select().from(demoRunSummaries);
  expect(evidence?.completionEnrichmentStatus).toBe("completed");
  expect(evidence?.httpSummary.buyerWallLatencySummary).toEqual(cohorts);
  expect(summary?.httpSummary.buyerWallLatencySummary).toEqual(cohorts);
  await completion.recordTrafficCompletion(report);
  expect((await db.db.select().from(demoRunSummaries))[0]).toEqual(summary);
});

it("returns durable technical failure without publishing ORDER work", async () => {
  const scope = await seedRun();
  const r = await runtime({ technicalFailure: true });
  expect(await buy(r.apiUrl, scope)).toMatchObject({
    status: 502,
    body: { outcome: "order_confirmation_failed", order: { status: "failed" } },
  });
  expect(r.posts()).toBe(1);
  expect(await r.orderQueue.getJobs()).toHaveLength(0);
  expect(await db.db.select().from(simulatedNotifications)).toHaveLength(0);
});

it("recovers a lost ERP reply through the real ledger after service restart with no second POST", async () => {
  const scope = await seedRun();
  const r = await runtime({ lostResponse: true });
  const buyer = buy(r.apiUrl, scope);
  await vi.waitFor(async () =>
    expect(await db.sql`select * from erp_confirmation_ledger`).toHaveLength(1),
  );
  await r.adapter.cancelRun(scope.runId, "lost-reply");
  expect(await buyer).toMatchObject({
    status: 503,
    body: { outcome: "order_confirmation_pending" },
  });
  await vi.waitFor(async () =>
    expect(
      (await db.sql`select lease_expires_at from order_recovery_jobs`)[0]?.lease_expires_at,
    ).toBeNull(),
  );
  r.release();
  const [order] = await db.db.select().from(orders);
  if (!order) throw new Error("Expected unresolved order");
  const deferred = await r.control.readControlRecord({ orderId: order.id });
  if (!deferred?.nextAttemptAt) throw new Error("Expected durable retry eligibility");
  // Durable retry time plus one scanner interval, lookup allowance and scheduling margin.
  const allowanceMs = Math.max(0, deferred.nextAttemptAt.getTime() - Date.now()) + 3_000;
  await r.restartAndScan(allowanceMs);
  expect(r.posts()).toBe(1);
  expect(r.lookups()).toBeGreaterThan(0);
  expect((await buy(r.apiUrl, scope)).body.outcome).toBe("order_confirmed");
  expect(await r.orderQueue.getJobs()).toHaveLength(0);
});

it("materializes an expired pending hold without ORDER publication and survives a lost post-session handoff", async () => {
  const scope = await seedRun(1, new Date(Date.now() - 70_000));
  const r = await runtime();
  const held = {
    id: randomUUID(),
    runId: scope.runId,
    saleOfferId: scope.saleOfferId,
    correlationId: "pending-hold",
    quantity: 1,
    reservationToken: randomUUID(),
    securedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  await r.stockReservations.reserve({
    reservation: held,
    idempotencyKey: "pending-hold",
    idempotencyTtlSeconds: 1800,
  });
  await r.stockReservations.markPendingPersistence({
    reservation: held,
    idempotencyKey: "pending-hold",
  });
  const operations = createPendingPersistenceRecoveryOperations({
    databaseUrl: requireTestDatabaseUrl(),
    redisUrl: process.env.TEST_REDIS_URL ?? "",
    discoveryTimeoutMs: 1000,
  });
  const persistence = new PostgresBuyPersistence(db.db);
  let sessionClosed = false;
  const handoff = vi.fn(async () => {
    expect(sessionClosed).toBe(true);
    throw new Error("Injected lost handoff");
  });
  const recovery = new PendingPersistenceRecoveryService({
    storage: operations.storage,
    persistence,
    audit: {
      recordAttempt: (input) => persistence.recordPendingPersistenceAttempt(input),
      markResolved: (input) => persistence.markPendingPersistenceResolved(input),
      markExhausted: (input) => persistence.markPendingPersistenceExhausted(input),
    },
    stockReservations: r.stockReservations,
    orderProcessJobPublisher: {
      enqueue: async () => {
        throw new Error("Inline recovery published ORDER work");
      },
    },
    listRunScopes: (signal) => operations.listRunScopes(signal),
    resolveRunScope: (reservation) => operations.resolveRunScope(reservation),
    openDiscoveryScope: (signal) => operations.openDiscoveryScope(signal),
    openAttemptScope: async (input) => {
      const attempt = await operations.openAttemptScope(input);
      expect(attempt.orderProcessJobPublisher).toBeUndefined();
      return {
        ...attempt,
        close: async () => {
          await attempt.close();
          sessionClosed = true;
        },
      };
    },
    closeDiscovery: () => operations.close(),
    recoverInlineOrder: handoff,
    idempotencyTtlSeconds: 1800,
    logger,
  });
  cleanups.push(() => recovery.close());
  await expect(recovery.runOnce()).resolves.toMatchObject({ materialized: 1, resolved: 1 });
  expect(handoff).toHaveBeenCalledOnce();
  await r.scanOnce();
  expect(r.posts()).toBe(0);
  expect(r.lookups()).toBe(0);
  expect((await db.db.select().from(orders))[0]).toMatchObject({ status: "processing" });
  expect(await r.orderQueue.getJobs()).toHaveLength(0);
  expect(await db.sql`select * from postgres_order_deliveries`).toHaveLength(0);
  expect(await db.sql`select * from erp_dispatch_calls`).toHaveLength(0);
});

it.each([
  "confirmation",
  "ERP decision",
] as const)("cancels reset before purge and fences a late %s from resurrecting state or touching its successor", async (heldStage) => {
  const scope = await seedRun();
  const r = await runtime(
    heldStage === "confirmation" ? { holdConfirmation: true } : { holdDecision: true },
  );
  const buyer = buy(r.apiUrl, scope);
  await vi.waitFor(() =>
    expect(heldStage === "confirmation" ? r.confirmations() : r.decisions()).toBe(1),
  );
  const workflowDb = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
  cleanups.push(() => workflowDb.close());
  const queueLimits = { synchronize: async () => {} };
  const reset = new AdminDemoResetService({
    db: db.db,
    redis,
    logger,
    inventory: createRunInventoryLifecycle(db.db, redis),
    inlineConfirmation: {
      cancelRun: async (runId, correlationId) => {
        // Reproduce reset's exclusive terminal fence during the control ACK.
        // The ACK must not wait for the ERP handler or check out this pool.
        await db.sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext(${terminalDemoRunTransitionLockKey(runId)}))`;
          await r.adapter.cancelRun(runId, correlationId);
        });
      },
    },
    queueLimits,
    queueMaintenance: { cleanRuns: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }) },
    terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db.db, queueLimits),
    trafficAborter: { abortCurrent: async () => ({ outcome: "no_current_run" }) },
    runnerOperations: { releaseAfterRun: () => {} },
    dashboardLiveStateReset: {
      fenceRun: async () => {},
      clearRun: async () => {},
      hasRunState: async () => false,
    },
    resetWorkflowFence: new PostgresDemoResetWorkflowFence(workflowDb.sql),
    maintenanceAuthority: new ProcessLocalDemoMaintenanceAuthority(),
  });
  await expect(reset.reset("inline-reset", "admin_reset")).resolves.toMatchObject({
    failedRunCount: 1,
  });
  expect(await buyer).toMatchObject({ status: 503 });
  expect(await db.db.select().from(orders)).toHaveLength(0);
  expect(await db.db.select().from(reservations)).toHaveLength(0);
  const successor = await seedRun();
  await r.context.activate(successor.runId);
  r.release();
  if (heldStage === "ERP decision") await vi.waitFor(() => expect(r.ledgerSaves()).toBe(1));
  else await delay(100);
  expect(await db.db.select().from(orders)).toHaveLength(0);
  expect(await db.db.select().from(simulatedNotifications)).toHaveLength(0);
  expect(await r.notificationQueue.getJobs()).toHaveLength(0);
  expect(
    await db.sql`select * from erp_confirmation_ledger where run_id=${scope.runId}`,
  ).toHaveLength(0);
  expect(await db.sql`select * from erp_dispatch_calls where run_id=${scope.runId}`).toHaveLength(
    0,
  );
  expect(await db.sql`select * from order_recovery_jobs`).toHaveLength(0);
  expect(await buy(r.apiUrl, successor, "successor")).toMatchObject({
    status: 200,
    body: { outcome: "order_confirmed" },
  });
  expect(
    (await db.db.select().from(demoRuns).where(eq(demoRuns.id, scope.runId)))[0],
  ).toMatchObject({ status: "failed", failureReason: "admin_reset" });
});

function completionReport(
  scope: Awaited<ReturnType<typeof seedRun>>,
  buyerWallLatencySummary: NonNullable<
    TrafficCompletionReport["httpSummary"]["buyerWallLatencySummary"]
  >,
): TrafficCompletionReport {
  const completedAt = new Date().toISOString();
  return {
    runId: scope.runId,
    status: "succeeded",
    exitCode: 0,
    completedAt,
    correlationId: "completion",
    transportAttemptCounts: {
      plannedRequests: 2,
      startedRequests: 2,
      completedRequests: 2,
      interruptedRequests: 0,
      unstartedRequests: 0,
    },
    httpSummary: {
      failedRequests: 0,
      acceptedResponses: 1,
      soldOutResponses: 1,
      transportFailures: 0,
      unexpectedResponses: 0,
      failureRate: 0,
      buyerWallLatencySummary,
    },
    trafficOutcomeSummary: {},
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    trafficDeliverySummary: {
      trafficMode: "buyer-spike",
      plannedBuyers: 2,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: 2,
      requestArrivalSummary: emptyRequestArrivalSummary,
      notes: [],
    },
    loadRunDiagnosticsSummary: {
      startedAt: scope.startedAt.toISOString(),
      completedAt,
      nproc: null,
      ulimitNofile: null,
      processMaxOpenFiles: null,
      generatorCapacity: null,
      generatorUtilisation: null,
      networkDiagnostics: null,
      k6Version: null,
      executionPlan: {
        trafficMode: "buyer-spike",
        buyerCount: 2,
        duplicateEachBuyerAttempt: false,
        iterationsPerVu: 1,
        plannedEmittedAttempts: 2,
        startDelaySeconds: 0,
        maxDurationSeconds: 5,
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
        transportFailures: "summary_export",
        unexpectedResponses: "summary_export",
        droppedIterations: "summary_export",
        completedIterations: "summary_export",
      },
      summaryExportWarnings: [],
    },
  };
}
