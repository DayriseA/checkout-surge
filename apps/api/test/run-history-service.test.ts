import {
  emptyHttpTimingBreakdownSummary,
  emptyRequestArrivalSummary,
  runSignalBucketCount,
  trafficDeliverySummarySchema,
} from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  demoPresets,
  demoRunSaleContexts,
  demoRunSummaries,
  demoRuns,
  erpAttempts,
  orderEvents,
  orders,
  products,
  reservations,
  saleOffers,
  simulatedNotifications,
} from "@checkout-surge/db";
import { requireTestDatabaseUrl, resetTestDatabase } from "@checkout-surge/db/testing";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RunHistoryService } from "../src/services/run-history-service.js";

const ids = {
  product: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  preset: "33333333-3333-4333-8333-333333333331",
  olderRun: "55555555-5555-4555-8555-555555555551",
  newerRun: "55555555-5555-4555-8555-555555555552",
  noSummaryRun: "55555555-5555-4555-8555-555555555553",
  olderSummary: "77777777-7777-4777-8777-777777777771",
  newerSummary: "77777777-7777-4777-8777-777777777772",
  saleOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  reservation: "99999999-9999-4999-8999-999999999991",
  order: "99999999-9999-4999-8999-999999999992",
  erpAttempt: "99999999-9999-4999-8999-999999999993",
  notification: "99999999-9999-4999-8999-999999999994",
  orderQueuedEvent: "99999999-9999-4999-8999-999999999995",
  orderConfirmedEvent: "99999999-9999-4999-8999-999999999996",
} as const;

describe("run history service", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;

  beforeEach(async () => {
    await connection?.close();
    connection = null;

    await resetTestDatabase();
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("projects the same safe diagnosis publicly and for admins while keeping stderr protected", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);
    const warning =
      'level=warning msg="Insufficient VUs, reached 4000 active VUs and cannot initialize more"';
    await db
      .update(demoRuns)
      .set({ failureReason: "traffic_delivery_major_shortfall" })
      .where(eq(demoRuns.id, ids.newerRun));
    await db
      .update(demoRunSummaries)
      .set({
        failureReason: "traffic_delivery_major_shortfall",
        loadRunDiagnosticsSummary: {
          ...runHistoryDiagnosticsFixture(),
          executionPlan: {
            trafficMode: "constant-arrival-rate",
            ratePerSecond: 2000,
            durationSeconds: 15,
            startDelaySeconds: 6,
            preAllocatedVus: 3000,
            maxVus: 4000,
            plannedEmittedAttempts: 30000,
          },
          stderrLines: [warning],
          stderrLineCountObserved: 1,
          stderrLineCountRetained: 1,
        },
      })
      .where(eq(demoRunSummaries.runId, ids.newerRun));
    const publicDetail = await service.detail(ids.newerRun);
    const adminDetail = await service.adminDetail(ids.newerRun);
    expect(publicDetail?.failureDiagnostic).toEqual({ cause: "virtual_user_limit", maxVus: 4000 });
    expect(adminDetail?.failureDiagnostic).toEqual(publicDetail?.failureDiagnostic);
    expect(JSON.stringify(publicDetail)).not.toContain("stderr");
    expect(JSON.stringify(publicDetail)).not.toContain(warning);
    expect(adminDetail?.loadRunDiagnosticsSummary?.stderrLines).toEqual([warning]);
    expect((await service.detail(ids.olderRun))?.failureDiagnostic).toBeNull();
  });

  it("returns empty public history with stable pagination metadata", async () => {
    const service = createService(connection);

    const history = await service.list({ page: 1, pageSize: 10 });

    expect(history).toEqual({
      summaries: [],
      page: 1,
      pageSize: 10,
      totalCount: 0,
      timestamp: "2026-06-20T00:00:10.000Z",
    });
  });

  it("lists immutable terminal summaries newest first with public-safe payloads", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);

    const firstPage = await service.list({ page: 1, pageSize: 1 });
    const secondPage = await service.list({ page: 2, pageSize: 1 });

    expect(firstPage.totalCount).toBe(2);
    expect(firstPage.summaries).toHaveLength(1);
    expect(firstPage.summaries[0]).toMatchObject({
      runId: ids.newerRun,
      presetName: "History Failed",
      occurredAt: "2026-06-20T00:00:00.000Z",
      overallDurationMs: 9_000,
      resultOutcome: "failed",
      plannedAttempts: 10,
      startingStock: 5,
      uniqueReservations: 3,
      soldOutRejections: 2,
      confirmedOrders: 2,
      failedOrders: 1,
      convergenceDurationSeconds: null,
    });
    expect(firstPage.summaries[0]).not.toHaveProperty("id");
    expect(firstPage.summaries[0]).not.toHaveProperty("failureCategory");
    expect(firstPage.summaries[0]).not.toHaveProperty("terminalInventorySnapshot");
    expect(firstPage.summaries[0]).not.toHaveProperty("reservationToken");
    expect(firstPage.summaries[0]).not.toHaveProperty("idempotencyKey");
    expect(secondPage.summaries[0]?.runId).toBe(ids.olderRun);
    expect(firstPage.summaries[0]?.convergenceDurationSeconds).toBeNull();
  });

  it("uses the public duration derivation for protected detail", async () => {
    const service = createService(connection);
    await seedHistory(requireConnection(connection).db);

    const [publicDetail, protectedDetail] = await Promise.all([
      service.detail(ids.newerRun),
      service.adminDetail(ids.newerRun),
    ]);

    expect(protectedDetail?.overallDurationMs).toBe(publicDetail?.overallDurationMs);
  });

  it("keeps list payloads headline-only and detail payloads series-bearing", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);
    await db
      .update(demoRunSummaries)
      .set({ runSignalTimelineSummary: runSignalTimelineFixture() })
      .where(eq(demoRunSummaries.id, ids.newerSummary));

    const list = await service.list({ page: 1, pageSize: 1 });
    const detail = await service.detail(ids.newerRun);
    const adminDetail = await service.adminDetail(ids.newerRun);

    expect(list.summaries[0]?.convergenceDurationSeconds).toBe(5);
    expect(list.summaries[0]).not.toHaveProperty("runSignalTimelineSummary");
    expect(detail?.runSignalTimelineSummary?.queueBacklog.backlogSeries).toHaveLength(120);
    expect(adminDetail?.runSignalTimelineSummary?.inventoryDrain.remainingStockSeries).toHaveLength(
      120,
    );
  });

  it("keeps config-derived demand consistent across list and detail despite generator mismatch", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);
    await db
      .update(demoRunSummaries)
      .set({
        transportAttemptCounts: {
          plannedRequests: 99,
          startedRequests: 5,
          completedRequests: 5,
          interruptedRequests: 0,
          unstartedRequests: 94,
        },
        terminalInventorySnapshot: null,
      })
      .where(eq(demoRunSummaries.id, ids.newerSummary));

    const [history, detail] = await Promise.all([
      service.list({ page: 1, pageSize: 1 }),
      service.detail(ids.newerRun),
    ]);

    expect(history.summaries[0]).toMatchObject({
      plannedAttempts: 10,
      startingStock: 5,
    });
    expect(detail).toMatchObject({
      plannedAttempts: 10,
      summary: { transportAttemptCounts: { plannedRequests: 99 } },
    });
    expect(history.summaries[0]).not.toHaveProperty("terminalInventorySnapshot");
  });

  it("assembles canonical detail results from persisted summary evidence", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);
    const completeTransport = {
      plannedRequests: 10,
      startedRequests: 10,
      completedRequests: 10,
      interruptedRequests: 0,
      unstartedRequests: 0,
    };
    const completeHttp = {
      failedRequests: 0,
      acceptedResponses: 3,
      soldOutResponses: 2,
      transportFailures: 0,
      unexpectedResponses: 0,
      p95LatencyMs: 42,
      failureRate: 0,
    };
    const cleanBusinessOutcome = {
      acceptedReservations: 3,
      reservedUnits: 5,
      soldOutRejections: 2,
      queuedOrders: 0,
      processingOrders: 0,
      retryingOrders: 0,
      confirmedOrders: 3,
      failedOrders: 0,
      pendingPersistenceCount: 0,
      notificationsRecorded: 3,
    };
    const completeTrafficDelivery = trafficDeliverySummarySchema.parse({
      trafficMode: null,
      plannedBuyers: null,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: null,
      requestArrivalSummary: emptyRequestArrivalSummary,
      trafficDeliveryStatus: "complete",
      notes: [],
    });
    const terminalInventory = {
      saleOfferId: ids.saleOffer,
      startingStock: 5,
      remainingStock: 0,
      reservedStock: 5,
      acceptedReservations: 3,
      soldOutRejections: 2,
      pendingPersistenceCount: 0,
      capturedAt: "2026-06-20T00:00:05.000Z",
      source: "redis" as const,
    };
    const updateSummary = (values: Partial<typeof demoRunSummaries.$inferInsert>) =>
      db.update(demoRunSummaries).set(values).where(eq(demoRunSummaries.id, ids.olderSummary));

    await updateSummary({
      businessOutcomeSummary: cleanBusinessOutcome,
      httpSummary: completeHttp,
      terminalInventorySnapshot: terminalInventory,
      trafficDeliverySummary: completeTrafficDelivery,
      transportAttemptCounts: completeTransport,
    });
    expect((await service.detail(ids.olderRun))?.result).toMatchObject({
      outcome: "completed-successfully",
      uniqueReservations: 3,
      reservedUnits: 5,
      confirmedOrders: 3,
      failedOrders: 0,
    });

    await updateSummary({
      businessOutcomeSummary: {
        ...cleanBusinessOutcome,
        confirmedOrders: 2,
        failedOrders: 1,
        notificationsRecorded: 2,
      },
    });
    expect((await service.detail(ids.olderRun))?.result.outcome).toBe(
      "completed-with-order-failures",
    );

    await updateSummary({ terminalInventorySnapshot: null });
    expect((await service.detail(ids.olderRun))?.result).toMatchObject({
      outcome: "outcome-indeterminate",
      startingStock: null,
      remainingStock: null,
    });

    await updateSummary({
      businessOutcomeSummary: cleanBusinessOutcome,
      terminalInventorySnapshot: terminalInventory,
      trafficDeliverySummary: {
        ...completeTrafficDelivery,
        droppedIterations: 1,
        trafficDeliveryStatus: "failed",
      },
      transportAttemptCounts: {
        ...completeTransport,
        startedRequests: 9,
        completedRequests: 9,
        unstartedRequests: 1,
      },
    });
    expect((await service.detail(ids.olderRun))?.result).toMatchObject({
      outcome: "completed-successfully",
      maximumClassification: "evidence_incomplete",
      reconciliations: expect.arrayContaining([
        expect.objectContaining({
          code: "partial_generator_coverage",
          classification: "evidence_incomplete",
        }),
      ]),
    });

    await updateSummary({
      httpSummary: { ...completeHttp, acceptedResponses: 4 },
      trafficDeliverySummary: completeTrafficDelivery,
      transportAttemptCounts: completeTransport,
    });
    expect((await service.detail(ids.olderRun))?.result).toMatchObject({
      outcome: "completed-successfully",
      maximumClassification: "warning",
      reconciliations: expect.arrayContaining([
        expect.objectContaining({
          code: "accepted_responses_vs_unique_reservations",
          classification: "warning",
        }),
      ]),
    });
  });

  it("computes protected exception counts from authoritative run evidence", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);
    const updateSummary = (values: Partial<typeof demoRunSummaries.$inferInsert>) =>
      db.update(demoRunSummaries).set(values).where(eq(demoRunSummaries.id, ids.olderSummary));
    const cleanBusinessOutcome = {
      acceptedReservations: 3,
      reservedUnits: 5,
      soldOutRejections: 2,
      queuedOrders: 0,
      processingOrders: 0,
      retryingOrders: 0,
      confirmedOrders: 3,
      failedOrders: 0,
      pendingPersistenceCount: 0,
      notificationsRecorded: 3,
    };
    const cleanInventory = {
      saleOfferId: ids.saleOffer,
      startingStock: 5,
      remainingStock: 0,
      reservedStock: 5,
      acceptedReservations: 3,
      soldOutRejections: 2,
      pendingPersistenceCount: 0,
      capturedAt: "2026-06-20T00:00:05.000Z",
      source: "redis" as const,
    };
    const completeDelivery = trafficDeliverySummarySchema.parse({
      trafficMode: null,
      plannedBuyers: null,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: null,
      requestArrivalSummary: emptyRequestArrivalSummary,
      trafficDeliveryStatus: "complete",
      notes: [],
    });

    await updateSummary({
      businessOutcomeSummary: cleanBusinessOutcome,
      terminalInventorySnapshot: cleanInventory,
      trafficDeliverySummary: completeDelivery,
      loadRunDiagnosticsSummary: completeRunHistoryDiagnosticsFixture(),
    });
    expect((await service.adminDetail(ids.olderRun))?.exceptionSummary).toEqual({
      maximumClassification: "expected_population_difference",
      brokenInvariants: 0,
      failedOrders: 0,
      pendingWork: 0,
      partialDelivery: 0,
      generatorWarnings: 0,
    });

    await updateSummary({
      businessOutcomeSummary: {
        ...cleanBusinessOutcome,
        queuedOrders: 1,
        processingOrders: 1,
        retryingOrders: 1,
        confirmedOrders: 0,
        failedOrders: 1,
        pendingPersistenceCount: 1,
      },
      terminalInventorySnapshot: { ...cleanInventory, pendingPersistenceCount: 1 },
      trafficDeliverySummary: {
        ...completeDelivery,
        droppedIterations: 1,
        trafficDeliveryStatus: "degraded",
      },
      transportAttemptCounts: {
        plannedRequests: 20,
        startedRequests: 19,
        completedRequests: 19,
        interruptedRequests: 0,
        unstartedRequests: 1,
      },
      loadRunDiagnosticsSummary: {
        ...completeRunHistoryDiagnosticsFixture(),
        summaryExportWarnings: ["summary_export_missing"],
      },
    });
    expect((await service.adminDetail(ids.olderRun))?.exceptionSummary).toMatchObject({
      maximumClassification: "evidence_incomplete",
      failedOrders: 1,
      pendingWork: 3,
      partialDelivery: 1,
      generatorWarnings: 1,
    });

    await updateSummary({
      businessOutcomeSummary: { ...cleanBusinessOutcome, reservedUnits: 4 },
      terminalInventorySnapshot: {
        ...cleanInventory,
        remainingStock: 1,
        reservedStock: 4,
      },
      trafficDeliverySummary: completeDelivery,
      transportAttemptCounts: {
        plannedRequests: 20,
        startedRequests: 20,
        completedRequests: 20,
        interruptedRequests: 0,
        unstartedRequests: 0,
      },
    });
    expect((await service.adminDetail(ids.olderRun))?.exceptionSummary).toMatchObject({
      maximumClassification: "warning",
      brokenInvariants: 0,
    });

    await updateSummary({
      businessOutcomeSummary: cleanBusinessOutcome,
      terminalInventorySnapshot: null,
    });
    expect((await service.adminDetail(ids.olderRun))?.exceptionSummary).toMatchObject({
      maximumClassification: "evidence_incomplete",
      brokenInvariants: 0,
    });

    await updateSummary({
      businessOutcomeSummary: cleanBusinessOutcome,
      terminalInventorySnapshot: { ...cleanInventory, remainingStock: 1 },
    });
    expect((await service.adminDetail(ids.olderRun))?.exceptionSummary).toMatchObject({
      maximumClassification: "correctness_failure",
      brokenInvariants: 1,
    });
  });

  it("parses persisted server timing and derives expected replies from transport evidence", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);
    await db
      .update(demoRunSummaries)
      .set({
        httpSummary: {
          failedRequests: 2,
          acceptedResponses: 2,
          soldOutResponses: 1,
          transportFailures: 2,
          unexpectedResponses: 0,
          p95LatencyMs: 42,
          failureRate: 0.4,
        },
        serverReservationTimingSummary: {
          redisAtomicReservation: { sampleCount: 3, averageMs: 4, p95Ms: 25 },
          reserveOrderService: { sampleCount: 3, averageMs: 30, p95Ms: 100 },
        },
      })
      .where(eq(demoRunSummaries.id, ids.newerSummary));

    const history = await service.list({ page: 1, pageSize: 10 });
    const detail = await service.detail(ids.newerRun);

    expect(history.summaries[0]).not.toHaveProperty("serverReservationTimingSummary");
    expect(detail?.summary).toMatchObject({
      serverReservationTimingSummary: {
        redisAtomicReservation: { sampleCount: 3, averageMs: 4, p95Ms: 25 },
        reserveOrderService: { sampleCount: 3, averageMs: 30, p95Ms: 100 },
      },
    });
  });

  it("rejects malformed persisted server timing with summary-row context", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);
    await db
      .update(demoRunSummaries)
      .set({
        serverReservationTimingSummary: {
          redisAtomicReservation: { sampleCount: 1, averageMs: 4, p95Ms: null },
          reserveOrderService: { sampleCount: 1, averageMs: 30, p95Ms: 100 },
        } as unknown as (typeof demoRunSummaries.$inferSelect)["serverReservationTimingSummary"],
      })
      .where(eq(demoRunSummaries.id, ids.newerSummary));

    await expect(service.list({ page: 1, pageSize: 10 })).rejects.toThrow(
      new RegExp(`${ids.newerSummary}.*${ids.newerRun}.*serverReservationTimingSummary`),
    );
  });

  it("rejects stored run config snapshots that rely on wire defaults with run context", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);
    const config = configSnapshotFixture();
    const { forcedOutage: _defaulted, ...incompleteErpConfig } = config.erpConfig;
    await db
      .update(demoRuns)
      .set({
        configSnapshot: {
          ...config,
          erpConfig: incompleteErpConfig,
        } as unknown as (typeof demoRuns.$inferSelect)["configSnapshot"],
      })
      .where(eq(demoRuns.id, ids.newerRun));

    await expect(service.detail(ids.newerRun)).rejects.toThrow(
      new RegExp(`${ids.newerRun}.*configSnapshot\\.erpConfig\\.forcedOutage`),
    );
  });

  it("rejects stored business summaries that rely on wire defaults with row context", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);
    const summary = summaryFixture({
      id: ids.newerSummary,
      runId: ids.newerRun,
      presetName: "History Failed",
      status: "failed",
      failureReason: "traffic_delivery_major_shortfall",
      capturedAt: new Date("2026-06-20T00:00:08.000Z"),
      startedRequests: 5,
      trafficDeliveryStatus: "failed",
    });
    const { processingOrders: _defaulted, ...incompleteBusinessOutcome } =
      summary.businessOutcomeSummary;
    await db
      .update(demoRunSummaries)
      .set({
        businessOutcomeSummary:
          incompleteBusinessOutcome as unknown as (typeof demoRunSummaries.$inferSelect)["businessOutcomeSummary"],
      })
      .where(eq(demoRunSummaries.id, ids.newerSummary));

    await expect(service.list({ page: 1, pageSize: 10 })).rejects.toThrow(
      new RegExp(`${ids.newerSummary}.*${ids.newerRun}.*businessOutcomeSummary\\.processingOrders`),
    );
  });

  it("rejects malformed terminal inventory with summary-row context", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);
    await db
      .update(demoRunSummaries)
      .set({
        terminalInventorySnapshot: {
          ...summaryFixture({
            id: ids.newerSummary,
            runId: ids.newerRun,
            presetName: "History Failed",
            status: "failed",
            failureReason: "traffic_delivery_major_shortfall",
            capturedAt: new Date("2026-06-20T00:00:08.000Z"),
            startedRequests: 5,
            trafficDeliveryStatus: "failed",
          }).terminalInventorySnapshot,
          remainingStock: -1,
        } as (typeof demoRunSummaries.$inferSelect)["terminalInventorySnapshot"],
      })
      .where(eq(demoRunSummaries.id, ids.newerSummary));

    await expect(service.list({ page: 1, pageSize: 10 })).rejects.toThrow(
      new RegExp(
        `${ids.newerSummary}.*${ids.newerRun}.*terminalInventorySnapshot\\.remainingStock`,
      ),
    );
  });

  it("returns aggregate public detail and aggregate admin detail", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);
    await seedRunDetailRecords(db);
    await db.insert(erpAttempts).values([
      {
        disposition: "temporarily_unavailable",
        id: "88888888-8888-4888-8888-888888888881",
        orderId: ids.order,
        deliveryId: "history-delivery-1",
        correlationId: "corr-history-detail",
        runId: ids.newerRun,
        attemptNumber: 1,
        status: "failed",
        terminal: false,
        latencyMs: 10,
        startedAt: new Date("2026-06-20T00:00:02.000Z"),
        finishedAt: new Date("2026-06-20T00:00:03.000Z"),
        createdAt: new Date("2026-06-20T00:00:03.000Z"),
      },
      {
        disposition: "uncertain_result",
        id: "88888888-8888-4888-8888-888888888882",
        orderId: ids.order,
        deliveryId: "history-delivery-1",
        correlationId: "corr-history-detail",
        runId: ids.newerRun,
        attemptNumber: 2,
        status: "timed_out",
        terminal: false,
        latencyMs: 100,
        startedAt: new Date("2026-06-20T00:00:02.000Z"),
        finishedAt: new Date("2026-06-20T00:00:03.000Z"),
        createdAt: new Date("2026-06-20T00:00:03.000Z"),
      },
    ]);

    const detail = await service.detail(ids.newerRun);

    expect(detail).toMatchObject({
      summary: {
        runId: ids.newerRun,
        status: "failed",
      },
      run: {
        runId: ids.newerRun,
        status: "failed",
        trafficStatus: "failed",
      },
      erpAttempts: {
        totalCount: 3,
        historyCoverage: "retained_history",
        attemptRetentionLimitPerOrder: 32,
        cumulativeOutcomeCounts: {
          capacityRejected: 0,
          temporarilyUnavailable: 0,
          uncertainResult: 0,
        },
        byStatus: { succeeded: 1, failed: 1, timedOut: 1 },
      },
    });
    expect(detail).not.toHaveProperty("orders");
    expect(detail).not.toHaveProperty("notifications");
    expect(detail).not.toHaveProperty("eventTimeline");
    expect(detail?.erpAttempts.averageLatencyMs).toBeCloseTo(50.666_666, 5);
    expect(detail?.erpAttempts.p95LatencyMs).toBeCloseTo(94.2, 3);

    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("private-delivery-diagnostic-marker");
    expect(serialized).not.toContain(ids.saleOffer);
    expect(serialized).not.toContain("corr-history-detail");
    expect(serialized).not.toContain(ids.order);
    expect(serialized).not.toContain("reservation-token-private");
    expect(serialized).not.toContain("idempotency-key-private");
    expect(serialized).not.toContain("raw-private-header");
    expect(serialized).not.toContain("private-upstream-response");
    expect(serialized).not.toContain("private-recipient-placeholder");
    expect(serialized).not.toContain("x-control-service-token");
    expect(serialized).not.toContain("payload");

    await db
      .update(erpAttempts)
      .set({ status: "failed", terminal: false, httpStatus: 503 })
      .where(eq(erpAttempts.id, ids.erpAttempt));
    const changedDetail = await service.detail(ids.newerRun);
    expect(changedDetail?.erpAttempts).toMatchObject({
      byStatus: { succeeded: 0, failed: 2, timedOut: 1 },
    });

    const adminDetail = await service.adminDetail(ids.newerRun);
    expect(adminDetail?.exceptionSummary.failedOrders).toBe(1);
    expect(adminDetail?.exceptionSummary.partialDelivery).toBe(1);
    expect(adminDetail?.exceptionSummary.generatorWarnings).toBe(17);
    expect(adminDetail?.httpTimingBreakdownSummary).toEqual(emptyHttpTimingBreakdownSummary);
    expect(adminDetail?.loadRunDiagnosticsSummary).toMatchObject({
      k6Version: "k6 v1.0.0",
      generatorCapacity: null,
      generatorUtilisation: null,
    });
    expect(adminDetail?.summary.trafficDeliverySummary.notes).toContain(
      "private-delivery-diagnostic-marker",
    );
    expect(adminDetail?.erpAttemptSummary).toMatchObject({
      totalCount: 3,
      byStatus: { succeeded: 0, failed: 2, timedOut: 1 },
    });
    expect(adminDetail?.erpAttemptSummary.averageLatencyMs).toBeCloseTo(50.666_666, 5);
    expect(adminDetail?.erpAttemptSummary.p95LatencyMs).toBeCloseTo(94.2, 3);

    await db
      .update(demoRunSummaries)
      .set({
        loadRunDiagnosticsSummary: {
          ...runHistoryDiagnosticsFixture(),
          accountingWarnings: ["accepted_response_accounting_incomplete"],
        },
      })
      .where(eq(demoRunSummaries.id, ids.newerSummary));
    const annotatedAdminDetail = await service.adminDetail(ids.newerRun);
    expect(annotatedAdminDetail?.loadRunDiagnosticsSummary).toMatchObject({
      generatorCapacity: null,
      generatorUtilisation: null,
    });
    expect(annotatedAdminDetail?.loadRunDiagnosticsSummary).not.toHaveProperty(
      "accountingWarnings",
    );

    await db
      .update(demoRunSummaries)
      .set({ loadRunDiagnosticsSummary: { ...runHistoryDiagnosticsFixture(), nproc: 0 } })
      .where(eq(demoRunSummaries.id, ids.newerSummary));
    await expect(service.adminDetail(ids.newerRun)).rejects.toThrow(
      /loadRunDiagnosticsSummary\.nproc/,
    );

    await db
      .update(demoRunSummaries)
      .set({ loadRunDiagnosticsSummary: { failureReason: "failed_before_traffic_start" } })
      .where(eq(demoRunSummaries.id, ids.newerSummary));
    await expect(service.adminDetail(ids.newerRun)).resolves.toMatchObject({
      loadRunDiagnosticsSummary: null,
    });
  });

  it("returns explicit zero buckets and null ERP latency for empty live sets", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);

    const detail = await service.detail(ids.newerRun);

    expect(detail?.erpAttempts).toEqual({
      totalCount: 0,
      historyCoverage: "retained_history",
      attemptRetentionLimitPerOrder: 32,
      cumulativeOutcomeCounts: {
        capacityRejected: 0,
        temporarilyUnavailable: 0,
        uncertainResult: 0,
      },
      byStatus: { succeeded: 0, failed: 0, timedOut: 0 },
      averageLatencyMs: null,
      p95LatencyMs: null,
    });
    expect(detail).not.toHaveProperty("orders");
    expect(detail).not.toHaveProperty("notifications");
    expect(detail).not.toHaveProperty("events");
  });

  it("returns null for missing or non-summary-backed runs", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);
    await db.insert(demoRuns).values(
      runFixture({
        id: ids.noSummaryRun,
        presetName: "No Summary Run",
        status: "completed",
        failureReason: null,
        finalizedAt: new Date("2026-06-20T00:00:08.000Z"),
      }),
    );

    await expect(service.detail(ids.noSummaryRun)).resolves.toBeNull();
    await expect(service.detail("ffffffff-ffff-4fff-8fff-ffffffffffff")).resolves.toBeNull();
    await expect(service.adminDetail(ids.noSummaryRun)).resolves.toBeNull();
  });

  it("deletes selected summaries without deleting demo runs", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);

    const deletion = await service.delete({ runIds: [ids.olderRun] }, "corr-delete-selected");
    const history = await service.list({ page: 1, pageSize: 10 });
    const runs = await db
      .select({ id: demoRuns.id })
      .from(demoRuns)
      .where(inArray(demoRuns.id, [ids.olderRun, ids.newerRun]));

    expect(deletion).toEqual({
      deletedSummaryCount: 1,
      deletedAt: "2026-06-20T00:00:10.000Z",
      correlationId: "corr-delete-selected",
    });
    expect(history.totalCount).toBe(1);
    expect(history.summaries[0]?.runId).toBe(ids.newerRun);
    expect(runs.map((run) => run.id).sort()).toEqual([ids.newerRun, ids.olderRun].sort());
    await expect(service.detail(ids.olderRun)).resolves.toBeNull();
  });

  it("deletes all summaries only through the explicit delete-all command", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);

    const deletion = await service.delete({ deleteAllConfirmation: "DELETE" }, "corr-delete-all");
    const history = await service.list({ page: 1, pageSize: 10 });

    expect(deletion.deletedSummaryCount).toBe(2);
    expect(deletion.correlationId).toBe("corr-delete-all");
    expect(history.totalCount).toBe(0);
    expect(history.summaries).toEqual([]);
  });
});

function createService(
  connection: ReturnType<typeof createDatabaseConnection> | null,
): RunHistoryService {
  return new RunHistoryService({
    db: requireConnection(connection).db,
    now: () => new Date("2026-06-20T00:00:10.000Z"),
  });
}

async function seedHistory(db: ReturnType<typeof createDatabaseConnection>["db"]): Promise<void> {
  await db.insert(products).values({
    id: ids.product,
    sku: "HISTORY-TEST-SKU",
    slug: "history-test-product",
    name: "History Test Product",
    isActive: true,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await db.insert(saleOffers).values({
    id: ids.saleOffer,
    productId: ids.product,
    name: "History Test Sale Offer",
    allocatedStock: 5,
    saleStartsAt: new Date("2026-06-20T00:00:00.000Z"),
    saleEndsAt: new Date("2026-06-21T00:00:00.000Z"),
    isActive: true,
    purpose: "generated_run",
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await db.insert(demoPresets).values({
    id: ids.preset,
    slug: "history-preset",
    visibility: "public",
    isEditable: false,
    isCustom: false,
    display: {
      name: "History Preset",
      description: "Run history fixture.",
      sortOrder: 1,
      outcomeFocus: ["run_history"],
    },
    ...configSnapshotFixture(),
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await db.insert(demoRuns).values([
    runFixture({
      id: ids.olderRun,
      presetName: "History Completed",
      status: "completed",
      failureReason: null,
      finalizedAt: new Date("2026-06-20T00:00:05.000Z"),
    }),
    runFixture({
      id: ids.newerRun,
      presetName: "History Failed",
      status: "failed",
      failureReason: "traffic_delivery_major_shortfall",
      finalizedAt: new Date("2026-06-20T00:00:09.000Z"),
      saleOfferId: ids.saleOffer,
    }),
  ]);
  await db.insert(demoRunSummaries).values([
    summaryFixture({
      id: ids.olderSummary,
      runId: ids.olderRun,
      presetName: "History Completed",
      status: "completed",
      failureReason: null,
      capturedAt: new Date("2026-06-20T00:00:05.000Z"),
      startedRequests: 10,
      trafficDeliveryStatus: "complete",
    }),
    summaryFixture({
      id: ids.newerSummary,
      runId: ids.newerRun,
      presetName: "History Failed",
      status: "failed",
      failureReason: "traffic_delivery_major_shortfall",
      capturedAt: new Date("2026-06-20T00:00:09.000Z"),
      startedRequests: 5,
      trafficDeliveryStatus: "failed",
    }),
  ]);
  await db.insert(demoRunSaleContexts).values({
    runId: ids.newerRun,
    saleOfferId: ids.saleOffer,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
}

async function seedRunDetailRecords(
  db: ReturnType<typeof createDatabaseConnection>["db"],
): Promise<void> {
  await db.insert(reservations).values({
    id: ids.reservation,
    saleOfferId: ids.saleOffer,
    correlationId: "corr-history-detail",
    runId: ids.newerRun,
    quantity: 1,
    reservationToken: "reservation-token-private",
    expiresAt: new Date("2026-06-20T00:15:02.000Z"),
    securedAt: new Date("2026-06-20T00:00:02.000Z"),
    createdAt: new Date("2026-06-20T00:00:02.000Z"),
    updatedAt: new Date("2026-06-20T00:00:02.000Z"),
  });
  await db.insert(orders).values({
    id: ids.order,
    publicOrderId: "ord_history_1",
    saleOfferId: ids.saleOffer,
    reservationId: ids.reservation,
    correlationId: "corr-history-detail",
    runId: ids.newerRun,
    quantity: 1,
    status: "confirmed",
    queuedAt: new Date("2026-06-20T00:00:02.000Z"),
    processingAt: new Date("2026-06-20T00:00:03.000Z"),
    confirmedAt: new Date("2026-06-20T00:00:07.000Z"),
    createdAt: new Date("2026-06-20T00:00:02.000Z"),
    updatedAt: new Date("2026-06-20T00:00:07.000Z"),
  });
  await db.insert(erpAttempts).values({
    disposition: "succeeded",
    id: ids.erpAttempt,
    orderId: ids.order,
    deliveryId: "history-delivery-1",
    correlationId: "corr-history-detail",
    runId: ids.newerRun,
    attemptNumber: 3,
    status: "succeeded",
    terminal: true,
    httpStatus: 200,
    errorMessage: "private-upstream-response",
    latencyMs: 42,
    startedAt: new Date("2026-06-20T00:00:04.000Z"),
    finishedAt: new Date("2026-06-20T00:00:05.000Z"),
    createdAt: new Date("2026-06-20T00:00:05.000Z"),
  });
  await db.insert(simulatedNotifications).values({
    id: ids.notification,
    orderId: ids.order,
    saleOfferId: ids.saleOffer,
    correlationId: "corr-history-detail",
    runId: ids.newerRun,
    recipientPlaceholder: "private-recipient-placeholder",
    recordedAt: new Date("2026-06-20T00:00:08.000Z"),
    createdAt: new Date("2026-06-20T00:00:08.000Z"),
  });
  await db.insert(orderEvents).values([
    {
      id: ids.orderQueuedEvent,
      orderId: ids.order,
      reservationId: ids.reservation,
      saleOfferId: ids.saleOffer,
      correlationId: "corr-history-detail",
      runId: ids.newerRun,
      eventName: "order.queued",
      payload: {
        reservationToken: "reservation-token-private",
        idempotencyKey: "idempotency-key-private",
        privateHeaders: { "raw-private-header": "secret" },
        "x-control-service-token": "private-control-token",
      },
      source: "api",
      occurredAt: new Date("2026-06-20T00:00:02.000Z"),
      createdAt: new Date("2026-06-20T00:00:02.000Z"),
    },
    {
      id: ids.orderConfirmedEvent,
      orderId: ids.order,
      reservationId: ids.reservation,
      saleOfferId: ids.saleOffer,
      correlationId: "corr-history-detail",
      runId: ids.newerRun,
      eventName: "order.confirmed",
      payload: {
        rawPrivatePayload: true,
      },
      source: "worker",
      occurredAt: new Date("2026-06-20T00:00:07.000Z"),
      createdAt: new Date("2026-06-20T00:00:07.000Z"),
    },
  ]);
}

function runFixture(input: {
  id: string;
  presetName: string;
  status: "completed" | "failed";
  failureReason: string | null;
  finalizedAt: Date;
  saleOfferId?: string;
}): typeof demoRuns.$inferInsert {
  return {
    id: input.id,
    correlationId: "corr-history-test",
    presetId: ids.preset,
    presetName: input.presetName,
    operatorMode: "public",
    status: input.status,
    trafficStatus: input.status === "completed" ? "succeeded" : "failed",
    configSnapshot: configSnapshotFixture(),
    ...(input.saleOfferId ? { saleOfferId: input.saleOfferId } : {}),
    startedAt: new Date("2026-06-20T00:00:00.000Z"),
    trafficStartedAt: new Date("2026-06-20T00:00:01.000Z"),
    trafficEndedAt: new Date("2026-06-20T00:00:04.000Z"),
    finalizedAt: input.finalizedAt,
    failureReason: input.failureReason,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: input.finalizedAt,
  };
}

function summaryFixture(input: {
  id: string;
  runId: string;
  presetName: string;
  status: "completed" | "failed";
  failureReason: string | null;
  capturedAt: Date;
  startedRequests: number;
  trafficDeliveryStatus: "complete" | "failed";
}): typeof demoRunSummaries.$inferInsert {
  return {
    id: input.id,
    runId: input.runId,
    presetName: input.presetName,
    status: input.status,
    failureReason: input.failureReason,
    replayPossible: false,
    startedAt: new Date("2026-06-20T00:00:00.000Z"),
    endedAt: input.capturedAt,
    transportAttemptCounts: {
      plannedRequests: 10,
      startedRequests: input.startedRequests,
      completedRequests: input.startedRequests,
      interruptedRequests: 0,
      unstartedRequests: 10 - input.startedRequests,
    },
    httpSummary: {
      failedRequests: 0,
      acceptedResponses: 3,
      soldOutResponses: 2,
      transportFailures: 0,
      unexpectedResponses: 0,
      p95LatencyMs: 42,
      failureRate: 0,
    },
    trafficDeliverySummary: trafficDeliverySummarySchema.parse({
      trafficMode: null,
      plannedBuyers: null,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 10 - input.startedRequests,
      completedIterations: null,
      requestArrivalSummary: emptyRequestArrivalSummary,
      trafficDeliveryStatus: input.trafficDeliveryStatus,
      notes: input.trafficDeliveryStatus === "failed" ? ["private-delivery-diagnostic-marker"] : [],
    }),
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    loadRunDiagnosticsSummary: runHistoryDiagnosticsFixture(),
    businessOutcomeSummary: {
      acceptedReservations: 3,
      reservedUnits: 3,
      soldOutRejections: 2,
      queuedOrders: 0,
      processingOrders: 0,
      retryingOrders: 0,
      confirmedOrders: 2,
      failedOrders: 1,
      pendingPersistenceCount: 0,
      notificationsRecorded: 2,
    },
    terminalInventorySnapshot: {
      saleOfferId: ids.saleOffer,
      startingStock: 5,
      remainingStock: 0,
      reservedStock: 5,
      acceptedReservations: 3,
      soldOutRejections: 2,
      pendingPersistenceCount: 0,
      capturedAt: input.capturedAt.toISOString(),
      source: "redis",
    },
    capturedAt: input.capturedAt,
    createdAt: input.capturedAt,
  };
}

function runHistoryDiagnosticsFixture() {
  return {
    startedAt: "2026-06-20T00:00:00.000Z",
    completedAt: "2026-06-20T00:00:10.000Z",
    nproc: 8,
    ulimitNofile: 1_048_576,
    processMaxOpenFiles: { soft: 1_048_576, hard: 1_048_576 },
    generatorCapacity: null,
    generatorUtilisation: null,
    networkDiagnostics: null,
    k6Version: "k6 v1.0.0",
    executionPlan: {
      trafficMode: "buyer-spike" as const,
      buyerCount: 10,
      duplicateEachBuyerAttempt: false,
      iterationsPerVu: 1,
      plannedEmittedAttempts: 10,
      startDelaySeconds: 0,
      maxDurationSeconds: 1,
    },
    stderrLines: [],
    stderrLineCountObserved: 0,
    stderrLineCountRetained: 0,
    stderrRetainedLineLimit: 50 as const,
    stderrLineTruncationLength: 500 as const,
    stderrLineTruncatedCount: 0,
    terminalMetricSources: {
      startedRequests: "summary_export" as const,
      completedRequests: "summary_export" as const,
      acceptedResponses: "summary_export" as const,
      soldOutResponses: "summary_export" as const,
      transportFailures: "summary_export" as const,
      unexpectedResponses: "summary_export" as const,
      droppedIterations: "summary_export" as const,
      completedIterations: "summary_export" as const,
    },
    summaryExportWarnings: [],
  };
}

function completeRunHistoryDiagnosticsFixture() {
  return {
    ...runHistoryDiagnosticsFixture(),
    generatorCapacity: {
      memTotalBytes: 1,
      memAvailableBytes: 1,
      swapTotalBytes: 0,
      cgroupMemoryLimitBytes: null,
      cgroupMemoryLimitUnlimited: true,
      cgroupCpuQuota: null,
      cgroupCpuQuotaUnlimited: true,
    },
    generatorUtilisation: {
      peakK6RssBytes: 1,
      peakCgroupMemoryBytes: 1,
      minimumHostMemAvailableBytes: 1,
      peakCpuUtilisationPercent: 1,
      meanCpuUtilisationPercent: 1,
      peakCgroupSwapBytes: 0,
      finalMemoryEventsHighCount: 0,
      finalMemoryEventsMaxCount: 0,
      finalMemoryEventsOomKillCount: 0,
      sampleCount: 1,
      effectiveIntervalMs: 1,
    },
    networkDiagnostics: {
      ipLocalPortRange: "1 65535",
      tcpTwReuse: 1,
      tcpTimestamps: 1,
    },
  };
}

function runSignalTimelineFixture() {
  const elapsed = Array.from({ length: runSignalBucketCount }, (_, index) => index + 1);
  return {
    window: {
      anchoredAt: "2026-06-20T00:00:01.000Z",
      endedAt: "2026-06-20T00:02:01.000Z",
      bucketCount: runSignalBucketCount,
      bucketWidthSeconds: 1,
    },
    inventoryDrain: {
      startingStock: 5,
      remainingStock: 0,
      depletedAt: "2026-06-20T00:00:05.000Z",
      timeToDepletionSeconds: 4,
      remainingStockSeries: elapsed.map((elapsedSeconds) => ({
        elapsedSeconds,
        remainingStock: Math.max(0, 5 - elapsedSeconds),
      })),
    },
    queueBacklog: {
      peakBacklog: 3,
      peakAtElapsedSeconds: 2,
      backlogDrainedAt: "2026-06-20T00:00:06.000Z",
      drainDurationSeconds: 4,
      drainDurationBoundary: "first_order_queued_to_final_backlog_zero" as const,
      definition: "accepted_awaiting_first_processing_start" as const,
      backlogSeries: elapsed.map((elapsedSeconds) => ({
        elapsedSeconds,
        backlog: elapsedSeconds <= 3 ? elapsedSeconds : 0,
      })),
    },
    confirmationConvergence: {
      confirmedOrderCount: 2,
      failedOrderCount: 1,
      pendingAtCaptureCount: 0,
      averageLagMs: 2_000,
      p95LagMs: 3_000,
      maxLagMs: 3_000,
      boundary: "reservation_secured_to_order_confirmed" as const,
      convergenceSeries: elapsed.map((elapsedSeconds) => ({
        elapsedSeconds,
        cumulativeConfirmedOrderCount: Math.min(2, elapsedSeconds),
        cumulativeSettledOrderCount: Math.min(3, elapsedSeconds),
      })),
    },
    convergenceDurationSeconds: 5,
  };
}

function configSnapshotFixture() {
  return {
    trafficConfig: {
      mode: "buyer-spike" as const,
      buyerCount: 10,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 1,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 5,
    },
    erpConfig: {
      latencyMs: 10,
      maxTps: 10,
      errorRate: 0,
      forcedOutage: false,
    },
    backpressureConfig: {
      queueName: "orders:process" as const,
      physicalQueueName: "orders-process" as const,
      orderProcessConcurrency: 2,
    },
  };
}

function requireConnection(
  connection: ReturnType<typeof createDatabaseConnection> | null,
): ReturnType<typeof createDatabaseConnection> {
  if (!connection) {
    throw new Error("Expected a test database connection.");
  }

  return connection;
}
