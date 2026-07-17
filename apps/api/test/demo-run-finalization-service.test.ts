import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type {
  AcceptedRunConfigSnapshot,
  AdminDemoResetResponse,
  BusinessOutcomeSummary,
  TerminalInventorySnapshot,
  TrafficCompletionReport,
} from "@checkout-surge/contracts";
import {
  dashboardEventsRedisChannel,
  emptyHttpTimingBreakdownSummary,
  trafficDeliverySummarySchema,
} from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createRedisClient,
  demoPresets,
  demoRunFinalizations,
  demoRunReservationOutcomes,
  demoRunSaleContexts,
  demoRunSummaries,
  demoRuns,
  erpAttempts,
  initializeInventory,
  orderRecoveryJobs,
  orders,
  products,
  reservationPendingPersistence,
  reservations,
  saleOffers,
  simulatedNotifications,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { count, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoMaintenanceService } from "../src/services/demo-maintenance-service.js";
import { DemoRunFinalizationService } from "../src/services/demo-run-finalization-service.js";
import type { PendingPersistenceReconciler } from "../src/services/pending-persistence-reconciler.js";
import {
  PostgresTerminalDemoRunSummaryWriter,
  terminalDemoRunTransitionLockKey,
} from "../src/services/terminal-demo-run-transition.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPackageRoot = path.resolve(packageRoot, "../../packages/db");
const migrationsFolder = path.join(dbPackageRoot, "drizzle");

const ids = {
  product: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  preset: "33333333-3333-4333-8333-333333333331",
  run: "55555555-5555-4555-8555-555555555555",
  saleOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  reservation1: "11111111-1111-4111-8111-111111111111",
  reservation2: "22222222-2222-4222-8222-222222222222",
  order1: "44444444-4444-4444-8444-444444444441",
  order2: "44444444-4444-4444-8444-444444444442",
  erpAttempt: "88888888-8888-4888-8888-888888888888",
  notification: "99999999-9999-4999-8999-999999999999",
} as const;

const durableTerminalInventorySnapshot: TerminalInventorySnapshot = {
  saleOfferId: ids.saleOffer,
  startingStock: 73,
  remainingStock: 11,
  reservedStock: 62,
  acceptedReservations: 61,
  soldOutRejections: 43,
  pendingPersistenceCount: 0,
  capturedAt: "2026-06-20T00:00:05.123Z",
  source: "redis",
};

describe("demo run finalization service", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;
  let redis: ReturnType<typeof createRedisClient> | null = null;

  beforeEach(async () => {
    await connection?.close();
    redis?.disconnect();
    connection = null;
    redis = null;

    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    redis = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    await redis.flushdb();
  });

  afterAll(async () => {
    await connection?.close();
    if (redis) {
      await redis.flushdb();
      redis.disconnect();
    }
  });

  it.each([
    {
      name: "queued orders",
      seed: async (db: ReturnType<typeof createDatabaseConnection>["db"]) => {
        await db.insert(reservations).values(reservationFixture(ids.reservation1));
        await db.insert(orders).values(orderFixture(ids.order1, ids.reservation1, "queued"));
      },
    },
    {
      name: "processing orders",
      seed: async (db: ReturnType<typeof createDatabaseConnection>["db"]) => {
        await db.insert(reservations).values(reservationFixture(ids.reservation1));
        await db.insert(orders).values(orderFixture(ids.order1, ids.reservation1, "processing"));
      },
    },
    {
      name: "retrying orders",
      seed: async (db: ReturnType<typeof createDatabaseConnection>["db"]) => {
        await db.insert(reservations).values(reservationFixture(ids.reservation1));
        await db.insert(orders).values(orderFixture(ids.order1, ids.reservation1, "processing"));
        await db.insert(erpAttempts).values({
          id: ids.erpAttempt,
          orderId: ids.order1,
          deliveryId: "finalize-delivery-1",
          correlationId: "corr-finalize-test",
          runId: ids.run,
          attemptNumber: 1,
          status: "failed",
          terminal: false,
          httpStatus: 503,
          errorCode: "erp_unavailable",
          errorMessage: "ERP unavailable.",
          latencyMs: 50,
          startedAt: new Date("2026-06-20T00:00:04.000Z"),
          finishedAt: new Date("2026-06-20T00:00:04.050Z"),
          createdAt: new Date("2026-06-20T00:00:04.050Z"),
        });
      },
    },
    {
      name: "missing required notifications",
      seed: async (db: ReturnType<typeof createDatabaseConnection>["db"]) => {
        await db.insert(reservations).values(reservationFixture(ids.reservation1));
        await db.insert(orders).values(orderFixture(ids.order1, ids.reservation1, "confirmed"));
      },
    },
    {
      name: "pending persistence reconciliation",
      seed: async (db: ReturnType<typeof createDatabaseConnection>["db"]) => {
        await db.insert(reservationPendingPersistence).values(pendingPersistenceFixture());
      },
    },
  ])("keeps a traffic-complete run draining while $name remain unsettled", async ({ seed }) => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);

    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await seed(db);

    const finalized = await service.finalizeRun(ids.run, "corr-finalize-test");
    const [summaryCount] = await db
      .select({ value: count() })
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));

    expect(finalized?.status).toBe("draining");
    expect(summaryCount?.value).toBe(0);
  });

  it("writes one immutable completed summary after business work settles", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const postgresTerminalRunWriter = new PostgresTerminalDemoRunSummaryWriter(db);
    const writeTerminalRun = vi.fn(postgresTerminalRunWriter.write.bind(postgresTerminalRunWriter));
    const service = createService(connection, redis, {
      terminalRunWriter: { write: writeTerminalRun },
    });

    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await db
      .update(demoRunFinalizations)
      .set({
        trafficOutcomeSummary: {
          loadGeneratorOutcome: "preserved",
          terminalInventorySnapshot: durableTerminalInventorySnapshot,
        },
      })
      .where(eq(demoRunFinalizations.runId, ids.run));
    await db.insert(demoRunReservationOutcomes).values({
      runId: ids.run,
      outcome: "api_sold_out_decision",
      count: 7,
      latestObservedAt: new Date("2026-06-20T00:00:09.000Z"),
      source: "redis",
      capturedAt: new Date("2026-06-20T00:00:10.000Z"),
      createdAt: new Date("2026-06-20T00:00:10.000Z"),
    });
    await db
      .insert(reservations)
      .values([reservationFixture(ids.reservation1), reservationFixture(ids.reservation2)]);
    await db
      .insert(orders)
      .values([
        orderFixture(ids.order1, ids.reservation1, "confirmed"),
        orderFixture(ids.order2, ids.reservation2, "failed"),
      ]);
    await db.insert(simulatedNotifications).values({
      id: ids.notification,
      orderId: ids.order1,
      saleOfferId: ids.saleOffer,
      runId: ids.run,
      correlationId: "corr-finalize-test",
      channel: "email",
      recipientPlaceholder: "buyer@example.invalid",
      status: "recorded",
      recordedAt: new Date("2026-06-20T00:00:08.000Z"),
      createdAt: new Date("2026-06-20T00:00:08.000Z"),
    });

    const first = await service.finalizeRun(ids.run, "corr-finalize-test");
    const second = await service.finalizeRun(ids.run, "corr-finalize-test");
    const summaries = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));

    expect(first?.status).toBe("completed");
    expect(second?.status).toBe("completed");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.status).toBe("completed");
    expect(summaries[0]?.endedAt).toEqual(new Date("2026-06-20T00:00:10.000Z"));
    expect(summaries[0]?.createdAt).toEqual(new Date("2026-06-20T00:00:10.000Z"));
    expect(summaries[0]?.failureReason).toBeNull();
    expect(summaries[0]?.businessOutcomeSummary as BusinessOutcomeSummary).toMatchObject({
      acceptedReservations: 2,
      soldOutRejections: 7,
      confirmedOrders: 1,
      failedOrders: 1,
      notificationsRecorded: 1,
      pendingPersistenceCount: 0,
    });
    expect(summaries[0]?.terminalInventorySnapshot).toEqual(durableTerminalInventorySnapshot);
    expect(summaries[0]?.httpTimingBreakdownSummary).toEqual({
      ...emptyHttpTimingBreakdownSummary,
      waiting: { averageMs: 10, p95Ms: 20 },
    });
    expect(summaries[0]?.loadRunDiagnosticsSummary).toMatchObject({
      terminalMetricSources: {
        emittedRequests: "summary_export",
        acceptedResponses: "point_stream",
      },
      summaryExportWarnings: ["k6_outcome_counter_point_stream_fallback_used"],
    });
    expect(writeTerminalRun).toHaveBeenCalledOnce();
    expect(writeTerminalRun).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalStatus: "completed",
        businessOutcome: expect.objectContaining({
          acceptedReservations: 2,
          soldOutRejections: 7,
        }),
        terminalInventorySnapshot: durableTerminalInventorySnapshot,
        allowedCurrentStatuses: ["draining"],
        finalizedAt: new Date("2026-06-20T00:00:10.000Z"),
      }),
    );
  });

  it("finalizes legacy traffic outcomes without a durable inventory snapshot as null", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);

    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await db
      .update(demoRunFinalizations)
      .set({ trafficOutcomeSummary: { loadGeneratorOutcome: "legacy" } })
      .where(eq(demoRunFinalizations.runId, ids.run));

    await expect(service.finalizeRun(ids.run, "corr-finalize-legacy")).resolves.toMatchObject({
      status: "completed",
    });
    const [summary] = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));
    const [legacyFinalization] = await db
      .select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, ids.run));

    expect(summary?.terminalInventorySnapshot).toBeNull();
    expect(legacyFinalization?.completionEnrichmentStatus).toBe("completed");
  });

  it("does not treat pending completion enrichment as a drain timeout or write a summary", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const reconcileSaleOffer = vi.fn();
    const service = createService(connection, redis, {
      pendingPersistenceReconciler: { reconcileSaleOffer } as never,
      now: () => new Date("2026-06-20T01:00:00.000Z"),
    });

    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await db
      .update(demoRunFinalizations)
      .set({ completionEnrichmentStatus: "pending" })
      .where(eq(demoRunFinalizations.runId, ids.run));

    await expect(service.finalizeRun(ids.run, "corr-finalize-pending")).resolves.toMatchObject({
      status: "draining",
    });
    await expect(service.finalizeReadyRuns()).resolves.toBe(0);
    const [summaryCount] = await db
      .select({ value: count() })
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));

    expect(summaryCount?.value).toBe(0);
    expect(reconcileSaleOffer).not.toHaveBeenCalled();
  });

  it("rejects a present but invalid durable inventory snapshot", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);

    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await db
      .update(demoRunFinalizations)
      .set({
        trafficOutcomeSummary: {
          terminalInventorySnapshot: {
            ...durableTerminalInventorySnapshot,
            capturedAt: "not-an-iso-timestamp",
          },
        },
      })
      .where(eq(demoRunFinalizations.runId, ids.run));

    await expect(service.finalizeRun(ids.run, "corr-finalize-invalid")).rejects.toThrow();
    const [run] = await db.select().from(demoRuns).where(eq(demoRuns.id, ids.run));
    const [summaryCount] = await db
      .select({ value: count() })
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));

    expect(run?.status).toBe("draining");
    expect(summaryCount?.value).toBe(0);
  });

  it("blocks on pending reconciliation, then settles after resolution", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);
    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await db.insert(reservations).values(reservationFixture(ids.reservation1));
    await db.insert(orders).values(orderFixture(ids.order1, ids.reservation1, "confirmed"));
    await db.insert(simulatedNotifications).values({
      id: ids.notification,
      orderId: ids.order1,
      saleOfferId: ids.saleOffer,
      runId: ids.run,
      correlationId: "corr-finalize-test",
      channel: "email",
      recipientPlaceholder: "buyer@example.invalid",
      status: "recorded",
      recordedAt: new Date("2026-06-20T00:00:08.000Z"),
    });
    await db.insert(orderRecoveryJobs).values({
      recoveryKey: `order:${ids.order1}`,
      jobId: "pending-recovery",
      orderId: ids.order1,
      payload: { orderId: ids.order1 },
      reason: "erp_local_persistence_unavailable",
      status: "pending",
      attempts: 1,
    });

    await expect(service.finalizeRun(ids.run, "corr-finalize-pending")).resolves.toMatchObject({
      status: "draining",
    });
    await db
      .update(orderRecoveryJobs)
      .set({ status: "resolved", resolvedAt: new Date("2026-06-20T00:00:09.000Z") })
      .where(eq(orderRecoveryJobs.recoveryKey, `order:${ids.order1}`));
    await expect(service.finalizeRun(ids.run, "corr-finalize-resolved")).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("allows escalated processing orders to fail terminally while unrelated work still blocks", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);
    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await db
      .insert(reservations)
      .values([reservationFixture(ids.reservation1), reservationFixture(ids.reservation2)]);
    await db
      .insert(orders)
      .values([
        orderFixture(ids.order1, ids.reservation1, "processing"),
        orderFixture(ids.order2, ids.reservation2, "processing"),
      ]);
    await db.insert(erpAttempts).values({
      orderId: ids.order1,
      deliveryId: "escalated-retry-delivery",
      correlationId: "corr-finalize-test",
      runId: ids.run,
      attemptNumber: 1,
      status: "failed",
      terminal: false,
      errorCode: "erp_unavailable",
      errorMessage: "ERP unavailable.",
      latencyMs: 10,
      startedAt: new Date("2026-06-20T00:00:04.000Z"),
      finishedAt: new Date("2026-06-20T00:00:04.010Z"),
    });
    await db.insert(orderRecoveryJobs).values({
      recoveryKey: `order:${ids.order1}`,
      jobId: "escalated-recovery",
      orderId: ids.order1,
      payload: { orderId: ids.order1 },
      reason: "recovery_attempt_limit_exceeded",
      status: "escalated",
      attempts: 3,
    });

    await expect(service.finalizeRun(ids.run, "corr-finalize-unrelated")).resolves.toMatchObject({
      status: "draining",
    });
    await db
      .update(orders)
      .set({ status: "confirmed", confirmedAt: new Date("2026-06-20T00:00:05.000Z") })
      .where(eq(orders.id, ids.order2));
    await db.insert(simulatedNotifications).values({
      id: ids.notification,
      orderId: ids.order2,
      saleOfferId: ids.saleOffer,
      runId: ids.run,
      correlationId: "corr-finalize-test",
      channel: "email",
      recipientPlaceholder: "buyer@example.invalid",
      status: "recorded",
      recordedAt: new Date("2026-06-20T00:00:08.000Z"),
    });

    const finalized = await service.finalizeRun(ids.run, "corr-finalize-escalated");
    expect(finalized).toMatchObject({
      status: "failed",
      failureReason: "reconciliation_escalated",
    });
  });

  it("invokes pending reconciliation before finalization readiness", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    const reconcileSaleOffer = vi.fn(async () => ({
      found: 0,
      materialized: 0,
      reconciled: 0,
      reversed: 0,
      failed: 0,
    }));
    const service = createService(connection, redis, {
      pendingPersistenceReconciler: { reconcileSaleOffer },
    });

    const finalized = await service.finalizeRun(ids.run, "corr-finalize-reconcile");

    expect(finalized?.status).toBe("completed");
    expect(reconcileSaleOffer).toHaveBeenCalledWith(ids.saleOffer, { runId: ids.run });
  });

  it("materializes pending persistence before capturing terminal business counts", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await setAcceptedDeliveryEvidence(db, { acceptedResponses: 1 });
    await db
      .update(demoRunFinalizations)
      .set({
        trafficOutcomeSummary: { terminalInventorySnapshot: durableTerminalInventorySnapshot },
      })
      .where(eq(demoRunFinalizations.runId, ids.run));
    await db.insert(reservationPendingPersistence).values(pendingPersistenceFixture());
    const reconcileSaleOffer = vi.fn(async () => {
      await db.insert(reservations).values(reservationFixture(ids.reservation1));
      await db.insert(orders).values(orderFixture(ids.order1, ids.reservation1, "failed"));
      await db
        .update(reservationPendingPersistence)
        .set({
          status: "reconciled",
          updatedAt: new Date("2026-06-20T00:00:09.000Z"),
        })
        .where(eq(reservationPendingPersistence.reservationId, ids.reservation1));
      return { found: 1, materialized: 1, reconciled: 1, reversed: 0, failed: 0 };
    });
    const service = createService(connection, redis, {
      pendingPersistenceReconciler: { reconcileSaleOffer },
    });

    await expect(service.finalizeRun(ids.run, "corr-finalize-materialize")).resolves.toMatchObject({
      status: "completed",
    });
    const [summary] = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));

    expect(reconcileSaleOffer).toHaveBeenCalledOnce();
    expect(summary?.businessOutcomeSummary as BusinessOutcomeSummary).toMatchObject({
      acceptedReservations: 1,
      failedOrders: 1,
      pendingPersistenceCount: 0,
    });
    expect(summary?.terminalInventorySnapshot).toEqual(durableTerminalInventorySnapshot);
  });

  it.each([
    "reported",
    "thrown",
  ] as const)("keeps a %s pending reconciliation failure draining before timeout and fails at timeout", async (failureMode) => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    const reconcileSaleOffer = vi.fn(async () => {
      if (failureMode === "thrown") throw new Error("Redis reconciliation unavailable");
      return {
        found: 1,
        materialized: 0,
        reconciled: 0,
        reversed: 0,
        failed: 1,
      };
    });
    const beforeTimeout = createService(connection, redis, {
      pendingPersistenceReconciler: { reconcileSaleOffer },
    });

    await expect(
      beforeTimeout.finalizeRun(ids.run, "corr-finalize-retryable"),
    ).resolves.toMatchObject({ status: "draining" });
    await expect(
      db.select().from(demoRunSummaries).where(eq(demoRunSummaries.runId, ids.run)),
    ).resolves.toHaveLength(0);

    const atTimeout = createService(connection, redis, {
      pendingPersistenceReconciler: { reconcileSaleOffer },
      now: () => new Date("2026-06-20T00:10:00.000Z"),
    });
    await expect(
      atTimeout.finalizeRun(ids.run, "corr-finalize-retryable-timeout"),
    ).resolves.toMatchObject({
      status: "failed",
      failureReason: "pending_persistence_reconciliation_timeout",
    });
    const summaries = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      status: "failed",
      failureReason: "pending_persistence_reconciliation_timeout",
    });
  });

  it("keeps run and summary terminal state consistent when reset races with finalization", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const finalizationService = createService(connection, redis);
    const lockConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    const resetConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    const resetService = new DemoMaintenanceService({
      db: resetConnection.db,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(resetConnection.db),
      redis: redisClient,
      queueMaintenance: {
        cleanResetOwnedQueues: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
      },
      trafficAborter: { abortCurrent: async () => ({ outcome: "no_current_run" }) },
      dashboardLiveStateReset: {
        fenceRun: async () => undefined,
        clearRun: async () => undefined,
        hasRunState: async () => false,
      },
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:11.000Z"),
    });
    let finalizationPromise: Promise<unknown> | null = null;
    let resetPromise: Promise<AdminDemoResetResponse> | null = null;

    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });

    try {
      await lockConnection.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${terminalDemoRunTransitionLockKey(ids.run)}))`,
        );

        finalizationPromise = finalizationService.finalizeRun(ids.run, "corr-finalize-race");
        await waitForWaitingAdvisoryLock(resetConnection.sql);

        resetPromise = resetService.reset("corr-reset-race");
        await delay(100);
      });

      const startedFinalization = requireStartedPromise(finalizationPromise, "finalization");
      const startedReset = requireStartedPromise<AdminDemoResetResponse>(resetPromise, "reset");
      await startedFinalization;
      const resetResponse = await startedReset;
      const [run] = await db.select().from(demoRuns).where(eq(demoRuns.id, ids.run)).limit(1);
      const summaries = await db
        .select()
        .from(demoRunSummaries)
        .where(eq(demoRunSummaries.runId, ids.run));
      const [summary] = summaries;

      expect(resetResponse.failedRunCount === 0 || resetResponse.failedRunCount === 1).toBe(true);
      expect(summaries).toHaveLength(1);
      expect(run).toBeDefined();
      expect(run?.status).toBe(summary?.status);
      expect(run?.failureReason).toBe(summary?.failureReason);
      expect(run?.finalizedAt).toEqual(summary?.endedAt);
    } finally {
      await lockConnection.close();
      await resetConnection.close();
    }
  });

  it("lets only one competing finalizer own terminal summary side effects", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const lockConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    const competingConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    const observerConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    const subscriberRedis = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    const barrierChannel = "task-74-terminal-event-barrier";
    const barrierSentinel = "finalizer-publishes-complete";
    const terminalEvents: unknown[] = [];
    const observedBarriers: string[] = [];
    const writeResults: boolean[] = [];
    const firstWriter = new PostgresTerminalDemoRunSummaryWriter(db);
    const secondWriter = new PostgresTerminalDemoRunSummaryWriter(competingConnection.db);
    const firstService = createService(connection, redis, {
      terminalRunWriter: {
        write: async (input) => {
          const wrote = await firstWriter.write(input);
          writeResults.push(wrote);
          return wrote;
        },
      },
    });
    const secondService = createService(competingConnection, redis, {
      terminalRunWriter: {
        write: async (input) => {
          const wrote = await secondWriter.write(input);
          writeResults.push(wrote);
          return wrote;
        },
      },
    });
    let firstFinalization: Promise<unknown> | null = null;
    let secondFinalization: Promise<unknown> | null = null;
    let subscribed = false;
    const handleSubscriberMessage = (channel: string, message: string) => {
      if (channel === dashboardEventsRedisChannel) {
        terminalEvents.push(JSON.parse(message));
      }
      if (channel === barrierChannel && message === barrierSentinel) {
        observedBarriers.push(message);
      }
    };
    subscriberRedis.on("message", handleSubscriberMessage);

    try {
      await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
      await subscriberRedis.subscribe(dashboardEventsRedisChannel, barrierChannel);
      subscribed = true;
      await lockConnection.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${terminalDemoRunTransitionLockKey(ids.run)}))`,
        );

        firstFinalization = firstService.finalizeRun(ids.run, "corr-finalize-first");
        secondFinalization = secondService.finalizeRun(ids.run, "corr-finalize-second");
        await waitForWaitingAdvisoryLock(observerConnection.sql, 2);
      });

      await Promise.all([
        requireStartedPromise(firstFinalization, "first finalization"),
        requireStartedPromise(secondFinalization, "second finalization"),
      ]);
      await redisClient.publish(barrierChannel, barrierSentinel);
      await waitForObservedCount(observedBarriers, 1);
      const summaries = await db
        .select()
        .from(demoRunSummaries)
        .where(eq(demoRunSummaries.runId, ids.run));

      expect(summaries).toHaveLength(1);
      expect(writeResults.sort()).toEqual([false, true]);
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]).toMatchObject({
        type: "load.run.updated",
        runId: ids.run,
        run: { status: "completed" },
      });
    } finally {
      subscriberRedis.off("message", handleSubscriberMessage);
      try {
        if (subscribed) {
          await subscriberRedis.unsubscribe(dashboardEventsRedisChannel, barrierChannel);
        }
      } finally {
        try {
          subscriberRedis.disconnect();
        } finally {
          await Promise.all([
            lockConnection.close(),
            competingConnection.close(),
            observerConnection.close(),
          ]);
        }
      }
    }
  });

  it("finalizes as failed for major traffic-delivery shortfall after business drain", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);

    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "failed" });
    await db.insert(reservations).values(reservationFixture(ids.reservation1));
    await db.insert(orders).values(orderFixture(ids.order1, ids.reservation1, "processing"));

    await expect(service.finalizeRun(ids.run, "corr-finalize-draining")).resolves.toMatchObject({
      status: "draining",
    });
    await db
      .update(orders)
      .set({ status: "confirmed", confirmedAt: new Date("2026-06-20T00:00:09.000Z") })
      .where(eq(orders.id, ids.order1));
    await db.insert(simulatedNotifications).values({
      id: ids.notification,
      orderId: ids.order1,
      saleOfferId: ids.saleOffer,
      runId: ids.run,
      correlationId: "corr-finalize-test",
      channel: "email",
      recipientPlaceholder: "buyer@example.invalid",
      status: "recorded",
      recordedAt: new Date("2026-06-20T00:00:09.000Z"),
    });

    const finalized = await service.finalizeRun(ids.run, "corr-finalize-test");
    const [summary] = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run))
      .limit(1);

    expect(finalized?.status).toBe("failed");
    expect(finalized?.failureReason).toBe("traffic_delivery_major_shortfall");
    expect(summary?.status).toBe("failed");
    expect(summary?.failureReason).toBe("traffic_delivery_major_shortfall");
    expect(summary?.trafficDeliverySummary).toMatchObject({
      requestShortfall: 5,
      trafficDeliveryStatus: "failed",
    });
  });

  it("gives unexpected responses precedence over delivery and traffic-process failures", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);
    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await db
      .update(demoRunFinalizations)
      .set({
        httpSummary: {
          ...trafficCompletionReportFixture("complete").httpSummary,
          unexpectedResponses: 1,
          failedRequests: 1,
        },
        errorMessage: "k6 also reported a process error",
      })
      .where(eq(demoRunFinalizations.runId, ids.run));

    await expect(service.finalizeRun(ids.run)).resolves.toMatchObject({
      status: "failed",
      failureReason: "traffic_outcome_unexpected_responses",
    });
  });

  it("normalizes a fully evidenced duplicate buyer spike before PostgreSQL reconciliation", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);
    const duplicateConfig = duplicateBuyerConfigSnapshot();
    await seedDrainingRun({
      db,
      redis: redisClient,
      trafficDeliveryStatus: "complete",
      configSnapshot: duplicateConfig,
    });
    await setAcceptedDeliveryEvidence(db, {
      acceptedResponses: 100,
      plannedRequests: 400,
      emittedRequests: 400,
      completedIterations: 400,
      unstartedIterations: 0,
    });
    await insertFailedReservationOrders(db, 50);

    await expect(service.finalizeRun(ids.run)).resolves.toMatchObject({ status: "completed" });
    const [summary] = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));
    expect(summary?.businessOutcomeSummary).toMatchObject({
      acceptedReservations: 50,
      failedOrders: 50,
    });
  });

  it("does not halve duplicate responses when delivery is incomplete", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);
    await seedDrainingRun({
      db,
      redis: redisClient,
      trafficDeliveryStatus: "complete",
      configSnapshot: duplicateBuyerConfigSnapshot(),
    });
    await setAcceptedDeliveryEvidence(db, {
      acceptedResponses: 100,
      plannedRequests: 400,
      emittedRequests: 399,
      completedIterations: 399,
      unstartedIterations: 1,
    });
    await insertFailedReservationOrders(db, 50);

    await expect(service.finalizeRun(ids.run)).resolves.toMatchObject({ status: "draining" });
  });

  it("times out with accepted-response accounting when durable PostgreSQL evidence is missing", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await setAcceptedDeliveryEvidence(db, { acceptedResponses: 25 });
    await insertFailedReservationOrders(db, 20);

    await expect(createService(connection, redis).finalizeRun(ids.run)).resolves.toMatchObject({
      status: "draining",
    });
    await expect(
      createService(connection, redis, {
        now: () => new Date("2026-06-20T00:10:00.000Z"),
      }).finalizeRun(ids.run),
    ).resolves.toMatchObject({
      status: "failed",
      failureReason: "accepted_response_accounting_timeout",
    });
  });

  it("preserves underreported durable rows and writes one structured diagnostic", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);
    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await setAcceptedDeliveryEvidence(db, { acceptedResponses: 24 });
    await insertFailedReservationOrders(db, 25);
    const durableCountsBefore = await readDurableRowCounts(db);

    await expect(service.finalizeRun(ids.run)).resolves.toMatchObject({ status: "completed" });
    await expect(service.finalizeRun(ids.run)).resolves.toMatchObject({ status: "completed" });
    const [summary] = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));
    expect(
      (summary?.loadRunDiagnosticsSummary as { accountingWarnings?: unknown[] }).accountingWarnings,
    ).toEqual([
      {
        code: "traffic_outcome_counter_underreported",
        rawAcceptedResponses: 24,
        normalizedExpectedCount: 24,
        reservationCount: 25,
        orderCount: 25,
        duplicateNormalizationApplied: false,
      },
    ]);
    expect(await readDurableRowCounts(db)).toEqual(durableCountsBefore);
    expect(durableCountsBefore).toEqual({ reservationCount: 25, orderCount: 25 });
    expect((summary?.businessOutcomeSummary as BusinessOutcomeSummary).acceptedReservations).toBe(
      25,
    );
  });

  it("uses the current API drain timeout for an already-draining run", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis, { drainTimeoutSeconds: 1 });

    await seedDrainingRun({
      db,
      redis: redisClient,
      trafficDeliveryStatus: "complete",
      configSnapshot: configSnapshotFixture({ drainTimeoutSeconds: 300 }),
      trafficEndedAt: new Date("2026-06-20T00:00:00.000Z"),
    });
    await db.insert(reservationPendingPersistence).values({
      reservationId: ids.reservation1,
      saleOfferId: ids.saleOffer,
      runId: ids.run,
      correlationId: "corr-finalize-test",
      idempotencyKey: "pending-key",
      quantity: 1,
      reservationToken: "pending-token",
      status: "pending_reconciliation",
      securedAt: new Date("2026-06-20T00:00:00.000Z"),
      expiresAt: new Date("2026-06-20T00:15:00.000Z"),
      createdAt: new Date("2026-06-20T00:00:00.000Z"),
      updatedAt: new Date("2026-06-20T00:00:00.000Z"),
    });

    const finalized = await service.finalizeRun(ids.run, "corr-finalize-test");

    expect(finalized?.status).toBe("failed");
    expect(finalized?.failureReason).toBe("business_drain_timeout");
  });
});

function createService(
  connection: ReturnType<typeof createDatabaseConnection> | null,
  redis: ReturnType<typeof createRedisClient> | null,
  options: {
    pendingPersistenceReconciler?: Pick<PendingPersistenceReconciler, "reconcileSaleOffer">;
    terminalRunWriter?: ConstructorParameters<
      typeof DemoRunFinalizationService
    >[0]["terminalRunWriter"];
    now?: () => Date;
    drainTimeoutSeconds?: number;
  } = {},
): DemoRunFinalizationService {
  return new DemoRunFinalizationService({
    db: requireConnection(connection).db,
    terminalRunWriter:
      options.terminalRunWriter ??
      new PostgresTerminalDemoRunSummaryWriter(requireConnection(connection).db),
    redis: requireRedis(redis),
    logger: createSilentLogger("api"),
    drainTimeoutSeconds: 300,
    now: () => new Date("2026-06-20T00:00:10.000Z"),
    ...options,
  });
}

async function seedDrainingRun(input: {
  db: ReturnType<typeof createDatabaseConnection>["db"];
  redis: ReturnType<typeof createRedisClient>;
  trafficDeliveryStatus: "complete" | "failed";
  configSnapshot?: AcceptedRunConfigSnapshot;
  trafficEndedAt?: Date;
}): Promise<void> {
  const configSnapshot = input.configSnapshot ?? configSnapshotFixture();
  const trafficEndedAt = input.trafficEndedAt ?? new Date("2026-06-20T00:00:05.000Z");
  await input.db.insert(products).values({
    id: ids.product,
    sku: "FINALIZE-001",
    slug: "finalize-product",
    name: "Finalize Product",
    isActive: true,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await input.db.insert(demoPresets).values({
    id: ids.preset,
    slug: "finalize-preset",
    visibility: "public",
    isEditable: false,
    isCustom: false,
    display: {
      name: "Finalize Preset",
      description: "Finalization fixture.",
      sortOrder: 1,
      outcomeFocus: ["run_history"],
    },
    ...configSnapshot,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await input.db.insert(saleOffers).values({
    id: ids.saleOffer,
    productId: ids.product,
    name: "Finalize Offer",
    allocatedStock: configSnapshot.inventoryConfig.startingStock,
    saleStartsAt: new Date("2026-06-20T00:00:00.000Z"),
    saleEndsAt: new Date("2026-06-21T00:00:00.000Z"),
    isActive: true,
    purpose: "generated_run",
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await input.db.insert(demoRuns).values({
    id: ids.run,
    presetId: ids.preset,
    presetName: "Finalize Preset",
    operatorMode: "public",
    status: "draining",
    trafficStatus: "succeeded",
    configSnapshot,
    saleOfferId: ids.saleOffer,
    startedAt: new Date("2026-06-20T00:00:00.000Z"),
    trafficStartedAt: new Date("2026-06-20T00:00:01.000Z"),
    trafficEndedAt,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: trafficEndedAt,
  });
  await input.db.insert(demoRunSaleContexts).values({
    runId: ids.run,
    saleOfferId: ids.saleOffer,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await input.db.insert(demoRunFinalizations).values({
    runId: ids.run,
    exitCode: 0,
    httpSummary: trafficCompletionReportFixture(input.trafficDeliveryStatus).httpSummary,
    trafficOutcomeSummary: {},
    trafficDeliverySummary: trafficDeliverySummarySchema.parse({
      ...trafficCompletionReportFixture(input.trafficDeliveryStatus).trafficDeliverySummary,
      trafficDeliveryStatus: input.trafficDeliveryStatus,
    }),
    httpTimingBreakdownSummary: {
      ...emptyHttpTimingBreakdownSummary,
      waiting: { averageMs: 10, p95Ms: 20 },
    },
    loadRunDiagnosticsSummary: runnerDiagnosticsFixture(),
    apiRequestLifecycleSummary: {},
    trafficSummaryReceivedAt: trafficEndedAt,
    createdAt: trafficEndedAt,
    updatedAt: trafficEndedAt,
  });
  await initializeInventory(input.redis, {
    saleOfferId: ids.saleOffer,
    allocatedStock: configSnapshot.inventoryConfig.startingStock,
    initializedAt: new Date("2026-06-20T00:00:00.000Z"),
    run: { runId: ids.run, status: "closed" },
  });
}

function runnerDiagnosticsFixture(): TrafficCompletionReport["loadRunDiagnosticsSummary"] {
  return {
    startedAt: "2026-06-20T00:00:00.000Z",
    completedAt: "2026-06-20T00:00:05.000Z",
    nproc: null,
    ulimitNofile: null,
    processMaxOpenFiles: null,
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
      emittedRequests: "summary_export",
      completedRequests: "summary_export",
      acceptedResponses: "point_stream",
      soldOutResponses: "summary_export",
      unexpectedResponses: "summary_export",
      droppedIterations: "summary_export",
      completedIterations: "summary_export",
    },
    summaryExportWarnings: ["k6_outcome_counter_point_stream_fallback_used"],
  };
}

function reservationFixture(id: string): typeof reservations.$inferInsert {
  return {
    id,
    saleOfferId: ids.saleOffer,
    runId: ids.run,
    correlationId: "corr-finalize-test",
    quantity: 1,
    status: "secured",
    reservationToken: `token-${id}`,
    securedAt: new Date("2026-06-20T00:00:02.000Z"),
    expiresAt: new Date("2026-06-20T00:15:02.000Z"),
    createdAt: new Date("2026-06-20T00:00:02.000Z"),
    updatedAt: new Date("2026-06-20T00:00:02.000Z"),
  };
}

function orderFixture(
  id: string,
  reservationId: string,
  status: "queued" | "processing" | "confirmed" | "failed",
): typeof orders.$inferInsert {
  return {
    id,
    publicOrderId: `ord-${id}`,
    saleOfferId: ids.saleOffer,
    reservationId,
    runId: ids.run,
    correlationId: "corr-finalize-test",
    quantity: 1,
    status,
    queuedAt: new Date("2026-06-20T00:00:03.000Z"),
    ...(status === "processing"
      ? {
          processingAt: new Date("2026-06-20T00:00:04.000Z"),
        }
      : {}),
    ...(status === "confirmed"
      ? {
          processingAt: new Date("2026-06-20T00:00:04.000Z"),
          confirmedAt: new Date("2026-06-20T00:00:05.000Z"),
        }
      : {}),
    ...(status === "failed"
      ? {
          processingAt: new Date("2026-06-20T00:00:04.000Z"),
          failedAt: new Date("2026-06-20T00:00:05.000Z"),
          failureCode: "erp_failed",
          failureMessage: "ERP failed.",
        }
      : {}),
    createdAt: new Date("2026-06-20T00:00:03.000Z"),
    updatedAt: new Date("2026-06-20T00:00:05.000Z"),
  };
}

function pendingPersistenceFixture(): typeof reservationPendingPersistence.$inferInsert {
  return {
    reservationId: ids.reservation1,
    saleOfferId: ids.saleOffer,
    runId: ids.run,
    correlationId: "corr-finalize-test",
    idempotencyKey: "pending-key",
    quantity: 1,
    reservationToken: "pending-token",
    status: "pending_reconciliation",
    securedAt: new Date("2026-06-20T00:00:00.000Z"),
    expiresAt: new Date("2026-06-20T00:15:00.000Z"),
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  };
}

function configSnapshotFixture(
  options: { drainTimeoutSeconds?: number } = {},
): AcceptedRunConfigSnapshot {
  return {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 10,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 1,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 10,
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
      orderProcessConcurrency: 2,
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
      drainTimeoutSeconds: options.drainTimeoutSeconds ?? 300,
      pendingPersistenceRetryAfterSeconds: 30,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
    },
  };
}

function duplicateBuyerConfigSnapshot(): AcceptedRunConfigSnapshot {
  return {
    ...configSnapshotFixture(),
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 200,
      duplicateEachBuyerAttempt: true,
      startDelaySeconds: 0,
      maxDurationSeconds: 60,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      ...configSnapshotFixture().inventoryConfig,
      startingStock: 200,
    },
  };
}

async function setAcceptedDeliveryEvidence(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  input: {
    acceptedResponses: number;
    plannedRequests?: number;
    emittedRequests?: number;
    completedIterations?: number;
    unstartedIterations?: number;
  },
): Promise<void> {
  const plannedRequests = input.plannedRequests ?? 10;
  const emittedRequests = input.emittedRequests ?? plannedRequests;
  await db
    .update(demoRunFinalizations)
    .set({
      httpSummary: {
        plannedRequests,
        emittedRequests,
        completedRequests: emittedRequests,
        failedRequests: 0,
        acceptedResponses: input.acceptedResponses,
        soldOutResponses: 0,
        unexpectedResponses: 0,
        failureRate: 0,
      },
      trafficDeliverySummary: {
        plannedRequests,
        emittedRequests,
        trafficMode: "buyer-spike",
        plannedBuyers: plannedRequests === 400 ? 200 : 10,
        scheduledRatePerSecond: null,
        configuredDurationSeconds: null,
        preAllocatedVUs: null,
        maxVUs: null,
        droppedIterations: 0,
        completedIterations: input.completedIterations ?? emittedRequests,
        unstartedIterations:
          input.unstartedIterations ?? Math.max(0, plannedRequests - emittedRequests),
        requestShortfall: Math.max(0, plannedRequests - emittedRequests),
        trafficDeliveryStatus: "complete",
        notes: [],
      },
    })
    .where(eq(demoRunFinalizations.runId, ids.run));
}

async function insertFailedReservationOrders(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  countToInsert: number,
): Promise<void> {
  const pairs = Array.from({ length: countToInsert }, () => ({
    reservationId: randomUUID(),
    orderId: randomUUID(),
  }));
  await db
    .insert(reservations)
    .values(pairs.map(({ reservationId }) => reservationFixture(reservationId)));
  await db
    .insert(orders)
    .values(
      pairs.map(({ reservationId, orderId }) => orderFixture(orderId, reservationId, "failed")),
    );
}

async function readDurableRowCounts(
  db: ReturnType<typeof createDatabaseConnection>["db"],
): Promise<{ reservationCount: number; orderCount: number }> {
  const [[reservationRow], [orderRow]] = await Promise.all([
    db.select({ value: count() }).from(reservations).where(eq(reservations.runId, ids.run)),
    db.select({ value: count() }).from(orders).where(eq(orders.runId, ids.run)),
  ]);
  return {
    reservationCount: reservationRow?.value ?? 0,
    orderCount: orderRow?.value ?? 0,
  };
}

function trafficCompletionReportFixture(
  trafficDeliveryStatus: "complete" | "failed",
): TrafficCompletionReport {
  return {
    runId: ids.run,
    status: "succeeded",
    exitCode: 0,
    httpSummary: {
      plannedRequests: 10,
      emittedRequests: trafficDeliveryStatus === "failed" ? 5 : 10,
      completedRequests: trafficDeliveryStatus === "failed" ? 5 : 10,
      failedRequests: 0,
      acceptedResponses: 0,
      soldOutResponses: trafficDeliveryStatus === "failed" ? 3 : 8,
      unexpectedResponses: 0,
      p95LatencyMs: 25,
      failureRate: 0,
    },
    trafficOutcomeSummary: {},
    trafficDeliverySummary: {
      plannedRequests: 10,
      emittedRequests: trafficDeliveryStatus === "failed" ? 5 : 10,
      trafficMode: "buyer-spike",
      plannedBuyers: 10,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: trafficDeliveryStatus === "failed" ? 5 : 0,
      notes: trafficDeliveryStatus === "failed" ? ["Major request delivery shortfall."] : [],
    },
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    loadRunDiagnosticsSummary: runnerDiagnosticsFixture(),
    apiRequestLifecycleSummary: {},
    completedAt: "2026-06-20T00:00:05.000Z",
    correlationId: "corr-finalize-test",
  };
}

async function waitForWaitingAdvisoryLock(
  sqlClient: ReturnType<typeof createDatabaseConnection>["sql"],
  minimumWaitingCount = 1,
): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const rows = await sqlClient`
      select count(*)::integer as waiting_count
      from pg_locks
      where locktype = 'advisory'
        and granted = false
    `;
    if ((rows[0]?.waiting_count ?? 0) >= minimumWaitingCount) {
      return;
    }
    await delay(20);
  }

  throw new Error("Timed out waiting for a blocked terminal run advisory lock.");
}

async function waitForObservedCount(values: unknown[], expectedCount: number): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    if (values.length >= expectedCount) {
      return;
    }
    await delay(20);
  }

  throw new Error(`Timed out waiting for ${expectedCount} observed dashboard event(s).`);
}

function requireStartedPromise<T>(promise: Promise<T> | null, label: string): Promise<T> {
  if (!promise) {
    throw new Error(`${label} promise was not started.`);
  }

  return promise;
}

function requireTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for API finalization tests.");
  }

  return databaseUrl;
}

function requireTestRedisUrl(): string {
  const redisUrl = process.env.TEST_REDIS_URL;

  if (!redisUrl) {
    throw new Error("TEST_REDIS_URL is required for API finalization tests.");
  }

  return redisUrl;
}

function requireConnection(
  connection: ReturnType<typeof createDatabaseConnection> | null,
): ReturnType<typeof createDatabaseConnection> {
  if (!connection) {
    throw new Error("Test database connection was not initialized.");
  }

  return connection;
}

function requireRedis(
  redis: ReturnType<typeof createRedisClient> | null,
): ReturnType<typeof createRedisClient> {
  if (!redis) {
    throw new Error("Test Redis client was not initialized.");
  }

  return redis;
}
