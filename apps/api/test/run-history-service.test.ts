import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDatabaseConnection,
  demoPresets,
  demoRunSummaries,
  demoRuns,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RunHistoryService } from "../src/services/run-history-service.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPackageRoot = path.resolve(packageRoot, "../../packages/db");
const migrationsFolder = path.join(dbPackageRoot, "drizzle");

const ids = {
  preset: "33333333-3333-4333-8333-333333333331",
  olderRun: "55555555-5555-4555-8555-555555555551",
  newerRun: "55555555-5555-4555-8555-555555555552",
  olderSummary: "77777777-7777-4777-8777-777777777771",
  newerSummary: "77777777-7777-4777-8777-777777777772",
  saleOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
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
}

function runFixture(input: {
  id: string;
  presetName: string;
  status: "completed" | "failed";
  failureReason: string | null;
  finalizedAt: Date;
}): typeof demoRuns.$inferInsert {
  return {
    id: input.id,
    presetId: ids.preset,
    presetName: input.presetName,
    operatorMode: "public",
    status: input.status,
    trafficStatus: input.status === "completed" ? "succeeded" : "failed",
    configSnapshot: configSnapshotFixture(),
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
