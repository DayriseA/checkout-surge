import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RunHistoryService } from "../src/services/run-history-service.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPackageRoot = path.resolve(packageRoot, "../../packages/db");
const migrationsFolder = path.join(dbPackageRoot, "drizzle");

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

    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
  });

  afterAll(async () => {
    await connection?.close();
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
      id: ids.newerSummary,
      runId: ids.newerRun,
      presetName: "History Failed",
      status: "failed",
      failureReason: "traffic_delivery_major_shortfall",
      httpSummary: {
        plannedRequests: 10,
        emittedRequests: 5,
      },
      trafficDeliverySummary: {
        trafficDeliveryStatus: "failed",
      },
      businessOutcomeSummary: {
        acceptedReservations: 3,
        soldOutRejections: 2,
      },
      terminalInventorySnapshot: {
        saleOfferId: ids.saleOffer,
        source: "redis",
      },
    });
    expect(firstPage.summaries[0]).not.toHaveProperty("reservationToken");
    expect(firstPage.summaries[0]).not.toHaveProperty("idempotencyKey");
    expect(secondPage.summaries[0]?.runId).toBe(ids.olderRun);
  });

  it("returns public-safe detail for a summary-backed terminal run", async () => {
    const db = requireConnection(connection).db;
    const service = createService(connection);
    await seedHistory(db);
    await seedRunDetailRecords(db);

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
        saleOfferId: ids.saleOffer,
      },
      orders: {
        totalCount: 1,
        truncated: false,
        records: [
          {
            orderId: ids.order,
            publicOrderId: "ord_history_1",
            status: "confirmed",
          },
        ],
      },
      erpAttempts: {
        totalCount: 1,
        records: [
          {
            attemptId: ids.erpAttempt,
            publicOrderId: "ord_history_1",
            status: "succeeded",
            httpStatus: 200,
          },
        ],
      },
      notifications: {
        totalCount: 1,
        records: [
          {
            notificationId: ids.notification,
            publicOrderId: "ord_history_1",
            channel: "email",
          },
        ],
      },
      eventTimeline: {
        totalCount: 2,
      },
    });
    expect(detail?.eventTimeline.records.map((event) => event.eventName)).toEqual([
      "order.confirmed",
      "order.queued",
    ]);

    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("reservation-token-private");
    expect(serialized).not.toContain("idempotency-key-private");
    expect(serialized).not.toContain("raw-private-header");
    expect(serialized).not.toContain("private-upstream-response");
    expect(serialized).not.toContain("private-recipient-placeholder");
    expect(serialized).not.toContain("x-control-service-token");
    expect(serialized).not.toContain("payload");
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

    const deletion = await service.delete(
      { deleteAllConfirmation: "DELETE_ALL_RUN_SUMMARIES" },
      "corr-delete-all",
    );
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
      emittedRequests: 10,
      trafficDeliveryStatus: "complete",
    }),
    summaryFixture({
      id: ids.newerSummary,
      runId: ids.newerRun,
      presetName: "History Failed",
      status: "failed",
      failureReason: "traffic_delivery_major_shortfall",
      capturedAt: new Date("2026-06-20T00:00:09.000Z"),
      emittedRequests: 5,
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
    status: "secured",
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
    id: ids.erpAttempt,
    orderId: ids.order,
    correlationId: "corr-history-detail",
    runId: ids.newerRun,
    attemptNumber: 1,
    status: "succeeded",
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
    channel: "email",
    recipientPlaceholder: "private-recipient-placeholder",
    status: "recorded",
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
  emittedRequests: number;
  trafficDeliveryStatus: "complete" | "failed";
}): typeof demoRunSummaries.$inferInsert {
  return {
    id: input.id,
    runId: input.runId,
    presetName: input.presetName,
    status: input.status,
    failureReason: input.failureReason,
    startedAt: new Date("2026-06-20T00:00:00.000Z"),
    endedAt: input.capturedAt,
    httpSummary: {
      plannedRequests: 10,
      emittedRequests: input.emittedRequests,
      completedRequests: input.emittedRequests,
      failedRequests: 0,
      acceptedResponses: 3,
      soldOutResponses: 2,
      unexpectedResponses: 0,
      p95LatencyMs: 42,
      failureRate: 0,
    },
    trafficDeliverySummary: {
      plannedRequests: 10,
      emittedRequests: input.emittedRequests,
      droppedIterations: 10 - input.emittedRequests,
      trafficDeliveryStatus: input.trafficDeliveryStatus,
      notes: input.trafficDeliveryStatus === "failed" ? ["Major delivery shortfall."] : [],
    },
    httpTimingBreakdownSummary: {},
    loadRunDiagnosticsSummary: {},
    apiRequestLifecycleSummary: {},
    businessOutcomeSummary: {
      acceptedReservations: 3,
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
      queueName: "orders:process" as const,
      physicalQueueName: "orders-process" as const,
      orderProcessConcurrency: 2,
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
    },
  };
}

function requireTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for Run History service tests.");
  }

  return databaseUrl;
}

function requireConnection(
  connection: ReturnType<typeof createDatabaseConnection> | null,
): ReturnType<typeof createDatabaseConnection> {
  if (!connection) {
    throw new Error("Expected a test database connection.");
  }

  return connection;
}
