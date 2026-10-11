import { randomUUID } from "node:crypto";
import type { OrderProcessJob, SecuredReservationHold } from "@checkout-surge/contracts";
import { technicalOrderFailureCodeValues } from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createRedisClient,
  dashboardProjectionScopeKey,
  deleteGeneratedRunDurable,
  deleteGeneratedRunRedisState,
  demoRunSaleContexts,
  demoRunSummaries,
  demoRuns,
  incrementDashboardProjectionRevision,
  inspectGeneratedRunTeardown,
  inventoryKeys,
  orders,
  PostgresOrderDelivery,
  PostgresStockReservations,
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
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createErpDeclaredDispatchGate } from "../../worker/src/application/erp-declared-dispatch-gate.js";
import { PostgresGeneratedRunPublicationFence } from "../../worker/src/persistence/postgres-generated-run-publication-fence.js";
import { createPostgresOrderProcessConsumer } from "../../worker/src/queue/postgres-order-process-consumer.js";
import { createPostgresOrderProcessJobPublisher } from "../../worker/src/queue/postgres-order-process-job-publisher.js";
import { createRunInventoryLifecycle } from "../src/runtime/run-inventory-lifecycle.js";
import { AdminDemoResetService } from "../src/services/admin-demo-reset-service.js";
import { ProcessLocalDemoMaintenanceAuthority } from "../src/services/demo-maintenance-authority.js";
import { GeneratedRunTeardownService } from "../src/services/generated-run-teardown-service.js";
import { PostgresDemoResetWorkflowFence } from "../src/services/postgres-demo-reset-workflow-fence.js";
import { PostgresTerminalDemoRunSummaryWriter } from "../src/services/terminal-demo-run-transition.js";

let connection: ReturnType<typeof createDatabaseConnection>;
let resetConnection: ReturnType<typeof createDatabaseConnection>;
let redis: ReturnType<typeof createRedisClient>;
let scope: { runId: string; saleOfferId: string; executionMode: "without_redis" };
const logger = createSilentLogger("api");
const queueLimits = { synchronize: async () => {} };
const queueMaintenance = { cleanRuns: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }) };

beforeEach(async () => {
  await resetTestDatabase();
  connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
  resetConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
  redis = createRedisClient(requireRedisUrl(), { lazyConnect: true });
  await redis.flushdb();
  scope = await createRun();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await redis.flushdb();
  redis.disconnect();
  await resetConnection.close();
  await connection.close();
});

async function createRun() {
  const identity = {
    runId: randomUUID(),
    saleOfferId: randomUUID(),
    executionMode: "without_redis" as const,
  };
  const productId = randomUUID();
  await connection.db
    .insert(products)
    .values({ id: productId, sku: productId, slug: productId, name: "PG lifecycle" });
  await connection.db.insert(saleOffers).values({
    id: identity.saleOfferId,
    productId,
    name: "PG lifecycle",
    allocatedStock: 3,
    saleStartsAt: new Date(),
    saleEndsAt: new Date(Date.now() + 60_000),
  });
  await createPurchaseRunFixture(connection.db, identity);
  await connection.db
    .update(demoRuns)
    .set({ executionMode: identity.executionMode })
    .where(eq(demoRuns.id, identity.runId));
  await createRunInventoryLifecycle(connection.db, redis).initialize(identity, 3, new Date());
  return identity;
}

function attempt(quantity = 1) {
  const securedAt = new Date().toISOString();
  const reservation: SecuredReservationHold = {
    id: randomUUID(),
    runId: scope.runId,
    saleOfferId: scope.saleOfferId,
    quantity,
    correlationId: randomUUID(),
    reservationToken: randomUUID(),
    securedAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return { idempotencyKey: randomUUID(), idempotencyTtlSeconds: 60, reservation };
}

async function acceptedOrder(status: "queued" | "failed" = "failed") {
  const input = attempt();
  const stock = new PostgresStockReservations(connection.sql);
  expect((await stock.reserve(input)).outcome).toBe("reservation_secured");
  await connection.db.insert(reservations).values({
    ...input.reservation,
    securedAt: new Date(input.reservation.securedAt),
    expiresAt: new Date(input.reservation.expiresAt),
  });
  const job: OrderProcessJob = {
    orderId: randomUUID(),
    publicOrderId: randomUUID(),
    runId: scope.runId,
    saleOfferId: scope.saleOfferId,
    processingGeneration: 0,
    reservationId: input.reservation.id,
    correlationId: input.reservation.correlationId,
    quantity: 1,
    queuedAt: input.reservation.securedAt,
  };
  await connection.db.insert(orders).values({
    id: job.orderId,
    ...job,
    status,
    queuedAt: new Date(job.queuedAt),
    ...(status === "failed"
      ? {
          processingAt: new Date(),
          failedAt: new Date(),
          failureCode: technicalOrderFailureCodeValues[0],
          failureMessage: "ERP failed.",
        }
      : {}),
  });
  await stock.promoteAccepted(input);
  return { input, job };
}

function resetService() {
  return new AdminDemoResetService({
    db: connection.db,
    redis,
    inventory: createRunInventoryLifecycle(connection.db, redis),
    queueLimits,
    queueMaintenance,
    terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(connection.db, queueLimits),
    trafficAborter: { abortCurrent: async () => ({ outcome: "no_current_run" }) },
    runnerOperations: { releaseAfterRun: () => {} },
    dashboardLiveStateReset: {
      fenceRun: async () => {},
      clearRun: async () => {},
      hasRunState: async () => false,
    },
    resetWorkflowFence: new PostgresDemoResetWorkflowFence(resetConnection.sql),
    maintenanceAuthority: new ProcessLocalDemoMaintenanceAuthority(),
    logger,
  });
}

async function expectWorkingRowsGone() {
  const [row] = await connection.sql`select
    (select count(*)::int from postgres_run_inventory where run_id=${scope.runId}) as inventory,
    (select count(*)::int from postgres_reservation_holds where run_id=${scope.runId}) as holds,
    (select count(*)::int from postgres_reservation_idempotency where run_id=${scope.runId}) as idempotency,
    (select count(*)::int from postgres_run_sold_out_counts where run_id=${scope.runId}) as counter,
    (select count(*)::int from postgres_order_deliveries where run_id=${scope.runId}) as deliveries`;
  expect(row).toEqual({ inventory: 0, holds: 0, idempotency: 0, counter: 0, deliveries: 0 });
}

it("retains pending predecessor inventory and retires settled working state without Redis shadow stock", async () => {
  const inventory = createRunInventoryLifecycle(connection.db, redis);
  const stock = new PostgresStockReservations(connection.sql);
  const input = attempt();
  await stock.reserve(input);
  await new PostgresTerminalDemoRunSummaryWriter(connection.db, queueLimits).claimTerminalRun({
    runId: scope.runId,
    terminalStatus: "failed",
    failureReason: "load_generator_lost",
    finalizedAt: new Date(),
    allowedCurrentStatuses: ["active"],
  });
  expect(await inventory.retire(scope)).toBe("pending_persistence");
  expect(await incrementDashboardProjectionRevision(redis, scope)).toBe(1);
  await stock.reverse(input);
  expect(await inventory.retire(scope)).toBe("deleted");
  await expect(incrementDashboardProjectionRevision(redis, scope)).rejects.toThrow(/retired/i);
  expect(await redis.exists(inventoryKeys(scope.saleOfferId).state)).toBe(0);
  expect(await inventory.close(scope)).toBe(false);
  expect((await stock.reserve(attempt())).outcome).toBe("inventory_not_initialized");
});

it("captures and purges a reset's PostgreSQL rows while retaining history and fencing late operations", async () => {
  const stock = new PostgresStockReservations(connection.sql);
  const { input, job } = await acceptedOrder();
  const pending = attempt();
  await stock.reserve(pending);
  expect((await stock.reserve(attempt(3))).outcome).toBe("sold_out");
  const delivery = new PostgresOrderDelivery(connection.sql);
  const publisher = createPostgresOrderProcessJobPublisher({
    sql: connection.sql,
    delivery,
    publicationFence: new PostgresGeneratedRunPublicationFence(connection.db),
  });
  await publisher.enqueue(job);
  const [claim] = await delivery.claim({ limit: 1, leaseSeconds: 1 });
  expect(claim).toBeDefined();
  await resetService().reset("pg-reset", "admin_reset");
  await expectWorkingRowsGone();
  const [run] = await connection.db.select().from(demoRuns).where(eq(demoRuns.id, scope.runId));
  const summaries = await connection.db.select().from(demoRunSummaries);
  expect(run?.adminResetCompletedAt).not.toBeNull();
  expect(summaries[0]?.terminalInventorySnapshot).toMatchObject({
    source: "postgres",
    remainingStock: 1,
    reservedStock: 2,
    soldOutRejections: 1,
    pendingPersistenceCount: 1,
    acceptedReservations: 1,
  });
  expect(summaries[0]?.businessOutcomeSummary.soldOutRejections).toBe(1);
  expect(await connection.db.select().from(demoRunSaleContexts)).toHaveLength(1);
  expect(
    await redis.exists(
      dashboardProjectionScopeKey(scope.runId),
      inventoryKeys(scope.saleOfferId).state,
    ),
  ).toBe(0);
  expect((await stock.reserve(attempt())).outcome).toBe("inventory_not_initialized");
  await expect(stock.promoteAccepted(input)).rejects.toThrow(/hold identity/);
  expect(await stock.reverse(pending)).toBe("not_held");
  await stock.close(scope);
  await expect(publisher.enqueue(job)).rejects.toThrow(/terminal, missing/);
  if (claim) expect(await delivery.settle(claim)).toBe(false);
  await expectWorkingRowsGone();
  await resetService().reset("pg-reset-retry", "admin_reset");
  expect(await connection.db.select().from(demoRunSummaries)).toEqual(summaries);
});

it("revalidates pending holds and unsettled deliveries before exact teardown", async () => {
  const { job } = await acceptedOrder();
  const pending = attempt();
  const stock = new PostgresStockReservations(connection.sql);
  await stock.reserve(pending);
  const delivery = new PostgresOrderDelivery(connection.sql);
  await delivery.publish(connection.sql, job);
  const [claim] = await delivery.claim({ limit: 1, leaseSeconds: 60 });
  await new PostgresTerminalDemoRunSummaryWriter(connection.db, queueLimits).claimTerminalRun({
    runId: scope.runId,
    terminalStatus: "failed",
    failureReason: "load_generator_lost",
    finalizedAt: new Date(),
    allowedCurrentStatuses: ["active"],
  });
  expect(await inspectGeneratedRunTeardown(connection.db, scope.runId)).toEqual({
    outcome: "outstanding_work",
  });
  expect(await deleteGeneratedRunDurable(connection.db, scope)).toEqual({
    outcome: "outstanding_work",
  });
  await stock.reverse(pending);
  expect(await deleteGeneratedRunDurable(connection.db, scope)).toEqual({
    outcome: "outstanding_work",
  });
  if (claim) await delivery.settle(claim);
  const teardown = new GeneratedRunTeardownService({
    db: connection.db,
    redis,
    inventory: createRunInventoryLifecycle(connection.db, redis),
    queueMaintenance,
    deleteGeneratedRunRedisState,
    inspectGeneratedRunTeardown,
    deleteGeneratedRunDurable,
    maintenanceAuthority: new ProcessLocalDemoMaintenanceAuthority(),
    logger,
  });
  expect(
    (await teardown.teardownGeneratedRun({ runId: scope.runId, correlationId: "teardown" }))
      .outcome,
  ).toBe("deleted");
  await expectWorkingRowsGone();
  expect(await connection.db.select().from(demoRuns)).toHaveLength(0);
});

it("keeps successor quota when a forced-close old handler resumes after reset", async () => {
  const { job } = await acceptedOrder("queued");
  const delivery = new PostgresOrderDelivery(connection.sql);
  await delivery.publish(connection.sql, job);
  let now = 0;
  const gate = createErpDeclaredDispatchGate({ now: () => now });
  const contextA = {
    scope: `run:${scope.runId}` as const,
    configuredConcurrency: 1,
    dispatch: { executionMode: "without_redis" as const, maxTps: 1 },
  };
  let resume!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const delayedAdmission = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let lateDecision: unknown;
  const handler = {
    handle: async () => {
      expect(await gate.tryAcquire(contextA)).toEqual({ admitted: true });
      started();
      await delayedAdmission;
      lateDecision = await gate.tryAcquire(contextA);
    },
  };
  const consumer = createPostgresOrderProcessConsumer({
    delivery,
    sql: connection.sql,
    handler,
    recovery: {
      recordRecoverable: async () => {},
      recordDeadLetter: async () => {},
      isTerminalResetRun: async () => true,
    },
    logger,
    concurrency: 1,
    scanIntervalMs: 10,
    leaseSeconds: 1,
    closeDeadlineMs: 10,
  });
  try {
    consumer.start();
    await startedPromise;
    await consumer.close();
    await resetService().reset("old-handler-reset", "admin_reset");
    const successor = await createRun();
    now = 2000;
    const contextB = { ...contextA, scope: `run:${successor.runId}` as const };
    expect(await gate.tryAcquire(contextB)).toEqual({ admitted: true });
    resume();
    await vi.waitFor(() => expect(lateDecision).toEqual({ admitted: true }));
    expect(await gate.tryAcquire(contextB)).toEqual({ admitted: false, nextEligibleAtMs: 3053 });
    await expectWorkingRowsGone();
  } finally {
    resume();
    await consumer.close();
  }
});

function requireRedisUrl(): string {
  const value = process.env.TEST_REDIS_URL;
  if (!value) throw new Error("TEST_REDIS_URL is required.");
  return value;
}
