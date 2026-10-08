import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AcceptedRunConfigSnapshot,
  AdminDemoResetResponse,
  BusinessOutcomeSummary,
  TerminalInventorySnapshot,
  TrafficCompletionReport,
} from "@checkout-surge/contracts";
import {
  deriveLoadExecutionPlan,
  emptyHttpTimingBreakdownSummary,
  emptyRequestArrivalSummary,
  erpDispatchRateLimit,
  idleErpDispatchLimits,
  isReplayPossible,
  orderProcessBullMqQueueName,
  technicalOrderFailureCodeValues,
  trafficCompletionReportSchema,
  trafficDeliverySummarySchema,
} from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createRedisClient,
  dashboardProjectionDirtyRedisChannel,
  deferPendingPersistenceRecord,
  demoPresets,
  demoRunFinalizations,
  demoRunSaleContexts,
  demoRunSoldOutCounts,
  demoRunSummaries,
  demoRuns,
  erpAttempts,
  getInventoryStatus,
  initializeInventory,
  inventoryKeys,
  orderRecoveryJobs,
  orders,
  products,
  reservationPendingPersistence,
  reservations,
  reserveInventoryStock,
  saleOffers,
  simulatedNotifications,
} from "@checkout-surge/db";
import { requireTestDatabaseUrl, resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { Queue } from "bullmq";
import { count, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresGeneratedRunPublicationFence } from "../../worker/src/persistence/postgres-generated-run-publication-fence.js";
import { PostgresNotificationRecordPersistence } from "../../worker/src/persistence/postgres-notification-record-persistence.js";
import { createNotificationRecordPublisher } from "../../worker/src/queue/bullmq-notification-record-publisher.js";
import { createOrderProcessJobPublisher } from "../src/queue/bullmq-order-process-job-publisher.js";
import { OperationDeadlineExceededError } from "../src/runtime/operation-lifecycle.js";
import { AdminDemoResetService } from "../src/services/admin-demo-reset-service.js";
import {
  DashboardProjectionService,
  PostgresDashboardRecoveryContextReader,
} from "../src/services/dashboard-recovery-service.js";
import { ProcessLocalDemoMaintenanceAuthority } from "../src/services/demo-maintenance-authority.js";
import { DemoRunFinalizationService } from "../src/services/demo-run-finalization-service.js";
import {
  DemoRunQueueLimits,
  type OrderProcessQueueLimits,
} from "../src/services/order-process-queue-limits.js";
import {
  PostgresTerminalDemoRunSummaryWriter,
  terminalDemoRunTransitionLockKey,
} from "../src/services/terminal-demo-run-transition.js";
import { findTrafficCompletionBindingMismatch } from "../src/services/traffic-completion-binding.js";
import { classifyTrafficDelivery } from "../src/services/traffic-delivery-classifier.js";

const ids = {
  product: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  preset: "33333333-3333-4333-8333-333333333331",
  run: "55555555-5555-4555-8555-555555555555",
  saleOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  reservation1: "11111111-1111-4111-8111-111111111111",
  reservation2: "22222222-2222-4222-8222-222222222222",
  reservation3: "22222222-2222-4222-8222-222222222223",
  order1: "44444444-4444-4444-8444-444444444441",
  order2: "44444444-4444-4444-8444-444444444442",
  order3: "44444444-4444-4444-8444-444444444443",
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

    await resetTestDatabase();
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

  it("heals a failed terminal limit update on the next lifecycle poll without another run or restart", async () => {
    const db = requireConnection(connection).db;
    await seedDrainingRun({ db, redis: requireRedis(redis), trafficDeliveryStatus: "complete" });
    const queue = new Queue(orderProcessBullMqQueueName, {
      connection: { url: requireTestRedisUrl() },
    });
    const publisher = createOrderProcessJobPublisher(queue);
    const queueLimits = new DemoRunQueueLimits(db, publisher);
    const logger = createSilentLogger("api");
    const logged = vi.spyOn(logger, "error");
    const terminalWriter = new PostgresTerminalDemoRunSummaryWriter(db, queueLimits, logger);
    try {
      await queueLimits.synchronize();
      const previousLimits = await queue.getGlobalRateLimit();
      vi.spyOn(publisher, "setLimits").mockRejectedValueOnce(
        new Error("Redis temporarily unavailable"),
      );
      await expect(
        terminalWriter.claimTerminalRun({
          runId: ids.run,
          terminalStatus: "completed",
          failureReason: null,
          finalizedAt: new Date("2026-06-20T00:00:10.000Z"),
          allowedCurrentStatuses: ["draining"],
        }),
      ).resolves.toBe(true);
      expect(logged).toHaveBeenCalledOnce();
      expect(await queue.getGlobalRateLimit()).toEqual(previousLimits);
      expect(await db.select({ status: demoRuns.status }).from(demoRuns)).toEqual([
        { status: "completed" },
      ]);
      const service = createService(connection, redis, {
        queueLimits,
        terminalRunWriter: terminalWriter,
      });
      await expect(service.finalizeReadyRuns()).resolves.toBe(0);
      expect(await queue.getGlobalRateLimit()).toEqual(
        erpDispatchRateLimit(idleErpDispatchLimits.maxTps),
      );
      expect(await queue.getGlobalConcurrency()).toBe(idleErpDispatchLimits.concurrency);
    } finally {
      await publisher.close();
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
          disposition: "technical_failure",
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
    const postgresTerminalRunWriter = new PostgresTerminalDemoRunSummaryWriter(db, {
      synchronize: async () => {},
    });
    const preparedInputs: unknown[] = [];
    const writeTerminalRun = vi.fn(
      async (...args: Parameters<typeof postgresTerminalRunWriter.writePrepared>) =>
        postgresTerminalRunWriter.writePrepared(args[0], async (lockedDb) => {
          const input = await args[1](lockedDb);
          if (input) preparedInputs.push(input);
          return input;
        }),
    );
    const releaseAfterRun = vi.fn();
    const service = createService(connection, redis, {
      terminalRunWriter: { writePrepared: writeTerminalRun },
      runnerOperations: { releaseAfterRun },
    });
    const runnerBootId = "99999999-9999-4999-8999-999999999999";

    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await db.update(demoRuns).set({ runnerBootId }).where(eq(demoRuns.id, ids.run));
    await setArrivalAnchor(db);
    await db
      .update(demoRunFinalizations)
      .set({
        trafficOutcomeSummary: {
          loadGeneratorOutcome: "preserved",
          terminalInventorySnapshot: durableTerminalInventorySnapshot,
        },
      })
      .where(eq(demoRunFinalizations.runId, ids.run));
    await db.insert(demoRunSoldOutCounts).values({
      runId: ids.run,
      count: 7,
      latestObservedAt: new Date("2026-06-20T00:00:09.000Z"),
      capturedAt: new Date("2026-06-20T00:00:10.000Z"),
      createdAt: new Date("2026-06-20T00:00:10.000Z"),
    });
    await redisClient.hset(
      inventoryKeys(ids.saleOffer).soldOut,
      "count",
      "7",
      "latest_observed_at",
      "2026-06-20T00:00:09.000Z",
    );
    await db
      .insert(reservations)
      .values([
        reservationFixture(ids.reservation1),
        reservationFixture(ids.reservation2),
        reservationFixture(ids.reservation3),
      ]);
    await db.insert(orders).values([
      orderFixture(ids.order1, ids.reservation1, "confirmed"),
      orderFixture(ids.order2, ids.reservation2, "failed"),
      {
        ...orderFixture(ids.order3, ids.reservation3, "failed"),
        failureCode: "erp_response_contract_invalid",
        failureMessage: "ERP response failed contract validation.",
      },
    ]);
    await db.insert(simulatedNotifications).values({
      id: ids.notification,
      orderId: ids.order1,
      saleOfferId: ids.saleOffer,
      runId: ids.run,
      correlationId: "corr-finalize-test",
      recipientPlaceholder: "buyer@example.invalid",
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
    expect(releaseAfterRun).toHaveBeenCalledExactlyOnceWith({
      runId: ids.run,
      bootId: runnerBootId,
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.status).toBe("completed");
    expect(summaries[0]?.replayPossible).toBe(false);
    expect(summaries[0]?.endedAt).toEqual(new Date("2026-06-20T00:00:10.000Z"));
    expect(summaries[0]?.createdAt).toEqual(new Date("2026-06-20T00:00:10.000Z"));
    expect(summaries[0]?.failureReason).toBeNull();
    expect(summaries[0]?.businessOutcomeSummary as BusinessOutcomeSummary).toMatchObject({
      acceptedReservations: 3,
      reservedUnits: 3,
      soldOutRejections: 7,
      confirmedOrders: 1,
      failedOrders: 2,
      notificationsRecorded: 1,
      pendingPersistenceCount: 0,
    });
    expect(summaries[0]?.terminalInventorySnapshot).toEqual({
      saleOfferId: ids.saleOffer,
      startingStock: 10,
      remainingStock: 10,
      reservedStock: 0,
      acceptedReservations: 3,
      soldOutRejections: 7,
      pendingPersistenceCount: 0,
      capturedAt: "2026-06-20T00:00:10.000Z",
      source: "redis",
    });
    expect(summaries[0]?.runSignalTimelineSummary).toMatchObject({
      window: { anchoredAt: "2026-06-20T00:00:01.500Z", bucketCount: 120 },
      queueBacklog: { peakBacklog: 3 },
      confirmationConvergence: {
        confirmedOrderCount: 1,
        failedOrderCount: 2,
        pendingAtCaptureCount: 0,
      },
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
          acceptedReservations: 3,
          reservedUnits: 3,
          soldOutRejections: 7,
        }),
        terminalInventorySnapshot: expect.objectContaining({
          acceptedReservations: 3,
          soldOutRejections: 7,
          capturedAt: "2026-06-20T00:00:10.000Z",
        }),
        runSignalTimelineSummary: expect.objectContaining({
          queueBacklog: expect.objectContaining({ peakBacklog: 3 }),
        }),
        allowedCurrentStatuses: ["draining"],
        finalizedAt: new Date("2026-06-20T00:00:10.000Z"),
      }),
    );
  });

  it("does not let subordinate audit history block after Redis pending state clears", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);
    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await db.insert(reservationPendingPersistence).values({
      reservationId: ids.reservation1,
      saleOfferId: ids.saleOffer,
      runId: ids.run,
      correlationId: "corr-stale-audit",
      status: "pending_reconciliation",
      attemptCount: 1,
    });

    await expect(service.finalizeRun(ids.run, "corr-stale-audit")).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("rejects malformed transport-attempt evidence before terminal summary persistence", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);

    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await db
      .update(demoRunFinalizations)
      .set({ transportAttemptCounts: { completedRequests: 10 } as never })
      .where(eq(demoRunFinalizations.runId, ids.run));

    await expect(service.finalizeRun(ids.run, "corr-finalize-invalid-transport")).rejects.toThrow(
      new RegExp(`${ids.run}.*transportAttemptCounts`),
    );
    const [summary] = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));
    expect(summary).toBeUndefined();
  });

  it("does not treat pending completion enrichment as a drain timeout or write a summary", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis, {
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
    await db.insert(demoRunSoldOutCounts).values({
      runId: ids.run,
      count: 1,
      latestObservedAt: new Date("2026-06-20T00:00:09.000Z"),
      capturedAt: new Date("2026-06-20T00:00:10.000Z"),
      createdAt: new Date("2026-06-20T00:00:10.000Z"),
    });
    await redisClient.hset(
      inventoryKeys(ids.saleOffer).soldOut,
      "count",
      "2",
      "latest_observed_at",
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
      recipientPlaceholder: "buyer@example.invalid",
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

  it.each([
    { name: "before", now: "2026-06-20T00:00:10.000Z", exhausted: false },
    { name: "after", now: "2026-06-20T00:10:00.000Z", exhausted: false },
    { name: "after as exhausted", now: "2026-06-20T00:10:00.000Z", exhausted: true },
  ])("keeps a run draining $name its drain timeout while Redis pending state remains", async (testCase) => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await initializeInventory(redisClient, {
      saleOfferId: ids.saleOffer,
      allocatedStock: 73,
      run: { runId: ids.run, status: "accepting" },
    });
    const pendingInput = {
      idempotencyKey: "finalization-pending",
      idempotencyTtlSeconds: 1_800,
      reservation: {
        id: ids.reservation1,
        saleOfferId: ids.saleOffer,
        runId: ids.run,
        correlationId: "corr-finalize-pending",
        quantity: 1,
        reservationToken: "finalization-pending-token",
        securedAt: "2026-06-20T00:00:06.000Z",
        expiresAt: "2026-06-20T00:15:06.000Z",
      },
    };
    await reserveInventoryStock(redisClient, pendingInput);
    if (testCase.exhausted) {
      await deferPendingPersistenceRecord(redisClient, {
        saleOfferId: ids.saleOffer,
        reservationId: ids.reservation1,
        attemptCount: 6,
        status: "exhausted",
        nextRecoveryAt: new Date("2026-06-20T00:05:06.000Z"),
        recoveryDeadlineAt: new Date("2026-06-20T00:05:06.000Z"),
        lastError: "exhausted for test",
      });
    }
    const service = createService(connection, redis, { now: () => new Date(testCase.now) });

    await expect(service.finalizeRun(ids.run, "corr-finalize-pending")).resolves.toMatchObject({
      status: "draining",
    });
    expect(
      await db.select().from(demoRunSummaries).where(eq(demoRunSummaries.runId, ids.run)),
    ).toHaveLength(0);
  });

  it("keeps a timed-out run draining when the terminal Redis observation is unreadable", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    const service = createService(connection, redis, {
      now: () => new Date("2026-06-20T00:10:00.000Z"),
      terminalInventoryRead: {
        read: async () => {
          throw new Error("redis unavailable");
        },
      },
    });

    await expect(service.finalizeRun(ids.run, "corr-finalize-unreadable")).resolves.toMatchObject({
      status: "draining",
    });
    expect(
      await db.select().from(demoRunSummaries).where(eq(demoRunSummaries.runId, ids.run)),
    ).toHaveLength(0);
  });

  it("keeps escalated processing work nonterminal", async () => {
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
      disposition: "technical_failure",
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
      recipientPlaceholder: "buyer@example.invalid",
      recordedAt: new Date("2026-06-20T00:00:08.000Z"),
    });

    await expect(service.finalizeRun(ids.run, "corr-finalize-escalated")).resolves.toMatchObject({
      status: "draining",
    });
    expect(
      await db.select().from(demoRunSummaries).where(eq(demoRunSummaries.runId, ids.run)),
    ).toHaveLength(0);
  });

  it("keeps a pre-fence confirmation draining until its notification is published", async () => {
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
      });

      await expect(
        requireStartedPromise(finalizationPromise, "finalization"),
      ).resolves.toMatchObject({
        status: "draining",
      });
      expect(
        await db.select().from(demoRunSummaries).where(eq(demoRunSummaries.runId, ids.run)),
      ).toHaveLength(0);

      const notificationPersistence = new PostgresNotificationRecordPersistence(
        persistenceConnection.db,
        () => new Date("2026-06-20T00:00:08.000Z"),
      );
      const publisher = createNotificationRecordPublisher(
        {
          add: async (_name, payload) => notificationPersistence.record(payload),
          close: async () => undefined,
        },
        { publicationFence: new PostgresGeneratedRunPublicationFence(db) },
      );
      await publisher.publishForConfirmedOrder(
        {
          orderId: ids.order1,
          publicOrderId: `ord_${ids.order1}`,
          reservationId: ids.reservation1,
          saleOfferId: ids.saleOffer,
          runId: ids.run,
          correlationId: "corr-finalize-test",
          quantity: 1,
          queuedAt: "2026-06-20T00:00:01.000Z",
          processingGeneration: 0,
        },
        "2026-06-20T00:00:05.000Z",
      );

      await expect(service.finalizeRun(ids.run, "corr-post-notification")).resolves.toMatchObject({
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
      await expect(
        db.select().from(simulatedNotifications).where(eq(simulatedNotifications.runId, ids.run)),
      ).resolves.toHaveLength(summary?.businessOutcomeSummary.notificationsRecorded ?? 0);
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
    const barrierChannel = "terminal-inventory-timeout-barrier";
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
      if (channel === dashboardProjectionDirtyRedisChannel) {
        terminalEvents.push(JSON.parse(message));
      }
      if (channel === barrierChannel && message === barrierSentinel) {
        observedBarriers.push(message);
      }
    };
    subscriberRedis.on("message", handleSubscriberMessage);

    try {
      await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
      await subscriberRedis.subscribe(dashboardProjectionDirtyRedisChannel, barrierChannel);

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
        type: "dashboard.projection.dirty",
        scope: { runId: ids.run, saleOfferId: ids.saleOffer },
      });
    } finally {
      subscriberRedis.off("message", handleSubscriberMessage);
      try {
        await subscriberRedis.unsubscribe(dashboardProjectionDirtyRedisChannel, barrierChannel);
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
    const resetService = new AdminDemoResetService({
      runnerOperations: { releaseAfterRun: () => undefined },
      queueLimits: { synchronize: async () => {} },
      db: resetConnection.db,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(resetConnection.db, {
        synchronize: async () => {},
      }),
      redis: redisClient,
      queueMaintenance: {
        cleanRuns: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
      },
      trafficAborter: { abortCurrent: async () => ({ outcome: "no_current_run" }) },
      dashboardLiveStateReset: {
        fenceRun: async () => undefined,
        clearRun: async () => undefined,
        hasRunState: async () => false,
      },
      resetWorkflowFence: { runExclusive: async (operation) => operation() },
      maintenanceAuthority: new ProcessLocalDemoMaintenanceAuthority(),
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
    const barrierChannel = "terminal-event-barrier";
    const barrierSentinel = "finalizer-publishes-complete";
    const terminalEvents: unknown[] = [];
    const observedBarriers: string[] = [];
    const writeResults: boolean[] = [];
    const firstWriter = new PostgresTerminalDemoRunSummaryWriter(db, {
      synchronize: async () => {},
    });
    const secondWriter = new PostgresTerminalDemoRunSummaryWriter(competingConnection.db, {
      synchronize: async () => {},
    });
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
      if (channel === dashboardProjectionDirtyRedisChannel) {
        terminalEvents.push(JSON.parse(message));
      }
      if (channel === barrierChannel && message === barrierSentinel) {
        observedBarriers.push(message);
      }
    };
    subscriberRedis.on("message", handleSubscriberMessage);

    try {
      await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
      await subscriberRedis.subscribe(dashboardProjectionDirtyRedisChannel, barrierChannel);
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
        type: "dashboard.projection.dirty",
        scope: { runId: ids.run, saleOfferId: ids.saleOffer },
      });
    } finally {
      subscriberRedis.off("message", handleSubscriberMessage);
      try {
        if (subscribed) {
          await subscriberRedis.unsubscribe(dashboardProjectionDirtyRedisChannel, barrierChannel);
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

  it("publishes the persisted run correlation when the sweep finalizes a run", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const subscriberRedis = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    const logger = createSilentLogger("api");
    const debug = vi.spyOn(logger, "debug");
    const service = createService(connection, redis, { logger });
    const terminalEvents: Record<string, unknown>[] = [];
    const handleSubscriberMessage = (channel: string, message: string) => {
      if (channel === dashboardProjectionDirtyRedisChannel) {
        terminalEvents.push(JSON.parse(message) as Record<string, unknown>);
      }
    };
    subscriberRedis.on("message", handleSubscriberMessage);

    try {
      await seedDrainingRun({
        db,
        redis: redisClient,
        trafficDeliveryStatus: "complete",
        correlationId: "corr-run-root",
      });
      await subscriberRedis.subscribe(dashboardProjectionDirtyRedisChannel);

      await expect(service.finalizeReadyRuns()).resolves.toBe(1);
      await waitForObservedCount(terminalEvents, 1);

      expect(terminalEvents).toEqual([
        {
          type: "dashboard.projection.dirty",
          correlationId: "corr-run-root",
          scope: { runId: ids.run, saleOfferId: ids.saleOffer },
        },
      ]);
      expect(debug).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: ids.run,
          correlationId: "corr-run-root",
          finalizationActor: "sweep",
        }),
        "Published terminal projection dirty signal.",
      );
    } finally {
      subscriberRedis.off("message", handleSubscriberMessage);
      try {
        await subscriberRedis.unsubscribe(dashboardProjectionDirtyRedisChannel);
      } finally {
        subscriberRedis.disconnect();
      }
    }
  });

  it("publishes caller correlation over the persisted root after commit", async () => {
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
    expect(recoveryStartT1.getTime()).toBeGreaterThan(finalizationAttemptT0.getTime());
    const finalizationClockCalls: Date[] = [];
    const service = createService(connection, redis, {
      now: () => {
        finalizationClockCalls.push(finalizationAttemptT0);
        return finalizationAttemptT0;
      },
    });
    const terminalEvents: Record<string, unknown>[] = [];
    const handleSubscriberMessage = (channel: string, message: string) => {
      if (channel === dashboardProjectionDirtyRedisChannel) {
        terminalEvents.push(JSON.parse(message) as Record<string, unknown>);
      }
    };
    subscriberRedis.on("message", handleSubscriberMessage);
    let finalizationPromise: Promise<unknown> | null = null;

    try {
      await seedDrainingRun({
        db,
        redis: redisClient,
        trafficDeliveryStatus: "complete",
        correlationId: "corr-persisted-root",
      });
      await subscriberRedis.subscribe(dashboardProjectionDirtyRedisChannel);
      const staleRecovery = await lockConnection.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${terminalDemoRunTransitionLockKey(ids.run)}))`,
        );

        // t0: the finalization attempt starts and blocks on the terminal lock.
        finalizationPromise = service.finalizeRun(ids.run, "corr-finalize-overlap");
        await waitForWaitingAdvisoryLock(observerConnection.sql);

        // t1: recovery reads the still-draining projection before the commit.
        const recoveryService = new DashboardProjectionService({
          openOperation: async () => ({
            dependencies: {
              contextReader: new PostgresDashboardRecoveryContextReader(recoveryConnection.db),
              businessOutcomeReader: {
                read: async () => Promise.reject(new Error("unused business projection")),
              },
              consistencyLagReader: {
                read: async () => Promise.reject(new Error("unused lag projection")),
              },
              inventoryStatusService: {
                getStatus: async () => Promise.reject(new Error("unused inventory projection")),
              },
              queueStatusService: {
                getStatus: async () => Promise.reject(new Error("unused queue projection")),
              },
              runErpOutcomeService: {
                getOutcomes: async () => Promise.reject(new Error("unused run ERP projection")),
              },
              trafficMetricReader: { readRecent: async () => [] },
              transportObservationReader: { read: async () => null },
              runtimeProgressService: {
                getProgress: async () => {
                  throw new Error("unused runtime progress projection");
                },
              },
              revisionAllocator: { allocate: async () => 1 },
            },
            close: async () => undefined,
          }),
          logger: createSilentLogger("api"),
          now: () => recoveryStartT1,
        });
        const recovery = await recoveryService.build({
          correlationId: "corr-recovery-overlap",
        });
        // The terminal writer has not committed, so nothing may be published yet.
        expect(terminalEvents).toHaveLength(0);
        return recovery;
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
      expect(finalizationClockCalls).toEqual([finalizationAttemptT0]);
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]).toMatchObject({
        type: "dashboard.projection.dirty",
        correlationId: "corr-finalize-overlap",
        scope: { runId: ids.run, saleOfferId: ids.saleOffer },
      });
    } finally {
      subscriberRedis.off("message", handleSubscriberMessage);
      try {
        await subscriberRedis.unsubscribe(dashboardProjectionDirtyRedisChannel);
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
      recipientPlaceholder: "buyer@example.invalid",
      recordedAt: new Date("2026-06-20T00:00:09.000Z"),
    });

    const finalized = await service.finalizeRun(ids.run, "corr-finalize-test");
    const [summary] = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run))
      .limit(1);

    expect(finalized?.status).toBe("failed");
    expect(finalized?.failureCategory).toBe("traffic");
    expect(summary?.status).toBe("failed");
    expect(summary?.failureReason).toBe("traffic_delivery_major_shortfall");
    expect(summary?.transportAttemptCounts).toMatchObject({
      startedRequests: 5,
      unstartedRequests: 5,
    });
    expect(summary?.trafficDeliverySummary).toMatchObject({
      trafficDeliveryStatus: "failed",
    });
  });

  it("fails one unexpected application response before a traffic-process failure", async () => {
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
      failureCategory: "traffic",
    });
    const [summary] = await db
      .select({ failureReason: demoRunSummaries.failureReason })
      .from(demoRunSummaries);
    expect(summary?.failureReason).toBe("traffic_outcome_unexpected_responses");
  });

  it("reports major delivery shortfall before an unexpected application response", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);
    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "failed" });
    await db
      .update(demoRunFinalizations)
      .set({
        httpSummary: {
          ...trafficCompletionReportFixture("failed").httpSummary,
          unexpectedResponses: 1,
          failedRequests: 1,
        },
      })
      .where(eq(demoRunFinalizations.runId, ids.run));

    await expect(service.finalizeRun(ids.run)).resolves.toMatchObject({
      status: "failed",
      failureCategory: "traffic",
    });
    const [summary] = await db
      .select({ failureReason: demoRunSummaries.failureReason })
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run))
      .limit(1);

    expect(summary?.failureReason).toBe("traffic_delivery_major_shortfall");
  });

  it("reports transport-only major loss before a generic traffic-process failure", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);
    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await db
      .update(demoRunFinalizations)
      .set({
        httpSummary: {
          ...trafficCompletionReportFixture("complete").httpSummary,
          transportFailures: 1,
          failedRequests: 1,
        },
        errorMessage: "k6 also reported a process error",
      })
      .where(eq(demoRunFinalizations.runId, ids.run));

    await expect(service.finalizeRun(ids.run)).resolves.toMatchObject({
      status: "failed",
      failureCategory: "traffic",
    });
    const [summary] = await db
      .select({ failureReason: demoRunSummaries.failureReason })
      .from(demoRunSummaries);
    expect(summary?.failureReason).toBe("traffic_transport_major_loss");
  });

  it("reports an unexpected application response before major transport loss", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);
    await seedDrainingRun({ db, redis: redisClient, trafficDeliveryStatus: "complete" });
    await db
      .update(demoRunFinalizations)
      .set({
        httpSummary: {
          ...trafficCompletionReportFixture("complete").httpSummary,
          transportFailures: 1,
          unexpectedResponses: 1,
          failedRequests: 2,
        },
        errorMessage: "k6 also reported a process error",
      })
      .where(eq(demoRunFinalizations.runId, ids.run));

    await expect(service.finalizeRun(ids.run)).resolves.toMatchObject({
      status: "failed",
      failureCategory: "traffic",
    });
    const [summary] = await db
      .select({ failureReason: demoRunSummaries.failureReason })
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run))
      .limit(1);

    expect(summary?.failureReason).toBe("traffic_outcome_unexpected_responses");
  });

  it("completes the motivating degraded transport-loss profile without a failure reason", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);
    await seedDrainingRun({
      db,
      redis: redisClient,
      trafficDeliveryStatus: "complete",
      configSnapshot: configSnapshotFixture(10_000),
    });
    await db
      .update(demoRunFinalizations)
      .set({
        transportAttemptCounts: {
          plannedRequests: 10_000,
          startedRequests: 10_000,
          completedRequests: 10_000,
          interruptedRequests: 0,
          unstartedRequests: 0,
        },
        httpSummary: {
          ...trafficCompletionReportFixture("complete").httpSummary,
          acceptedResponses: 0,
          soldOutResponses: 9_698,
          transportFailures: 302,
          unexpectedResponses: 0,
          failedRequests: 302,
          failureRate: 0.0302,
        },
      })
      .where(eq(demoRunFinalizations.runId, ids.run));

    await expect(service.finalizeRun(ids.run)).resolves.toMatchObject({ status: "completed" });
    const [summary] = await db
      .select({ failureReason: demoRunSummaries.failureReason, status: demoRunSummaries.status })
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));
    expect(summary).toEqual({ status: "completed", failureReason: null });
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
      startedRequests: 400,
      completedIterations: 400,
    });
    await insertFailedReservationOrders(db, 50);

    await expect(service.finalizeRun(ids.run)).resolves.toMatchObject({ status: "completed" });
    const [summary] = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));
    expect(summary?.businessOutcomeSummary).toMatchObject({
      acceptedReservations: 50,
      reservedUnits: 50,
      failedOrders: 50,
    });
    expect(summary?.replayPossible).toBe(true);
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
      startedRequests: 399,
      completedIterations: 399,
    });
    await insertFailedReservationOrders(db, 50);

    expect(isReplayPossible(duplicateBuyerConfigSnapshot())).toBe(true);
    await expect(service.finalizeRun(ids.run)).resolves.toMatchObject({ status: "draining" });
  });

  it("keeps missing accepted-response accounting nonterminal ten minutes into the run", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    await seedDrainingRun({
      db,
      redis: redisClient,
      trafficDeliveryStatus: "complete",
      configSnapshot: configSnapshotFixture(25),
    });
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
      status: "draining",
    });
  });

  it("finalizes a missing-export completion after durable work settles without inventing counters", async () => {
    const db = requireConnection(connection).db;
    const config = configSnapshotFixture(25);
    await seedDrainingRun({
      db,
      redis: requireRedis(redis),
      trafficDeliveryStatus: "complete",
      configSnapshot: config,
    });
    await insertFailedReservationOrders(db, 25);
    const http = {
      failedRequests: null,
      acceptedResponses: null,
      soldOutResponses: null,
      transportFailures: null,
      unexpectedResponses: null,
      failureRate: null,
    };
    const diagnostics = runnerDiagnosticsFixture(config);
    diagnostics.terminalMetricSources = {
      startedRequests: "point_stream",
      completedRequests: "point_stream",
      acceptedResponses: null,
      soldOutResponses: null,
      transportFailures: null,
      unexpectedResponses: null,
      droppedIterations: null,
      completedIterations: "point_stream",
    };
    diagnostics.summaryExportWarnings = [
      "summary_export_missing",
      "k6_outcome_counter_summary_export_unavailable",
    ];
    await db
      .update(demoRunFinalizations)
      .set({ httpSummary: http, loadRunDiagnosticsSummary: diagnostics });

    await expect(createService(connection, redis).finalizeRun(ids.run)).resolves.toMatchObject({
      status: "completed",
    });
    const [summary] = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, ids.run));
    expect(summary?.httpSummary).toEqual(http);
    expect(summary?.businessOutcomeSummary).toMatchObject({
      acceptedReservations: 25,
      failedOrders: 25,
      pendingPersistenceCount: 0,
    });
    expect(
      (summary?.loadRunDiagnosticsSummary as { accountingWarnings?: unknown[] }).accountingWarnings,
    ).toBeUndefined();
  });

  it("preserves underreported durable rows and writes one structured diagnostic", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createService(connection, redis);
    await seedDrainingRun({
      db,
      redis: redisClient,
      trafficDeliveryStatus: "complete",
      configSnapshot: configSnapshotFixture(25),
    });
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
});

function createService(
  connection: ReturnType<typeof createDatabaseConnection> | null,
  redis: ReturnType<typeof createRedisClient> | null,
  options: {
    queueLimits?: OrderProcessQueueLimits;
    terminalRunWriter?: ConstructorParameters<
      typeof DemoRunFinalizationService
    >[0]["terminalRunWriter"];
    terminalInventoryRead?: ConstructorParameters<
      typeof DemoRunFinalizationService
    >[0]["terminalInventoryRead"];
    terminalInventoryReadTimeoutMs?: number;
    now?: () => Date;
    logger?: ConstructorParameters<typeof DemoRunFinalizationService>[0]["logger"];
    runnerOperations?: ConstructorParameters<
      typeof DemoRunFinalizationService
    >[0]["runnerOperations"];
  } = {},
): DemoRunFinalizationService {
  return new DemoRunFinalizationService({
    runnerOperations: { releaseAfterRun: () => undefined },
    queueLimits: { synchronize: async () => {} },
    db: requireConnection(connection).db,
    terminalRunWriter:
      options.terminalRunWriter ??
      new PostgresTerminalDemoRunSummaryWriter(requireConnection(connection).db, {
        synchronize: async () => {},
      }),
    redis: requireRedis(redis),
    terminalInventoryRead: createTerminalInventoryRead(requireRedis(redis)),
    terminalInventoryReadTimeoutMs: 2_000,
    logger: createSilentLogger("api"),
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

async function seedDrainingRun(input: {
  db: ReturnType<typeof createDatabaseConnection>["db"];
  redis: ReturnType<typeof createRedisClient>;
  trafficDeliveryStatus: "complete" | "failed";
  configSnapshot?: AcceptedRunConfigSnapshot;
  correlationId?: string;
}): Promise<void> {
  const configSnapshot = input.configSnapshot ?? configSnapshotFixture();
  const report = trafficCompletionReportSchema.parse(
    trafficCompletionReportFixture(input.trafficDeliveryStatus, configSnapshot),
  );
  expect(
    findTrafficCompletionBindingMismatch(
      {
        runId: ids.run,
        configSnapshot,
        acceptedAt: new Date("2026-06-20T00:00:00.000Z"),
        trafficStartedAt: new Date(report.loadRunDiagnosticsSummary.startedAt),
      },
      report,
    ),
  ).toBeNull();
  const trafficEndedAt = new Date(report.completedAt);
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
    correlationId: input.correlationId ?? "corr-finalize-test",
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
    transportAttemptCounts: report.transportAttemptCounts,
    httpSummary: report.httpSummary,
    trafficOutcomeSummary: {},
    trafficDeliverySummary: trafficDeliverySummarySchema.parse({
      ...report.trafficDeliverySummary,
      completedIterations: report.trafficDeliverySummary.completedIterations ?? null,
      trafficDeliveryStatus: input.trafficDeliveryStatus,
    }),
    httpTimingBreakdownSummary: {
      ...emptyHttpTimingBreakdownSummary,
      waiting: { averageMs: 10, p95Ms: 20 },
    },
    loadRunDiagnosticsSummary: report.loadRunDiagnosticsSummary,
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

function runnerDiagnosticsFixture(
  configSnapshot: AcceptedRunConfigSnapshot,
): TrafficCompletionReport["loadRunDiagnosticsSummary"] {
  return {
    startedAt: "2026-06-20T00:00:01.000Z",
    completedAt: "2026-06-20T00:00:05.000Z",
    nproc: null,
    ulimitNofile: null,
    processMaxOpenFiles: null,
    generatorCapacity: null,
    generatorUtilisation: null,
    networkDiagnostics: null,
    k6Version: null,
    executionPlan: deriveLoadExecutionPlan(configSnapshot.trafficConfig),
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
      transportFailures: "summary_export" as const,
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
          failureCode: technicalOrderFailureCodeValues[0],
          failureMessage: "ERP failed.",
        }
      : {}),
    createdAt: new Date("2026-06-20T00:00:03.000Z"),
    updatedAt: new Date("2026-06-20T00:00:05.000Z"),
  };
}

function configSnapshotFixture(buyerCount = 10): AcceptedRunConfigSnapshot {
  return {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 1,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 10,
    },
    erpConfig: {
      latencyMs: 10,
      maxTps: 10,
      errorRate: 0,
      forcedOutage: false,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 2,
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
    startedRequests?: number;
    completedIterations?: number;
  },
): Promise<void> {
  const [run] = await db
    .select({ configSnapshot: demoRuns.configSnapshot })
    .from(demoRuns)
    .where(eq(demoRuns.id, ids.run));
  if (!run) throw new Error("Missing seeded run.");
  const configSnapshot = run.configSnapshot as AcceptedRunConfigSnapshot;
  const plan = deriveLoadExecutionPlan(configSnapshot.trafficConfig);
  const plannedRequests = plan.plannedEmittedAttempts;
  const startedRequests = input.startedRequests ?? plannedRequests;
  const unstartedRequests = plannedRequests - startedRequests;
  const report = trafficCompletionReportSchema.parse({
    ...trafficCompletionReportFixture("complete", configSnapshot),
    transportAttemptCounts: {
      plannedRequests,
      startedRequests,
      completedRequests: startedRequests,
      interruptedRequests: 0,
      unstartedRequests,
    },
    httpSummary: {
      failedRequests: 0,
      acceptedResponses: input.acceptedResponses,
      soldOutResponses: startedRequests - input.acceptedResponses,
      transportFailures: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    trafficDeliverySummary: {
      ...trafficCompletionReportFixture("complete", configSnapshot).trafficDeliverySummary,
      completedIterations: input.completedIterations ?? startedRequests,
    },
  });
  const trafficDeliveryStatus = classifyTrafficDelivery(report.transportAttemptCounts);
  if (!trafficDeliveryStatus) throw new Error("Test fixture requires a positive request plan.");
  expect(
    findTrafficCompletionBindingMismatch(
      {
        runId: ids.run,
        configSnapshot,
        acceptedAt: new Date("2026-06-20T00:00:00.000Z"),
        trafficStartedAt: new Date(report.loadRunDiagnosticsSummary.startedAt),
      },
      report,
    ),
  ).toBeNull();
  await db
    .update(demoRunFinalizations)
    .set({
      transportAttemptCounts: report.transportAttemptCounts,
      httpSummary: report.httpSummary,
      trafficDeliverySummary: {
        ...report.trafficDeliverySummary,
        completedIterations: report.trafficDeliverySummary.completedIterations ?? null,
        trafficDeliveryStatus,
      },
      loadRunDiagnosticsSummary: report.loadRunDiagnosticsSummary,
    })
    .where(eq(demoRunFinalizations.runId, ids.run));
}

async function setArrivalAnchor(
  db: ReturnType<typeof createDatabaseConnection>["db"],
): Promise<void> {
  const [row] = await db
    .select({ trafficDeliverySummary: demoRunFinalizations.trafficDeliverySummary })
    .from(demoRunFinalizations)
    .where(eq(demoRunFinalizations.runId, ids.run));
  const delivery = trafficDeliverySummarySchema.parse(row?.trafficDeliverySummary);
  await db
    .update(demoRunFinalizations)
    .set({
      trafficDeliverySummary: {
        ...delivery,
        requestArrivalSummary: {
          ...delivery.requestArrivalSummary,
          firstAttemptStartedAt: "2026-06-20T00:00:01.500Z",
          dispatchDurationSeconds: 1,
        },
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
  configSnapshot: AcceptedRunConfigSnapshot = configSnapshotFixture(),
): TrafficCompletionReport {
  const plan = deriveLoadExecutionPlan(configSnapshot.trafficConfig);
  const plannedRequests = plan.plannedEmittedAttempts;
  const startedRequests =
    trafficDeliveryStatus === "failed" ? plannedRequests / 2 : plannedRequests;
  return {
    runId: ids.run,
    status: "succeeded",
    exitCode: 0,
    transportAttemptCounts: {
      plannedRequests,
      startedRequests,
      completedRequests: startedRequests,
      interruptedRequests: 0,
      unstartedRequests: plannedRequests - startedRequests,
    },
    httpSummary: {
      failedRequests: 0,
      acceptedResponses: 0,
      soldOutResponses: startedRequests,
      transportFailures: 0,
      unexpectedResponses: 0,
      p95LatencyMs: 25,
      failureRate: 0,
    },
    trafficOutcomeSummary: {},
    trafficDeliverySummary: {
      trafficMode: "buyer-spike",
      plannedBuyers: plan.trafficMode === "buyer-spike" ? plan.buyerCount : null,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: plannedRequests - startedRequests,
      requestArrivalSummary: emptyRequestArrivalSummary,
      notes: trafficDeliveryStatus === "failed" ? ["Major request delivery shortfall."] : [],
    },
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    loadRunDiagnosticsSummary: runnerDiagnosticsFixture(configSnapshot),
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

  throw new Error(`Timed out waiting for ${expectedCount} projection dirty signal(s).`);
}

function requireStartedPromise<T>(promise: Promise<T> | null, label: string): Promise<T> {
  if (!promise) {
    throw new Error(`${label} promise was not started.`);
  }

  return promise;
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
