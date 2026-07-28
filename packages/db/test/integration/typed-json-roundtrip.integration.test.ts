import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AcceptedRunConfigSnapshot,
  type BusinessOutcomeSummary,
  emptyHttpTimingBreakdownSummary,
  type HttpTimingBreakdownSummary,
  publicRuntimePolicyPersistedSchema,
  type RealLoadRunDiagnosticsSummary,
  type TerminalInventorySnapshot,
  type TrafficDeliverySummary,
  type TrafficHttpSummary,
  type TransportAttemptCounts,
} from "@checkout-surge/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseConnection } from "../../src/client.js";
import {
  demoPresets,
  demoRunFinalizations,
  demoRunSummaries,
  demoRuns,
  publicRuntimePolicies,
} from "../../src/schema.js";
import { resetTestDatabase } from "../../src/testing.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const databaseUrl = process.env.TEST_DATABASE_URL;

const ids = {
  preset: "57575757-0000-4000-8000-000000000001",
  run: "57575757-0000-4000-8000-000000000002",
} as const;
const capturedAt = new Date("2026-07-15T12:00:00.000Z");

describe.skipIf(!databaseUrl)("contract-typed persisted JSON", () => {
  let connection: ReturnType<typeof createDatabaseConnection>;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error("TEST_DATABASE_URL is required for typed JSON integration tests.");
    }

    await resetTestDatabase({ databaseUrl, migrationsFolder });
    connection = createDatabaseConnection(databaseUrl, { max: 1 });
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("round-trips preset, run, finalization, summary, inventory, and policy JSON without shape loss", async () => {
    const configSnapshot = configSnapshotFixture();
    const httpSummary = httpSummaryFixture();
    const transportAttemptCounts: TransportAttemptCounts = {
      plannedRequests: 10,
      startedRequests: 10,
      completedRequests: 10,
      interruptedRequests: 0,
      unstartedRequests: 0,
    };
    const trafficDeliverySummary = trafficDeliverySummaryFixture();
    const businessOutcomeSummary = businessOutcomeSummaryFixture();
    const terminalInventorySnapshot = terminalInventorySnapshotFixture();
    const trafficOutcomeSummary = { terminalInventorySnapshot, producer: "roundtrip-test" };
    const httpTimingBreakdownSummary: HttpTimingBreakdownSummary = emptyHttpTimingBreakdownSummary;
    const loadRunDiagnosticsSummary: RealLoadRunDiagnosticsSummary = {
      startedAt: capturedAt.toISOString(),
      completedAt: capturedAt.toISOString(),
      nproc: null,
      ulimitNofile: null,
      processMaxOpenFiles: null,
      generatorCapacity: {
        memTotalBytes: 8_589_934_592,
        memAvailableBytes: 6_442_450_944,
        swapTotalBytes: 0,
        cgroupMemoryLimitBytes: null,
        cgroupMemoryLimitUnlimited: true,
        cgroupCpuQuota: 1.5,
        cgroupCpuQuotaUnlimited: false,
      },
      generatorUtilisation: {
        peakK6RssBytes: 268_435_456,
        peakCgroupMemoryBytes: 536_870_912,
        minimumHostMemAvailableBytes: 4_294_967_296,
        peakCpuUtilisationPercent: 98.5,
        meanCpuUtilisationPercent: 74.25,
        peakCgroupSwapBytes: 0,
        finalMemoryEventsHighCount: 0,
        finalMemoryEventsMaxCount: 0,
        finalMemoryEventsOomKillCount: 0,
        sampleCount: 10,
        effectiveIntervalMs: 1_000,
      },
      networkDiagnostics: null,
      k6Version: "k6 v1.0.0",
      executionPlan: {
        trafficMode: "buyer-spike",
        buyerCount: 10,
        duplicateEachBuyerAttempt: false,
        iterationsPerVu: 1,
        plannedEmittedAttempts: 10,
        startDelaySeconds: 0,
        maxDurationSeconds: 10,
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
        transportFailures: "summary_export" as const,
        unexpectedResponses: "summary_export",
        droppedIterations: "summary_export",
        completedIterations: "summary_export",
      },
      summaryExportWarnings: [],
    };
    const policy = publicRuntimePolicyPersistedSchema.parse({
      isPublicRunBudgetEnforced: true,
      publicRunBudget: {
        windowSeconds: 300,
        perVisitorMaxStarts: 2,
        globalMaxStarts: 6,
      },
      publicCustomDefaults: configSnapshot,
      publicCustomLimits: {
        maxTotalRequests: 10_000,
        maxBuyers: 10_000,
        maxRequestsPerSecond: 1_000,
        maxTrafficDurationSeconds: 120,
        maxTrafficStartDelaySeconds: 10,
        maxPreAllocatedVus: 1_000,
        maxVus: 1_000,
        maxStartingStock: 1_000,
        maxErpLatencyMs: 2_000,
        minErpMaxTps: 1,
        maxErpMaxTps: 100,
        maxErpErrorRate: 0.25,
        allowForcedOutage: false,
        allowedTrafficModes: ["buyer-spike", "constant-arrival-rate"],
      },
    });

    await connection.db.insert(demoPresets).values({
      id: ids.preset,
      slug: "typed-json-roundtrip",
      visibility: "admin",
      isEditable: true,
      display: {
        name: "Typed JSON round-trip",
        description: "Verifies contract-shaped PostgreSQL JSON.",
        sortOrder: 57,
        outcomeFocus: ["run_history", "typed_json"],
      },
      ...configSnapshot,
    });
    await connection.db.insert(demoRuns).values({
      id: ids.run,
      presetId: ids.preset,
      presetName: "Typed JSON round-trip",
      operatorMode: "admin",
      status: "completed",
      trafficStatus: "succeeded",
      configSnapshot,
      startedAt: capturedAt,
      trafficStartedAt: capturedAt,
      trafficEndedAt: capturedAt,
      finalizedAt: capturedAt,
    });
    await connection.db.insert(demoRunFinalizations).values({
      runId: ids.run,
      exitCode: 0,
      transportAttemptCounts,
      httpSummary,
      trafficOutcomeSummary,
      trafficDeliverySummary,
      httpTimingBreakdownSummary,
      loadRunDiagnosticsSummary,
      trafficSummaryReceivedAt: capturedAt,
    });
    await connection.db.insert(demoRunSummaries).values({
      runId: ids.run,
      presetName: "Typed JSON round-trip",
      status: "completed",
      startedAt: capturedAt,
      endedAt: capturedAt,
      transportAttemptCounts,
      httpSummary,
      trafficDeliverySummary,
      httpTimingBreakdownSummary,
      loadRunDiagnosticsSummary,
      businessOutcomeSummary,
      terminalInventorySnapshot,
      capturedAt,
    });
    await connection.db.insert(publicRuntimePolicies).values({ id: "active", policy });

    const [preset] = await connection.db.select().from(demoPresets);
    const [run] = await connection.db.select().from(demoRuns);
    const [finalization] = await connection.db.select().from(demoRunFinalizations);
    const [summary] = await connection.db.select().from(demoRunSummaries);
    const [policyRow] = await connection.db.select().from(publicRuntimePolicies);

    expect(preset).toMatchObject({
      display: {
        name: "Typed JSON round-trip",
        outcomeFocus: ["run_history", "typed_json"],
      },
      ...configSnapshot,
    });
    expect(run?.configSnapshot).toEqual(configSnapshot);
    expect(finalization?.transportAttemptCounts).toEqual(transportAttemptCounts);
    expect(finalization?.httpSummary).toEqual(httpSummary);
    expect(finalization?.trafficOutcomeSummary).toEqual(trafficOutcomeSummary);
    expect(finalization?.trafficDeliverySummary).toEqual(trafficDeliverySummary);
    expect(finalization?.httpTimingBreakdownSummary).toEqual(httpTimingBreakdownSummary);
    expect(finalization?.loadRunDiagnosticsSummary).toEqual(loadRunDiagnosticsSummary);
    expect(summary?.transportAttemptCounts).toEqual(transportAttemptCounts);
    expect(summary?.httpSummary).toEqual(httpSummary);
    expect(summary?.trafficDeliverySummary).toEqual(trafficDeliverySummary);
    expect(summary?.httpTimingBreakdownSummary).toEqual(httpTimingBreakdownSummary);
    expect(summary?.loadRunDiagnosticsSummary).toEqual(loadRunDiagnosticsSummary);
    expect(summary?.businessOutcomeSummary).toEqual(businessOutcomeSummary);
    expect(summary?.terminalInventorySnapshot).toEqual(terminalInventorySnapshot);
    expect(policyRow?.policy).toEqual(policy);
    expect(policyRow?.policy).not.toHaveProperty("deploymentHardCaps");
  });
});

function configSnapshotFixture(): AcceptedRunConfigSnapshot {
  return {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 10,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 10,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 10,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 25,
      maxTps: 100,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 2_000,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 5,
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
    },
  };
}

function httpSummaryFixture(): TrafficHttpSummary {
  return {
    failedRequests: 0,
    acceptedResponses: 7,
    soldOutResponses: 3,
    transportFailures: 0,
    unexpectedResponses: 0,
    p95LatencyMs: 42,
    failureRate: 0,
  };
}

function trafficDeliverySummaryFixture(): TrafficDeliverySummary {
  return {
    trafficMode: "buyer-spike",
    plannedBuyers: 10,
    scheduledRatePerSecond: null,
    configuredDurationSeconds: null,
    preAllocatedVUs: null,
    maxVUs: null,
    droppedIterations: 0,
    completedIterations: 10,
    notes: ["Typed JSON round-trip evidence."],
    trafficDeliveryStatus: "complete",
  };
}

function businessOutcomeSummaryFixture(): BusinessOutcomeSummary {
  return {
    acceptedReservations: 7,
    soldOutRejections: 3,
    queuedOrders: 0,
    processingOrders: 0,
    retryingOrders: 0,
    confirmedOrders: 7,
    failedOrders: 0,
    pendingPersistenceCount: 0,
    notificationsRecorded: 7,
  };
}

function terminalInventorySnapshotFixture(): TerminalInventorySnapshot {
  return {
    saleOfferId: "57575757-0000-4000-8000-000000000003",
    startingStock: 10,
    remainingStock: 3,
    reservedStock: 7,
    acceptedReservations: 7,
    soldOutRejections: 3,
    pendingPersistenceCount: 0,
    capturedAt: capturedAt.toISOString(),
    source: "redis",
  };
}
