import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AcceptedOrderSummary,
  type AcceptedReservationSummary,
  adminDeleteRunHistoryResponseSchema,
  adminDemoResetPath,
  adminMaintenanceCleanupRunsPath,
  adminPresetCopyToCustomPath,
  adminPresetDuplicatePath,
  adminPresetListPath,
  adminPresetSavePath,
  adminPublicRuntimePolicyPath,
  adminPublicRuntimePolicyResponseSchema,
  type BusinessOutcomeSummary,
  buyResponseSchema,
  controlServiceTokenHeaderName,
  type DashboardEvent,
  type DemoRunSnapshot,
  dashboardEventsPath,
  dashboardRecoveryResponseSchema,
  demoRunOperatorModeHeaderName,
  type ErpResilienceStatus,
  erpResilienceStatusPath,
  erpResilienceStatusSchema,
  errorPayloadSchema,
  healthResponseSchema,
  inventoryStatusSchema,
  livenessResponseSchema,
  loadRunIdHeaderName,
  type OrderProcessJob,
  orderProcessBullMqQueueName,
  orderProcessJobName,
  publicPresetListPath,
  publicPresetListResponseSchema,
  publicRuntimePolicyPath,
  publicRuntimePolicyResponseSchema,
  publicVisitorIdHeaderName,
  type QueueStatus,
  queueStatusSchema,
  type RunHistoryDetailResponse,
  type RunHistoryListResponse,
  runHistoryDetailPath,
  runHistoryDetailResponseSchema,
  runHistoryListResponseSchema,
  runHistoryPath,
  startDemoRunPath,
  startDemoRunResponseSchema,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeRedis,
  createDatabaseConnection,
  createRedisClient,
  demoPresets,
  demoRunSaleContexts,
  demoRuns,
  getInventoryStatus,
  InventoryNotInitializedError,
  initializeInventory,
  inventoryKeys,
  markReservationPendingPersistence,
  orderEvents,
  orders,
  products,
  promoteReservationIdempotencyToAccepted,
  readBusinessOutcomeSummary,
  reservationPendingPersistence,
  reservations,
  reserveInventoryStock,
  saleOffers,
  setRunSaleEligibility,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
import { Queue, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBullMqOrderProcessJobPublisher } from "../src/queue/bullmq-order-process-job-publisher.js";
import {
  createBullMqOrderProcessQueueInspector,
  createOrderProcessQueueInspector,
} from "../src/queue/bullmq-order-process-queue-inspector.js";
import { DashboardEventFanout } from "../src/realtime/dashboard-event-fanout.js";
import { loadApiConfig } from "../src/runtime/config.js";
import type { ApiFastifyInstance } from "../src/runtime/fastify.js";
import { createInfrastructureReadinessCheck } from "../src/runtime/readiness.js";
import { buildApiServer } from "../src/server.js";
import type { DashboardRecoveryAdmissionController } from "../src/services/dashboard-recovery-admission.js";
import {
  type DashboardRecoveryContextReader,
  DashboardRecoveryService,
} from "../src/services/dashboard-recovery-service.js";
import type { DemoMaintenanceService } from "../src/services/demo-maintenance-service.js";
import type { DemoRunController } from "../src/services/demo-run-service.js";
import type { ErpStatusService } from "../src/services/erp-status-service.js";
import {
  type InventoryStatusReader,
  InventoryStatusService,
} from "../src/services/inventory-status-service.js";
import type { OrderProcessJobPublisher } from "../src/services/order-process-job-publisher.js";
import { PendingPersistenceReconciler } from "../src/services/pending-persistence-reconciler.js";
import { PostgresBuyPersistence } from "../src/services/postgres-buy-persistence.js";
import {
  type OrderProcessQueueInspector,
  QueueStatusService,
} from "../src/services/queue-status-service.js";
import {
  type BuyPersistence,
  type PersistedBuyAcceptance,
  type ReservationPartialFailureReport,
  ReserveOrderService,
  type StockReservationGateway,
} from "../src/services/reserve-order-service.js";
import type { RunHistoryController } from "../src/services/run-history-service.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPackageRoot = path.resolve(packageRoot, "../../packages/db");
const migrationsFolder = path.join(dbPackageRoot, "drizzle");

const fixtureIds = {
  product: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  saleOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  run: "55555555-5555-4555-8555-555555555555",
} as const;
const fixtureCorrelationId = "corr-api-test";

function requireTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for API tests.");
  }

  return databaseUrl;
}

function baseConfig() {
  return loadApiConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost/test",
    REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6380",
    CONTROL_SERVICE_TOKEN: "test-control-token",
    PUBLIC_CLIENT_COOKIE_SECRET: "test-public-cookie-secret",
    LOG_LEVEL: "silent",
  });
}

function queueStatusFixture(): QueueStatus {
  return {
    name: "orders:process",
    connectivity: "reachable",
    depth: 10,
    counts: { waiting: 4, prioritized: 1, paused: 3, delayed: 2, active: 3, failed: 2 },
    oldestWaitingAgeSeconds: 12.5,
    retryPressure: {
      inspectedJobCount: 10,
      inspectionLimit: 100,
      retryingJobCount: 2,
      retryAttemptCount: 3,
      inspectionTruncated: false,
    },
    failedJobs: {
      totalCount: 2,
      recent: [
        {
          jobId: "failed-order-1",
          jobName: "order.process",
          attemptsMade: 2,
          failedReason: "Confirmation failed.",
          failedAt: "2026-06-20T00:00:09.000Z",
        },
      ],
      inspectionLimit: 20,
      inspectionTruncated: false,
    },
    updatedAt: "2026-06-20T00:00:10.000Z",
  };
}

async function buildTestServer(options: {
  persistence: BuyPersistence;
  stockReservations?: StockReservationGateway;
  inventoryReader?: InventoryStatusReader | null;
  readiness?: "ok" | "unavailable";
  generateId?: () => string;
  orderProcessJobPublisher?: OrderProcessJobPublisher;
  queueInspector?: OrderProcessQueueInspector;
  erpStatusService?: ErpStatusService;
  dashboardRecoveryService?: DashboardRecoveryService;
  dashboardRecoveryAdmission?: DashboardRecoveryAdmissionController;
  dashboardEventFanout?: DashboardEventFanout;
  demoRunService?: DemoRunController;
  demoMaintenanceService?: DemoMaintenanceService;
  runHistoryService?: RunHistoryController;
  reportPersistenceFailure?: (report: ReservationPartialFailureReport) => void;
}): Promise<ApiFastifyInstance> {
  const inventoryReader =
    options.inventoryReader === undefined
      ? {
          getStatus: async (saleOfferId: string) => ({
            saleOfferId,
            allocatedStock: 10,
            remainingStock: 7,
            reservedStock: 3,
            pendingPersistenceCount: 1,
            expiredReservationCount: 2,
            oldestPendingPersistenceAgeSeconds: 4.5,
            reservationThroughput: {
              windowSeconds: 60,
              successfulReservationCount: 6,
              rate: 0.1,
              unit: "reservations_per_second" as const,
              measuredAt: "2026-06-20T00:00:10.000Z",
            },
            soldOutPressure: {
              rejectionCount: 4,
              latestObservedAt: "2026-06-20T00:00:09.000Z",
            },
            lastUpdatedAt: "2026-06-20T00:00:00.000Z",
          }),
        }
      : options.inventoryReader;

  const logger = createSilentLogger("api");
  const queueStatusService = new QueueStatusService(
    options.queueInspector ?? { inspect: async () => queueStatusFixture() },
    logger,
  );
  const erpStatusService =
    options.erpStatusService ?? createStaticErpStatusService(erpStatusFixture());
  const inventoryStatusService = new InventoryStatusService(inventoryReader);

  return buildApiServer({
    config: baseConfig(),
    logger,
    readiness: {
      checks: async () => [
        {
          name: "database_reachable",
          status: options.readiness ?? "ok",
        },
        {
          name: "redis_url_configured",
          status: "ok",
        },
      ],
    },
    dashboardEventFanout: options.dashboardEventFanout ?? new DashboardEventFanout({ logger }),
    dashboardRecoveryService:
      options.dashboardRecoveryService ??
      new DashboardRecoveryService({
        contextReader: staticRecoveryContextReader(fixtureIds.saleOffer),
        businessOutcomeReader: { read: async () => businessOutcomeFixture() },
        consistencyLagReader: { read: async () => consistencyLagFixture() },
        completionOutcomeReader: { read: async () => [] },
        inventoryStatusService,
        queueStatusService,
        erpStatusService,
        logger,
        now: () => new Date("2026-06-20T00:00:10.000Z"),
      }),
    dashboardRecoveryAdmission: options.dashboardRecoveryAdmission ?? {
      admit: async () => ({ outcome: "admitted", release: () => undefined }),
    },
    erpStatusService,
    inventoryStatusService,
    queueStatusService,
    reserveOrderService: new ReserveOrderService({
      persistence: options.persistence,
      orderProcessJobPublisher: options.orderProcessJobPublisher ?? {
        enqueue: async () => undefined,
      },
      stockReservations: options.stockReservations ?? new AcceptingStockReservations(),
      reservationHoldMinutes: 15,
      idempotencyTtlSeconds: 1800,
      pendingPersistenceRetryAfterSeconds: 30,
      generateId: options.generateId ?? deterministicIdGenerator(),
      ...(options.reportPersistenceFailure
        ? { reportPersistenceFailure: options.reportPersistenceFailure }
        : {}),
    }),
    demoRunService: options.demoRunService ?? demoRunControllerFixture(),
    demoMaintenanceService:
      options.demoMaintenanceService ??
      ({
        reset: async (correlationId: string) => ({
          failedRunCount: 0,
          closedSaleOfferCount: 0,
          cleanedQueueCount: 0,
          cleanedJobCount: 0,
          resetAt: "2026-06-20T00:00:10.000Z",
          correlationId,
        }),
        cleanupOldRuns: async ({ correlationId }: { correlationId: string }) => ({
          deletedRunCount: 0,
          deletedSaleOfferCount: 0,
          preservedLatestCount: 0,
          preservedActiveRunCount: 0,
          cutoffBefore: "2026-06-13T00:00:10.000Z",
          cleanedAt: "2026-06-20T00:00:10.000Z",
          correlationId,
        }),
      } as never),
    runHistoryService: options.runHistoryService ?? runHistoryControllerFixture(),
    startedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
}

function staticRecoveryContextReader(saleOfferId: string): DashboardRecoveryContextReader {
  return {
    readContext: async () => ({
      currentRun: null,
      saleOfferId,
    }),
  };
}

function businessOutcomeFixture(): BusinessOutcomeSummary {
  return {
    acceptedReservations: 6,
    soldOutRejections: 4,
    queuedOrders: 2,
    processingOrders: 1,
    retryingOrders: 1,
    confirmedOrders: 2,
    failedOrders: 1,
    pendingPersistenceCount: 1,
    notificationsRecorded: 0,
  };
}

function consistencyLagFixture() {
  return {
    confirmedOrderCount: 2,
    pendingConfirmationCount: 1,
    averageLagMs: 225,
    p95LagMs: 350,
    maxLagMs: 375,
    oldestPendingAgeSeconds: 8.5,
    measuredAt: "2026-06-20T00:00:10.000Z",
  };
}

function demoRunSnapshotFixture(): DemoRunSnapshot {
  return {
    runId: fixtureIds.run,
    presetId: "33333333-3333-4333-8333-333333333331",
    presetName: "Preview 1k",
    operatorMode: "public",
    status: "active",
    trafficStatus: "active",
    saleOfferId: fixtureIds.saleOffer,
    configSnapshot: acceptedRunConfigSnapshotFixture(),
    startedAt: "2026-06-20T00:00:10.000Z",
    trafficStartedAt: "2026-06-20T00:00:10.000Z",
  };
}

function acceptedRunConfigSnapshotFixture() {
  return {
    trafficConfig: {
      mode: "buyer-spike" as const,
      buyerCount: 1000,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 2,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 250,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 80,
      maxTps: 250,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 2000,
    },
    backpressureConfig: {
      queueName: "orders:process" as const,
      physicalQueueName: "orders-process" as const,
      orderProcessConcurrency: 5,
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
    },
  };
}

function demoPresetFixture(slug: string) {
  return {
    id:
      slug === "custom"
        ? "44444444-4444-4444-8444-444444444443"
        : "55555555-5555-4555-8555-555555555555",
    slug,
    visibility: "admin" as const,
    isEditable: true,
    isCustom: slug === "custom",
    display: {
      name: slug === "custom" ? "Custom" : "Preview Copy",
      description: "Admin preset fixture.",
      sortOrder: 10,
      outcomeFocus: [],
    },
    ...acceptedRunConfigSnapshotFixture(),
    createdAt: "2026-06-20T00:00:10.000Z",
    updatedAt: "2026-06-20T00:00:10.000Z",
  };
}

function demoRunControllerFixture(): DemoRunController {
  return {
    listPublicPresets: async () => ({
      presets: [],
      timestamp: "2026-06-20T00:00:10.000Z",
    }),
    listAdminPresets: async () => ({
      presets: [],
      timestamp: "2026-06-20T00:00:10.000Z",
    }),
    saveAdminPreset: async () => ({
      preset: demoPresetFixture("custom"),
      timestamp: "2026-06-20T00:00:10.000Z",
    }),
    duplicatePreset: async () => ({
      preset: demoPresetFixture("preview-copy"),
      timestamp: "2026-06-20T00:00:10.000Z",
    }),
    copyPresetToCustom: async () => ({
      preset: demoPresetFixture("custom"),
      timestamp: "2026-06-20T00:00:10.000Z",
    }),
    getPublicRuntimePolicy: async () => ({
      id: "active",
      policy: publicRuntimePolicyFixture(),
      updatedAt: "2026-06-20T00:00:10.000Z",
    }),
    getAdminPublicRuntimePolicy: async (correlationId) => ({
      id: "active",
      policy: publicRuntimePolicyFixture(),
      updatedAt: "2026-06-20T00:00:10.000Z",
      correlationId,
      timestamp: "2026-06-20T00:00:10.000Z",
    }),
    updateAdminPublicRuntimePolicy: async (_request, correlationId) => ({
      id: "active",
      policy: publicRuntimePolicyFixture(),
      updatedAt: "2026-06-20T00:00:10.000Z",
      correlationId,
      timestamp: "2026-06-20T00:00:10.000Z",
    }),
    startRun: async (_request, correlationId) => ({
      run: demoRunSnapshotFixture(),
      recovery: { establishedAt: "2026-06-20T00:00:10.000Z" },
      correlationId,
      timestamp: "2026-06-20T00:00:10.000Z",
    }),
    ingestMetrics: async () => undefined,
    recordTrafficCompletion: async () => demoRunSnapshotFixture(),
  };
}

function runHistoryListResponseFixture(): RunHistoryListResponse {
  return {
    summaries: [
      {
        id: "77777777-7777-4777-8777-777777777777",
        runId: fixtureIds.run,
        presetName: "Preview 1k",
        status: "completed",
        startedAt: "2026-06-20T00:00:00.000Z",
        endedAt: "2026-06-20T00:00:10.000Z",
        httpSummary: {
          plannedRequests: 10,
          emittedRequests: 10,
          completedRequests: 10,
          failedRequests: 0,
          acceptedResponses: 6,
          soldOutResponses: 4,
          unexpectedResponses: 0,
          p95LatencyMs: 42,
          failureRate: 0,
        },
        trafficDeliverySummary: {
          plannedRequests: 10,
          emittedRequests: 10,
          droppedIterations: 0,
          trafficDeliveryStatus: "complete",
          notes: [],
        },
        businessOutcomeSummary: businessOutcomeFixture(),
        terminalInventorySnapshot: {
          saleOfferId: fixtureIds.saleOffer,
          startingStock: 10,
          remainingStock: 0,
          reservedStock: 10,
          acceptedReservations: 6,
          soldOutRejections: 4,
          pendingPersistenceCount: 0,
          capturedAt: "2026-06-20T00:00:10.000Z",
          source: "redis",
        },
        capturedAt: "2026-06-20T00:00:10.000Z",
      },
    ],
    page: 1,
    pageSize: 10,
    totalCount: 1,
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function runHistoryDetailResponseFixture(): RunHistoryDetailResponse {
  const summary = runHistoryListResponseFixture().summaries[0];
  if (!summary) {
    throw new Error("Expected run history summary fixture.");
  }

  return {
    summary,
    run: {
      ...demoRunSnapshotFixture(),
      status: "completed",
      trafficStatus: "succeeded",
      trafficEndedAt: "2026-06-20T00:00:10.000Z",
      finalizedAt: "2026-06-20T00:00:10.000Z",
    },
    orders: {
      totalCount: 1,
      limit: 20,
      truncated: false,
      records: [
        {
          orderId: "99999999-9999-4999-8999-999999999991",
          publicOrderId: "ord_history_1",
          saleOfferId: fixtureIds.saleOffer,
          correlationId: fixtureCorrelationId,
          quantity: 1,
          status: "confirmed",
          queuedAt: "2026-06-20T00:00:02.000Z",
          processingAt: "2026-06-20T00:00:03.000Z",
          confirmedAt: "2026-06-20T00:00:06.000Z",
        },
      ],
    },
    erpAttempts: {
      totalCount: 1,
      limit: 20,
      truncated: false,
      records: [
        {
          attemptId: "99999999-9999-4999-8999-999999999992",
          orderId: "99999999-9999-4999-8999-999999999991",
          publicOrderId: "ord_history_1",
          correlationId: fixtureCorrelationId,
          attemptNumber: 1,
          status: "succeeded",
          httpStatus: 200,
          latencyMs: 42,
          startedAt: "2026-06-20T00:00:04.000Z",
          finishedAt: "2026-06-20T00:00:05.000Z",
        },
      ],
    },
    notifications: {
      totalCount: 1,
      limit: 20,
      truncated: false,
      records: [
        {
          notificationId: "99999999-9999-4999-8999-999999999993",
          orderId: "99999999-9999-4999-8999-999999999991",
          publicOrderId: "ord_history_1",
          channel: "email",
          status: "recorded",
          recordedAt: "2026-06-20T00:00:07.000Z",
        },
      ],
    },
    eventTimeline: {
      totalCount: 1,
      limit: 20,
      truncated: false,
      records: [
        {
          eventId: "99999999-9999-4999-8999-999999999994",
          eventName: "order.confirmed",
          source: "worker",
          saleOfferId: fixtureIds.saleOffer,
          correlationId: fixtureCorrelationId,
          orderId: "99999999-9999-4999-8999-999999999991",
          publicOrderId: "ord_history_1",
          occurredAt: "2026-06-20T00:00:06.000Z",
        },
      ],
    },
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function runHistoryControllerFixture(): RunHistoryController {
  return {
    list: async (input) => ({
      ...runHistoryListResponseFixture(),
      page: input.page,
      pageSize: input.pageSize,
    }),
    detail: async (runId) => (runId === fixtureIds.run ? runHistoryDetailResponseFixture() : null),
    delete: async (_input, correlationId) => ({
      deletedSummaryCount: 1,
      deletedAt: "2026-06-20T00:00:10.000Z",
      correlationId,
    }),
  };
}

function publicRuntimePolicyFixture() {
  return {
    isPublicRunBudgetEnforced: true,
    publicRunBudget: {
      windowSeconds: 300,
      perVisitorMaxStarts: 2,
      globalMaxStarts: 6,
    },
    publicCustomDefaults: acceptedRunConfigSnapshotFixture(),
    publicCustomLimits: {
      maxTotalRequests: 10_000,
      maxBuyers: 10_000,
      maxRequestsPerSecond: 1000,
      maxTrafficDurationSeconds: 120,
      maxTrafficStartDelaySeconds: 10,
      maxPreAllocatedVus: 1000,
      maxVus: 1000,
      maxStartingStock: 1000,
      maxErpLatencyMs: 2000,
      minErpMaxTps: 1,
      maxErpMaxTps: 300,
      maxErpErrorRate: 0.25,
      allowForcedOutage: false,
      allowedTrafficModes: ["buyer-spike" as const, "steady-arrival-rate" as const],
    },
    deploymentHardCaps: {
      maxBuyers: 100_000,
      maxTotalRequests: 100_000,
      maxRequestsPerSecond: 10_000,
      maxTrafficDurationSeconds: 300,
      maxTrafficStartDelaySeconds: 30,
      maxPreAllocatedVus: 10_000,
      maxVus: 10_000,
    },
  };
}

function publicRuntimePolicyMutableFixture() {
  const policy = publicRuntimePolicyFixture();
  return {
    isPublicRunBudgetEnforced: policy.isPublicRunBudgetEnforced,
    publicRunBudget: {
      windowSeconds: 120,
      perVisitorMaxStarts: 1,
      globalMaxStarts: 3,
    },
    publicCustomDefaults: policy.publicCustomDefaults,
    publicCustomLimits: policy.publicCustomLimits,
  };
}

function erpStatusFixture(): ErpResilienceStatus {
  return {
    status: "healthy",
    reason: null,
    circuit: {
      state: "closed",
      consecutiveFailureCount: 0,
      failureThreshold: 5,
      resetTimeoutMs: 10_000,
      openedAt: null,
      nextAttemptAt: null,
      halfOpenProbeInFlight: false,
      updatedAt: "2026-06-20T00:00:10.000Z",
    },
    retryPressure: {
      retryingJobCount: 0,
      retryAttemptCount: 0,
      inspectedJobCount: 0,
      inspectionLimit: 100,
      inspectionTruncated: false,
    },
    latestAttempt: null,
    recentAttemptWindowSeconds: 60,
    recentAttemptCount: 0,
    recentFailureCount: 0,
    recentTimeoutCount: 0,
    confirmationDelay: {
      processingOrderCount: 0,
      oldestProcessingAgeSeconds: null,
      recentConfirmedCount: 0,
      averageConfirmationDelayMs: null,
    },
    updatedAt: "2026-06-20T00:00:10.000Z",
  };
}

function createStaticErpStatusService(status: ErpResilienceStatus): ErpStatusService {
  return { getStatus: async () => status } as unknown as ErpStatusService;
}

function createRedisStockReservations(redis: CheckoutSurgeRedis): StockReservationGateway {
  return {
    reserve: (input) => reserveInventoryStock(redis, input),
    markPendingPersistence: (input) => markReservationPendingPersistence(redis, input),
    promoteAccepted: (input) =>
      promoteReservationIdempotencyToAccepted(redis, input).then(() => undefined),
  };
}

async function waitForInsertRaceBarrier(barrier: Promise<void>): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      barrier,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for the insert-race barrier.")),
          2_000,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function readStreamUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expectedText: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let received = "";

  while (!received.includes(expectedText)) {
    let timeout: NodeJS.Timeout | null = null;
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${expectedText}.`)),
          1_000,
        );
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }

    if (result.done) {
      break;
    }

    received += decoder.decode(result.value, { stream: true });
  }

  return received;
}

class AcceptingPersistence implements BuyPersistence {
  private readonly persisted = new Map<string, PersistedBuyAcceptance>();

  async persistSecuredReservation(input: {
    reservation: import("@checkout-surge/contracts").SecuredReservationHold;
  }) {
    const hold = input.reservation;
    const reservation: AcceptedReservationSummary = {
      ...hold,
      status: "secured",
    };
    const order: AcceptedOrderSummary = {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      publicOrderId: "ord_test",
      saleOfferId: hold.saleOfferId,
      reservationId: reservation.id,
      correlationId: hold.correlationId,
      ...(hold.runId ? { runId: hold.runId } : {}),
      quantity: hold.quantity,
      status: "queued",
      queuedAt: hold.securedAt,
    };

    const result = { reservation, order };
    this.persisted.set(reservation.id, result);
    return result;
  }

  async getPersistedBuyByReservationId(reservationId: string) {
    return this.persisted.get(reservationId) ?? null;
  }
}

class AcceptingStockReservations implements StockReservationGateway {
  async reserve(input: Parameters<StockReservationGateway["reserve"]>[0]) {
    return { outcome: "reservation_secured" as const, reservation: input.reservation };
  }

  async markPendingPersistence(): Promise<void> {}

  async promoteAccepted(): Promise<void> {}
}

function deterministicIdGenerator(): () => string {
  const ids = ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"];
  const firstId = ids[0];
  if (!firstId) {
    throw new Error("A deterministic test ID is required.");
  }
  let index = 0;
  return () => ids[index++ % ids.length] ?? firstId;
}

describe("API gateway routes", () => {
  const servers: ApiFastifyInstance[] = [];

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  async function trackedServer(options: {
    persistence: BuyPersistence;
    stockReservations?: StockReservationGateway;
    inventoryReader?: InventoryStatusReader | null;
    readiness?: "ok" | "unavailable";
    generateId?: () => string;
    orderProcessJobPublisher?: OrderProcessJobPublisher;
    queueInspector?: OrderProcessQueueInspector;
    erpStatusService?: ErpStatusService;
    demoRunService?: DemoRunController;
    demoMaintenanceService?: DemoMaintenanceService;
    runHistoryService?: RunHistoryController;
  }) {
    const server = await buildTestServer(options);
    servers.push(server);
    return server;
  }

  it("returns contract-valid liveness and readiness responses", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const live = await server.inject({ method: "GET", url: "/health/live" });
    const ready = await server.inject({ method: "GET", url: "/health/ready" });

    expect(live.statusCode).toBe(200);
    expect(() => livenessResponseSchema.parse(live.json())).not.toThrow();
    expect(ready.statusCode).toBe(200);
    expect(() => healthResponseSchema.parse(ready.json())).not.toThrow();
  });

  it("returns unavailable readiness with HTTP 503 when a dependency check fails", async () => {
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      readiness: "unavailable",
    });

    const ready = await server.inject({ method: "GET", url: "/health/ready" });
    const payload = healthResponseSchema.parse(ready.json());

    expect(ready.statusCode).toBe(503);
    expect(payload.status).toBe("unavailable");
    expect(payload.checks).toContainEqual({
      name: "database_reachable",
      status: "unavailable",
    });
  });

  it("returns a contract-valid dashboard recovery projection", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const response = await server.inject({ method: "GET", url: "/dashboard/recovery" });
    const payload = dashboardRecoveryResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(payload.currentRun).toBeNull();
    expect(payload.inventory?.remainingStock).toBe(7);
    expect(payload.queue?.depth).toBe(10);
    expect(payload.erp?.status).toBe("healthy");
    expect(payload.businessOutcome).toEqual(businessOutcomeFixture());
    expect(payload.consistencyLag).toEqual(consistencyLagFixture());
    expect(payload.recentCompletionOutcomes).toEqual([]);
    expect(payload.recentMetrics).toEqual([]);
  });

  it("opens the dashboard realtime SSE stream with browser reconnect guidance", async () => {
    const dashboardEventFanout = new DashboardEventFanout({
      logger: createSilentLogger("api"),
      retryMs: 1234,
    });
    const server = await buildTestServer({
      persistence: new AcceptingPersistence(),
      dashboardEventFanout,
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${dashboardEventsPath}`);
    const reader = response.body?.getReader();

    try {
      if (!reader) {
        throw new Error("Expected a readable SSE body.");
      }

      const initialFrame = await readStreamUntil(reader, ": connected");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("cache-control")).toContain("no-cache");
      expect(initialFrame).toContain("retry: 1234");
      expect(initialFrame).toContain(": connected");
      expect(dashboardEventFanout.clientCount()).toBe(1);
    } finally {
      await reader?.cancel();
      dashboardEventFanout.close();
      await server.close();
    }
  });

  it("fans contract dashboard events to connected browser SSE clients", async () => {
    const dashboardEventFanout = new DashboardEventFanout({
      logger: createSilentLogger("api"),
      retryMs: 1234,
    });
    const server = await buildTestServer({
      persistence: new AcceptingPersistence(),
      dashboardEventFanout,
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${dashboardEventsPath}`);
    const reader = response.body?.getReader();
    const event: DashboardEvent = {
      type: "business.outcome.updated",
      eventId: "99999999-9999-4999-8999-999999999999",
      saleOfferId: fixtureIds.saleOffer,
      correlationId: "corr-dashboard-event",
      occurredAt: "2026-06-20T00:00:11.000Z",
      outcome: {
        acceptedReservations: 2,
        soldOutRejections: 1,
        queuedOrders: 1,
        processingOrders: 0,
        retryingOrders: 0,
        confirmedOrders: 1,
        failedOrders: 0,
        pendingPersistenceCount: 0,
        notificationsRecorded: 0,
      },
      consistencyLag: {
        confirmedOrderCount: 1,
        pendingConfirmationCount: 1,
        averageLagMs: 180,
        p95LagMs: 180,
        maxLagMs: 180,
        oldestPendingAgeSeconds: 3,
        measuredAt: "2026-06-20T00:00:11.000Z",
      },
    };

    try {
      if (!reader) {
        throw new Error("Expected a readable SSE body.");
      }

      await readStreamUntil(reader, ": connected");
      dashboardEventFanout.publish(event);
      const frame = await readStreamUntil(reader, "business.outcome.updated");

      expect(frame).toContain('"type":"business.outcome.updated"');
      expect(frame).toContain('"eventId":"99999999-9999-4999-8999-999999999999"');
      expect(frame).toContain('"acceptedReservations":2');
      expect(frame).toContain('"p95LagMs":180');
    } finally {
      await reader?.cancel();
      dashboardEventFanout.close();
      await server.close();
    }
  });

  it("returns the shared inventory status contract", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const response = await server.inject({
      method: "GET",
      url: `/inventory/${fixtureIds.saleOffer}/status`,
    });
    const payload = inventoryStatusSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(payload).toMatchObject({
      saleOfferId: fixtureIds.saleOffer,
      allocatedStock: 10,
      remainingStock: 7,
      reservedStock: 3,
      pendingPersistenceCount: 1,
      expiredReservationCount: 2,
      reservationThroughput: {
        windowSeconds: 60,
        successfulReservationCount: 6,
        rate: 0.1,
        unit: "reservations_per_second",
      },
      soldOutPressure: {
        rejectionCount: 4,
        latestObservedAt: "2026-06-20T00:00:09.000Z",
      },
    });
  });

  it("returns the validated queue status projection", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const response = await server.inject({ method: "GET", url: "/queue/status" });
    const payload = queueStatusSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(payload).toEqual(queueStatusFixture());
    expect(payload).not.toHaveProperty("physicalName");
  });

  it("returns the validated ERP resilience status projection", async () => {
    const status = erpStatusFixture();
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      erpStatusService: createStaticErpStatusService(status),
    });

    const response = await server.inject({ method: "GET", url: erpResilienceStatusPath });
    const payload = erpResilienceStatusSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(payload).toEqual(status);
  });

  it("returns public demo presets and runtime policy through shared contracts", async () => {
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      demoRunService: {
        ...demoRunControllerFixture(),
        listPublicPresets: async () => ({
          presets: [
            {
              id: "33333333-3333-4333-8333-333333333331",
              slug: "preview-1k",
              visibility: "public",
              isEditable: false,
              isCustom: false,
              display: {
                name: "Preview 1k",
                description: "Preview run",
                sortOrder: 10,
                outcomeFocus: ["happy_path"],
              },
              ...acceptedRunConfigSnapshotFixture(),
              createdAt: "2026-06-20T00:00:00.000Z",
              updatedAt: "2026-06-20T00:00:00.000Z",
            },
          ],
          timestamp: "2026-06-20T00:00:10.000Z",
        }),
      },
    });

    const presetsResponse = await server.inject({ method: "GET", url: publicPresetListPath });
    const policyResponse = await server.inject({ method: "GET", url: publicRuntimePolicyPath });

    const presets = publicPresetListResponseSchema.parse(presetsResponse.json());
    const policy = publicRuntimePolicyResponseSchema.parse(policyResponse.json());
    expect(presetsResponse.statusCode).toBe(200);
    expect(presets.presets[0]?.slug).toBe("preview-1k");
    expect(policyResponse.statusCode).toBe(200);
    expect(policy.policy.deploymentHardCaps.maxTotalRequests).toBe(100_000);
  });

  it("protects admin public runtime policy reads and updates", async () => {
    const getAdminPublicRuntimePolicy = vi.fn(
      demoRunControllerFixture().getAdminPublicRuntimePolicy,
    );
    const updateAdminPublicRuntimePolicy = vi.fn(
      demoRunControllerFixture().updateAdminPublicRuntimePolicy,
    );
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      demoRunService: {
        ...demoRunControllerFixture(),
        getAdminPublicRuntimePolicy,
        updateAdminPublicRuntimePolicy,
      },
    });
    const policy = publicRuntimePolicyMutableFixture();
    const headers = { [controlServiceTokenHeaderName]: "test-control-token" };

    const unauthorized = await server.inject({
      method: "GET",
      url: adminPublicRuntimePolicyPath,
    });
    const readResponse = await server.inject({
      method: "GET",
      url: adminPublicRuntimePolicyPath,
      headers: {
        ...headers,
        "x-correlation-id": "corr-admin-policy-read",
      },
    });
    const updateResponse = await server.inject({
      method: "PUT",
      url: adminPublicRuntimePolicyPath,
      headers,
      payload: {
        policy,
        correlationId: "corr-admin-policy-update",
      },
    });

    const readPayload = adminPublicRuntimePolicyResponseSchema.parse(readResponse.json());
    const updatePayload = adminPublicRuntimePolicyResponseSchema.parse(updateResponse.json());
    expect(unauthorized.statusCode).toBe(401);
    expect(readResponse.statusCode).toBe(200);
    expect(updateResponse.statusCode).toBe(200);
    expect(readPayload.correlationId).toBe("corr-admin-policy-read");
    expect(updatePayload.correlationId).toBe("corr-admin-policy-update");
    expect(updateResponse.headers["x-correlation-id"]).toBe("corr-admin-policy-update");
    expect(getAdminPublicRuntimePolicy).toHaveBeenCalledWith("corr-admin-policy-read");
    expect(updateAdminPublicRuntimePolicy).toHaveBeenCalledWith(
      { policy, correlationId: "corr-admin-policy-update" },
      "corr-admin-policy-update",
    );
  });

  it("returns public run history summaries through the shared contract", async () => {
    const list = vi.fn(runHistoryControllerFixture().list);
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      runHistoryService: {
        ...runHistoryControllerFixture(),
        list,
      },
    });

    const response = await server.inject({
      method: "GET",
      url: `${runHistoryPath}?page=2&pageSize=5`,
    });
    const payload = runHistoryListResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(payload.page).toBe(2);
    expect(payload.pageSize).toBe(5);
    expect(payload.summaries[0]?.runId).toBe(fixtureIds.run);
    expect(payload.summaries[0]).not.toHaveProperty("reservationToken");
    expect(payload.summaries[0]).not.toHaveProperty("idempotencyKey");
    expect(list).toHaveBeenCalledWith({ page: 2, pageSize: 5 });
  });

  it("returns public-safe run history detail and stable not found responses", async () => {
    const detail = vi.fn(runHistoryControllerFixture().detail);
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      runHistoryService: {
        ...runHistoryControllerFixture(),
        detail,
      },
    });

    const response = await server.inject({
      method: "GET",
      url: runHistoryDetailPath(fixtureIds.run),
    });
    const missing = await server.inject({
      method: "GET",
      url: runHistoryDetailPath("ffffffff-ffff-4fff-8fff-ffffffffffff"),
    });
    const payload = runHistoryDetailResponseSchema.parse(response.json());
    const missingPayload = errorPayloadSchema.parse(missing.json());

    expect(response.statusCode).toBe(200);
    expect(payload.summary.runId).toBe(fixtureIds.run);
    expect(payload.orders.records[0]?.publicOrderId).toBe("ord_history_1");
    expect(payload.orders.records[0]).not.toHaveProperty("reservationToken");
    expect(payload.orders.records[0]).not.toHaveProperty("idempotencyKey");
    expect(payload.eventTimeline.records[0]).not.toHaveProperty("payload");
    expect(missing.statusCode).toBe(404);
    expect(missingPayload).toMatchObject({
      code: "run_history_detail_not_found",
      details: { runId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    });
    expect(detail).toHaveBeenCalledWith(fixtureIds.run);
    expect(detail).toHaveBeenCalledWith("ffffffff-ffff-4fff-8fff-ffffffffffff");
  });

  it("protects run history deletion and requires delete-all confirmation", async () => {
    const deleteHistory = vi.fn(runHistoryControllerFixture().delete);
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      runHistoryService: {
        ...runHistoryControllerFixture(),
        delete: deleteHistory,
      },
    });
    const headers = { [controlServiceTokenHeaderName]: "test-control-token" };

    const unauthorized = await server.inject({
      method: "DELETE",
      url: runHistoryPath,
      payload: { runIds: [fixtureIds.run] },
    });
    const missingConfirmation = await server.inject({
      method: "DELETE",
      url: runHistoryPath,
      headers,
      payload: {},
    });
    const selected = await server.inject({
      method: "DELETE",
      url: runHistoryPath,
      headers: { ...headers, "x-correlation-id": "corr-history-delete" },
      payload: { runIds: [fixtureIds.run] },
    });
    const deleteAll = await server.inject({
      method: "DELETE",
      url: runHistoryPath,
      headers,
      payload: { deleteAllConfirmation: "DELETE_ALL_RUN_SUMMARIES" },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(missingConfirmation.statusCode).toBe(400);
    expect(selected.statusCode).toBe(200);
    expect(deleteAll.statusCode).toBe(200);
    expect(adminDeleteRunHistoryResponseSchema.parse(selected.json())).toMatchObject({
      deletedSummaryCount: 1,
      correlationId: "corr-history-delete",
    });
    expect(deleteHistory).toHaveBeenCalledWith({ runIds: [fixtureIds.run] }, "corr-history-delete");
    expect(deleteHistory).toHaveBeenCalledWith(
      { deleteAllConfirmation: "DELETE_ALL_RUN_SUMMARIES" },
      expect.any(String),
    );
  });

  it("starts a demo run through the API run lifecycle and propagates correlation IDs", async () => {
    const startRun = vi.fn(demoRunControllerFixture().startRun);
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      demoRunService: {
        ...demoRunControllerFixture(),
        startRun,
      },
    });

    const response = await server.inject({
      method: "POST",
      url: startDemoRunPath,
      headers: {
        "x-correlation-id": "run-start-correlation",
        [controlServiceTokenHeaderName]: "test-control-token",
        [demoRunOperatorModeHeaderName]: "public",
      },
      payload: {
        presetSlug: "preview-1k",
      },
    });
    const payload = startDemoRunResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(202);
    expect(response.headers["x-correlation-id"]).toBe("run-start-correlation");
    expect(payload.correlationId).toBe("run-start-correlation");
    expect(payload.run.status).toBe("active");
    expect(startRun).toHaveBeenCalledWith(
      {
        presetSlug: "preview-1k",
        operatorMode: "public",
      },
      "run-start-correlation",
    );
  });

  it("derives admin demo-run authority only from trusted headers", async () => {
    const startRun = vi.fn(demoRunControllerFixture().startRun);
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      demoRunService: {
        ...demoRunControllerFixture(),
        startRun,
      },
    });

    const untrustedBody = await server.inject({
      method: "POST",
      url: startDemoRunPath,
      payload: {
        presetSlug: "admin-smoke-steady",
        operatorMode: "admin",
      },
    });
    const untrustedHeader = await server.inject({
      method: "POST",
      url: startDemoRunPath,
      headers: { [demoRunOperatorModeHeaderName]: "admin" },
      payload: {
        presetSlug: "admin-smoke-steady",
      },
    });
    const invalidHeader = await server.inject({
      method: "POST",
      url: startDemoRunPath,
      headers: {
        [demoRunOperatorModeHeaderName]: "root",
        [controlServiceTokenHeaderName]: "test-control-token",
      },
      payload: {
        presetSlug: "preview-1k",
      },
    });
    const missingMode = await server.inject({
      method: "POST",
      url: startDemoRunPath,
      headers: { [controlServiceTokenHeaderName]: "test-control-token" },
      payload: { presetSlug: "preview-1k" },
    });
    const wrongPublicToken = await server.inject({
      method: "POST",
      url: startDemoRunPath,
      headers: {
        [controlServiceTokenHeaderName]: "wrong",
        [demoRunOperatorModeHeaderName]: "public",
      },
      payload: { presetSlug: "preview-1k" },
    });
    const wrongAdminToken = await server.inject({
      method: "POST",
      url: startDemoRunPath,
      headers: {
        [controlServiceTokenHeaderName]: "wrong",
        [demoRunOperatorModeHeaderName]: "admin",
      },
      payload: { presetSlug: "admin-smoke-steady" },
    });
    const trustedHeader = await server.inject({
      method: "POST",
      url: startDemoRunPath,
      headers: {
        [demoRunOperatorModeHeaderName]: "admin",
        "x-control-service-token": "test-control-token",
      },
      payload: {
        presetSlug: "admin-smoke-steady",
      },
    });

    expect(untrustedBody.statusCode).toBe(401);
    expect(untrustedHeader.statusCode).toBe(401);
    expect(invalidHeader.statusCode).toBe(400);
    expect(missingMode.statusCode).toBe(400);
    expect(wrongPublicToken.statusCode).toBe(401);
    expect(wrongAdminToken.statusCode).toBe(401);
    expect(trustedHeader.statusCode).toBe(202);
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun).toHaveBeenCalledWith(
      {
        presetSlug: "admin-smoke-steady",
        operatorMode: "admin",
      },
      expect.any(String),
    );
  });

  it("protects admin demo reset and delegates to the maintenance service", async () => {
    const reset = vi.fn(async (correlationId: string) => ({
      failedRunCount: 2,
      closedSaleOfferCount: 2,
      cleanedQueueCount: 2,
      cleanedJobCount: 5,
      resetAt: "2026-06-20T00:00:10.000Z",
      correlationId,
    }));
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      demoMaintenanceService: {
        reset,
        cleanupOldRuns: vi.fn(),
      } as never,
    });

    const unauthorized = await server.inject({ method: "POST", url: adminDemoResetPath });
    const authorized = await server.inject({
      method: "POST",
      url: adminDemoResetPath,
      headers: { [controlServiceTokenHeaderName]: "test-control-token" },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toMatchObject({
      failedRunCount: 2,
      closedSaleOfferCount: 2,
      cleanedQueueCount: 2,
      cleanedJobCount: 5,
    });
    expect(reset).toHaveBeenCalledOnce();
  });

  it("protects generated-run cleanup and validates cleanup options", async () => {
    const cleanupOldRuns = vi.fn(async (input: { correlationId: string }) => ({
      deletedRunCount: 3,
      deletedSaleOfferCount: 3,
      preservedLatestCount: 2,
      preservedActiveRunCount: 1,
      cutoffBefore: "2026-06-13T00:00:10.000Z",
      cleanedAt: "2026-06-20T00:00:10.000Z",
      correlationId: input.correlationId,
    }));
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      demoMaintenanceService: {
        reset: vi.fn(),
        cleanupOldRuns,
      } as never,
    });

    const response = await server.inject({
      method: "POST",
      url: adminMaintenanceCleanupRunsPath,
      headers: { [controlServiceTokenHeaderName]: "test-control-token" },
      payload: {
        keepLatest: 2,
        olderThanDays: 14,
        correlationId: "corr-cleanup-test",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      deletedRunCount: 3,
      deletedSaleOfferCount: 3,
      preservedLatestCount: 2,
      preservedActiveRunCount: 1,
      correlationId: "corr-cleanup-test",
    });
    expect(response.headers[correlationIdHeaderName]).toBe("corr-cleanup-test");
    expect(cleanupOldRuns).toHaveBeenCalledWith({
      keepLatest: 2,
      olderThanDays: 14,
      correlationId: "corr-cleanup-test",
    });
  });

  it("protects and delegates admin preset management endpoints", async () => {
    const listAdminPresets = vi.fn(demoRunControllerFixture().listAdminPresets);
    const saveAdminPreset = vi.fn(demoRunControllerFixture().saveAdminPreset);
    const duplicatePreset = vi.fn(demoRunControllerFixture().duplicatePreset);
    const copyPresetToCustom = vi.fn(demoRunControllerFixture().copyPresetToCustom);
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      demoRunService: {
        ...demoRunControllerFixture(),
        listAdminPresets,
        saveAdminPreset,
        duplicatePreset,
        copyPresetToCustom,
      },
    });
    const headers = { [controlServiceTokenHeaderName]: "test-control-token" };
    const savePayload = {
      slug: "custom",
      display: {
        name: "Custom",
        description: "Updated custom preset.",
        sortOrder: 10,
        outcomeFocus: [],
      },
      ...acceptedRunConfigSnapshotFixture(),
    };

    expect((await server.inject({ method: "GET", url: adminPresetListPath })).statusCode).toBe(401);
    expect(
      (await server.inject({ method: "GET", url: adminPresetListPath, headers })).statusCode,
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: "POST",
          url: adminPresetSavePath,
          headers,
          payload: savePayload,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: "POST",
          url: adminPresetDuplicatePath,
          headers,
          payload: { sourceSlug: "preview-1k", targetSlug: "preview-copy" },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await server.inject({
          method: "POST",
          url: adminPresetCopyToCustomPath,
          headers,
          payload: { sourceSlug: "preview-1k" },
        })
      ).statusCode,
    ).toBe(200);

    expect(listAdminPresets).toHaveBeenCalledOnce();
    expect(saveAdminPreset).toHaveBeenCalledWith(savePayload);
    expect(duplicatePreset).toHaveBeenCalledWith({
      sourceSlug: "preview-1k",
      targetSlug: "preview-copy",
    });
    expect(copyPresetToCustom).toHaveBeenCalledWith({ sourceSlug: "preview-1k" });
  });

  it("rejects tokenless visitor assertions and forwards only authenticated proxy assertions", async () => {
    const startRun = vi.fn(demoRunControllerFixture().startRun);
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      demoRunService: {
        ...demoRunControllerFixture(),
        startRun,
      },
    });

    const tokenless = await server.inject({
      method: "POST",
      url: startDemoRunPath,
      headers: { [publicVisitorIdHeaderName]: "signed-visitor-1" },
      payload: {
        presetSlug: "preview-1k",
      },
    });
    const response = await server.inject({
      method: "POST",
      url: startDemoRunPath,
      headers: {
        [controlServiceTokenHeaderName]: "test-control-token",
        [demoRunOperatorModeHeaderName]: "public",
        [publicVisitorIdHeaderName]: "signed-visitor-1",
      },
      payload: { presetSlug: "preview-1k" },
    });

    expect(tokenless.statusCode).toBe(401);
    expect(response.statusCode).toBe(202);
    expect(startRun).toHaveBeenCalledWith(
      {
        presetSlug: "preview-1k",
        operatorMode: "public",
        publicVisitorCredential: "signed-visitor-1",
      },
      expect.any(String),
    );
  });

  it("protects internal load metric ingestion with the control service token", async () => {
    const ingestMetrics = vi.fn();
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      demoRunService: {
        ...demoRunControllerFixture(),
        ingestMetrics,
      },
    });

    const unauthorized = await server.inject({
      method: "POST",
      url: "/internal/load/metrics",
      payload: {
        runId: fixtureIds.run,
        correlationId: fixtureCorrelationId,
        samples: [
          {
            metricName: "traffic.latency",
            value: 42,
            unit: "ms",
            timestamp: "2026-06-20T00:00:10.000Z",
          },
        ],
        observedAt: "2026-06-20T00:00:10.000Z",
      },
    });
    const accepted = await server.inject({
      method: "POST",
      url: "/internal/load/metrics",
      headers: { "x-control-service-token": "test-control-token" },
      payload: {
        runId: fixtureIds.run,
        correlationId: fixtureCorrelationId,
        samples: [
          {
            metricName: "traffic.latency",
            value: 42,
            unit: "ms",
            timestamp: "2026-06-20T00:00:10.000Z",
          },
        ],
        observedAt: "2026-06-20T00:00:10.000Z",
      },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers[correlationIdHeaderName]).toBe(fixtureCorrelationId);
    expect(ingestMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: fixtureCorrelationId }),
    );
  });

  it("protects internal traffic completion ingestion with the control service token", async () => {
    const recordTrafficCompletion = vi.fn(async () => demoRunSnapshotFixture());
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      demoRunService: {
        ...demoRunControllerFixture(),
        recordTrafficCompletion,
      },
    });
    const report = {
      runId: fixtureIds.run,
      status: "succeeded",
      exitCode: 0,
      httpSummary: {
        plannedRequests: 2,
        emittedRequests: 2,
        completedRequests: 2,
        failedRequests: 0,
        acceptedResponses: 1,
        soldOutResponses: 1,
        unexpectedResponses: 0,
        p95LatencyMs: 42,
        failureRate: 0,
      },
      trafficOutcomeSummary: {},
      trafficDeliverySummary: {
        plannedRequests: 2,
        emittedRequests: 2,
        droppedIterations: 0,
        trafficDeliveryStatus: "complete",
        notes: [],
      },
      httpTimingBreakdownSummary: {},
      loadRunDiagnosticsSummary: {},
      apiRequestLifecycleSummary: {},
      completedAt: "2026-06-20T00:00:10.000Z",
      correlationId: fixtureCorrelationId,
    };

    const unauthorized = await server.inject({
      method: "POST",
      url: "/internal/load/completion",
      payload: report,
    });
    const accepted = await server.inject({
      method: "POST",
      url: "/internal/load/completion",
      headers: { "x-control-service-token": "test-control-token" },
      payload: report,
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers[correlationIdHeaderName]).toBe(fixtureCorrelationId);
    expect(accepted.json()).toEqual({
      runId: fixtureIds.run,
      acknowledged: true,
      correlationId: fixtureCorrelationId,
    });
    expect(recordTrafficCompletion).toHaveBeenCalledWith(report);
  });

  it("returns a stable unavailable response when queue inspection fails", async () => {
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      queueInspector: { inspect: async () => Promise.reject(new Error("Redis disconnected")) },
    });

    const response = await server.inject({ method: "GET", url: "/queue/status" });
    const payload = errorPayloadSchema.parse(response.json());

    expect(response.statusCode).toBe(503);
    expect(payload.code).toBe("queue_status_unavailable");
  });

  it("returns a stable shared error when inventory is not initialized", async () => {
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      inventoryReader: {
        getStatus: async (saleOfferId) => {
          throw new InventoryNotInitializedError(saleOfferId);
        },
      },
    });

    const response = await server.inject({
      method: "GET",
      url: `/inventory/${fixtureIds.saleOffer}/status`,
    });
    const payload = errorPayloadSchema.parse(response.json());

    expect(response.statusCode).toBe(404);
    expect(payload.code).toBe("inventory_not_initialized");
    expect(payload.details).toEqual({ saleOfferId: fixtureIds.saleOffer });
  });

  it("rejects invalid inventory status sale offer IDs", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const response = await server.inject({ method: "GET", url: "/inventory/not-a-uuid/status" });
    const payload = errorPayloadSchema.parse(response.json());

    expect(response.statusCode).toBe(400);
    expect(payload.code).toBe("invalid_request");
  });

  it("returns shared error shape for invalid buy requests", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const response = await server.inject({
      method: "POST",
      url: "/buy",
      payload: {
        saleOfferId: fixtureIds.saleOffer,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["x-correlation-id"]).toBeTruthy();
    expect(() => errorPayloadSchema.parse(response.json())).not.toThrow();
  });

  it("propagates request correlation IDs through headers and buy payloads", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const response = await server.inject({
      method: "POST",
      url: "/buy",
      headers: {
        "x-correlation-id": "phase2-test-correlation",
      },
      payload: {
        saleOfferId: fixtureIds.saleOffer,
        idempotencyKey: "idem-1",
        quantity: 1,
      },
    });
    const payload = buyResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(202);
    expect(response.headers["x-correlation-id"]).toBe("phase2-test-correlation");
    expect(payload.correlationId).toBe("phase2-test-correlation");
    expect(payload.outcome).toBe("reservation_secured");
  });

  it("allows body correlation ID to set the final buy correlation when no header is supplied", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const response = await server.inject({
      method: "POST",
      url: "/buy",
      payload: {
        saleOfferId: fixtureIds.saleOffer,
        idempotencyKey: "idem-2",
        quantity: 1,
        correlationId: "body-correlation",
      },
    });
    const payload = buyResponseSchema.parse(response.json());

    expect(response.headers["x-correlation-id"]).toBe("body-correlation");
    expect(payload.correlationId).toBe("body-correlation");
  });

  it("accepts matching run attribution from the buy body and load-run header", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const response = await server.inject({
      method: "POST",
      url: "/buy",
      headers: {
        [loadRunIdHeaderName]: fixtureIds.run,
      },
      payload: {
        saleOfferId: fixtureIds.saleOffer,
        runId: fixtureIds.run,
        idempotencyKey: "matching-run-attribution",
        quantity: 1,
      },
    });
    const payload = buyResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(202);
    expect(payload.reservation?.runId).toBe(fixtureIds.run);
    expect(payload.order?.runId).toBe(fixtureIds.run);
  });

  it("uses the load-run header when the buy body omits run attribution", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const response = await server.inject({
      method: "POST",
      url: "/buy",
      headers: {
        [loadRunIdHeaderName]: fixtureIds.run,
      },
      payload: {
        saleOfferId: fixtureIds.saleOffer,
        idempotencyKey: "header-only-run-attribution",
        quantity: 1,
      },
    });
    const payload = buyResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(202);
    expect(payload.reservation?.runId).toBe(fixtureIds.run);
    expect(payload.order?.runId).toBe(fixtureIds.run);
  });

  it("rejects mismatched buy body and load-run header attribution", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const response = await server.inject({
      method: "POST",
      url: "/buy",
      headers: {
        [loadRunIdHeaderName]: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      },
      payload: {
        saleOfferId: fixtureIds.saleOffer,
        runId: fixtureIds.run,
        idempotencyKey: "mismatched-run-attribution",
        quantity: 1,
      },
    });
    const payload = errorPayloadSchema.parse(response.json());

    expect(response.statusCode).toBe(400);
    expect(payload.code).toBe("run_attribution_mismatch");
    expect(payload.details).toEqual({
      bodyRunId: fixtureIds.run,
      headerRunId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      headerName: loadRunIdHeaderName,
    });
  });

  it("maps the atomic Redis run rejection to the compatible API response", async () => {
    const stockReservations: StockReservationGateway = {
      reserve: async () => ({ outcome: "run_not_accepting_traffic", reservation: null }),
      markPendingPersistence: async () => undefined,
      promoteAccepted: async () => undefined,
    };
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      stockReservations,
    });

    const response = await server.inject({
      method: "POST",
      url: "/buy",
      payload: {
        saleOfferId: fixtureIds.saleOffer,
        runId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        idempotencyKey: "run-without-eligibility",
        quantity: 1,
      },
    });
    const payload = buyResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(503);
    expect(payload).toMatchObject({
      outcome: "inventory_not_initialized",
      reason: "run_not_accepting_traffic",
      reservation: null,
      order: null,
    });
  });

  it.each([
    ["run_not_accepting_traffic", 503, "inventory_not_initialized"],
    ["inventory_not_initialized", 503, "inventory_not_initialized"],
    ["idempotency_conflict", 409, "idempotency_conflict"],
    ["sold_out", 409, "sold_out"],
  ] as const)("does no PostgreSQL work for the route-level Redis %s decision", async (decision, expectedStatus, expectedOutcome) => {
    const persistSecuredReservation = vi.fn();
    const getPersistedBuyByReservationId = vi.fn();
    const server = await trackedServer({
      persistence: { persistSecuredReservation, getPersistedBuyByReservationId },
      stockReservations: {
        reserve: async () => ({ outcome: decision, reservation: null }),
        markPendingPersistence: async () => undefined,
        promoteAccepted: async () => undefined,
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/buy",
      payload: {
        saleOfferId: fixtureIds.saleOffer,
        idempotencyKey: `route-rejection-${decision}`,
        quantity: 1,
      },
    });

    expect(response.statusCode).toBe(expectedStatus);
    expect(buyResponseSchema.parse(response.json()).outcome).toBe(expectedOutcome);
    expect(persistSecuredReservation).not.toHaveBeenCalled();
    expect(getPersistedBuyByReservationId).not.toHaveBeenCalled();
  });

  it("does no PostgreSQL work when malformed Redis projection state raises an error", async () => {
    const persistSecuredReservation = vi.fn();
    const getPersistedBuyByReservationId = vi.fn();
    const server = await trackedServer({
      persistence: { persistSecuredReservation, getPersistedBuyByReservationId },
      stockReservations: {
        reserve: async () => {
          throw new Error("Inventory scope must be catalog or generated_run");
        },
        markPendingPersistence: async () => undefined,
        promoteAccepted: async () => undefined,
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/buy",
      payload: {
        saleOfferId: fixtureIds.saleOffer,
        idempotencyKey: "route-malformed-projection",
        quantity: 1,
      },
    });

    expect(response.statusCode).toBe(500);
    expect(persistSecuredReservation).not.toHaveBeenCalled();
    expect(getPersistedBuyByReservationId).not.toHaveBeenCalled();
  });

  it("rejects invalid quantity at the HTTP schema without Redis or PostgreSQL work", async () => {
    const persistSecuredReservation = vi.fn();
    const getPersistedBuyByReservationId = vi.fn();
    const reserve = vi.fn();
    const server = await trackedServer({
      persistence: { persistSecuredReservation, getPersistedBuyByReservationId },
      stockReservations: {
        reserve,
        markPendingPersistence: async () => undefined,
        promoteAccepted: async () => undefined,
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/buy",
      payload: {
        saleOfferId: fixtureIds.saleOffer,
        idempotencyKey: "route-invalid-quantity",
        quantity: 0,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(reserve).not.toHaveBeenCalled();
    expect(persistSecuredReservation).not.toHaveBeenCalled();
    expect(getPersistedBuyByReservationId).not.toHaveBeenCalled();
  });

  it("requires Redis configuration for production composition", () => {
    expect(() => loadApiConfig({ DATABASE_URL: "postgresql://localhost/test" })).toThrow(
      "REDIS_URL is required.",
    );
  });
});

describe("API buy persistence", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;
  let redis: CheckoutSurgeRedis | null = null;

  beforeEach(async () => {
    await connection?.close();
    connection = null;
    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    redis ??= createRedisClient(process.env.TEST_REDIS_URL ?? "redis://localhost:6380", {
      maxRetriesPerRequest: 3,
    });
    await redis.flushdb();
    await connection.db.insert(products).values({
      id: fixtureIds.product,
      sku: "API-TEST-SKU",
      slug: "api-test-product",
      name: "API Test Product",
      isActive: true,
    });
    await connection.db.insert(saleOffers).values({
      id: fixtureIds.saleOffer,
      productId: fixtureIds.product,
      name: "API Test Sale Offer",
      allocatedStock: 5,
      saleStartsAt: new Date("2026-01-01T00:00:00.000Z"),
      saleEndsAt: new Date("2035-01-01T00:00:00.000Z"),
      isActive: true,
      purpose: "catalog",
    });
    await initializeInventory(redis, { saleOfferId: fixtureIds.saleOffer, allocatedStock: 5 });
  });

  afterEach(async () => {
    await connection?.close();
    connection = null;
  });

  afterAll(async () => {
    await connection?.close();
    await redis?.flushdb();
    redis?.disconnect();
  });

  it("keeps fresh catalog persistence within the measured six-round-trip budget", async () => {
    const wireQueries: string[] = [];
    const measuredConnection = createDatabaseConnection(requireTestDatabaseUrl(), {
      max: 1,
      debug: (_connection, query) => wireQueries.push(query),
    });
    try {
      await measuredConnection.sql`select 1`;
      expect(wireQueries.map((query) => query.trim().split(/\s+/u)[0]?.toLowerCase())).toEqual([
        "select",
        "select",
      ]);
      wireQueries.length = 0;
      await new PostgresBuyPersistence(measuredConnection.db).persistSecuredReservation({
        reservation: {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000090",
          saleOfferId: fixtureIds.saleOffer,
          correlationId: "persistence-budget-correlation",
          quantity: 1,
          status: "secured",
          reservationToken: "persistence-budget-token",
          securedAt: "2026-06-20T12:00:00.000Z",
          expiresAt: "2026-06-20T12:15:00.000Z",
        },
      });

      const operationQueries = wireQueries.map((query) =>
        query.trim().split(/\s+/u)[0]?.toLowerCase(),
      );
      expect(operationQueries).toEqual(["begin", "insert", "insert", "insert", "update", "commit"]);
    } finally {
      await measuredConnection.close();
    }
  });

  it("persists a secured reservation, queued order, and initial events", async () => {
    if (!connection) {
      throw new Error("Test database connection was not initialized.");
    }

    if (!redis) {
      throw new Error("Test Redis connection was not initialized.");
    }
    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/buy",
        headers: {
          "x-correlation-id": "persist-correlation",
        },
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "persist-idem-1",
          quantity: 1,
        },
      });
      const payload = buyResponseSchema.parse(response.json());

      const [reservationRow] = await connection.db
        .select()
        .from(reservations)
        .where(eq(reservations.id, payload.reservation?.id ?? ""))
        .limit(1);
      const [orderRow] = await connection.db
        .select()
        .from(orders)
        .where(eq(orders.id, payload.order?.id ?? ""))
        .limit(1);
      const events = await connection.db
        .select()
        .from(orderEvents)
        .where(eq(orderEvents.reservationId, payload.reservation?.id ?? ""));

      expect(response.statusCode).toBe(202);
      expect(payload.outcome).toBe("reservation_secured");
      expect(reservationRow?.status).toBe("secured");
      expect(reservationRow?.correlationId).toBe("persist-correlation");
      expect(reservationRow?.id).toBe(payload.reservation?.id);
      expect(reservationRow?.reservationToken).toBe(payload.reservation?.reservationToken);
      expect(reservationRow?.securedAt.toISOString()).toBe(payload.reservation?.securedAt);
      expect(reservationRow?.expiresAt.toISOString()).toBe(payload.reservation?.expiresAt);
      expect(orderRow?.status).toBe("queued");
      expect(orderRow?.reservationId).toBe(reservationRow?.id);
      expect(events.map((event) => event.eventName).sort()).toEqual([
        "order.queued",
        "reservation.secured",
      ]);
    } finally {
      await server.close();
    }
  });

  it("converges a Redis-only pending hold into durable rows, one queue handoff, and accepted replay", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }
    const idempotencyKey = "reconciler-full-convergence";
    const decision = await reserveInventoryStock(redis, {
      idempotencyKey,
      idempotencyTtlSeconds: 1800,
      reservation: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000077",
        saleOfferId: fixtureIds.saleOffer,
        correlationId: "reconciler-full-convergence-correlation",
        quantity: 1,
        status: "secured",
        reservationToken: "reservation-token-77",
        securedAt: "2026-06-20T12:00:00.000Z",
        expiresAt: "2026-06-20T12:15:00.000Z",
      },
    });
    if (!decision.reservation) {
      throw new Error("Expected a secured Redis hold.");
    }
    const jobs: OrderProcessJob[] = [];
    const reconciler = new PendingPersistenceReconciler({
      redis,
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: {
        promoteAccepted: (input) =>
          promoteReservationIdempotencyToAccepted(redis, input).then(() => undefined),
      },
      orderProcessJobPublisher: {
        enqueue: async (job) => {
          jobs.push(job);
        },
      },
      logger: createSilentLogger("api"),
    });

    const result = await reconciler.reconcileSaleOffer(fixtureIds.saleOffer);
    const reservationRows = await connection.db.select().from(reservations);
    const orderRows = await connection.db.select().from(orders);
    const eventRows = await connection.db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.reservationId, decision.reservation.id));
    const inventoryStatus = await getInventoryStatus(redis, fixtureIds.saleOffer);
    const replay = await reserveInventoryStock(redis, {
      idempotencyKey,
      idempotencyTtlSeconds: 1800,
      reservation: decision.reservation,
    });

    expect(result).toMatchObject({ found: 1, materialized: 1, reconciled: 1, failed: 0 });
    expect(reservationRows).toHaveLength(1);
    expect(orderRows).toHaveLength(1);
    expect(eventRows.map((event) => event.eventName)).toEqual([
      "reservation.secured",
      "order.queued",
    ]);
    expect(jobs).toHaveLength(1);
    expect(inventoryStatus.pendingPersistenceCount).toBe(0);
    expect(replay.outcome).toBe("idempotent_replay");
  });

  it("returns 202 after publishing one deterministic BullMQ job without a running worker", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }

    const redisUrl = process.env.TEST_REDIS_URL ?? "redis://localhost:6380";
    const publisher = createBullMqOrderProcessJobPublisher(
      { url: redisUrl, maxRetriesPerRequest: 3 },
      undefined,
      { resolve: vi.fn() },
    );
    const queue = new Queue<OrderProcessJob, void, typeof orderProcessJobName>(
      orderProcessBullMqQueueName,
      { connection: { url: redisUrl, maxRetriesPerRequest: 3 } },
    );
    const queueInspector = createBullMqOrderProcessQueueInspector({
      url: redisUrl,
      maxRetriesPerRequest: 3,
    });
    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
      orderProcessJobPublisher: publisher,
      queueInspector,
      generateId: randomUUID,
    });

    try {
      const request = {
        method: "POST" as const,
        url: "/buy",
        headers: { "x-correlation-id": "queued-api-correlation" },
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "queued-api-idempotency",
          quantity: 2,
        },
      };
      const firstResponse = await server.inject(request);
      const firstPayload = buyResponseSchema.parse(firstResponse.json());
      if (!firstPayload.order || !firstPayload.reservation) {
        throw new Error("Expected a persisted reservation and order.");
      }

      const replayResponses = await Promise.all(
        Array.from({ length: 8 }, () => server.inject(request)),
      );
      const job = await queue.getJob(firstPayload.order.id);
      await queue.pause();
      const queueStatusResponse = await server.inject({ method: "GET", url: "/queue/status" });
      const queueStatus = queueStatusSchema.parse(queueStatusResponse.json());

      expect(firstResponse.statusCode).toBe(202);
      expect(firstPayload.outcome).toBe("reservation_secured");
      expect(replayResponses.every((response) => response.statusCode === 202)).toBe(true);
      expect(job?.id).toBe(firstPayload.order.id);
      expect(job?.data).toEqual({
        orderId: firstPayload.order.id,
        publicOrderId: firstPayload.order.publicOrderId,
        reservationId: firstPayload.reservation.id,
        saleOfferId: fixtureIds.saleOffer,
        correlationId: "queued-api-correlation",
        quantity: 2,
        queuedAt: firstPayload.order.queuedAt,
      });
      expect(await job?.getState()).toBe("waiting");
      expect(queueStatus).toMatchObject({
        name: "orders:process",
        depth: 1,
        counts: { waiting: 0, prioritized: 0, paused: 1, delayed: 0, active: 0, failed: 0 },
        retryPressure: {
          inspectedJobCount: 1,
          retryingJobCount: 0,
          retryAttemptCount: 0,
          inspectionTruncated: false,
        },
        failedJobs: { totalCount: 0, recent: [], inspectionTruncated: false },
      });
      expect(queueStatus).not.toHaveProperty("physicalName");
      expect(await connection.db.select().from(orderEvents)).toHaveLength(2);
    } finally {
      await server.close();
      await publisher.close();
      await queueInspector.close();
      await queue.close();
    }
  });

  it("projects bounded health from real paused, delayed, retrying, and failed BullMQ jobs", async () => {
    if (!redis) {
      throw new Error("Test Redis was not initialized.");
    }

    const redisUrl = process.env.TEST_REDIS_URL ?? "redis://localhost:6380";
    const connectionOptions = { url: redisUrl, maxRetriesPerRequest: 3 } as const;
    const queue = new Queue<OrderProcessJob, void, typeof orderProcessJobName>(
      orderProcessBullMqQueueName,
      { connection: connectionOptions },
    );
    const worker = new Worker<OrderProcessJob, void, typeof orderProcessJobName>(
      orderProcessBullMqQueueName,
      async () => {
        throw new Error("test-only queue inspection failure");
      },
      { connection: { url: redisUrl, maxRetriesPerRequest: null } },
    );
    const truncatedInspector = createOrderProcessQueueInspector(queue, {
      retryInspectionLimit: 1,
      failedJobInspectionLimit: 1,
    });
    const fullInspector = createOrderProcessQueueInspector(queue, {
      retryInspectionLimit: 10,
      failedJobInspectionLimit: 1,
    });
    const queueJob = (orderId: string): OrderProcessJob => ({
      orderId,
      publicOrderId: `ord_${orderId.slice(0, 8)}`,
      reservationId: randomUUID(),
      saleOfferId: fixtureIds.saleOffer,
      correlationId: `queue-inspection-${orderId}`,
      quantity: 1,
      queuedAt: new Date().toISOString(),
    });

    try {
      const failedOlder = await queue.add(orderProcessJobName, queueJob(randomUUID()), {
        attempts: 1,
        jobId: "failed-older",
      });
      await vi.waitFor(async () => expect(await failedOlder.getState()).toBe("failed"), {
        timeout: 10_000,
        interval: 25,
      });
      await vi.waitFor(
        async () => {
          const persistedJob = await queue.getJob("failed-older");
          expect(Date.now()).toBeGreaterThan(persistedJob?.finishedOn ?? Number.MAX_SAFE_INTEGER);
        },
        { timeout: 10_000, interval: 25 },
      );
      const failedNewest = await queue.add(orderProcessJobName, queueJob(randomUUID()), {
        attempts: 1,
        jobId: "failed-newest",
      });
      await vi.waitFor(async () => expect(await failedNewest.getState()).toBe("failed"), {
        timeout: 10_000,
        interval: 25,
      });
      const retrying = await queue.add(orderProcessJobName, queueJob(randomUUID()), {
        attempts: 2,
        backoff: 60_000,
        jobId: "retrying-delayed",
      });
      await vi.waitFor(
        async () => {
          expect(await retrying.getState()).toBe("delayed");
          expect((await queue.getJob("retrying-delayed"))?.attemptsMade).toBe(1);
        },
        { timeout: 10_000, interval: 25 },
      );
      await queue.add(orderProcessJobName, queueJob(randomUUID()), {
        delay: 120_000,
        jobId: "scheduled-delayed",
      });

      const boundedStatus = queueStatusSchema.parse(await truncatedInspector.inspect());
      expect(boundedStatus).toMatchObject({
        name: "orders:process",
        connectivity: "reachable",
        depth: 2,
        counts: { waiting: 0, prioritized: 0, paused: 0, delayed: 2, active: 0, failed: 2 },
        retryPressure: {
          inspectedJobCount: 1,
          inspectionLimit: 1,
          retryingJobCount: 1,
          retryAttemptCount: 1,
          inspectionTruncated: true,
        },
        failedJobs: {
          totalCount: 2,
          inspectionLimit: 1,
          inspectionTruncated: true,
          recent: [
            expect.objectContaining({
              jobId: "failed-newest",
              attemptsMade: 1,
              failedReason: "test-only queue inspection failure",
            }),
          ],
        },
      });

      await queue.pause();
      await queue.add(orderProcessJobName, queueJob(randomUUID()), { jobId: "paused-backlog" });
      const fullStatus = queueStatusSchema.parse(await fullInspector.inspect());

      expect(fullStatus.depth).toBe(3);
      expect(fullStatus.counts).toMatchObject({ paused: 1, delayed: 2, failed: 2 });
      expect(fullStatus.retryPressure).toMatchObject({
        inspectedJobCount: 3,
        retryingJobCount: 1,
        retryAttemptCount: 1,
        inspectionTruncated: false,
      });
      expect(fullStatus.oldestWaitingAgeSeconds).not.toBeNull();
      expect(fullStatus).not.toHaveProperty("physicalName");
    } finally {
      await worker.close();
      await queue.close();
    }
  });

  it("heals a committed reservation after the first real-boundary enqueue attempt fails", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }

    const redisUrl = process.env.TEST_REDIS_URL ?? "redis://localhost:6380";
    const publisher = createBullMqOrderProcessJobPublisher(
      { url: redisUrl, maxRetriesPerRequest: 3 },
      undefined,
      { resolve: vi.fn() },
    );
    const queue = new Queue<OrderProcessJob, void, typeof orderProcessJobName>(
      orderProcessBullMqQueueName,
      { connection: { url: redisUrl, maxRetriesPerRequest: 3 } },
    );
    let enqueueAttempts = 0;
    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
      orderProcessJobPublisher: {
        enqueue: async (job) => {
          enqueueAttempts += 1;
          if (enqueueAttempts === 1) {
            throw new Error("simulated queue handoff interruption");
          }
          await publisher.enqueue(job);
        },
      },
      generateId: randomUUID,
    });

    try {
      const request = {
        method: "POST" as const,
        url: "/buy",
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "queue-handoff-healing",
          quantity: 1,
        },
      };
      const firstResponse = await server.inject(request);
      const firstError = errorPayloadSchema.parse(firstResponse.json());
      const reservationRowsAfterFailure = await connection.db.select().from(reservations);
      const orderRowsAfterFailure = await connection.db.select().from(orders);
      const eventsAfterFailure = await connection.db.select().from(orderEvents);
      const inventoryAfterFailure = await getInventoryStatus(redis, fixtureIds.saleOffer);

      expect(firstResponse.statusCode).toBe(500);
      expect(firstError.code).toBe("internal_error");
      expect(reservationRowsAfterFailure).toHaveLength(1);
      expect(orderRowsAfterFailure).toHaveLength(1);
      expect(eventsAfterFailure.map((event) => event.eventName).sort()).toEqual([
        "order.queued",
        "reservation.secured",
      ]);
      expect(inventoryAfterFailure.pendingPersistenceCount).toBe(1);
      expect(await queue.getWaitingCount()).toBe(0);

      const retryResponse = await server.inject(request);
      const retryPayload = buyResponseSchema.parse(retryResponse.json());
      if (!retryPayload.order) {
        throw new Error("Expected the durable order on the healing replay.");
      }

      expect(retryResponse.statusCode).toBe(202);
      expect(retryPayload.outcome).toBe("reservation_secured");
      expect(enqueueAttempts).toBe(2);
      expect(await queue.getWaitingCount()).toBe(1);
      expect((await queue.getJob(retryPayload.order.id))?.id).toBe(retryPayload.order.id);
      expect(await connection.db.select().from(reservations)).toHaveLength(1);
      expect(await connection.db.select().from(orders)).toHaveLength(1);
      expect(await connection.db.select().from(orderEvents)).toHaveLength(2);
      expect((await getInventoryStatus(redis, fixtureIds.saleOffer)).pendingPersistenceCount).toBe(
        0,
      );
    } finally {
      await server.close();
      await publisher.close();
      await queue.close();
    }
  });

  it.each([
    {
      name: "generated-run inventory when runId is omitted",
      inventoryRunId: "11111111-1111-4111-8111-111111111111",
      inventoryStatus: "accepting" as const,
      requestRunId: undefined,
    },
    {
      name: "generated-run inventory when runId is mismatched",
      inventoryRunId: "11111111-1111-4111-8111-111111111111",
      inventoryStatus: "accepting" as const,
      requestRunId: "22222222-2222-4222-8222-222222222222",
    },
    {
      name: "generated-run inventory after closure",
      inventoryRunId: "11111111-1111-4111-8111-111111111111",
      inventoryStatus: "closed" as const,
      requestRunId: "11111111-1111-4111-8111-111111111111",
    },
    {
      name: "catalog inventory when runId is supplied",
      inventoryRunId: undefined,
      inventoryStatus: undefined,
      requestRunId: "11111111-1111-4111-8111-111111111111",
    },
  ])("rejects $name without changing stock", async (testCase) => {
    if (!redis) {
      throw new Error("Test Redis connection was not initialized.");
    }

    await initializeInventory(redis, {
      saleOfferId: fixtureIds.saleOffer,
      allocatedStock: 5,
      ...(testCase.inventoryRunId && testCase.inventoryStatus
        ? {
            run: {
              runId: testCase.inventoryRunId,
              status: testCase.inventoryStatus,
            },
          }
        : {}),
    });
    const server = await buildTestServer({
      persistence: new AcceptingPersistence(),
      stockReservations: createRedisStockReservations(redis),
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/buy",
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          ...(testCase.requestRunId ? { runId: testCase.requestRunId } : {}),
          idempotencyKey: `atomic-run-rejection-${testCase.name}`,
          quantity: 1,
        },
      });
      const payload = buyResponseSchema.parse(response.json());

      expect(response.statusCode).toBe(503);
      expect(payload).toMatchObject({
        outcome: "inventory_not_initialized",
        reason: "run_not_accepting_traffic",
        reservation: null,
        order: null,
      });
      expect(await getInventoryStatus(redis, fixtureIds.saleOffer)).toMatchObject({
        remainingStock: 5,
        reservedStock: 0,
        pendingPersistenceCount: 0,
      });
    } finally {
      await server.close();
    }
  });

  it("does not oversell through concurrent API requests and exposes the real Redis projection", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }

    const stock = 5;
    const requestCount = 12;
    const activeRedis = redis;
    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
      inventoryReader: { getStatus: (saleOfferId) => getInventoryStatus(activeRedis, saleOfferId) },
      generateId: randomUUID,
    });

    try {
      const responses = await Promise.all(
        Array.from({ length: requestCount }, (_, index) =>
          server.inject({
            method: "POST",
            url: "/buy",
            payload: {
              saleOfferId: fixtureIds.saleOffer,
              idempotencyKey: `concurrent-scarcity-${index}`,
              quantity: 1,
            },
          }),
        ),
      );
      const payloads = responses.map((response) => buyResponseSchema.parse(response.json()));
      const secured = payloads.filter((payload) => payload.outcome === "reservation_secured");
      const soldOut = payloads.filter((payload) => payload.outcome === "sold_out");
      const reservationRows = await connection.db.select().from(reservations);
      const orderRows = await connection.db.select().from(orders);
      const eventRows = await connection.db.select().from(orderEvents);
      const statusResponse = await server.inject({
        method: "GET",
        url: `/inventory/${fixtureIds.saleOffer}/status`,
      });
      const status = inventoryStatusSchema.parse(statusResponse.json());

      expect(secured).toHaveLength(stock);
      expect(soldOut).toHaveLength(requestCount - stock);
      expect(new Set(secured.map((payload) => payload.reservation?.id)).size).toBe(stock);
      expect(new Set(secured.map((payload) => payload.order?.id)).size).toBe(stock);
      expect(reservationRows).toHaveLength(stock);
      expect(orderRows).toHaveLength(stock);
      expect(eventRows).toHaveLength(stock * 2);
      expect(eventRows.filter((event) => event.eventName === "reservation.secured")).toHaveLength(
        stock,
      );
      expect(eventRows.filter((event) => event.eventName === "order.queued")).toHaveLength(stock);
      expect(statusResponse.statusCode).toBe(200);
      expect(status).toMatchObject({
        remainingStock: 0,
        reservedStock: stock,
        pendingPersistenceCount: 0,
        soldOutPressure: { rejectionCount: requestCount - stock },
      });
    } finally {
      await server.close();
    }
  });

  it("deduplicates concurrent API requests sharing one idempotency key", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }

    const realPersistence = new PostgresBuyPersistence(connection.db);
    let persistCallCount = 0;
    let recordPendingCallCount = 0;
    let releasePersistenceBarrier: (() => void) | undefined;
    const persistenceBarrier = new Promise<void>((resolve) => {
      releasePersistenceBarrier = resolve;
    });
    const controlledPersistence: BuyPersistence = {
      getPersistedBuyByReservationId: (reservationId) =>
        realPersistence.getPersistedBuyByReservationId(reservationId),
      persistSecuredReservation: async (input) => {
        persistCallCount += 1;
        if (persistCallCount === 2) {
          releasePersistenceBarrier?.();
        }
        await waitForInsertRaceBarrier(persistenceBarrier);
        return realPersistence.persistSecuredReservation(input);
      },
      recordPendingPersistence: async (input) => {
        recordPendingCallCount += 1;
        await realPersistence.recordPendingPersistence(input);
      },
      markPendingPersistenceReconciled: (input) =>
        realPersistence.markPendingPersistenceReconciled(input),
    };
    const reportPersistenceFailure = vi.fn();
    const server = await buildTestServer({
      persistence: controlledPersistence,
      stockReservations: createRedisStockReservations(redis),
      generateId: randomUUID,
      reportPersistenceFailure,
    });

    try {
      const responses = await Promise.all(
        Array.from({ length: 2 }, () =>
          server.inject({
            method: "POST",
            url: "/buy",
            payload: {
              saleOfferId: fixtureIds.saleOffer,
              idempotencyKey: "concurrent-shared-idempotency-key",
              quantity: 1,
            },
          }),
        ),
      );
      const payloads = responses.map((response) => buyResponseSchema.parse(response.json()));
      const reservationRows = await connection.db.select().from(reservations);
      const orderRows = await connection.db.select().from(orders);
      const eventRows = await connection.db.select().from(orderEvents);
      const pendingRows = await connection.db.select().from(reservationPendingPersistence);
      const inventoryStatus = await getInventoryStatus(redis, fixtureIds.saleOffer);
      const businessOutcome = await readBusinessOutcomeSummary(connection.db, {
        saleOfferId: fixtureIds.saleOffer,
      });
      const keys = inventoryKeys(fixtureIds.saleOffer);

      expect(responses.every((response) => response.statusCode === 202)).toBe(true);
      expect(reportPersistenceFailure).not.toHaveBeenCalled();
      expect(payloads.every((payload) => payload.outcome === "reservation_secured")).toBe(true);
      expect(payloads.filter((payload) => payload.outcome === "reservation_secured")).toHaveLength(
        2,
      );
      expect(persistCallCount).toBe(2);
      expect(recordPendingCallCount).toBe(0);
      expect(new Set(payloads.map((payload) => payload.reservation?.id)).size).toBe(1);
      expect(
        new Set(payloads.flatMap((payload) => (payload.order ? [payload.order.id] : []))).size,
      ).toBe(1);
      expect(reservationRows).toHaveLength(1);
      expect(orderRows).toHaveLength(1);
      expect(eventRows).toHaveLength(2);
      expect(eventRows.map((event) => event.eventName).sort()).toEqual([
        "order.queued",
        "reservation.secured",
      ]);
      expect(pendingRows).toEqual([]);
      expect(await redis.zcard(keys.pendingPersistence)).toBe(0);
      expect(await redis.hlen(keys.pendingPersistenceRecords)).toBe(0);
      expect(businessOutcome.pendingPersistenceCount).toBe(0);
      expect(inventoryStatus).toMatchObject({
        remainingStock: 4,
        reservedStock: 1,
        pendingPersistenceCount: 0,
        reservationThroughput: { successfulReservationCount: 1 },
      });
    } finally {
      await server.close();
    }
  });

  it("reconciles a Redis-secured hold after a transient PostgreSQL transaction failure", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }

    await connection.sql`
      DROP TRIGGER IF EXISTS order_events_reject_test_order_queued ON order_events
    `;
    await connection.sql`DROP FUNCTION IF EXISTS reject_test_order_queued_event()`;
    await connection.sql`
      CREATE FUNCTION reject_test_order_queued_event()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.event_name = 'order.queued' THEN
          RAISE EXCEPTION 'intentional order event persistence failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
    await connection.sql`
      CREATE TRIGGER order_events_reject_test_order_queued
      BEFORE INSERT ON order_events
      FOR EACH ROW EXECUTE FUNCTION reject_test_order_queued_event()
    `;

    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
      generateId: randomUUID,
    });

    try {
      const request = {
        method: "POST",
        url: "/buy",
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "real-postgres-transaction-failure",
          quantity: 2,
        },
      } as const;
      const response = await server.inject(request);
      const payload = buyResponseSchema.parse(response.json());
      const keys = inventoryKeys(fixtureIds.saleOffer);
      const pendingRowsAfterFailure = await connection.db
        .select()
        .from(reservationPendingPersistence)
        .where(eq(reservationPendingPersistence.reservationId, payload.reservation?.id ?? ""));

      expect(response.statusCode).toBe(202);
      expect(response.headers["retry-after"]).toBe("30");
      expect(payload.outcome).toBe("reservation_pending_persistence");
      expect(payload.order).toBeNull();
      expect(await connection.db.select().from(reservations)).toEqual([]);
      expect(await connection.db.select().from(orders)).toEqual([]);
      expect(await connection.db.select().from(orderEvents)).toEqual([]);
      expect(await redis.hgetall(keys.state)).toMatchObject({
        remainingStock: "3",
        reservedStock: "2",
      });
      expect(await redis.hlen(keys.reservations)).toBe(1);
      expect(await redis.zcard(keys.pendingPersistence)).toBe(1);
      expect(await getInventoryStatus(redis, fixtureIds.saleOffer)).toMatchObject({
        pendingPersistenceCount: 1,
      });
      expect(pendingRowsAfterFailure).toHaveLength(1);
      expect(pendingRowsAfterFailure[0]?.status).toBe("pending_reconciliation");

      await connection.sql`
        DROP TRIGGER IF EXISTS order_events_reject_test_order_queued ON order_events
      `;
      const retry = await server.inject(request);
      const retryPayload = buyResponseSchema.parse(retry.json());
      const pendingRowsAfterRetry = await connection.db
        .select()
        .from(reservationPendingPersistence)
        .where(eq(reservationPendingPersistence.reservationId, payload.reservation?.id ?? ""));

      expect(retry.statusCode).toBe(202);
      expect(retryPayload.outcome).toBe("reservation_secured");
      expect(retryPayload.reservation?.id).toBe(payload.reservation?.id);
      expect(retryPayload.order?.reservationId).toBe(payload.reservation?.id);
      expect(await connection.db.select().from(reservations)).toHaveLength(1);
      expect(await connection.db.select().from(orders)).toHaveLength(1);
      expect(await connection.db.select().from(orderEvents)).toHaveLength(2);
      expect(await redis.hgetall(keys.state)).toMatchObject({
        remainingStock: "3",
        reservedStock: "2",
      });
      expect(await redis.hlen(keys.reservations)).toBe(1);
      expect(await redis.zcard(keys.pendingPersistence)).toBe(0);
      expect(await getInventoryStatus(redis, fixtureIds.saleOffer)).toMatchObject({
        pendingPersistenceCount: 0,
      });
      expect(pendingRowsAfterRetry).toHaveLength(1);
      expect(pendingRowsAfterRetry[0]?.status).toBe("reconciled");
    } finally {
      try {
        await server.close();
      } finally {
        await connection.sql`
          DROP TRIGGER IF EXISTS order_events_reject_test_order_queued ON order_events
        `;
        await connection.sql`DROP FUNCTION IF EXISTS reject_test_order_queued_event()`;
      }
    }
  });

  it("records run-scoped pending-persistence state after a generated-run durable write failure", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }

    const generatedSaleOfferId = "99999999-9999-4999-8999-999999999999";
    const presetId = "88888888-8888-4888-8888-888888888888";

    await connection.db.insert(saleOffers).values({
      id: generatedSaleOfferId,
      productId: fixtureIds.product,
      name: "Generated API Test Sale Offer",
      allocatedStock: 3,
      saleStartsAt: new Date("2026-01-01T00:00:00.000Z"),
      saleEndsAt: new Date("2035-01-01T00:00:00.000Z"),
      isActive: true,
      purpose: "generated_run",
    });
    await connection.db.insert(demoPresets).values({
      id: presetId,
      slug: "generated-pending-test",
      visibility: "admin",
      isEditable: true,
      display: { name: "Generated Pending Test", description: "Run attribution test" },
      trafficConfig: {},
      inventoryConfig: {},
      erpConfig: {},
      backpressureConfig: {},
    });
    await connection.db.insert(demoRuns).values({
      id: fixtureIds.run,
      presetId,
      presetName: "Generated Pending Test",
      operatorMode: "admin",
      status: "active",
      trafficStatus: "active",
      configSnapshot: {
        trafficConfig: {},
        inventoryConfig: {},
        erpConfig: {},
        backpressureConfig: {},
      },
      saleOfferId: generatedSaleOfferId,
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await connection.db.insert(demoRunSaleContexts).values({
      runId: fixtureIds.run,
      saleOfferId: generatedSaleOfferId,
    });
    await initializeInventory(redis, {
      saleOfferId: generatedSaleOfferId,
      allocatedStock: 3,
      run: { runId: fixtureIds.run, status: "accepting" },
    });
    await connection.sql`
      DROP TRIGGER IF EXISTS order_events_reject_test_order_queued ON order_events
    `;
    await connection.sql`DROP FUNCTION IF EXISTS reject_test_order_queued_event()`;
    await connection.sql`
      CREATE FUNCTION reject_test_order_queued_event()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.event_name = 'order.queued' THEN
          RAISE EXCEPTION 'intentional generated-run order event persistence failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
    await connection.sql`
      CREATE TRIGGER order_events_reject_test_order_queued
      BEFORE INSERT ON order_events
      FOR EACH ROW EXECUTE FUNCTION reject_test_order_queued_event()
    `;

    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
      generateId: randomUUID,
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/buy",
        headers: {
          [loadRunIdHeaderName]: fixtureIds.run,
        },
        payload: {
          saleOfferId: generatedSaleOfferId,
          runId: fixtureIds.run,
          idempotencyKey: "generated-run-pending-persistence",
          quantity: 1,
        },
      });
      const payload = buyResponseSchema.parse(response.json());
      const pendingRows = await connection.db
        .select()
        .from(reservationPendingPersistence)
        .where(eq(reservationPendingPersistence.reservationId, payload.reservation?.id ?? ""));

      expect(response.statusCode).toBe(202);
      expect(payload.outcome).toBe("reservation_pending_persistence");
      expect(payload.reservation?.runId).toBe(fixtureIds.run);
      expect(payload.order).toBeNull();
      expect(await connection.db.select().from(reservations)).toEqual([]);
      expect(await connection.db.select().from(orders)).toEqual([]);
      expect(await connection.db.select().from(orderEvents)).toEqual([]);
      expect(pendingRows).toHaveLength(1);
      expect(pendingRows[0]).toMatchObject({
        reservationId: payload.reservation?.id,
        saleOfferId: generatedSaleOfferId,
        runId: fixtureIds.run,
        idempotencyKey: "generated-run-pending-persistence",
        quantity: 1,
        reservationToken: payload.reservation?.reservationToken,
        status: "pending_reconciliation",
      });
      expect(await getInventoryStatus(redis, generatedSaleOfferId)).toMatchObject({
        remainingStock: 2,
        reservedStock: 1,
        pendingPersistenceCount: 1,
      });
    } finally {
      try {
        await server.close();
      } finally {
        await connection.sql`
          DROP TRIGGER IF EXISTS order_events_reject_test_order_queued ON order_events
        `;
        await connection.sql`DROP FUNCTION IF EXISTS reject_test_order_queued_event()`;
      }
    }
  });

  it("rejects generated-run buys after lifecycle closure updates Redis admission", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }

    const generatedSaleOfferId = "99999999-9999-4999-8999-999999999998";
    const presetId = "88888888-8888-4888-8888-888888888887";

    await connection.db.insert(saleOffers).values({
      id: generatedSaleOfferId,
      productId: fixtureIds.product,
      name: "Generated Stale Closure Test Sale Offer",
      allocatedStock: 3,
      saleStartsAt: new Date("2026-01-01T00:00:00.000Z"),
      saleEndsAt: new Date("2035-01-01T00:00:00.000Z"),
      isActive: true,
      purpose: "generated_run",
    });
    await connection.db.insert(demoPresets).values({
      id: presetId,
      slug: "generated-stale-closure-test",
      visibility: "admin",
      isEditable: true,
      display: { name: "Generated Stale Closure Test", description: "Run closure test" },
      trafficConfig: {},
      inventoryConfig: {},
      erpConfig: {},
      backpressureConfig: {},
    });
    await connection.db.insert(demoRuns).values({
      id: fixtureIds.run,
      presetId,
      presetName: "Generated Stale Closure Test",
      operatorMode: "admin",
      status: "active",
      trafficStatus: "active",
      configSnapshot: {
        trafficConfig: {},
        inventoryConfig: {},
        erpConfig: {},
        backpressureConfig: {},
      },
      saleOfferId: generatedSaleOfferId,
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await connection.db.insert(demoRunSaleContexts).values({
      runId: fixtureIds.run,
      saleOfferId: generatedSaleOfferId,
    });
    await initializeInventory(redis, {
      saleOfferId: generatedSaleOfferId,
      allocatedStock: 3,
      run: { runId: fixtureIds.run, status: "accepting" },
    });
    await connection.db
      .update(demoRuns)
      .set({
        status: "draining",
        trafficStatus: "succeeded",
        trafficEndedAt: new Date("2026-01-01T00:00:05.000Z"),
        updatedAt: new Date("2026-01-01T00:00:05.000Z"),
      })
      .where(eq(demoRuns.id, fixtureIds.run));
    await setRunSaleEligibility(redis, {
      runId: fixtureIds.run,
      saleOfferId: generatedSaleOfferId,
      status: "closed",
    });

    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
      generateId: randomUUID,
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/buy",
        headers: {
          [loadRunIdHeaderName]: fixtureIds.run,
        },
        payload: {
          saleOfferId: generatedSaleOfferId,
          runId: fixtureIds.run,
          idempotencyKey: "generated-run-stale-closure",
          quantity: 1,
        },
      });
      const payload = buyResponseSchema.parse(response.json());

      expect(response.statusCode).toBe(503);
      expect(payload).toMatchObject({
        outcome: "inventory_not_initialized",
        reason: "run_not_accepting_traffic",
        reservation: null,
        order: null,
      });
      expect(await redis.hget(inventoryKeys(generatedSaleOfferId).state, "runSaleStatus")).toBe(
        "closed",
      );
      expect(await getInventoryStatus(redis, generatedSaleOfferId)).toMatchObject({
        remainingStock: 3,
        reservedStock: 0,
        pendingPersistenceCount: 0,
      });
      expect(
        await connection.db
          .select()
          .from(reservations)
          .where(eq(reservations.saleOfferId, generatedSaleOfferId)),
      ).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("checks reachable and unavailable Redis readiness directly", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }

    const reachableChecks = await createInfrastructureReadinessCheck(connection.sql, redis, {
      checkConnectivity: async () => undefined,
    }).checks();
    const unavailableRedis = redis.duplicate({ lazyConnect: true });
    await unavailableRedis.connect();
    await unavailableRedis.quit();
    const unavailableChecks = await createInfrastructureReadinessCheck(
      connection.sql,
      unavailableRedis,
      { checkConnectivity: async () => undefined },
    ).checks();
    const unavailableRedisCheck = unavailableChecks.find(
      (check) => check.name === "redis_reachable",
    );
    const unavailableQueueChecks = await createInfrastructureReadinessCheck(connection.sql, redis, {
      checkConnectivity: async () => Promise.reject(new Error("BullMQ command failed")),
    }).checks();

    expect(reachableChecks).toContainEqual({ name: "redis_reachable", status: "ok" });
    expect(reachableChecks).toContainEqual({
      name: "order_process_queue_reachable",
      status: "ok",
    });
    expect(unavailableRedisCheck).toEqual({
      name: "redis_reachable",
      status: "unavailable",
      message: expect.any(String),
    });
    expect(unavailableRedisCheck?.message).not.toHaveLength(0);
    expect(unavailableQueueChecks).toContainEqual({
      name: "order_process_queue_reachable",
      status: "unavailable",
      message: "BullMQ command failed",
    });
  });

  it("rejects uninitialized inventory without PostgreSQL writes", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }

    const missingSaleOfferId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/buy",
        headers: {
          "x-correlation-id": "missing-offer-correlation",
        },
        payload: {
          saleOfferId: missingSaleOfferId,
          idempotencyKey: "missing-offer-idem-1",
          quantity: 1,
        },
      });
      const payload = buyResponseSchema.parse(response.json());
      const reservationRows = await connection.db
        .select()
        .from(reservations)
        .where(eq(reservations.saleOfferId, missingSaleOfferId));

      expect(response.statusCode).toBe(503);
      expect(payload.outcome).toBe("inventory_not_initialized");
      if (payload.outcome !== "inventory_not_initialized") {
        throw new Error(`Expected missing offer rejection, received ${payload.outcome}.`);
      }
      expect(payload.reason).toBe("inventory_not_initialized");
      expect(payload.reservation).toBeNull();
      expect(payload.order).toBeNull();
      expect(reservationRows).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("keeps sold-out requests on Redis without PostgreSQL writes", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }

    await redis.hset(`inventory:${fixtureIds.saleOffer}:state`, {
      remainingStock: "0",
      reservedStock: "5",
    });

    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/buy",
        headers: {
          "x-correlation-id": "inactive-offer-correlation",
        },
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "inactive-offer-idem-1",
          quantity: 1,
        },
      });
      const payload = buyResponseSchema.parse(response.json());
      const reservationRows = await connection.db
        .select()
        .from(reservations)
        .where(eq(reservations.saleOfferId, fixtureIds.saleOffer));

      expect(response.statusCode).toBe(409);
      expect(payload.outcome).toBe("sold_out");
      if (payload.outcome !== "sold_out") {
        throw new Error(`Expected sold-out rejection, received ${payload.outcome}.`);
      }
      expect(payload.reason).toBe("sold_out");
      expect(payload.reservation).toBeNull();
      expect(payload.order).toBeNull();
      expect(reservationRows).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("returns retryable pending without consuming additional stock while PostgreSQL remains unavailable", async () => {
    if (!redis) {
      throw new Error("Test Redis connection was not initialized.");
    }
    const redisGateway = createRedisStockReservations(redis);
    const gateway: StockReservationGateway = {
      ...redisGateway,
      markPendingPersistence: async () => {
        throw new Error("simulated pending marker ensure failure");
      },
    };
    const failingPersistence: BuyPersistence = {
      persistSecuredReservation: async () => {
        throw new Error("simulated PostgreSQL failure");
      },
      getPersistedBuyByReservationId: async () => null,
    };
    const server = await buildTestServer({
      persistence: failingPersistence,
      stockReservations: gateway,
    });

    try {
      const request = {
        method: "POST" as const,
        url: "/buy",
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "pending-persistence-idem",
          quantity: 2,
        },
      };
      const first = await server.inject(request);
      const replay = await server.inject(request);
      const firstPayload = buyResponseSchema.parse(first.json());
      const replayPayload = buyResponseSchema.parse(replay.json());
      const status = await getInventoryStatus(redis, fixtureIds.saleOffer);

      expect(first.statusCode).toBe(202);
      expect(first.headers["retry-after"]).toBe("30");
      expect(firstPayload.outcome).toBe("reservation_pending_persistence");
      expect(replayPayload.outcome).toBe("reservation_pending_persistence");
      expect(replayPayload.reservation?.id).toBe(firstPayload.reservation?.id);
      expect(replayPayload.order).toBeNull();
      expect(status).toMatchObject({
        remainingStock: 3,
        reservedStock: 2,
        pendingPersistenceCount: 1,
      });
    } finally {
      await server.close();
    }
  });

  it("returns the durable reservation and order for an accepted replay without duplicates", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }
    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
    });

    try {
      const request = {
        method: "POST" as const,
        url: "/buy",
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "accepted-replay-idem",
          quantity: 1,
        },
      };
      const firstPayload = buyResponseSchema.parse((await server.inject(request)).json());
      const replayPayload = buyResponseSchema.parse((await server.inject(request)).json());
      const reservationRows = await connection.db.select().from(reservations);
      const orderRows = await connection.db.select().from(orders);
      const eventRows = await connection.db.select().from(orderEvents);
      const inventoryStatus = await getInventoryStatus(redis, fixtureIds.saleOffer);

      expect(firstPayload.outcome).toBe("reservation_secured");
      expect(replayPayload.outcome).toBe("reservation_secured");
      if (
        firstPayload.outcome !== "reservation_secured" ||
        replayPayload.outcome !== "reservation_secured"
      ) {
        throw new Error("Expected secured and idempotent replay outcomes.");
      }
      expect(replayPayload.reservation.id).toBe(firstPayload.reservation.id);
      expect(replayPayload.order.id).toBe(firstPayload.order.id);
      expect(reservationRows).toHaveLength(1);
      expect(orderRows).toHaveLength(1);
      expect(eventRows).toHaveLength(2);
      expect(inventoryStatus.reservationThroughput.successfulReservationCount).toBe(1);
      expect(await redis.llen(inventoryKeys(fixtureIds.saleOffer).events)).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("keeps confirmed and failed durable replays acceptance-shaped", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }
    const enqueue = vi.fn<OrderProcessJobPublisher["enqueue"]>(async () => undefined);
    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
      orderProcessJobPublisher: { enqueue },
      generateId: randomUUID,
    });

    try {
      const cases = [
        {
          idempotencyKey: "confirmed-acceptance-replay",
          originalCorrelationId: "confirmed-original-correlation",
          retryCorrelationId: "confirmed-retry-correlation",
          terminal: {
            status: "confirmed" as const,
            processingAt: new Date("2026-07-12T12:01:00.000Z"),
            confirmedAt: new Date("2026-07-12T12:02:00.000Z"),
          },
        },
        {
          idempotencyKey: "failed-acceptance-replay",
          originalCorrelationId: "failed-original-correlation",
          retryCorrelationId: "failed-retry-correlation",
          terminal: {
            status: "failed" as const,
            processingAt: new Date("2026-07-12T12:03:00.000Z"),
            failedAt: new Date("2026-07-12T12:04:00.000Z"),
            failureCode: "erp_rejected",
            failureMessage: "Payment declined",
          },
        },
      ];

      for (const testCase of cases) {
        const payload = {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: testCase.idempotencyKey,
          quantity: 1,
        };
        const firstResponse = await server.inject({
          method: "POST",
          url: "/buy",
          headers: { [correlationIdHeaderName]: testCase.originalCorrelationId },
          payload,
        });
        if (firstResponse.statusCode !== 202) {
          throw new Error(`Initial buy failed: ${firstResponse.body}`);
        }
        const first = buyResponseSchema.parse(firstResponse.json());
        if (first.outcome !== "reservation_secured") {
          throw new Error("Expected initial durable acceptance.");
        }

        await connection.db
          .update(orders)
          .set(testCase.terminal)
          .where(eq(orders.id, first.order.id));

        const replayResponse = await server.inject({
          method: "POST",
          url: "/buy",
          headers: { [correlationIdHeaderName]: testCase.retryCorrelationId },
          payload,
        });
        const replay = buyResponseSchema.parse(replayResponse.json());
        if (replay.outcome !== "reservation_secured") {
          throw new Error("Expected acceptance-shaped durable replay.");
        }

        const { correlationId: _firstCorrelation, ...stableFirst } = first;
        const { correlationId: _replayCorrelation, ...stableReplay } = replay;
        expect(stableReplay).toEqual(stableFirst);
        expect(replay.correlationId).toBe(testCase.retryCorrelationId);
        expect(replayResponse.headers[correlationIdHeaderName]).toBe(testCase.retryCorrelationId);
        expect(replay.timestamp).toBe(first.timestamp);
        expect(replay.reservation.correlationId).toBe(testCase.originalCorrelationId);
        expect(replay.order.correlationId).toBe(testCase.originalCorrelationId);
        expect(replay.order.status).toBe("queued");
      }

      const durableOrders = await connection.db.select().from(orders);
      const reservationRows = await connection.db.select().from(reservations);
      const eventRows = await connection.db.select().from(orderEvents);
      expect(durableOrders.map((order) => order.status).sort()).toEqual(["confirmed", "failed"]);
      expect(reservationRows).toHaveLength(2);
      expect(durableOrders).toHaveLength(2);
      expect(eventRows).toHaveLength(4);
      expect(eventRows.map((event) => event.eventName).sort()).toEqual([
        "order.queued",
        "order.queued",
        "reservation.secured",
        "reservation.secured",
      ]);
      expect(await getInventoryStatus(redis, fixtureIds.saleOffer)).toMatchObject({
        remainingStock: 3,
        reservedStock: 2,
      });
      expect(enqueue).toHaveBeenCalledTimes(4);
      expect(new Set(enqueue.mock.calls.map(([job]) => job.orderId)).size).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("maps an idempotency quantity conflict without changing Redis or PostgreSQL", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }
    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
    });

    try {
      await server.inject({
        method: "POST",
        url: "/buy",
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "conflicting-api-idem",
          quantity: 1,
        },
      });
      const conflict = await server.inject({
        method: "POST",
        url: "/buy",
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "conflicting-api-idem",
          quantity: 2,
        },
      });
      const payload = buyResponseSchema.parse(conflict.json());

      expect(conflict.statusCode).toBe(409);
      expect(payload.outcome).toBe("idempotency_conflict");
      expect(await connection.db.select().from(reservations)).toHaveLength(1);
      expect(await connection.db.select().from(orders)).toHaveLength(1);
      expect(await getInventoryStatus(redis, fixtureIds.saleOffer)).toMatchObject({
        remainingStock: 4,
        reservedStock: 1,
      });
    } finally {
      await server.close();
    }
  });

  it("heals Redis promotion on retry after PostgreSQL already committed", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }
    const redisGateway = createRedisStockReservations(redis);
    let promotionAttempts = 0;
    const gateway: StockReservationGateway = {
      ...redisGateway,
      promoteAccepted: async (input) => {
        promotionAttempts += 1;
        if (promotionAttempts === 1) {
          throw new Error("simulated Redis promotion failure");
        }
        await redisGateway.promoteAccepted(input);
      },
    };
    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: gateway,
    });

    try {
      const request = {
        method: "POST" as const,
        url: "/buy",
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "promotion-recovery-idem",
          quantity: 1,
        },
      };
      const firstResponse = await server.inject(request);
      const firstPayload = buyResponseSchema.parse(firstResponse.json());
      const statusBeforeRetry = await getInventoryStatus(redis, fixtureIds.saleOffer);
      const replayPayload = buyResponseSchema.parse((await server.inject(request)).json());

      expect(firstResponse.statusCode).toBe(202);
      expect(firstPayload.outcome).toBe("reservation_secured");
      expect(statusBeforeRetry.pendingPersistenceCount).toBe(1);
      expect(replayPayload.outcome).toBe("reservation_secured");
      expect(await connection.db.select().from(reservations)).toHaveLength(1);
      expect(await connection.db.select().from(orders)).toHaveLength(1);
      expect((await getInventoryStatus(redis, fixtureIds.saleOffer)).pendingPersistenceCount).toBe(
        0,
      );
    } finally {
      await server.close();
    }
  });
});
