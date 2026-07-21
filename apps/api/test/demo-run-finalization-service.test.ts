import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type {
  AcceptedRunConfigSnapshot,
  AdminDemoResetResponse,
  BusinessOutcomeSummary,
  DashboardRecoveryResponse,
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
  getInventoryStatus,
  initializeInventory,
  inventoryKeys,
  orderRecoveryJobs,
  orders,
  pendingPersistenceIndexKey,
  products,
  promoteReservationIdempotencyToAccepted,
  reservationPendingPersistence,
  reservations,
  reserveInventoryStock,
  reverseReservation,
  saleOffers,
  setRunSaleEligibility,
  simulatedNotifications,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { count, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresRunRetryPolicyResolver } from "../src/queue/postgres-run-retry-policy-resolver.js";
import { OperationDeadlineExceededError } from "../src/runtime/operation-lifecycle.js";
import {
  DashboardRecoveryService,
  PostgresDashboardRecoveryContextReader,
} from "../src/services/dashboard-recovery-service.js";
import { DemoMaintenanceService } from "../src/services/demo-maintenance-service.js";
import { DemoRunFinalizationService } from "../src/services/demo-run-finalization-service.js";
import { PendingPersistenceReconciler } from "../src/services/pending-persistence-reconciler.js";
import { PendingPersistenceRemediationService } from "../src/services/pending-persistence-remediation-service.js";
import { PostgresBuyPersistence } from "../src/services/postgres-buy-persistence.js";
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
    const preparedInputs: unknown[] = [];
    const writeTerminalRun = vi.fn(
      async (...args: Parameters<typeof postgresTerminalRunWriter.writePrepared>) =>
        postgresTerminalRunWriter.writePrepared(args[0], async (lockedDb) => {
          const input = await args[1](lockedDb);
          if (input) preparedInputs.push(input);
          return input;
        }),
    );
    const service = createService(connection, redis, {
      terminalRunWriter: { writePrepared: writeTerminalRun },
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
    await redisClient.hset(
      inventoryKeys(ids.saleOffer).reservationOutcomes,
      "api_sold_out_decision",
      "7",
      "api_sold_out_decision_latest_observed_at",
      "2026-06-20T00:00:09.000Z",
    );
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
    expect(summaries[0]?.terminalInventorySnapshot).toEqual({
      saleOfferId: ids.saleOffer,
      startingStock: 10,
      remainingStock: 10,
      reservedStock: 0,
      acceptedReservations: 2,
      soldOutRejections: 7,
      pendingPersistenceCount: 0,
      capturedAt: "2026-06-20T00:00:10.000Z",
      source: "redis",
    });
    expect(summaries[0]?.httpTimingBreakdownSummary).toEqual({
      ...emptyHttpTimingBreakdownSummary,
      waiting: { averageMs: 10, p95Ms: 20 },
    });
    expect(summaries[0]?.loadRunDiagnosticsSummary).toMatchObject({
      terminalMetricSources: {
        startedRequests: "summary_export",
        acceptedResponses: "point_stream",
      },
      summaryExportWarnings: ["k6_outcome_counter_point_stream_fallback_used"],
    });
    expect(writeTerminalRun).toHaveBeenCalledOnce();
    expect(preparedInputs).toContainEqual(
      expect.objectContaining({
        terminalStatus: "completed",
        businessOutcome: expect.objectContaining({
          acceptedReservations: 2,
          soldOutRejections: 7,
        }),
        terminalInventorySnapshot: expect.objectContaining({
          acceptedReservations: 2,
          soldOutRejections: 7,
          capturedAt: "2026-06-20T00:00:10.000Z",
        }),
        allowedCurrentStatuses: ["draining"],
        finalizedAt: new Date("2026-06-20T00:00:10.000Z"),
      }),
    );
  });

  it("captures actual terminal inventory even when traffic evidence has no inventory snapshot", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);

    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    const diagnostics = runnerDiagnosticsFixture();
    const { startedRequests, ...legacyTerminalMetricSources } = diagnostics.terminalMetricSources;
    await db
      .update(demoRunFinalizations)
      .set({
        trafficOutcomeSummary: { loadGeneratorOutcome: "legacy" },
        loadRunDiagnosticsSummary: {
          ...diagnostics,
          terminalMetricSources: {
            emittedRequests: startedRequests,
            ...legacyTerminalMetricSources,
          },
        },
        apiRequestLifecycleSummary: { completedRequests: 10, failedRequests: 0 },
      })
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

    expect(summary?.terminalInventorySnapshot).toMatchObject({
      startingStock: 10,
      remainingStock: 10,
      reservedStock: 0,
      pendingPersistenceCount: 0,
      capturedAt: "2026-06-20T00:00:10.000Z",
    });
    expect(summary?.loadRunDiagnosticsSummary).toMatchObject({
      terminalMetricSources: { startedRequests: "summary_export" },
    });
    expect(summary?.loadRunDiagnosticsSummary.terminalMetricSources).not.toHaveProperty(
      "emittedRequests",
    );
    expect(summary?.apiRequestLifecycleSummary).toMatchObject({
      plannedRequests: 10,
      startedRequests: 10,
      completedRequests: 10,
      interruptedRequests: 0,
      unstartedRequests: 0,
      failedRequests: 0,
    });
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

  it("fails closed on a present invalid traffic-completion inventory snapshot", async () => {
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

    await expect(service.finalizeRun(ids.run, "corr-finalize-invalid")).resolves.toMatchObject({
      status: "draining",
    });
    const [run] = await db.select().from(demoRuns).where(eq(demoRuns.id, ids.run));
    const [summaryCount] = await db
      .select({ value: count() })
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));

    expect(run?.status).toBe("draining");
    expect(summaryCount?.value).toBe(0);
  });

  it("fails closed when fresh Redis and durable sold-out totals disagree", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);

    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await db.insert(demoRunReservationOutcomes).values({
      runId: ids.run,
      outcome: "api_sold_out_decision",
      count: 1,
      latestObservedAt: new Date("2026-06-20T00:00:09.000Z"),
      source: "redis",
      capturedAt: new Date("2026-06-20T00:00:10.000Z"),
      createdAt: new Date("2026-06-20T00:00:10.000Z"),
    });
    await redisClient.hset(
      inventoryKeys(ids.saleOffer).reservationOutcomes,
      "api_sold_out_decision",
      "2",
      "api_sold_out_decision_latest_observed_at",
      "2026-06-20T00:00:09.000Z",
    );

    await expect(
      service.finalizeRun(ids.run, "corr-finalize-sold-out-mismatch"),
    ).resolves.toMatchObject({ status: "draining" });
    const [summaryCount] = await db
      .select({ value: count() })
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));
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
    expect(summary?.terminalInventorySnapshot).toMatchObject({
      startingStock: 10,
      remainingStock: 10,
      reservedStock: 0,
      acceptedReservations: 1,
      pendingPersistenceCount: 0,
      capturedAt: "2026-06-20T00:00:10.000Z",
    });
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

  it("preserves the timeout reason when a restarted global pass clears the last pending page", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const configSnapshot: AcceptedRunConfigSnapshot = {
      ...configSnapshotFixture(),
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 125,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 1,
        quantityPerAttempt: 1,
      },
      inventoryConfig: {
        ...configSnapshotFixture().inventoryConfig,
        startingStock: 125,
      },
    };
    await seedDrainingRun({
      db,
      redis: redisClient,
      trafficDeliveryStatus: "complete",
      configSnapshot,
    });
    await initializeInventory(redisClient, {
      saleOfferId: ids.saleOffer,
      allocatedStock: 125,
      initializedAt: new Date("2026-06-20T00:00:00.000Z"),
      run: { runId: ids.run, status: "accepting" },
    });
    for (let index = 0; index < 125; index += 1) {
      await reserveInventoryStock(redisClient, {
        idempotencyKey: `pending-page-${index}`,
        idempotencyTtlSeconds: 1_800,
        reservation: {
          id: randomUUID(),
          saleOfferId: ids.saleOffer,
          runId: ids.run,
          correlationId: `pending-page-${index}`,
          quantity: 1,
          status: "secured",
          reservationToken: `pending-token-${index}`,
          securedAt: "2026-06-20T00:00:02.000Z",
          expiresAt: "2026-06-20T00:15:02.000Z",
        },
      });
    }
    await db
      .update(demoRunFinalizations)
      .set({
        trafficOutcomeSummary: {
          terminalInventorySnapshot: {
            saleOfferId: ids.saleOffer,
            startingStock: 125,
            remainingStock: 0,
            reservedStock: 125,
            acceptedReservations: 0,
            soldOutRejections: 0,
            pendingPersistenceCount: 125,
            capturedAt: "2026-06-20T00:00:03.000Z",
            source: "redis",
          },
        },
      })
      .where(eq(demoRunFinalizations.runId, ids.run));
    await setRunSaleEligibility(redisClient, {
      runId: ids.run,
      saleOfferId: ids.saleOffer,
      status: "closed",
    });
    await setAcceptedDeliveryEvidence(db, {
      acceptedResponses: 125,
      plannedRequests: 125,
      startedRequests: 125,
    });
    const enqueuedOrderIds: string[] = [];
    const createReconciler = () =>
      new PendingPersistenceReconciler({
        redis: redisClient,
        persistence: new PostgresBuyPersistence(db),
        stockReservations: {
          promoteAccepted: (input) =>
            promoteReservationIdempotencyToAccepted(redisClient, input).then(() => undefined),
        },
        orderProcessJobPublisher: {
          enqueue: async (job) => {
            enqueuedOrderIds.push(job.orderId);
          },
        },
        runRetryPolicyResolver: new PostgresRunRetryPolicyResolver(db),
        idempotencyTtlSeconds: 1_800,
        batchSize: 100,
        logger: createSilentLogger("api"),
      });
    const firstService = createService(connection, redis, {
      pendingPersistenceReconciler: createReconciler(),
      now: () => new Date("2026-06-20T00:10:00.000Z"),
    });

    await expect(firstService.finalizeRun(ids.run)).resolves.toMatchObject({ status: "draining" });
    expect((await getPendingStructureCounts(redisClient)).pending).toBe(25);

    const restartedGlobalReconciler = createReconciler();
    await expect(restartedGlobalReconciler.reconcileAll()).resolves.toMatchObject({
      found: 25,
      reconciled: 25,
      failed: 0,
    });
    const restartedFinalizer = createService(connection, redis, {
      pendingPersistenceReconciler: createReconciler(),
      now: () => new Date("2026-06-20T00:10:00.000Z"),
    });
    await expect(restartedFinalizer.finalizeRun(ids.run)).resolves.toMatchObject({
      status: "failed",
      failureReason: "pending_persistence_reconciliation_timeout",
    });
    expect(await getPendingStructureCounts(redisClient)).toEqual({
      pending: 0,
      records: 0,
      global: 0,
    });
    expect(new Set(enqueuedOrderIds).size).toBe(125);
    await expect(
      createReconciler().reconcileSaleOffer(ids.saleOffer, { runId: ids.run }),
    ).resolves.toMatchObject({
      found: 0,
      reconciled: 0,
      reversed: 0,
    });
    const [summary] = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));
    expect(summary?.terminalInventorySnapshot).toMatchObject({
      remainingStock: 0,
      reservedStock: 125,
      acceptedReservations: 125,
      pendingPersistenceCount: 0,
      capturedAt: "2026-06-20T00:10:00.000Z",
    });
  });

  it("uses the recovery-only lock to reverse a terminal Redis-only hold", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await initializeInventory(redisClient, {
      saleOfferId: ids.saleOffer,
      allocatedStock: 10,
      initializedAt: new Date("2026-06-20T00:00:00.000Z"),
      run: { runId: ids.run, status: "accepting" },
    });
    await reserveInventoryStock(redisClient, {
      idempotencyKey: "terminal-stale-hold",
      idempotencyTtlSeconds: 1_800,
      reservation: {
        id: ids.reservation1,
        saleOfferId: ids.saleOffer,
        runId: ids.run,
        correlationId: "terminal-stale-hold",
        quantity: 1,
        status: "secured",
        reservationToken: "terminal-stale-token",
        securedAt: "2026-06-20T00:00:02.000Z",
        expiresAt: "2026-06-20T00:15:02.000Z",
      },
    });
    await setRunSaleEligibility(redisClient, {
      runId: ids.run,
      saleOfferId: ids.saleOffer,
      status: "closed",
    });
    await db
      .update(demoRuns)
      .set({
        status: "failed",
        failureReason: "legacy_terminal_state",
        finalizedAt: new Date("2026-06-20T00:05:00.000Z"),
      })
      .where(eq(demoRuns.id, ids.run));
    const enqueue = vi.fn();
    const reconciler = new PendingPersistenceReconciler({
      redis: redisClient,
      persistence: new PostgresBuyPersistence(db),
      stockReservations: {
        promoteAccepted: (input) =>
          promoteReservationIdempotencyToAccepted(redisClient, input).then(() => undefined),
        reverse: (input) => reverseReservation(redisClient, input),
      },
      orderProcessJobPublisher: { enqueue },
      runRetryPolicyResolver: new PostgresRunRetryPolicyResolver(db),
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
    });

    await expect(
      reconciler.reconcileSaleOffer(ids.saleOffer, { runId: ids.run }),
    ).resolves.toMatchObject({
      found: 1,
      reversed: 1,
      reconciled: 0,
      failed: 0,
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(await getPendingStructureCounts(redisClient)).toEqual({
      pending: 0,
      records: 0,
      global: 0,
    });
    await expect(
      reconciler.reconcileSaleOffer(ids.saleOffer, { runId: ids.run }),
    ).resolves.toMatchObject({
      found: 0,
      reversed: 0,
    });
    await expect(getInventoryStatus(redisClient, ids.saleOffer)).resolves.toMatchObject({
      remainingStock: 10,
      reservedStock: 0,
      pendingPersistenceCount: 0,
    });
  });

  it("audits and converges mixed terminal pending state with real Redis and PostgreSQL", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await initializeInventory(redisClient, {
      saleOfferId: ids.saleOffer,
      allocatedStock: 10,
      initializedAt: new Date("2026-06-20T00:00:00.000Z"),
      run: { runId: ids.run, status: "accepting" },
    });
    const durableHold = {
      id: ids.reservation1,
      saleOfferId: ids.saleOffer,
      runId: ids.run,
      correlationId: "corr-finalize-test",
      quantity: 1,
      status: "secured" as const,
      reservationToken: `token-${ids.reservation1}`,
      securedAt: "2026-06-20T00:00:02.000Z",
      expiresAt: "2026-06-20T00:15:02.000Z",
    };
    const redisOnlyHold = {
      ...durableHold,
      id: ids.reservation2,
      correlationId: "corr-redis-only",
      reservationToken: "redis-only-token",
    };
    await reserveInventoryStock(redisClient, {
      idempotencyKey: "remediation-durable",
      idempotencyTtlSeconds: 1_800,
      reservation: durableHold,
    });
    await reserveInventoryStock(redisClient, {
      idempotencyKey: "remediation-reverse",
      idempotencyTtlSeconds: 1_800,
      reservation: redisOnlyHold,
    });
    const persistence = new PostgresBuyPersistence(db);
    const durable = await persistence.persistSecuredReservation({ reservation: durableHold });
    await db
      .update(demoRuns)
      .set({
        status: "failed",
        failureReason: "legacy_terminal_state",
        finalizedAt: new Date("2026-06-20T00:05:00.000Z"),
      })
      .where(eq(demoRuns.id, ids.run));
    await setRunSaleEligibility(redisClient, {
      runId: ids.run,
      saleOfferId: ids.saleOffer,
      status: "closed",
    });

    const enqueuedOrderIds: string[] = [];
    const reconciler = new PendingPersistenceReconciler({
      redis: redisClient,
      persistence,
      stockReservations: {
        promoteAccepted: (input) =>
          promoteReservationIdempotencyToAccepted(redisClient, input).then(() => undefined),
        reverse: (input) => reverseReservation(redisClient, input),
      },
      orderProcessJobPublisher: {
        enqueue: async (job) => {
          enqueuedOrderIds.push(job.orderId);
        },
      },
      runRetryPolicyResolver: new PostgresRunRetryPolicyResolver(db),
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
    });
    const remediation = new PendingPersistenceRemediationService({
      db,
      redis: redisClient,
      persistence,
      reconciler,
    });
    const target = { runId: ids.run, saleOfferId: ids.saleOffer };
    const keys = inventoryKeys(ids.saleOffer);
    const durableGlobalMember = `${ids.saleOffer}:${ids.reservation1}`;
    const durableGlobalScore = await redisClient.zscore(
      pendingPersistenceIndexKey,
      durableGlobalMember,
    );
    expect(durableGlobalScore).not.toBeNull();

    await redisClient.zrem(pendingPersistenceIndexKey, durableGlobalMember);
    await expect(remediation.inspect(target)).resolves.toMatchObject({
      safeToApply: false,
      classifications: expect.arrayContaining([
        expect.objectContaining({ reason: "global_index_member_missing" }),
      ]),
    });
    await redisClient.zadd(
      pendingPersistenceIndexKey,
      Number(durableGlobalScore),
      durableGlobalMember,
    );

    const unexpectedGlobalMember = `${ids.saleOffer}:unexpected`;
    await redisClient.zadd(pendingPersistenceIndexKey, Date.now(), unexpectedGlobalMember);
    await expect(remediation.inspect(target)).resolves.toMatchObject({
      safeToApply: false,
      classifications: expect.arrayContaining([
        expect.objectContaining({ reason: "unexpected_global_index_member" }),
      ]),
    });
    await redisClient.zrem(pendingPersistenceIndexKey, unexpectedGlobalMember);

    const durableIdempotencyKey = keys.idempotency("remediation-durable");
    const validIdempotency = await redisClient.get(durableIdempotencyKey);
    const validIdempotencyTtl = await redisClient.pttl(durableIdempotencyKey);
    expect(validIdempotency).not.toBeNull();
    await redisClient.set(durableIdempotencyKey, "not-json", "PX", validIdempotencyTtl);
    await expect(remediation.inspect(target)).resolves.toMatchObject({
      safeToApply: false,
      classifications: expect.arrayContaining([
        expect.objectContaining({ reason: "idempotency_record_malformed" }),
      ]),
    });
    const mismatchedIdempotency = JSON.parse(validIdempotency ?? "{}") as Record<string, unknown>;
    mismatchedIdempotency.quantity = 99;
    await redisClient.set(
      durableIdempotencyKey,
      JSON.stringify(mismatchedIdempotency),
      "PX",
      validIdempotencyTtl,
    );
    await expect(remediation.inspect(target)).resolves.toMatchObject({
      safeToApply: false,
      classifications: expect.arrayContaining([
        expect.objectContaining({ reason: "idempotency_record_attribution_mismatch" }),
      ]),
    });
    await redisClient.set(durableIdempotencyKey, validIdempotency ?? "", "PX", validIdempotencyTtl);

    await expect(remediation.inspect(target)).resolves.toMatchObject({
      safeToApply: true,
      pendingCount: 2,
      recordCount: 2,
      targetGlobalMemberCount: 2,
      classifications: expect.arrayContaining([
        expect.objectContaining({ reservationId: ids.reservation1, disposition: "durable" }),
        expect.objectContaining({ reservationId: ids.reservation2, disposition: "reverse" }),
      ]),
    });
    await expect(remediation.apply(target)).resolves.toMatchObject({
      finalPendingCount: 0,
      finalRecordCount: 0,
      remainingGlobalMembers: 0,
    });
    expect(enqueuedOrderIds).toEqual([durable.order.id]);
    await expect(getInventoryStatus(redisClient, ids.saleOffer)).resolves.toMatchObject({
      remainingStock: 9,
      reservedStock: 1,
      pendingPersistenceCount: 0,
    });

    await expect(remediation.apply(target)).resolves.toMatchObject({
      finalPendingCount: 0,
      finalRecordCount: 0,
      remainingGlobalMembers: 0,
    });
    expect(enqueuedOrderIds).toEqual([durable.order.id]);
    await expect(getInventoryStatus(redisClient, ids.saleOffer)).resolves.toMatchObject({
      remainingStock: 9,
      reservedStock: 1,
    });
  });

  it("captures a pre-fence buy through the locked facade without a nested pool checkout", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const persistenceConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    const observerConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    const service = createService(connection, redis);
    let finalizationPromise: Promise<unknown> | null = null;

    try {
      await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
      await persistenceConnection.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock_shared(hashtext(${terminalDemoRunTransitionLockKey(ids.run)}))`,
        );

        finalizationPromise = service.finalizeRun(ids.run, "corr-pre-fence-buy");
        await waitForWaitingAdvisoryLock(observerConnection.sql);

        await tx.insert(reservations).values(reservationFixture(ids.reservation1));
        await tx.insert(orders).values(orderFixture(ids.order1, ids.reservation1, "confirmed"));
        await tx.insert(simulatedNotifications).values({
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
      });

      await expect(
        requireStartedPromise(finalizationPromise, "finalization"),
      ).resolves.toMatchObject({
        status: "completed",
      });
      const [summary] = await db
        .select()
        .from(demoRunSummaries)
        .where(eq(demoRunSummaries.runId, ids.run))
        .limit(1);
      expect(summary?.businessOutcomeSummary).toMatchObject({
        acceptedReservations: 1,
        confirmedOrders: 1,
        notificationsRecorded: 1,
      });
      expect(summary?.terminalInventorySnapshot).toMatchObject({ acceptedReservations: 1 });
    } finally {
      await persistenceConnection.close();
      await observerConnection.close();
    }
  });

  it("times out and cancels the in-fence inventory read, then releases the terminal fence", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const observerConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    const subscriberRedis = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    const barrierChannel = "task-02-terminal-inventory-timeout-barrier";
    const barrierSentinel = "terminal-inventory-timeout-observed";
    const terminalEvents: unknown[] = [];
    const observedBarriers: string[] = [];
    let inventoryReadCallCount = 0;
    let lockHeldDuringInventoryRead: boolean | undefined;
    let abortReason: unknown;
    const terminalInventoryRead = {
      read: async (input: { saleOfferId: string; observedAt: Date; signal: AbortSignal }) => {
        inventoryReadCallCount += 1;
        if (inventoryReadCallCount > 1) {
          return getInventoryStatus(redisClient, input.saleOfferId, input.observedAt);
        }

        const rows = await observerConnection.sql`
          select pg_try_advisory_xact_lock(
            hashtext(${terminalDemoRunTransitionLockKey(ids.run)})
          ) as acquired
        `;
        lockHeldDuringInventoryRead = rows[0]?.acquired === false;

        return await new Promise<never>((_resolve, reject) => {
          const rejectForAbort = () => {
            abortReason = input.signal.reason;
            reject(input.signal.reason);
          };
          input.signal.addEventListener("abort", rejectForAbort, { once: true });
          if (input.signal.aborted) rejectForAbort();
        });
      },
    };
    const service = createService(connection, redis, {
      terminalInventoryRead,
      terminalInventoryReadTimeoutMs: 500,
    });
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

      await expect(
        service.finalizeRun(ids.run, "corr-terminal-inventory-timeout"),
      ).resolves.toMatchObject({ status: "draining" });
      await redisClient.publish(barrierChannel, barrierSentinel);
      await waitForObservedCount(observedBarriers, 1);

      const summariesAfterTimeout = await db
        .select()
        .from(demoRunSummaries)
        .where(eq(demoRunSummaries.runId, ids.run));
      expect(lockHeldDuringInventoryRead).toBe(true);
      expect(abortReason).toBeInstanceOf(OperationDeadlineExceededError);
      expect(summariesAfterTimeout).toHaveLength(0);
      expect(terminalEvents).toHaveLength(0);

      await expect(
        service.finalizeRun(ids.run, "corr-terminal-inventory-retry"),
      ).resolves.toMatchObject({ status: "completed" });
      await redisClient.publish(barrierChannel, barrierSentinel);
      await waitForObservedCount(observedBarriers, 2);

      const summariesAfterRetry = await db
        .select()
        .from(demoRunSummaries)
        .where(eq(demoRunSummaries.runId, ids.run));
      expect(inventoryReadCallCount).toBe(2);
      expect(summariesAfterRetry).toHaveLength(1);
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]).toMatchObject({
        type: "load.run.updated",
        runId: ids.run,
        run: { status: "completed" },
      });
    } finally {
      subscriberRedis.off("message", handleSubscriberMessage);
      try {
        await subscriberRedis.unsubscribe(dashboardEventsRedisChannel, barrierChannel);
      } finally {
        subscriberRedis.disconnect();
        await observerConnection.close();
      }
    }
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
        writePrepared: async (runId, prepare) => {
          const wrote = await firstWriter.writePrepared(runId, prepare);
          writeResults.push(wrote);
          return wrote;
        },
      },
    });
    const secondService = createService(competingConnection, redis, {
      terminalRunWriter: {
        writePrepared: async (runId, prepare) => {
          const wrote = await secondWriter.writePrepared(runId, prepare);
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

  it("publishes the terminal event at a post-commit time after an overlapping stale recovery", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const lockConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    const recoveryConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    const observerConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    const subscriberRedis = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    const finalizationAttemptT0 = new Date("2026-06-20T00:00:10.000Z");
    const recoveryStartT1 = new Date("2026-06-20T00:00:11.000Z");
    const postCommitEventT2 = new Date("2026-06-20T00:00:12.000Z");
    expect(recoveryStartT1.getTime()).toBeGreaterThan(finalizationAttemptT0.getTime());
    expect(postCommitEventT2.getTime()).toBeGreaterThan(recoveryStartT1.getTime());
    const finalizationClockCalls: Date[] = [];
    const finalizationTimes = [finalizationAttemptT0, postCommitEventT2];
    const service = createService(connection, redis, {
      now: () => {
        const next = finalizationTimes[finalizationClockCalls.length] ?? postCommitEventT2;
        finalizationClockCalls.push(next);
        return next;
      },
    });
    const terminalEvents: Record<string, unknown>[] = [];
    const handleSubscriberMessage = (channel: string, message: string) => {
      if (channel === dashboardEventsRedisChannel) {
        terminalEvents.push(JSON.parse(message) as Record<string, unknown>);
      }
    };
    subscriberRedis.on("message", handleSubscriberMessage);
    let finalizationPromise: Promise<unknown> | null = null;
    let staleRecovery: DashboardRecoveryResponse | null = null;

    try {
      await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
      await subscriberRedis.subscribe(dashboardEventsRedisChannel);
      await lockConnection.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${terminalDemoRunTransitionLockKey(ids.run)}))`,
        );

        // t0: the finalization attempt starts and blocks on the terminal lock.
        finalizationPromise = service.finalizeRun(ids.run, "corr-finalize-overlap");
        await waitForWaitingAdvisoryLock(observerConnection.sql);

        // t1: recovery reads the still-draining projection before the commit.
        const recoveryService = new DashboardRecoveryService({
          contextReader: new PostgresDashboardRecoveryContextReader(recoveryConnection.db),
          businessOutcomeReader: { read: async () => null } as never,
          consistencyLagReader: { read: async () => null } as never,
          completionOutcomeReader: { read: async () => [] },
          inventoryStatusService: { getStatus: async () => null } as never,
          queueStatusService: { getStatus: async () => null } as never,
          erpStatusService: { getStatus: async () => null } as never,
          logger: createSilentLogger("api"),
          now: () => recoveryStartT1,
        });
        staleRecovery = await recoveryService.getRecovery({
          correlationId: "corr-recovery-overlap",
        });
        // The terminal writer has not committed, so nothing may be published yet.
        expect(terminalEvents).toHaveLength(0);
      });

      // The lock release lets the terminal writer commit before publication.
      const finalized = await requireStartedPromise(finalizationPromise, "finalization");
      await waitForObservedCount(terminalEvents, 1);
      const summaries = await db
        .select()
        .from(demoRunSummaries)
        .where(eq(demoRunSummaries.runId, ids.run));

      expect(staleRecovery?.currentRun?.status).toBe("draining");
      expect(staleRecovery?.recoveredAt).toBe(recoveryStartT1.toISOString());
      expect(finalized).toMatchObject({ status: "completed" });
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.status).toBe("completed");
      expect(summaries[0]?.endedAt).toEqual(finalizationAttemptT0);
      // The attempt saw t0; the event publication saw a fresh post-commit t2.
      expect(finalizationClockCalls).toEqual([finalizationAttemptT0, postCommitEventT2]);
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]).toMatchObject({
        type: "load.run.updated",
        runId: ids.run,
        occurredAt: postCommitEventT2.toISOString(),
        run: {
          status: "completed",
          finalizedAt: finalizationAttemptT0.toISOString(),
        },
      });
    } finally {
      subscriberRedis.off("message", handleSubscriberMessage);
      try {
        await subscriberRedis.unsubscribe(dashboardEventsRedisChannel);
      } finally {
        subscriberRedis.disconnect();
        await Promise.all([
          lockConnection.close(),
          recoveryConnection.close(),
          observerConnection.close(),
        ]);
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
      startedRequests: 5,
      unstartedRequests: 5,
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
      startedRequests: 400,
      completedIterations: 400,
      unstartedRequests: 0,
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
      startedRequests: 399,
      completedIterations: 399,
      unstartedRequests: 1,
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
    terminalInventoryRead?: ConstructorParameters<
      typeof DemoRunFinalizationService
    >[0]["terminalInventoryRead"];
    terminalInventoryReadTimeoutMs?: number;
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
    terminalInventoryRead: createTerminalInventoryRead(requireRedis(redis)),
    terminalInventoryReadTimeoutMs: 2_000,
    logger: createSilentLogger("api"),
    drainTimeoutSeconds: 300,
    now: () => new Date("2026-06-20T00:00:10.000Z"),
    ...options,
  });
}

function createTerminalInventoryRead(redis: ReturnType<typeof createRedisClient>) {
  return {
    read: ({ saleOfferId, observedAt }: { saleOfferId: string; observedAt: Date }) =>
      getInventoryStatus(redis, saleOfferId, observedAt),
  };
}

async function getPendingStructureCounts(
  redis: ReturnType<typeof createRedisClient>,
): Promise<{ pending: number; records: number; global: number }> {
  const keys = inventoryKeys(ids.saleOffer);
  return {
    pending: await redis.zcard(keys.pendingPersistence),
    records: await redis.hlen(keys.pendingPersistenceRecords),
    global: await redis.zcard(pendingPersistenceIndexKey),
  };
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
      startedRequests: "summary_export",
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
    startedRequests?: number;
    completedIterations?: number;
    unstartedRequests?: number;
  },
): Promise<void> {
  const plannedRequests = input.plannedRequests ?? 10;
  const startedRequests = input.startedRequests ?? plannedRequests;
  await db
    .update(demoRunFinalizations)
    .set({
      httpSummary: {
        plannedRequests,
        startedRequests,
        completedRequests: startedRequests,
        interruptedRequests: 0,
        unstartedRequests: plannedRequests - startedRequests,
        failedRequests: 0,
        acceptedResponses: input.acceptedResponses,
        soldOutResponses: 0,
        unexpectedResponses: 0,
        failureRate: 0,
      },
      trafficDeliverySummary: {
        plannedRequests,
        startedRequests,
        completedRequests: startedRequests,
        interruptedRequests: 0,
        unstartedRequests: input.unstartedRequests ?? plannedRequests - startedRequests,
        trafficMode: "buyer-spike",
        plannedBuyers: plannedRequests === 400 ? 200 : 10,
        scheduledRatePerSecond: null,
        configuredDurationSeconds: null,
        preAllocatedVUs: null,
        maxVUs: null,
        droppedIterations: 0,
        completedIterations: input.completedIterations ?? startedRequests,
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
      startedRequests: trafficDeliveryStatus === "failed" ? 5 : 10,
      completedRequests: trafficDeliveryStatus === "failed" ? 5 : 10,
      interruptedRequests: 0,
      unstartedRequests: trafficDeliveryStatus === "failed" ? 5 : 0,
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
      startedRequests: trafficDeliveryStatus === "failed" ? 5 : 10,
      completedRequests: trafficDeliveryStatus === "failed" ? 5 : 10,
      interruptedRequests: 0,
      unstartedRequests: trafficDeliveryStatus === "failed" ? 5 : 0,
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
    apiRequestLifecycleSummary: {
      plannedRequests: 10,
      startedRequests: trafficDeliveryStatus === "failed" ? 5 : 10,
      completedRequests: trafficDeliveryStatus === "failed" ? 5 : 10,
      interruptedRequests: 0,
      unstartedRequests: trafficDeliveryStatus === "failed" ? 5 : 0,
      failedRequests: 0,
    },
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
