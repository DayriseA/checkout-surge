import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AcceptedRunConfigSnapshot,
  BusinessOutcomeSummary,
  PublicRuntimePolicy,
  PublicRuntimePolicyMutable,
  TrafficCompletionReport,
  TrafficConfig,
  TrafficExecutionStartRequest,
} from "@checkout-surge/contracts";
import {
  controlServiceTokenHeaderName,
  emptyHttpTimingBreakdownSummary,
  trafficDeliverySummarySchema,
  trafficExecutionStartPath,
} from "@checkout-surge/contracts";
import { signPublicVisitorCredential } from "@checkout-surge/contracts/public-visitor-credential";
import {
  completeGeneratedRunTeardown,
  createDatabaseConnection,
  createRedisClient,
  deleteGeneratedRunDurable,
  deleteGeneratedRunRedisState,
  demoPresets,
  demoRunFinalizations,
  demoRunReservationOutcomes,
  demoRunSaleContexts,
  demoRunSummaries,
  demoRuns,
  getInventoryStatus,
  initializeInventory,
  inventoryKeys,
  isRunSaleEligible,
  prepareGeneratedRunTeardown,
  products,
  publicRuntimePolicies,
  reserveInventoryStock,
  runSaleEligibilityKey,
  saleOffers,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiHttpError } from "../src/runtime/errors.js";
import { DemoMaintenanceService } from "../src/services/demo-maintenance-service.js";
import { DemoRunFinalizationService } from "../src/services/demo-run-finalization-service.js";
import {
  DemoRunService,
  DemoRunValidationError,
  HttpTrafficExecutionGateway,
  isSingleNonTerminalRunViolation,
  maximumPendingMetricBatches,
  RedisDashboardTrafficMetricStore,
  resolveEffectivePublicRuntimePolicy,
  validateAcceptedRunSnapshot,
  validateActivePublicRuntimePolicyAtStartup,
} from "../src/services/demo-run-service.js";
import { PostgresDemoResetWorkflowFence } from "../src/services/postgres-demo-reset-workflow-fence.js";
import { RedisPublicRunBudgetStore } from "../src/services/public-run-budget-store.js";
import { PostgresTerminalDemoRunSummaryWriter } from "../src/services/terminal-demo-run-transition.js";
import { findTrafficCompletionBindingMismatch } from "../src/services/traffic-completion-binding.js";
import { TrafficCompletionEnrichmentService } from "../src/services/traffic-completion-enrichment-service.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPackageRoot = path.resolve(packageRoot, "../../packages/db");
const migrationsFolder = path.join(dbPackageRoot, "drizzle");
const publicCookieSecret = "test-public-cookie-secret";
const signedVisitor = (visitorId: string) => {
  const credential = signPublicVisitorCredential(publicCookieSecret, visitorId, 1_750_000_000_000);
  if (!credential) throw new Error("Fixture visitor credential could not be signed.");
  return credential;
};

describe("demo-run service validation", () => {
  it.each([
    ["missing", undefined],
    ["raw", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ["malformed", "malformed.credential"],
    ["tampered", `${signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")}0`],
    [
      "wrong secret",
      signPublicVisitorCredential(
        "different-cookie-secret",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        1_750_000_000_000,
      ),
    ],
  ])("rejects %s public credentials before persistence or budget mutation", async (_case, credential) => {
    const select = vi.fn(() => {
      throw new Error("Database must not be read.");
    });
    const reserve = vi.fn();
    const service = new DemoRunService({
      db: { select } as never,
      redis: {} as never,
      trafficExecutionGateway: {} as never,
      publicRunBudgetStore: { reserve, release: vi.fn() },
      trafficMetricStore: {} as never,
      businessOutcomeReader: {} as never,
      completionEnrichmentService: {} as never,
      terminalRunWriter: {} as never,
      finalizationService: noOpFinalizationService(),
      apiBaseUrl: "http://api.test",
      buyEndpointPath: "/buy",
      logger: createSilentLogger("api"),
      publicClientCookieSecret: publicCookieSecret,
      deploymentHardCaps: publicRuntimePolicy().deploymentHardCaps,
    });
    await expect(
      service.startRun(
        {
          presetSlug: "preview-1k",
          operatorMode: "public",
          ...(credential ? { publicVisitorCredential: credential } : {}),
        },
        "credential-correlation",
      ),
    ).rejects.toMatchObject({ code: "public_visitor_forbidden" });
    expect(select).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("identifies only the exact wrapped single-run unique violation", () => {
    expect(
      isSingleNonTerminalRunViolation({
        cause: {
          code: "23505",
          constraint_name: "demo_runs_single_non_terminal_idx",
        },
      }),
    ).toBe(true);
    expect(
      isSingleNonTerminalRunViolation({
        code: "23505",
        constraint_name: "demo_runs_sale_offer_id_unique",
      }),
    ).toBe(false);
    expect(
      isSingleNonTerminalRunViolation({
        code: "23503",
        constraint_name: "demo_runs_single_non_terminal_idx",
      }),
    ).toBe(false);
  });

  it("allows curated public presets to exceed public-custom caps while enforcing deployment caps", () => {
    expect(() =>
      validateAcceptedRunSnapshot(surge10kSnapshot(), publicRuntimePolicy(), {
        operatorMode: "public",
        enforcePublicCustomLimits: false,
      }),
    ).not.toThrow();
  });

  it("keeps public custom starts inside public-custom caps", () => {
    expect(() =>
      validateAcceptedRunSnapshot(surge10kSnapshot(), publicRuntimePolicy(), {
        operatorMode: "public",
        enforcePublicCustomLimits: true,
      }),
    ).toThrow(DemoRunValidationError);
  });

  it.each([
    {
      ratePerSecond: 5_001,
      maxPreAllocatedVus: 5_000,
      maxVus: 10_000,
      expectedCode: "deployment_preallocated_vus_exceeded",
      expectedDetails: { value: 5_001, cap: 5_000 },
    },
    {
      ratePerSecond: 2_501,
      maxPreAllocatedVus: 5_000,
      maxVus: 5_000,
      expectedCode: "deployment_max_vus_exceeded",
      expectedDetails: { value: 5_002, cap: 5_000 },
    },
  ])("rejects automatically derived VUs with $expectedCode", (fixture) => {
    const policy = publicRuntimePolicy();
    policy.deploymentHardCaps.maxPreAllocatedVus = fixture.maxPreAllocatedVus;
    policy.deploymentHardCaps.maxVus = fixture.maxVus;
    const snapshot: AcceptedRunConfigSnapshot = {
      ...surge10kSnapshot(),
      trafficConfig: {
        mode: "steady-arrival-rate",
        ratePerSecond: fixture.ratePerSecond,
        startDelaySeconds: 0,
        durationSeconds: 1,
        quantityPerAttempt: 1,
      },
    };

    expect(() =>
      validateAcceptedRunSnapshot(snapshot, policy, {
        operatorMode: "admin",
        enforcePublicCustomLimits: false,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: fixture.expectedCode,
        details: fixture.expectedDetails,
      }),
    );
  });

  it("binds buyer-spike completion plan, counts, and runner start to the accepted run", () => {
    const report = trafficCompletionFixture({
      runId: "55555555-5555-4555-8555-555555555551",
      status: "succeeded",
      exitCode: 0,
      completedAt: "2026-06-20T00:00:12.000Z",
      plannedRequests: 10_000,
      correlationId: "completion-binding",
    });
    const accepted = {
      runId: report.runId,
      configSnapshot: surge10kSnapshot(),
      acceptedAt: new Date("2026-06-20T00:00:10.000Z"),
      trafficStartedAt: new Date("2026-06-20T00:00:11.000Z"),
    };

    expect(findTrafficCompletionBindingMismatch(accepted, report)).toBeNull();
    expect(
      findTrafficCompletionBindingMismatch(accepted, {
        ...report,
        loadRunDiagnosticsSummary: {
          ...report.loadRunDiagnosticsSummary,
          executionPlan: {
            trafficMode: "buyer-spike",
            buyerCount: 9_999,
            duplicateEachBuyerAttempt: false,
            iterationsPerVu: 1,
            plannedEmittedAttempts: 9_999,
            startDelaySeconds: 0,
            maxDurationSeconds: 2,
          },
        },
        httpSummary: { ...report.httpSummary, plannedRequests: 9_999 },
        trafficDeliverySummary: {
          ...report.trafficDeliverySummary,
          plannedRequests: 9_999,
          plannedBuyers: 9_999,
        },
      }),
    ).toMatchObject({ field: "loadRunDiagnosticsSummary.executionPlan" });
    expect(
      findTrafficCompletionBindingMismatch(
        { ...accepted, trafficStartedAt: new Date("2026-06-20T00:00:10.000Z") },
        report,
      ),
    ).toMatchObject({ field: "loadRunDiagnosticsSummary.startedAt" });
  });

  it("rejects a fast-completion runner start before the API accepted the run", () => {
    const report = trafficCompletionFixture({
      runId: "55555555-5555-4555-8555-555555555551",
      status: "succeeded",
      exitCode: 0,
      completedAt: "2026-06-20T00:00:12.000Z",
      plannedRequests: 10_000,
      correlationId: "completion-before-acceptance",
    });
    const staleReport = {
      ...report,
      loadRunDiagnosticsSummary: {
        ...report.loadRunDiagnosticsSummary,
        startedAt: "2026-06-20T00:00:09.999Z",
      },
    };

    expect(
      findTrafficCompletionBindingMismatch(
        {
          runId: report.runId,
          configSnapshot: surge10kSnapshot(),
          acceptedAt: new Date("2026-06-20T00:00:10.000Z"),
          trafficStartedAt: null,
        },
        staleReport,
      ),
    ).toEqual({
      field: "loadRunDiagnosticsSummary.startedAt",
      expected: { notBefore: "2026-06-20T00:00:10.000Z" },
      actual: "2026-06-20T00:00:09.999Z",
    });
  });

  it("binds steady-arrival mode, rate, duration, and VU identity", () => {
    const base = trafficCompletionFixture({
      runId: "55555555-5555-4555-8555-555555555552",
      status: "succeeded",
      exitCode: 0,
      completedAt: "2026-06-20T00:00:12.000Z",
      plannedRequests: 20,
      correlationId: "steady-completion-binding",
    });
    const report: TrafficCompletionReport = {
      ...base,
      loadRunDiagnosticsSummary: {
        ...base.loadRunDiagnosticsSummary,
        executionPlan: {
          trafficMode: "steady-arrival-rate",
          ratePerSecond: 5,
          durationSeconds: 4,
          plannedEmittedAttempts: 20,
          startDelaySeconds: 0,
          preAllocatedVus: 3,
          maxVus: 6,
        },
      },
      trafficDeliverySummary: {
        ...base.trafficDeliverySummary,
        trafficMode: "steady-arrival-rate",
        plannedBuyers: null,
        scheduledRatePerSecond: 5,
        configuredDurationSeconds: 4,
        preAllocatedVUs: 3,
        maxVUs: 6,
      },
    };
    const configSnapshot: AcceptedRunConfigSnapshot = {
      ...surge10kSnapshot(),
      trafficConfig: {
        mode: "steady-arrival-rate",
        ratePerSecond: 5,
        durationSeconds: 4,
        startDelaySeconds: 0,
        quantityPerAttempt: 1,
        k6Vus: { preAllocatedVus: 3, maxVus: 6 },
      },
    };

    expect(
      findTrafficCompletionBindingMismatch(
        {
          runId: report.runId,
          configSnapshot,
          acceptedAt: new Date("2026-06-20T00:00:10.000Z"),
          trafficStartedAt: null,
        },
        report,
      ),
    ).toBeNull();
    expect(
      findTrafficCompletionBindingMismatch(
        {
          runId: report.runId,
          configSnapshot: {
            ...configSnapshot,
            trafficConfig: {
              ...configSnapshot.trafficConfig,
              k6Vus: { preAllocatedVus: 4, maxVus: 8 },
            },
          },
          acceptedAt: new Date("2026-06-20T00:00:10.000Z"),
          trafficStartedAt: null,
        },
        report,
      ),
    ).toMatchObject({ field: "loadRunDiagnosticsSummary.executionPlan" });
  });

  it("constructs effective policy from strict mutable persistence and current caps", () => {
    const effectiveFixture = publicRuntimePolicy();
    const persisted = publicRuntimePolicyMutable();
    const currentCaps = { ...effectiveFixture.deploymentHardCaps, maxBuyers: 20_000 };

    const effective = resolveEffectivePublicRuntimePolicy(persisted, currentCaps);

    expect(effective.deploymentHardCaps.maxBuyers).toBe(20_000);
    expect(persisted).not.toHaveProperty("deploymentHardCaps");
    expect(() =>
      resolveEffectivePublicRuntimePolicy(
        { ...persisted, deploymentHardCaps: effectiveFixture.deploymentHardCaps },
        currentCaps,
      ),
    ).toThrow(/Unrecognized key.*deploymentHardCaps/i);
  });
});

describe("demo-run metric ingestion acceptance", () => {
  type PublishAccepted = Parameters<RedisDashboardTrafficMetricStore["appendAndPublishIfLive"]>[1];
  type WithAdmission = NonNullable<
    Parameters<RedisDashboardTrafficMetricStore["appendAndPublishIfLive"]>[2]
  >;
  const metricRequest = {
    runId: "55555555-5555-4555-8555-555555555551",
    correlationId: "metric-correlation",
    samples: [
      {
        metricName: "traffic.latency" as const,
        value: 42,
        unit: "ms",
        timestamp: "2026-07-14T00:00:00.000Z",
      },
      {
        metricName: "traffic.failure_rate" as const,
        value: 0.1,
        unit: "ratio",
        timestamp: "2026-07-14T00:00:01.000Z",
      },
      {
        metricName: "traffic.scheduled_request_rate" as const,
        value: 100,
        unit: "requests_per_second",
        timestamp: "2026-07-14T00:00:02.000Z",
      },
    ],
    observedAt: "2026-07-14T00:00:02.000Z",
  };

  it("retains before canonical publication and does not warn on success", async () => {
    const order: string[] = [];
    const publishedPayloads: string[][] = [];
    const warn = vi.fn();
    const appendAndPublishIfLive = vi.fn(
      async (_request: unknown, publishAccepted: PublishAccepted, withAdmission: WithAdmission) =>
        withAdmission(async () => {
          order.push("append");
          await publishAccepted(async (payloads) => {
            order.push("publish");
            publishedPayloads.push(payloads);
            return { outcome: "attempted", failures: [] };
          });
          return "accepted" as const;
        }),
    );
    const service = createMetricIngestionService({
      appendAndPublishIfLive,
      warn,
    });

    await expect(service.ingestMetrics(metricRequest)).resolves.toBeUndefined();

    expect(appendAndPublishIfLive).toHaveBeenCalledOnce();
    expect(order).toEqual(["append", "publish"]);
    expect(publishedPayloads).toHaveLength(1);
    expect(publishedPayloads[0]?.map((payload) => JSON.parse(payload))).toEqual([
      expect.objectContaining({
        type: "dashboard.metric.observed",
        runId: metricRequest.runId,
        correlationId: metricRequest.correlationId,
        metricName: "traffic.latency",
        value: 42,
        unit: "ms",
        occurredAt: "2026-07-14T00:00:00.000Z",
        observedAt: "2026-07-14T00:00:00.000Z",
      }),
      expect.objectContaining({ metricName: "traffic.failure_rate" }),
      expect.objectContaining({ metricName: "traffic.scheduled_request_rate" }),
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("contains mixed validation and transport failures and continues later samples", async () => {
    const transportError = new Error("pubsub unavailable");
    const publishedPayloads: string[][] = [];
    const warn = vi.fn();
    const appendAndPublishIfLive = vi.fn(
      async (_request: unknown, publishAccepted: PublishAccepted, withAdmission: WithAdmission) =>
        withAdmission(async () => {
          await publishAccepted(async (payloads) => {
            publishedPayloads.push(payloads);
            throw transportError;
          });
          return "accepted" as const;
        }),
    );
    const service = createMetricIngestionService({
      appendAndPublishIfLive,
      warn,
    });

    await expect(
      service.ingestMetrics({
        ...metricRequest,
        samples: metricRequest.samples.map((sample) =>
          sample.metricName === "traffic.failure_rate" ? { ...sample, value: 2 } : sample,
        ),
      }),
    ).resolves.toBeUndefined();

    expect(publishedPayloads).toHaveLength(1);
    expect(publishedPayloads[0]?.map((payload) => JSON.parse(payload).metricName)).toEqual([
      "traffic.latency",
      "traffic.scheduled_request_rate",
    ]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: transportError,
        runId: metricRequest.runId,
        correlationId: metricRequest.correlationId,
        metricName: "traffic.scheduled_request_rate",
      }),
      "Could not publish traffic metric dashboard event.",
    );
  });

  it("warns only for a failed sample publication and still attempts the later sample", async () => {
    const samplePublicationError = new Error("sample publish failed");
    const publishedPayloads: string[][] = [];
    const warn = vi.fn();
    const appendAndPublishIfLive = vi.fn(
      async (_request: unknown, publishAccepted: PublishAccepted, withAdmission: WithAdmission) =>
        withAdmission(async () => {
          await publishAccepted(async (payloads) => {
            publishedPayloads.push(payloads);
            return {
              outcome: "attempted",
              failures: [{ index: 1, error: samplePublicationError }],
            };
          });
          return "accepted" as const;
        }),
    );
    const service = createMetricIngestionService({
      appendAndPublishIfLive,
      warn,
    });

    await expect(service.ingestMetrics(metricRequest)).resolves.toBeUndefined();

    expect(publishedPayloads[0]?.map((payload) => JSON.parse(payload).metricName)).toEqual([
      "traffic.latency",
      "traffic.failure_rate",
      "traffic.scheduled_request_rate",
    ]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      {
        err: samplePublicationError,
        runId: metricRequest.runId,
        correlationId: metricRequest.correlationId,
        metricName: "traffic.failure_rate",
      },
      "Could not publish traffic metric dashboard event.",
    );
  });

  it("does not let a throwing warning logger redefine accepted retention", async () => {
    const appendAndPublishIfLive = vi.fn(
      async (_request: unknown, publishAccepted: PublishAccepted, withAdmission: WithAdmission) =>
        withAdmission(async () => {
          await publishAccepted(async () => ({
            outcome: "attempted",
            failures: [{ index: 0, error: new Error("sample publish failed") }],
          }));
          return "accepted" as const;
        }),
    );
    const warn = vi.fn(() => {
      throw new Error("logger unavailable");
    });
    const service = createMetricIngestionService({
      appendAndPublishIfLive,
      warn,
    });

    await expect(service.ingestMetrics(metricRequest)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("propagates retention failure without publishing events", async () => {
    const retentionError = new Error("retention unavailable");
    const publishAccepted = vi.fn();
    const appendAndPublishIfLive = vi.fn(
      async (_request: unknown, callback: PublishAccepted, withAdmission: WithAdmission) =>
        withAdmission(async () => {
          publishAccepted.mockImplementation(callback);
          throw retentionError;
        }),
    );
    const service = createMetricIngestionService({
      appendAndPublishIfLive,
      warn: vi.fn(),
    });

    await expect(service.ingestMetrics(metricRequest)).rejects.toBe(retentionError);
    expect(publishAccepted).not.toHaveBeenCalled();
  });

  it("rejects missing and wrong-lifecycle runs before executing admitted Redis work", async () => {
    const redisOperation = vi.fn(async () => "accepted" as const);
    const appendAndPublishIfLive = vi.fn(
      async (_request: unknown, _callback: PublishAccepted, withAdmission: WithAdmission) =>
        withAdmission(redisOperation),
    );
    const missing = createMetricIngestionService({
      appendAndPublishIfLive,
      warn: vi.fn(),
      run: null,
    });
    const draining = createMetricIngestionService({
      appendAndPublishIfLive,
      warn: vi.fn(),
      run: { status: "draining", trafficStatus: "succeeded" },
    });

    await expect(missing.ingestMetrics(metricRequest)).rejects.toMatchObject({
      code: "run_not_found",
      details: { runId: metricRequest.runId },
    });
    await expect(draining.ingestMetrics(metricRequest)).rejects.toMatchObject({
      code: "traffic_metric_run_not_eligible",
      details: {
        runId: metricRequest.runId,
        status: "draining",
        trafficStatus: "succeeded",
      },
    });
    expect(appendAndPublishIfLive).toHaveBeenCalledTimes(2);
    expect(redisOperation).not.toHaveBeenCalled();
  });

  it("reserves bounded queue capacity before DB admission and holds admission around Redis", async () => {
    let releaseFirstRetention: (() => void) | undefined;
    let markFirstRetentionEntered: (() => void) | undefined;
    const firstRetentionGate = new Promise<void>((resolve) => {
      releaseFirstRetention = resolve;
    });
    const firstRetentionEntered = new Promise<void>((resolve) => {
      markFirstRetentionEntered = resolve;
    });
    let transactionCount = 0;
    let transactionOpen = false;
    const redisObservedTransaction: boolean[] = [];
    const evalCommand = vi.fn(async (script: string) => {
      redisObservedTransaction.push(transactionOpen);
      if (script.includes("RPUSH")) {
        if (evalCommand.mock.calls.length === 1) {
          markFirstRetentionEntered?.();
          await firstRetentionGate;
        }
        return 1;
      }
      return ["attempted", "", "", ""];
    });
    const database: Record<string, unknown> = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: async () => [{ status: "active", trafficStatus: "active" }],
            }),
          }),
        }),
      }),
    };
    database.transaction = async (operation: (tx: typeof database) => Promise<unknown>) => {
      transactionCount += 1;
      transactionOpen = true;
      try {
        return await operation(database);
      } finally {
        transactionOpen = false;
      }
    };
    const trafficMetricStore = new RedisDashboardTrafficMetricStore({
      eval: evalCommand,
    } as never);
    const service = new DemoRunService({
      db: database as never,
      redis: {} as never,
      trafficExecutionGateway: {} as never,
      publicRunBudgetStore: {} as never,
      trafficMetricStore,
      businessOutcomeReader: {} as never,
      completionEnrichmentService: {} as never,
      terminalRunWriter: {} as never,
      finalizationService: noOpFinalizationService(),
      apiBaseUrl: "http://api.test",
      buyEndpointPath: "/buy",
      logger: { warn: vi.fn() } as never,
      publicClientCookieSecret: publicCookieSecret,
      deploymentHardCaps: publicRuntimePolicy().deploymentHardCaps,
    });

    const admitted = Array.from({ length: maximumPendingMetricBatches }, (_, index) =>
      service.ingestMetrics({ ...metricRequest, correlationId: `metric-admitted-${index}` }),
    );
    await firstRetentionEntered;
    await expect(
      service.ingestMetrics({ ...metricRequest, correlationId: "metric-overflow" }),
    ).resolves.toBeUndefined();

    expect(transactionCount).toBe(1);
    releaseFirstRetention?.();
    await expect(Promise.all(admitted)).resolves.toEqual(
      Array.from({ length: maximumPendingMetricBatches }, () => undefined),
    );
    expect(transactionCount).toBe(maximumPendingMetricBatches);
    expect(redisObservedTransaction).toEqual(
      Array.from({ length: maximumPendingMetricBatches * 2 }, () => true),
    );
  });
});

describe("HTTP traffic execution gateway", () => {
  it("sends the validated start correlation ID in the load-orchestrator header", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          runId: "55555555-5555-4555-8555-555555555555",
          status: "active",
          startedAt: "2026-06-20T00:00:11.000Z",
          correlationId: "corr-start-delegation",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "test-token",
    });

    try {
      const response = await gateway.start({
        runId: "55555555-5555-4555-8555-555555555555",
        saleOfferId: "22222222-2222-4222-8222-222222222222",
        apiBaseUrl: "http://api.test",
        buyEndpointPath: "/buy",
        correlationId: "corr-start-delegation",
        configSnapshot: surge10kSnapshot(),
      });

      expect(response.correlationId).toBe("corr-start-delegation");
      expect(fetchMock).toHaveBeenCalledWith(
        `http://load.test${trafficExecutionStartPath}`,
        expect.objectContaining({
          headers: expect.objectContaining({
            [correlationIdHeaderName]: "corr-start-delegation",
            [controlServiceTokenHeaderName]: "test-token",
          }),
        }),
      );
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
        correlationId: "corr-start-delegation",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("demo-run preset management", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;

  beforeEach(async () => {
    await connection?.close();
    connection = null;
    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    await seedPresetFixtures(connection);
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("lists all presets while public listing remains scoped to public presets", async () => {
    const service = createPresetManagementService(requireConnection(connection));

    const publicPresets = await service.listPublicPresets();
    const adminPresets = await service.listAdminPresets();

    expect(publicPresets.presets.map((preset) => preset.slug)).toEqual([
      "preview-1k",
      "public-custom",
    ]);
    expect(adminPresets.presets.map((preset) => preset.slug)).toEqual([
      "preview-1k",
      "public-custom",
      "custom",
    ]);
  });

  it("saves only editable admin presets", async () => {
    const service = createPresetManagementService(requireConnection(connection));
    const snapshot = surge10kSnapshot();

    const updated = await service.saveAdminPreset({
      slug: "custom",
      display: {
        name: "Custom Saved",
        description: "Updated scratch preset.",
        sortOrder: 125,
        outcomeFocus: ["failure_path"],
      },
      ...snapshot,
    });

    await expect(
      service.saveAdminPreset({
        slug: "preview-1k",
        display: {
          name: "Preview Edited",
          description: "Should not persist.",
          sortOrder: 10,
          outcomeFocus: [],
        },
        ...snapshot,
      }),
    ).rejects.toMatchObject({ code: "preset_not_editable" });
    expect(updated.preset.slug).toBe("custom");
    expect(updated.preset.display.name).toBe("Custom Saved");
    expect(expectBuyerSpikeTrafficConfig(updated.preset.trafficConfig)).toMatchObject({
      buyerCount: 10_000,
    });
  });

  it("duplicates presets as editable admin copies and rejects duplicate slugs", async () => {
    const service = createPresetManagementService(requireConnection(connection));

    const created = await service.duplicatePreset({
      sourceSlug: "preview-1k",
      targetSlug: "Preview Copy",
      displayName: "Preview Copy",
    });

    await expect(
      service.duplicatePreset({
        sourceSlug: "preview-1k",
        targetSlug: "preview-copy",
      }),
    ).rejects.toMatchObject({ code: "preset_slug_conflict" });
    await expect(
      service.duplicatePreset({
        sourceSlug: "public-custom",
        targetSlug: "public-custom-copy",
      }),
    ).rejects.toMatchObject({ code: "preset_not_duplicable" });
    expect(created.preset.slug).toBe("preview-copy");
    expect(created.preset.visibility).toBe("admin");
    expect(created.preset.isEditable).toBe(true);
    expect(created.preset.isCustom).toBe(false);
    expect(created.preset.display.name).toBe("Preview Copy");
  });

  it("copies any source preset into the editable admin custom preset", async () => {
    const service = createPresetManagementService(requireConnection(connection));

    const copied = await service.copyPresetToCustom({ sourceSlug: "preview-1k" });

    expect(copied.preset.slug).toBe("custom");
    expect(copied.preset.visibility).toBe("admin");
    expect(copied.preset.isCustom).toBe(true);
    expect(copied.preset.display.name).toBe("Custom");
    expect(copied.preset.display.description).toBe("Scratch copy of Preview 1k.");
    expect(expectBuyerSpikeTrafficConfig(copied.preset.trafficConfig)).toMatchObject({
      buyerCount: 10_000,
    });
  });

  it("reports an operator duplicate as archivable, archives it, and keeps the row soft-archived", async () => {
    const service = createPresetManagementService(requireConnection(connection));
    const created = await service.duplicatePreset({
      sourceSlug: "preview-1k",
      targetSlug: "operator-duplicate",
      displayName: "Operator Duplicate",
    });

    const beforeArchive = await service.listAdminPresets();
    const archivable = beforeArchive.presets.find((preset) => preset.slug === "operator-duplicate");
    expect(archivable?.canArchive).toBe(true);

    const archived = await service.archiveAdminPreset({ slug: "operator-duplicate" });
    expect(archived.slug).toBe("operator-duplicate");
    expect(archived.archivedAt).toBe("2026-06-20T00:00:10.000Z");
    expect(archived.timestamp).toBe("2026-06-20T00:00:10.000Z");

    const afterArchive = await service.listAdminPresets();
    expect(afterArchive.presets.map((preset) => preset.slug)).not.toContain("operator-duplicate");

    // Archived presets disappear from normal active lookup, so they can no
    // longer be saved, copied, duplicated, or started.
    await expect(service.saveAdminPreset(created.preset)).rejects.toMatchObject({
      code: "preset_not_found",
    });
    await expect(
      service.copyPresetToCustom({ sourceSlug: "operator-duplicate" }),
    ).rejects.toMatchObject({ code: "preset_not_found" });
    await expect(
      service.duplicatePreset({ sourceSlug: "operator-duplicate", targetSlug: "another-copy" }),
    ).rejects.toMatchObject({ code: "preset_not_found" });

    // Admin start reaches the preset lookup after the runtime policy read; an
    // archived slug is rejected as preset_not_found before any run is created.
    await requireConnection(connection)
      .db.insert(publicRuntimePolicies)
      .values({
        id: "active",
        policy: publicRuntimePolicyMutable(),
        createdAt: new Date("2026-06-20T00:00:00.000Z"),
        updatedAt: new Date("2026-06-20T00:00:00.000Z"),
      });
    await expect(
      service.startRun(
        { presetSlug: "operator-duplicate", operatorMode: "admin" },
        "corr-archived-start",
      ),
    ).rejects.toMatchObject({ code: "preset_not_found" });

    const [row] = await requireConnection(connection)
      .db.select()
      .from(demoPresets)
      .where(eq(demoPresets.slug, "operator-duplicate"));
    expect(row).toBeTruthy();
    expect(row?.archivedAt).toEqual(new Date("2026-06-20T00:00:10.000Z"));
  });

  it("archives a duplicated preset that is referenced by a run while keeping the run intact", async () => {
    const service = createPresetManagementService(requireConnection(connection));
    const created = await service.duplicatePreset({
      sourceSlug: "preview-1k",
      targetSlug: "linked-duplicate",
    });

    await requireConnection(connection)
      .db.insert(demoRuns)
      .values({
        id: "55555555-5555-4555-8555-555555555570",
        presetId: created.preset.id,
        presetName: "Linked Duplicate",
        operatorMode: "admin",
        status: "completed",
        trafficStatus: "succeeded",
        configSnapshot: surge10kSnapshot(),
        startedAt: new Date("2026-06-20T00:00:00.000Z"),
        trafficStartedAt: new Date("2026-06-20T00:00:01.000Z"),
        trafficEndedAt: new Date("2026-06-20T00:00:05.000Z"),
        finalizedAt: new Date("2026-06-20T00:00:06.000Z"),
        createdAt: new Date("2026-06-20T00:00:00.000Z"),
        updatedAt: new Date("2026-06-20T00:00:06.000Z"),
      });

    // Soft archive must succeed even though demo_runs.preset_id ON DELETE
    // RESTRICT would block a hard delete.
    const archived = await service.archiveAdminPreset({ slug: "linked-duplicate" });
    expect(archived.slug).toBe("linked-duplicate");

    const runs = await requireConnection(connection)
      .db.select()
      .from(demoRuns)
      .where(eq(demoRuns.presetId, created.preset.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
  });

  it("refuses to archive protected public, custom, and system admin presets", async () => {
    const service = createPresetManagementService(requireConnection(connection));
    await requireConnection(connection)
      .db.insert(demoPresets)
      .values({
        id: "44444444-4444-4444-8444-444444444450",
        slug: "system-admin-preset",
        visibility: "admin",
        isEditable: true,
        isCustom: false,
        isSystem: true,
        display: { name: "System Admin", description: "Seeded", sortOrder: 90, outcomeFocus: [] },
        ...surge10kSnapshot(),
        createdAt: new Date("2026-06-20T00:00:00.000Z"),
        updatedAt: new Date("2026-06-20T00:00:00.000Z"),
      });

    await expect(service.archiveAdminPreset({ slug: "preview-1k" })).rejects.toMatchObject({
      code: "preset_not_archivable",
      details: { slug: "preview-1k" },
    });
    await expect(service.archiveAdminPreset({ slug: "public-custom" })).rejects.toMatchObject({
      code: "preset_not_archivable",
    });
    await expect(service.archiveAdminPreset({ slug: "custom" })).rejects.toMatchObject({
      code: "preset_not_archivable",
    });
    await expect(service.archiveAdminPreset({ slug: "system-admin-preset" })).rejects.toMatchObject(
      {
        code: "preset_not_archivable",
      },
    );

    const adminList = await service.listAdminPresets();
    expect(
      adminList.presets.find((preset) => preset.slug === "system-admin-preset")?.canArchive,
    ).toBe(false);
    expect(adminList.presets.find((preset) => preset.slug === "custom")?.canArchive).toBe(false);
  });

  it("reports preset_not_found for unknown and already-archived slugs", async () => {
    const service = createPresetManagementService(requireConnection(connection));
    await service.duplicatePreset({ sourceSlug: "preview-1k", targetSlug: "archive-once" });
    await service.archiveAdminPreset({ slug: "archive-once" });

    await expect(service.archiveAdminPreset({ slug: "never-seeded" })).rejects.toMatchObject({
      code: "preset_not_found",
      details: { slug: "never-seeded" },
    });
    await expect(service.archiveAdminPreset({ slug: "archive-once" })).rejects.toMatchObject({
      code: "preset_not_found",
    });
  });

  it("does not archive a preset that becomes system-protected after eligibility is read", async () => {
    const activeConnection = requireConnection(connection);
    const setupService = createPresetManagementService(activeConnection);
    const created = await setupService.duplicatePreset({
      sourceSlug: "preview-1k",
      targetSlug: "concurrently-protected",
    });
    const racingDatabase = interceptNextSelectResult(activeConnection.db, async () => {
      await activeConnection.db
        .update(demoPresets)
        .set({ isSystem: true })
        .where(eq(demoPresets.id, created.preset.id));
    });
    const service = createPresetManagementService(activeConnection, undefined, racingDatabase);

    await expect(
      service.archiveAdminPreset({ slug: "concurrently-protected" }),
    ).rejects.toMatchObject({
      code: "preset_not_archivable",
      details: { slug: "concurrently-protected" },
    });

    const [row] = await activeConnection.db
      .select()
      .from(demoPresets)
      .where(eq(demoPresets.id, created.preset.id));
    expect(row).toMatchObject({ isSystem: true, archivedAt: null });
  });

  it("reports preset_not_found when another archive wins after eligibility is read", async () => {
    const activeConnection = requireConnection(connection);
    const setupService = createPresetManagementService(activeConnection);
    const created = await setupService.duplicatePreset({
      sourceSlug: "preview-1k",
      targetSlug: "concurrently-archived",
    });
    const concurrentlyArchivedAt = new Date("2026-06-20T00:00:09.000Z");
    const racingDatabase = interceptNextSelectResult(activeConnection.db, async () => {
      await activeConnection.db
        .update(demoPresets)
        .set({ archivedAt: concurrentlyArchivedAt })
        .where(eq(demoPresets.id, created.preset.id));
    });
    const service = createPresetManagementService(activeConnection, undefined, racingDatabase);

    await expect(
      service.archiveAdminPreset({ slug: "concurrently-archived" }),
    ).rejects.toMatchObject({
      code: "preset_not_found",
      details: { slug: "concurrently-archived" },
    });

    const [row] = await activeConnection.db
      .select()
      .from(demoPresets)
      .where(eq(demoPresets.id, created.preset.id));
    expect(row?.archivedAt).toEqual(concurrentlyArchivedAt);
  });

  it("still blocks reusing an archived slug as a duplicate target", async () => {
    const service = createPresetManagementService(requireConnection(connection));
    await service.duplicatePreset({ sourceSlug: "preview-1k", targetSlug: "reused-slug" });
    await service.archiveAdminPreset({ slug: "reused-slug" });

    await expect(
      service.duplicatePreset({ sourceSlug: "preview-1k", targetSlug: "reused-slug" }),
    ).rejects.toMatchObject({ code: "preset_slug_conflict", details: { slug: "reused-slug" } });
  });
});

describe("demo-run public runtime policy management", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;

  beforeEach(async () => {
    await connection?.close();
    connection = null;
    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    await seedStartFixtures(connection);
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("persists public budget, default, and limit updates while preserving deployment hard caps", async () => {
    const service = createPresetManagementService(requireConnection(connection));
    const policy = publicRuntimePolicyMutable();
    policy.publicRunBudget = {
      windowSeconds: 60,
      perVisitorMaxStarts: 1,
      globalMaxStarts: 2,
    };
    policy.publicCustomDefaults = {
      ...policy.publicCustomDefaults,
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 250,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 5,
        quantityPerAttempt: 1,
      },
      inventoryConfig: {
        startingStock: 75,
        quantityPerCheckout: 1,
        reservationHoldMinutes: 15,
      },
    };
    policy.publicCustomLimits = {
      ...policy.publicCustomLimits,
      maxBuyers: 500,
      maxStartingStock: 100,
    };

    const response = await service.updateAdminPublicRuntimePolicy(
      { policy, correlationId: "corr-policy-save" },
      "corr-policy-save",
    );
    const [row] = await requireConnection(connection).db.select().from(publicRuntimePolicies);
    const persistedPolicy = row?.policy as PublicRuntimePolicyMutable | undefined;

    expect(response.correlationId).toBe("corr-policy-save");
    expect(response.policy.publicRunBudget.perVisitorMaxStarts).toBe(1);
    expect(response.policy.publicCustomDefaults.inventoryConfig.startingStock).toBe(75);
    expect(response.policy.publicCustomLimits.maxBuyers).toBe(500);
    expect(response.policy.deploymentHardCaps.maxBuyers).toBe(100_000);
    expect(persistedPolicy?.publicRunBudget.globalMaxStarts).toBe(2);
    expect(persistedPolicy).not.toHaveProperty("deploymentHardCaps");
  });

  it("prioritizes deployment-cap update errors when multiple policy rules fail", async () => {
    const effectiveFixture = publicRuntimePolicy();
    const service = createPresetManagementService(requireConnection(connection), {
      ...effectiveFixture.deploymentHardCaps,
      maxBuyers: 450,
    });
    const policy = publicRuntimePolicyMutable();
    policy.publicCustomLimits.maxTotalRequests = 100_001;
    policy.publicCustomLimits.maxPreAllocatedVus = 1001;
    policy.publicCustomLimits.maxBuyers = 400;

    await expect(
      service.updateAdminPublicRuntimePolicy({ policy }, "corr-policy-reject"),
    ).rejects.toMatchObject({
      code: "public_limit_total_requests_exceeds_deployment_cap",
      details: { value: 100_001, cap: 100_000 },
    });

    const [row] = await requireConnection(connection).db.select().from(publicRuntimePolicies);
    const persistedPolicy = row?.policy as PublicRuntimePolicyMutable | undefined;
    expect(persistedPolicy?.publicCustomLimits.maxTotalRequests).toBe(10_000);
  });

  it("rejects automatic default VUs above deployment caps without changing the stored row", async () => {
    const effectiveFixture = publicRuntimePolicy();
    const service = createPresetManagementService(requireConnection(connection), {
      ...effectiveFixture.deploymentHardCaps,
      maxPreAllocatedVus: 10,
      maxVus: 10,
    });
    const policy = publicRuntimePolicyMutable();
    policy.publicCustomLimits.maxPreAllocatedVus = 10;
    policy.publicCustomLimits.maxVus = 10;
    policy.publicCustomDefaults.trafficConfig = {
      mode: "steady-arrival-rate",
      ratePerSecond: 6,
      startDelaySeconds: 0,
      durationSeconds: 1,
      quantityPerAttempt: 1,
    };

    await expect(
      service.updateAdminPublicRuntimePolicy({ policy }, "corr-policy-default-vus-reject"),
    ).rejects.toMatchObject({
      code: "public_custom_default_deployment_max_vus_exceeded",
      details: { value: 12, cap: 10 },
    });

    const [row] = await requireConnection(connection).db.select().from(publicRuntimePolicies);
    expect(row?.policy.publicCustomDefaults.trafficConfig.mode).toBe("buyer-spike");
  });

  it("rejects startup when current deployment caps are below the durable public policy", async () => {
    const policy = publicRuntimePolicy();
    await expect(
      validateActivePublicRuntimePolicyAtStartup(requireConnection(connection).db, {
        ...policy.deploymentHardCaps,
        maxBuyers: policy.publicCustomLimits.maxBuyers - 1,
      }),
    ).rejects.toThrow(/publicCustomLimits\.maxBuyers.*public_limit_buyers_exceeds_deployment_cap/);
  });

  it("accepts current mutable policy at startup", async () => {
    const policy = publicRuntimePolicy();
    const mutablePolicy = publicRuntimePolicyMutable();
    mutablePolicy.publicCustomDefaults.erpConfig.maxTps = 150;
    mutablePolicy.publicCustomLimits.maxErpMaxTps = 150;
    const db = requireConnection(connection).db;
    await db
      .update(publicRuntimePolicies)
      .set({ policy: mutablePolicy })
      .where(eq(publicRuntimePolicies.id, "active"));

    await expect(
      validateActivePublicRuntimePolicyAtStartup(db, policy.deploymentHardCaps),
    ).resolves.toBeUndefined();
  });

  it("rejects obsolete cap-bearing persisted policy at startup", async () => {
    const db = requireConnection(connection).db;
    const policy = publicRuntimePolicy();
    await db.execute(sql`
      UPDATE ${publicRuntimePolicies}
      SET policy = policy || ${JSON.stringify({
        deploymentHardCaps: policy.deploymentHardCaps,
      })}::jsonb
      WHERE id = 'active'
    `);

    await expect(
      validateActivePublicRuntimePolicyAtStartup(db, policy.deploymentHardCaps),
    ).rejects.toThrow(/Unrecognized key.*deploymentHardCaps/i);
  });

  it("changes effective hard caps between service boots without reseeding", async () => {
    const stored = publicRuntimePolicy();
    const first = createPresetManagementService(requireConnection(connection), {
      ...stored.deploymentHardCaps,
      maxBuyers: 20_000,
    });
    const second = createPresetManagementService(requireConnection(connection), {
      ...stored.deploymentHardCaps,
      maxBuyers: 30_000,
    });

    expect((await first.getPublicRuntimePolicy()).policy.deploymentHardCaps.maxBuyers).toBe(20_000);
    expect((await second.getPublicRuntimePolicy()).policy.deploymentHardCaps.maxBuyers).toBe(
      30_000,
    );
  });

  it("reports missing and malformed active policy rows before startup", async () => {
    const db = requireConnection(connection).db;
    const caps = publicRuntimePolicy().deploymentHardCaps;
    await db.delete(publicRuntimePolicies);

    await expect(validateActivePublicRuntimePolicyAtStartup(db, caps)).rejects.toThrow(
      /policy "active" is missing/,
    );

    await db.execute(
      sql`INSERT INTO ${publicRuntimePolicies} (id, policy)
          VALUES ('active', ${JSON.stringify({ malformed: true })}::jsonb)`,
    );
    await expect(validateActivePublicRuntimePolicyAtStartup(db, caps)).rejects.toThrow(
      /publicRunBudget|publicCustomDefaults/,
    );
  });
});

describe("demo-run lifecycle start gating", () => {
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
    await seedStartFixtures(connection);
  });

  afterAll(async () => {
    await connection?.close();
    if (redis) {
      await redis.flushdb();
      redis.disconnect();
    }
  });

  it.each([
    "starting",
    "active",
    "draining",
  ] as const)("blocks a new start while another run is %s", async (status) => {
    const service = createStartService(requireConnection(connection), requireRedis(redis));
    await seedExistingRun(requireConnection(connection), {
      runId: existingRunId(status),
      status,
    });

    await expect(
      service.startRun({ presetSlug: "preview-1k", operatorMode: "admin" }, "corr-start"),
    ).rejects.toMatchObject({
      code: "demo_run_already_active",
      details: { status },
    });
  });

  it("holds a successor start during abort, rejects it after failure, and admits it after repair", async () => {
    const primary = requireConnection(connection);
    const redisClient = requireRedis(redis);
    const resetConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 2 });
    await seedExistingRun(primary, { runId: existingRunId("active"), status: "active" });
    let releaseAbort!: () => void;
    let abortEntered!: () => void;
    const abortRelease = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const abortStarted = new Promise<void>((resolve) => {
      abortEntered = resolve;
    });
    let abortAttempt = 0;
    const queueCleanup = vi.fn(async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }));
    const resetService = new DemoMaintenanceService({
      db: resetConnection.db,
      redis: redisClient,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(resetConnection.db),
      queueMaintenance: {
        cleanResetOwnedQueues: queueCleanup,
        acquireGeneratedRunQuiescence: async () => ({ release: async () => undefined }),
        preflightGeneratedRun: async () => undefined,
        cleanGeneratedRun: async () => ({ deletedJobCount: 0 }),
      },
      deleteGeneratedRunDurable,
      deleteGeneratedRunRedisState,
      prepareGeneratedRunTeardown,
      completeGeneratedRunTeardown,
      clearErpCircuitBreakerState: async () => undefined,
      trafficAborter: {
        abortCurrent: async () => {
          abortAttempt += 1;
          if (abortAttempt === 1) {
            abortEntered();
            await abortRelease;
            throw new ApiHttpError({
              statusCode: 502,
              code: "load_orchestrator_abort_unconfirmed",
              message: "Traffic termination could not be confirmed.",
            });
          }
          return { outcome: "no_current_run" };
        },
      },
      dashboardLiveStateReset: new RedisDashboardTrafficMetricStore(redisClient),
      resetWorkflowFence: new PostgresDemoResetWorkflowFence(resetConnection.sql),
      logger: createSilentLogger("api"),
    });
    const start = vi.fn(async (request: TrafficExecutionStartRequest) => ({
      runId: request.runId,
      status: "active" as const,
      startedAt: "2026-07-13T00:00:01.000Z",
      correlationId: request.correlationId,
    }));
    const startService = createStartService(primary, redisClient, {
      trafficExecutionGateway: { start },
    });

    try {
      const resetPromise = resetService.reset("reset-fence-race");
      await abortStarted;
      const startPromise = startService.startRun(
        { presetSlug: "preview-1k", operatorMode: "admin" },
        "successor-start",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(start).not.toHaveBeenCalled();

      const rejectedStart = expect(startPromise).rejects.toMatchObject({
        code: "demo_reset_incomplete",
        details: { runId: existingRunId("active") },
      });
      releaseAbort();
      await expect(resetPromise).rejects.toMatchObject({
        code: "load_orchestrator_abort_unconfirmed",
      });
      await rejectedStart;
      expect(start).not.toHaveBeenCalled();
      expect(queueCleanup).not.toHaveBeenCalled();

      await expect(resetService.reset("reset-fence-repair")).resolves.toMatchObject({
        failedRunCount: 1,
      });
      await expect(
        startService.startRun(
          { presetSlug: "preview-1k", operatorMode: "admin" },
          "successor-after-repair",
        ),
      ).resolves.toMatchObject({ run: { status: "active" } });
      expect(start).toHaveBeenCalledOnce();
    } finally {
      releaseAbort();
      await resetConnection.close();
    }
  });

  it("rejects terminal or reset-fenced metric batches without SSE projection", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const runId = existingRunId("active");
    await seedExistingRun(requireConnection(connection), { runId, status: "active" });
    const trafficMetricStore = new RedisDashboardTrafficMetricStore(redisClient);
    const service = createStartService(requireConnection(connection), redisClient, {
      trafficMetricStore,
    });
    const batch = {
      runId,
      correlationId: "metric-ingest",
      samples: [
        {
          metricName: "traffic.latency" as const,
          value: 12,
          unit: "ms",
          timestamp: "2026-07-13T00:00:00.000Z",
        },
      ],
      observedAt: "2026-07-13T00:00:00.000Z",
    };

    await service.ingestMetrics(batch);
    expect(await trafficMetricStore.readRecent(runId)).toHaveLength(1);

    await trafficMetricStore.clearRun(runId);
    await expect(service.ingestMetrics(batch)).rejects.toMatchObject({
      code: "traffic_metric_run_not_eligible",
    });
    expect(await trafficMetricStore.readRecent(runId)).toEqual([]);

    await db.update(demoRuns).set({ status: "failed" }).where(eq(demoRuns.id, runId));
    await expect(service.ingestMetrics(batch)).rejects.toMatchObject({
      code: "traffic_metric_run_not_eligible",
    });
    expect(await trafficMetricStore.readRecent(runId)).toEqual([]);
  });

  it("replays a durable starting intent with the same run identity and activates it", async () => {
    const start = vi
      .fn(async (request: TrafficExecutionStartRequest) => ({
        runId: request.runId,
        status: "active" as const,
        startedAt: "2026-06-20T00:00:11.000Z",
        correlationId: request.correlationId,
      }))
      .mockRejectedValueOnce(
        new ApiHttpError({
          statusCode: 502,
          code: "load_orchestrator_start_ambiguous",
          message: "ambiguous",
        }),
      );
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      trafficExecutionGateway: { start },
    });
    await expect(
      service.startRun({ presetSlug: "preview-1k", operatorMode: "admin" }, "initial-start"),
    ).rejects.toMatchObject({ code: "load_orchestrator_start_ambiguous" });
    const [starting] = await requireConnection(connection)
      .db.select()
      .from(demoRuns)
      .where(eq(demoRuns.status, "starting"));
    const runId = starting?.id;
    expect(runId).toBeTruthy();
    await expect(service.reconcileStartingRuns()).resolves.toBe(1);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ runId, correlationId: `traffic-reconcile-${runId}` }),
    );
    const [row] = await requireConnection(connection)
      .db.select()
      .from(demoRuns)
      .where(eq(demoRuns.id, runId as string));
    expect(row).toMatchObject({ status: "active", trafficStatus: "active" });
  });

  it("accepts exactly one of two concurrent starts", async () => {
    const trafficStart = vi.fn(async (request) => ({
      runId: request.runId,
      status: "active" as const,
      startedAt: "2026-06-20T00:00:11.000Z",
      correlationId: request.correlationId,
    }));
    const services = [
      createStartService(requireConnection(connection), requireRedis(redis), {
        trafficExecutionGateway: { start: trafficStart },
      }),
      createStartService(requireConnection(connection), requireRedis(redis), {
        trafficExecutionGateway: { start: trafficStart },
      }),
    ];

    const results = await Promise.allSettled(
      services.map((service, index) =>
        service.startRun(
          { presetSlug: "preview-1k", operatorMode: "admin" },
          `corr-concurrent-${index}`,
        ),
      ),
    );
    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { code: "demo_run_already_active" },
    });
    expect(await requireConnection(connection).db.select().from(demoRuns)).toHaveLength(1);
    expect(await requireConnection(connection).db.select().from(saleOffers)).toHaveLength(1);
    expect(await requireConnection(connection).db.select().from(demoRunSaleContexts)).toHaveLength(
      1,
    );
    expect(trafficStart).toHaveBeenCalledTimes(1);
  });

  it("maps a direct-writer claim race and rolls back all losing start side effects", async () => {
    const directConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    const trafficStart = vi.fn();
    const release = vi.fn(async () => undefined);
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      trafficExecutionGateway: { start: trafficStart },
      publicRunBudgetStore: {
        reserve: async () => {
          await seedExistingRun(directConnection, {
            runId: "88888888-8888-4888-8888-888888888888",
            status: "starting",
          });
          return {
            outcome: "allowed" as const,
            reservation: {
              reservationId: "race",
              globalKey: "g",
              visitorKey: "v",
              reservationKey: "r",
            },
          };
        },
        release,
      },
    });

    try {
      await expect(
        service.startRun(
          {
            presetSlug: "preview-1k",
            operatorMode: "public",
            publicVisitorCredential: signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          },
          "corr-direct-writer-race",
        ),
      ).rejects.toMatchObject({ code: "demo_run_already_active" });

      expect(await requireConnection(connection).db.select().from(demoRuns)).toHaveLength(1);
      expect(await requireConnection(connection).db.select().from(saleOffers)).toHaveLength(0);
      expect(
        await requireConnection(connection).db.select().from(demoRunSaleContexts),
      ).toHaveLength(0);
      expect(await requireConnection(connection).db.select().from(demoRunSummaries)).toHaveLength(
        0,
      );
      expect(trafficStart).not.toHaveBeenCalled();
      expect(await requireRedis(redis).dbsize()).toBe(0);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await directConnection.close();
    }
  });

  it("keeps public validation and existing-run overlap rejection ahead of reservation", async () => {
    const reserve = vi.fn();
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      publicRunBudgetStore: { reserve, release: vi.fn() },
    });
    await expect(
      service.startRun(
        {
          presetSlug: "custom",
          operatorMode: "public",
          publicVisitorCredential: signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        },
        "visibility-rejection",
      ),
    ).rejects.toMatchObject({ code: "preset_not_public" });
    expect(reserve).not.toHaveBeenCalled();

    await seedExistingRun(requireConnection(connection), {
      runId: "88888888-8888-4888-8888-888888888889",
      status: "active",
    });
    await expect(
      service.startRun(
        {
          presetSlug: "preview-1k",
          operatorMode: "public",
          publicVisitorCredential: signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        },
        "overlap-rejection",
      ),
    ).rejects.toMatchObject({ code: "demo_run_already_active" });
    expect(reserve).not.toHaveBeenCalled();
  });

  it.each([
    ["visitor", "public_visitor_run_budget_exceeded"],
    ["global", "public_run_budget_exceeded"],
  ] as const)("maps %s budget denial decisions to stable application errors", async (reason, code) => {
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      publicRunBudgetStore: {
        reserve: async () => ({ outcome: "denied", reason }),
        release: vi.fn(),
      },
    });
    await expect(
      service.startRun(
        {
          presetSlug: "preview-1k",
          operatorMode: "public",
          publicVisitorCredential: signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        },
        `denied-${reason}`,
      ),
    ).rejects.toMatchObject({ code });
  });

  it.each([
    "completed",
    "failed",
  ] as const)("allows a new start after the existing run is %s", async (status) => {
    const service = createStartService(requireConnection(connection), requireRedis(redis));
    await seedExistingRun(requireConnection(connection), {
      runId: existingRunId(status),
      status,
    });

    const response = await service.startRun(
      { presetSlug: "preview-1k", operatorMode: "admin" },
      "corr-start",
    );

    expect(response.run.status).toBe("active");
    expect(response.run.trafficStatus).toBe("active");
    expect(response.run.saleOfferId).toBe("77777777-7777-4777-8777-777777777778");
  });

  it("keeps public custom overrides scoped to the accepted run snapshot", async () => {
    const service = createStartService(requireConnection(connection), requireRedis(redis));

    const response = await service.startRun(
      {
        presetSlug: "public-custom",
        operatorMode: "public",
        publicVisitorCredential: signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        configOverride: {
          trafficConfig: {
            mode: "buyer-spike",
            buyerCount: 321,
            duplicateEachBuyerAttempt: false,
            startDelaySeconds: 0,
            maxDurationSeconds: 3,
            quantityPerAttempt: 1,
          },
          inventoryConfig: {
            startingStock: 44,
            quantityPerCheckout: 1,
            reservationHoldMinutes: 15,
          },
          erpConfig: {
            latencyMs: 75,
            maxTps: 50,
            errorRate: 0,
            forcedOutage: false,
            requestTimeoutMs: 2000,
          },
        },
      },
      "corr-public-custom",
    );
    const publicCustomPreset = await readPresetRow(requireConnection(connection), "public-custom");

    expect(expectBuyerSpikeTrafficConfig(response.run.configSnapshot.trafficConfig)).toMatchObject({
      buyerCount: 321,
      maxDurationSeconds: 3,
    });
    expect(response.run.configSnapshot.inventoryConfig.startingStock).toBe(44);
    expect(publicCustomPreset.trafficConfig).toMatchObject({
      mode: "buyer-spike",
      buyerCount: 10_000,
    });
    expect(publicCustomPreset.inventoryConfig.startingStock).toBe(1000);
  });

  it("uses updated persisted public custom defaults for the next public custom start", async () => {
    const managementService = createPresetManagementService(requireConnection(connection));
    const policy = publicRuntimePolicyMutable();
    policy.publicCustomDefaults = {
      ...policy.publicCustomDefaults,
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 222,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 4,
        quantityPerAttempt: 1,
      },
      inventoryConfig: {
        startingStock: 55,
        quantityPerCheckout: 1,
        reservationHoldMinutes: 15,
      },
    };
    await managementService.updateAdminPublicRuntimePolicy({ policy }, "corr-policy-update");

    const startService = createStartService(requireConnection(connection), requireRedis(redis));
    const response = await startService.startRun(
      {
        presetSlug: "public-custom",
        operatorMode: "public",
        publicVisitorCredential: signedVisitor("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      },
      "corr-public-defaults",
    );

    expect(expectBuyerSpikeTrafficConfig(response.run.configSnapshot.trafficConfig)).toMatchObject({
      buyerCount: 222,
      maxDurationSeconds: 4,
    });
    expect(response.run.configSnapshot.inventoryConfig.startingStock).toBe(55);
  });

  it("allows admin run-scoped overrides for read-only public presets", async () => {
    const service = createStartService(requireConnection(connection), requireRedis(redis));

    const response = await service.startRun(
      {
        presetSlug: "preview-1k",
        operatorMode: "admin",
        configOverride: {
          trafficConfig: {
            mode: "buyer-spike",
            buyerCount: 123,
            duplicateEachBuyerAttempt: true,
            startDelaySeconds: 0,
            maxDurationSeconds: 5,
            quantityPerAttempt: 1,
          },
          inventoryConfig: {
            startingStock: 33,
            quantityPerCheckout: 1,
            reservationHoldMinutes: 15,
          },
        },
      },
      "corr-admin-public-override",
    );
    const previewPreset = await readPresetRow(requireConnection(connection), "preview-1k");

    expect(response.run.operatorMode).toBe("admin");
    expect(expectBuyerSpikeTrafficConfig(response.run.configSnapshot.trafficConfig)).toMatchObject({
      buyerCount: 123,
      duplicateEachBuyerAttempt: true,
    });
    expect(response.run.configSnapshot.inventoryConfig.startingStock).toBe(33);
    expect(previewPreset.trafficConfig).toMatchObject({
      mode: "buyer-spike",
      buyerCount: 10_000,
      duplicateEachBuyerAttempt: false,
    });
    expect(previewPreset.inventoryConfig.startingStock).toBe(1000);
  });

  it("does not consume public run budget for admin starts", async () => {
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      publicRunBudgetStore: {
        reserve: async () => {
          throw new Error("Admin starts should not consume public budget.");
        },
        release: async () => {
          throw new Error("Admin starts should not release public budget.");
        },
      },
    });

    const response = await service.startRun(
      { presetSlug: "preview-1k", operatorMode: "admin" },
      "corr-admin-budget-bypass",
    );

    expect(response.run.operatorMode).toBe("admin");
  });

  it("releases exactly once after a reserved acceptance failure and retains successful reservations", async () => {
    const reservation = {
      reservationId: "reservation-1",
      globalKey: "g",
      visitorKey: "v",
      reservationKey: "r",
    };
    const reserve = vi.fn(async () => ({ outcome: "allowed" as const, reservation }));
    const release = vi.fn(async () => undefined);
    const failing = createStartService(requireConnection(connection), requireRedis(redis), {
      publicRunBudgetStore: { reserve, release },
      trafficExecutionGateway: {
        start: async () => {
          throw new Error("orchestrator unavailable");
        },
      },
    });
    await expect(
      failing.startRun(
        {
          presetSlug: "preview-1k",
          operatorMode: "public",
          publicVisitorCredential: signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        },
        "compensation-correlation",
      ),
    ).rejects.toThrow("orchestrator unavailable");
    expect(reserve).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledExactlyOnceWith(reservation);
  });

  it("preserves the primary failure and logs safe metadata when compensation fails", async () => {
    const reservation = {
      reservationId: "safe-reservation-id",
      globalKey: "secret-key",
      visitorKey: "secret-visitor",
      reservationKey: "secret-marker",
    };
    const logger = createSilentLogger("api");
    const errorLog = vi.spyOn(logger, "error");
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      logger,
      publicRunBudgetStore: {
        reserve: async () => ({ outcome: "allowed", reservation }),
        release: async () => {
          throw new Error("release failed");
        },
      },
      trafficExecutionGateway: {
        start: async () => {
          throw new Error("primary failure");
        },
      },
    });
    await expect(
      service.startRun(
        {
          presetSlug: "preview-1k",
          operatorMode: "public",
          publicVisitorCredential: signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        },
        "safe-correlation",
      ),
    ).rejects.toThrow("primary failure");
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "safe-correlation",
        reservationId: "safe-reservation-id",
      }),
      expect.any(String),
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("secret-key");
  });

  it("retains the public budget reservation after a successful accepted response", async () => {
    const release = vi.fn();
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      publicRunBudgetStore: {
        reserve: async () => ({
          outcome: "allowed",
          reservation: {
            reservationId: "accepted",
            globalKey: "g",
            visitorKey: "v",
            reservationKey: "r",
          },
        }),
        release,
      },
    });
    const response = await service.startRun(
      {
        presetSlug: "preview-1k",
        operatorMode: "public",
        publicVisitorCredential: signedVisitor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      },
      "accepted-correlation",
    );
    expect(response.run.status).toBe("active");
    expect(release).not.toHaveBeenCalled();
  });

  it("enforces updated public run-budget windows through Redis", async () => {
    const store = new RedisPublicRunBudgetStore(requireRedis(redis));
    const policy = publicRuntimePolicy();
    policy.publicRunBudget = {
      windowSeconds: 60,
      perVisitorMaxStarts: 1,
      globalMaxStarts: 2,
    };

    const firstDecision = await store.reserve({
      budget: policy.publicRunBudget,
      publicVisitorId: "visitor-budget-1",
      now: new Date("2026-06-20T00:00:00.000Z"),
    });
    if (firstDecision.outcome !== "allowed") throw new Error("Expected allowed fixture decision.");
    const firstReservation = firstDecision.reservation;
    await expect(
      store.reserve({
        budget: policy.publicRunBudget,
        publicVisitorId: "visitor-budget-1",
        now: new Date("2026-06-20T00:00:01.000Z"),
      }),
    ).resolves.toEqual({ outcome: "denied", reason: "visitor" });
    expect(await requireRedis(redis).get(firstReservation.globalKey)).toBe("1");
    expect(await requireRedis(redis).get(firstReservation.visitorKey)).toBe("1");
    await store.release(firstReservation);
    await store.release(firstReservation);
    expect(await requireRedis(redis).get(firstReservation.globalKey)).toBeNull();
    expect(await requireRedis(redis).get(firstReservation.visitorKey)).toBeNull();
    await store.reserve({
      budget: policy.publicRunBudget,
      publicVisitorId: "visitor-budget-1",
      now: new Date("2026-06-20T00:00:59.000Z"),
    });

    await requireRedis(redis).flushdb();
    policy.publicRunBudget = {
      windowSeconds: 60,
      perVisitorMaxStarts: 10,
      globalMaxStarts: 2,
    };
    await store.reserve({
      budget: policy.publicRunBudget,
      publicVisitorId: "visitor-budget-2",
      now: new Date("2026-06-20T00:00:02.000Z"),
    });
    await store.reserve({
      budget: policy.publicRunBudget,
      publicVisitorId: "visitor-budget-3",
      now: new Date("2026-06-20T00:00:03.000Z"),
    });
    await expect(
      store.reserve({
        budget: policy.publicRunBudget,
        publicVisitorId: "visitor-budget-4",
        now: new Date("2026-06-20T00:00:04.000Z"),
      }),
    ).resolves.toEqual({ outcome: "denied", reason: "global" });
  });

  it("atomically enforces concurrent budgets and exact-window idempotent release", async () => {
    const client = requireRedis(redis);
    await client.flushdb();
    const store = new RedisPublicRunBudgetStore(client);
    const policy = publicRuntimePolicy();
    policy.publicRunBudget = { windowSeconds: 60, perVisitorMaxStarts: 2, globalMaxStarts: 3 };
    const now = new Date("2026-06-20T00:00:00.000Z");

    const visitorDecisions = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.reserve({ budget: policy.publicRunBudget, publicVisitorId: "concurrent", now }),
      ),
    );
    const visitorReservations = visitorDecisions.flatMap((decision) =>
      decision.outcome === "allowed" ? [decision.reservation] : [],
    );
    expect(visitorReservations).toHaveLength(2);
    const oldReservation = visitorReservations[0];
    if (!oldReservation) throw new Error("Expected a visitor reservation fixture.");
    expect(await client.get(oldReservation.globalKey)).toBe("2");
    expect(await client.get(oldReservation.visitorKey)).toBe("2");

    const allowedGlobal = await store.reserve({
      budget: policy.publicRunBudget,
      publicVisitorId: "other-a",
      now,
    });
    expect(allowedGlobal.outcome).toBe("allowed");
    const globalBefore = await client.get(oldReservation.globalKey);
    const deniedGlobal = await store.reserve({
      budget: policy.publicRunBudget,
      publicVisitorId: "denied-visitor",
      now,
    });
    expect(deniedGlobal).toEqual({ outcome: "denied", reason: "global" });
    const deniedKey = oldReservation.visitorKey.replace("concurrent", "denied-visitor");
    expect(await client.get(deniedKey)).toBeNull();
    expect(await client.get(oldReservation.globalKey)).toBe(globalBefore);
    const globalHashTag = oldReservation.globalKey.match(/\{\d+\}/)?.[0];
    expect(globalHashTag).toBeTruthy();
    expect(oldReservation.visitorKey).toContain(globalHashTag);
    expect(oldReservation.reservationKey).toContain(globalHashTag);

    const nextDecision = await store.reserve({
      budget: policy.publicRunBudget,
      publicVisitorId: "concurrent",
      now: new Date("2026-06-20T00:01:00.000Z"),
    });
    if (nextDecision.outcome !== "allowed") throw new Error("Expected next-window reservation.");
    const nextWindow = nextDecision.reservation;
    expect(await client.ttl(nextWindow.globalKey)).toBeGreaterThanOrEqual(118);
    expect(await client.ttl(nextWindow.globalKey)).toBeLessThanOrEqual(120);
    await store.release(oldReservation);
    await store.release(oldReservation);
    expect(await client.get(nextWindow.globalKey)).toBe("1");
    expect(await client.get(nextWindow.visitorKey)).toBe("1");
  });

  it("writes a terminal summary when inventory initialization fails", async () => {
    const db = requireConnection(connection).db;
    const postgresTerminalRunWriter = new PostgresTerminalDemoRunSummaryWriter(db);
    const writeTerminalRun = vi.fn(postgresTerminalRunWriter.write.bind(postgresTerminalRunWriter));
    const service = createStartService(requireConnection(connection), redisUnavailable(), {
      terminalRunWriter: { write: writeTerminalRun },
    });

    await expect(
      service.startRun({ presetSlug: "preview-1k", operatorMode: "admin" }, "corr-start"),
    ).rejects.toThrow("Redis unavailable during initialization.");

    const summaries = await requireConnection(connection).db.select().from(demoRunSummaries);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      runId: "77777777-7777-4777-8777-777777777777",
      status: "failed",
      failureReason: "inventory_initialization_failed",
      terminalInventorySnapshot: null,
    });
    expect(summaries[0]?.httpSummary).toMatchObject({
      plannedRequests: 10_000,
      startedRequests: 0,
      completedRequests: 0,
      interruptedRequests: 0,
      unstartedRequests: 10_000,
    });
    expect(summaries[0]?.trafficDeliverySummary).toMatchObject({
      trafficDeliveryStatus: "failed",
      droppedIterations: 0,
      completedIterations: 0,
      startedRequests: 0,
      completedRequests: 0,
      interruptedRequests: 0,
      unstartedRequests: 10_000,
      trafficMode: "buyer-spike",
      plannedBuyers: 10_000,
    });
    expect(writeTerminalRun).toHaveBeenCalledOnce();
    expect(writeTerminalRun).toHaveBeenCalledWith(
      expect.objectContaining({
        failureReason: "inventory_initialization_failed",
        allowedCurrentStatuses: ["starting", "active"],
        terminalTrafficStatus: "failed",
      }),
    );
  });

  it("writes a terminal summary when load-orchestrator traffic start fails", async () => {
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      trafficExecutionGateway: {
        start: async () => {
          throw new Error("load orchestrator unavailable");
        },
      },
    });

    await expect(
      service.startRun({ presetSlug: "preview-1k", operatorMode: "admin" }, "corr-start"),
    ).rejects.toThrow("load orchestrator unavailable");

    const summaries = await requireConnection(connection).db.select().from(demoRunSummaries);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      runId: "77777777-7777-4777-8777-777777777777",
      status: "failed",
      failureReason: "load_orchestrator_start_failed",
    });
    expect(summaries[0]?.terminalInventorySnapshot).toMatchObject({
      saleOfferId: "77777777-7777-4777-8777-777777777778",
      startingStock: 1000,
      remainingStock: 1000,
      acceptedReservations: 0,
      source: "redis",
    });
  });

  it("repairs stale Redis acceptance when an existing summary terminalizes a failed start", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const service = createStartService(requireConnection(connection), redisClient, {
      trafficExecutionGateway: {
        start: async (request) => {
          await db.insert(demoRunSummaries).values({
            runId: request.runId,
            presetName: "Preview 1k",
            status: "failed",
            failureReason: "existing_terminal_summary",
            startedAt: new Date("2026-06-20T00:00:10.000Z"),
            endedAt: new Date("2026-06-20T00:00:12.000Z"),
            httpSummary: {
              plannedRequests: 10_000,
              startedRequests: 0,
              completedRequests: 0,
              interruptedRequests: 0,
              unstartedRequests: 10_000,
              failedRequests: 0,
              acceptedResponses: 0,
              soldOutResponses: 0,
              unexpectedResponses: 0,
              failureRate: 0,
            },
            trafficDeliverySummary: trafficDeliverySummarySchema.parse({
              plannedRequests: 10_000,
              startedRequests: 0,
              completedRequests: 0,
              interruptedRequests: 0,
              unstartedRequests: 10_000,
              trafficMode: null,
              plannedBuyers: null,
              scheduledRatePerSecond: null,
              configuredDurationSeconds: null,
              preAllocatedVUs: null,
              maxVUs: null,
              droppedIterations: 10_000,
              completedIterations: null,
              trafficDeliveryStatus: "failed",
              notes: [],
            }),
            httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
            loadRunDiagnosticsSummary: { source: "existing-summary" },
            apiRequestLifecycleSummary: { source: "existing-summary" },
            businessOutcomeSummary: emptyBusinessOutcomeSummary(),
            terminalInventorySnapshot: null,
            capturedAt: new Date("2026-06-20T00:00:12.000Z"),
          });
          throw new Error("load orchestrator unavailable");
        },
      },
    });

    await expect(
      service.startRun({ presetSlug: "preview-1k", operatorMode: "admin" }, "corr-start"),
    ).rejects.toThrow("load orchestrator unavailable");

    const [run] = await db
      .select()
      .from(demoRuns)
      .where(eq(demoRuns.id, "77777777-7777-4777-8777-777777777777"));
    expect(run?.status).toBe("failed");
    await expect(
      isRunSaleEligible(redisClient, {
        runId: "77777777-7777-4777-8777-777777777777",
        saleOfferId: "77777777-7777-4777-8777-777777777778",
      }),
    ).resolves.toBe(false);
  });

  it("returns the draining run when fast traffic completion wins activation CAS", async () => {
    let releaseTrafficStart: (() => void) | undefined;
    let trafficStartEntered: (() => void) | undefined;
    const trafficStartEnteredPromise = new Promise<void>((resolve) => {
      trafficStartEntered = resolve;
    });
    const trafficStartReleasePromise = new Promise<void>((resolve) => {
      releaseTrafficStart = resolve;
    });
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      trafficExecutionGateway: {
        start: async (request) => {
          trafficStartEntered?.();
          await trafficStartReleasePromise;
          return {
            runId: request.runId,
            status: "active",
            startedAt: "2026-06-20T00:00:11.000Z",
            correlationId: request.correlationId,
          };
        },
      },
    });

    try {
      const startPromise = service.startRun(
        { presetSlug: "preview-1k", operatorMode: "admin" },
        "corr-fast-completion-start",
      );
      await trafficStartEnteredPromise;

      const completionRun = await service.recordTrafficCompletion({
        runId: "77777777-7777-4777-8777-777777777777",
        status: "succeeded",
        httpSummary: {
          plannedRequests: 10_000,
          startedRequests: 0,
          completedRequests: 0,
          interruptedRequests: 0,
          unstartedRequests: 10_000,
          failedRequests: 0,
          acceptedResponses: 0,
          soldOutResponses: 0,
          unexpectedResponses: 0,
          failureRate: 0,
        },
        trafficOutcomeSummary: {},
        trafficDeliverySummary: {
          plannedRequests: 10_000,
          startedRequests: 0,
          completedRequests: 0,
          interruptedRequests: 0,
          unstartedRequests: 10_000,
          trafficMode: "buyer-spike",
          plannedBuyers: 10_000,
          scheduledRatePerSecond: null,
          configuredDurationSeconds: null,
          preAllocatedVUs: null,
          maxVUs: null,
          droppedIterations: 10_000,
          notes: [],
        },
        httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
        loadRunDiagnosticsSummary: {
          ...runnerDiagnosticsFixture("2026-06-20T00:00:12.000Z", 10_000),
          completedAt: "2026-06-20T00:00:12.000Z",
        },
        apiRequestLifecycleSummary: {
          plannedRequests: 10_000,
          startedRequests: 0,
          completedRequests: 0,
          interruptedRequests: 0,
          unstartedRequests: 10_000,
          failedRequests: 0,
        },
        completedAt: "2026-06-20T00:00:12.000Z",
        correlationId: "corr-fast-completion",
      });
      expect(completionRun).toMatchObject({
        runId: "77777777-7777-4777-8777-777777777777",
        status: "draining",
        trafficStatus: "succeeded",
        trafficEndedAt: "2026-06-20T00:00:12.000Z",
      });

      releaseTrafficStart?.();
      const startResponse = await startPromise;

      expect(startResponse.run).toMatchObject({
        runId: "77777777-7777-4777-8777-777777777777",
        status: "draining",
        trafficStatus: "succeeded",
        trafficEndedAt: "2026-06-20T00:00:12.000Z",
      });
      const [run] = await requireConnection(connection)
        .db.select()
        .from(demoRuns)
        .where(eq(demoRuns.id, "77777777-7777-4777-8777-777777777777"));
      const [finalization] = await requireConnection(connection)
        .db.select()
        .from(demoRunFinalizations)
        .where(eq(demoRunFinalizations.runId, "77777777-7777-4777-8777-777777777777"));
      expect(run).toMatchObject({
        status: "draining",
        trafficStatus: "succeeded",
        trafficStartedAt: new Date("2026-06-20T00:00:11.000Z"),
        trafficEndedAt: new Date("2026-06-20T00:00:12.000Z"),
      });
      expect(finalization).toMatchObject({
        runId: "77777777-7777-4777-8777-777777777777",
        trafficSummaryReceivedAt: expect.any(Date),
      });
      await expect(
        isRunSaleEligible(requireRedis(redis), {
          runId: "77777777-7777-4777-8777-777777777777",
          saleOfferId: "77777777-7777-4777-8777-777777777778",
        }),
      ).resolves.toBe(false);
    } finally {
      releaseTrafficStart?.();
    }
  });

  it("rejects a conflicting completion without using it to repair the first accepted report", async () => {
    let releaseFirstEnrichment: () => void = () => undefined;
    let firstEnrichmentEntered: () => void = () => undefined;
    const firstEnrichmentGate = new Promise<void>((resolve) => {
      releaseFirstEnrichment = resolve;
    });
    const firstEnrichmentEnteredPromise = new Promise<void>((resolve) => {
      firstEnrichmentEntered = resolve;
    });
    let businessReads = 0;
    const finalizeRun = vi.fn().mockRejectedValueOnce(new Error("finalization temporarily failed"));
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      businessOutcomeReader: {
        read: async () => {
          businessReads += 1;
          if (businessReads === 1) {
            firstEnrichmentEntered();
            await firstEnrichmentGate;
          }
          return emptyBusinessOutcomeSummary();
        },
      },
      finalizationService: { finalizeRun, finalizeReadyRuns: async () => 0 },
    });
    const started = await service.startRun(
      completionStartCommand(111),
      "corr-completion-concurrency-start",
    );
    const firstReport = trafficCompletionFixture({
      runId: started.run.runId,
      status: "succeeded",
      exitCode: 0,
      completedAt: "2026-06-20T00:00:12.000Z",
      plannedRequests: 111,
      correlationId: "corr-completion-first",
    });
    const conflictingReport = trafficCompletionFixture({
      runId: started.run.runId,
      status: "failed",
      exitCode: 9,
      errorMessage: "conflicting duplicate",
      completedAt: "2026-06-20T00:00:13.000Z",
      plannedRequests: 999,
      correlationId: "corr-completion-conflict",
    });
    const saleOfferId = started.run.saleOfferId;
    if (!saleOfferId) {
      throw new Error("Started run did not expose its sale offer.");
    }

    const first = service.recordTrafficCompletion(firstReport);
    await firstEnrichmentEnteredPromise;
    await expect(
      isRunSaleEligible(requireRedis(redis), {
        runId: started.run.runId,
        saleOfferId,
      }),
    ).resolves.toBe(false);
    await expect(
      reserveInventoryStock(requireRedis(redis), {
        idempotencyKey: "completion-race-buy",
        idempotencyTtlSeconds: 1800,
        reservation: {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000093",
          saleOfferId,
          runId: started.run.runId,
          correlationId: "completion-race-buy-correlation",
          quantity: 1,
          status: "secured",
          reservationToken: "completion-race-buy-token",
          securedAt: "2026-06-20T00:00:12.000Z",
          expiresAt: "2026-06-20T00:15:12.000Z",
        },
      }),
    ).resolves.toEqual({ outcome: "run_not_accepting_traffic", reservation: null });
    const inventory = inventoryKeys(saleOfferId);
    await requireRedis(redis).hset(inventory.state, {
      remainingStock: "900",
      reservedStock: "100",
    });
    await requireRedis(redis).hset(inventory.reservationOutcomes, "api_sold_out_decision", "17");
    const duplicate = service.recordTrafficCompletion(conflictingReport);
    await expect(duplicate).rejects.toMatchObject({
      code: "traffic_completion_report_mismatch",
    });
    releaseFirstEnrichment();
    await expect(first).rejects.toThrow("finalization temporarily failed");
    await expect(service.recordTrafficCompletion(firstReport)).resolves.toMatchObject({
      status: "draining",
    });

    const [run] = await requireConnection(connection)
      .db.select()
      .from(demoRuns)
      .where(eq(demoRuns.id, started.run.runId));
    const [finalization] = await requireConnection(connection)
      .db.select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, started.run.runId));
    const [soldOutOutcome] = await requireConnection(connection)
      .db.select()
      .from(demoRunReservationOutcomes)
      .where(eq(demoRunReservationOutcomes.runId, started.run.runId));
    expect(finalizeRun).toHaveBeenCalledTimes(2);
    expect(run).toMatchObject({
      status: "draining",
      trafficStatus: "succeeded",
      trafficEndedAt: new Date(firstReport.completedAt),
    });
    expect(finalization).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      httpSummary: expect.objectContaining({ plannedRequests: 111 }),
      trafficDeliverySummary: expect.objectContaining({ plannedRequests: 111 }),
      completionEnrichmentStatus: "completed",
    });
    expect(finalization?.trafficOutcomeSummary).toMatchObject({
      terminalInventorySnapshot: expect.objectContaining({
        remainingStock: 1000,
        reservedStock: 0,
        soldOutRejections: 0,
      }),
      businessOutcomeAtTrafficCompletion: emptyBusinessOutcomeSummary(),
    });
    expect(soldOutOutcome).toMatchObject({ count: 0, source: "redis" });

    const authoritativeOutcome = structuredClone(finalization?.trafficOutcomeSummary);
    await requireRedis(redis).hset(inventory.state, {
      remainingStock: "1",
      reservedStock: "999",
    });
    await requireRedis(redis).hset(inventory.reservationOutcomes, "api_sold_out_decision", "99");
    await expect(service.recordTrafficCompletion(conflictingReport)).rejects.toMatchObject({
      code: "traffic_completion_report_mismatch",
    });
    const [afterRedelivery] = await requireConnection(connection)
      .db.select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, started.run.runId));
    const [soldOutAfterRedelivery] = await requireConnection(connection)
      .db.select()
      .from(demoRunReservationOutcomes)
      .where(eq(demoRunReservationOutcomes.runId, started.run.runId));
    expect(afterRedelivery?.trafficOutcomeSummary).toEqual(authoritativeOutcome);
    expect(soldOutAfterRedelivery?.count).toBe(0);
    expect(businessReads).toBe(1);
  });

  it("re-drives real finalization after enrichment commits and Redis inventory is removed", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    const enrichmentBusinessOutcome: BusinessOutcomeSummary = {
      ...emptyBusinessOutcomeSummary(),
      acceptedReservations: 149,
      soldOutRejections: 23,
    };
    const readBusinessOutcome = vi.fn(async () => enrichmentBusinessOutcome);
    let captureReadCount = 0;
    const captureRedis = new Proxy(redisClient, {
      get(target, property) {
        if (property === "hgetall") {
          return async (...args: Parameters<typeof target.hgetall>) => {
            captureReadCount += 1;
            return target.hgetall(...args);
          };
        }
        const value = target[property as keyof typeof target];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof redisClient;
    const completionEnrichmentService = new TrafficCompletionEnrichmentService({
      db,
      redis: captureRedis,
      businessOutcomeReader: { read: readBusinessOutcome },
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });
    const postgresWriter = new PostgresTerminalDemoRunSummaryWriter(db);
    let writeAttemptCount = 0;
    const writePrepared = vi.fn(
      async (...args: Parameters<typeof postgresWriter.writePrepared>) => {
        writeAttemptCount += 1;
        if (writeAttemptCount === 1) {
          const [runId, prepare] = args;
          return postgresWriter.writePrepared(runId, async (lockedDb) => {
            await prepare(lockedDb);
            throw new Error("injected failure before terminal summary persistence");
          });
        }
        return postgresWriter.writePrepared(...args);
      },
    );
    let reconciliationCount = 0;
    const reconcileSaleOffer = vi.fn(async (saleOfferId: string) => {
      reconciliationCount += 1;
      if (reconciliationCount > 1) {
        await initializeInventory(redisClient, {
          saleOfferId,
          allocatedStock: 1_000,
          initializedAt: new Date("2026-06-20T00:00:14.000Z"),
          run: { runId: startedRunId, status: "closed" },
        });
        const inventory = inventoryKeys(saleOfferId);
        await redisClient.hset(inventory.state, {
          remainingStock: "850",
          reservedStock: "150",
        });
        await redisClient.hset(inventory.reservationOutcomes, "api_sold_out_decision", "23");
      }
      return { found: 0, materialized: 0, reconciled: 0, reversed: 0, failed: 0 };
    });
    let startedRunId = "";
    const finalizationService = new DemoRunFinalizationService({
      db,
      redis: redisClient,
      logger: createSilentLogger("api"),
      pendingPersistenceReconciler: { reconcileSaleOffer },
      terminalRunWriter: { writePrepared },
      terminalInventoryRead: createTerminalInventoryRead(redisClient),
      terminalInventoryReadTimeoutMs: 2_000,
      drainTimeoutSeconds: 300,
      now: () => new Date("2026-06-20T00:00:15.000Z"),
    });
    const service = createStartService(requireConnection(connection), redisClient, {
      businessOutcomeReader: { read: readBusinessOutcome },
      completionEnrichmentService,
      finalizationService,
    });
    const started = await service.startRun(
      completionStartCommand(10),
      "corr-post-enrichment-start",
    );
    startedRunId = started.run.runId;
    const saleOfferId = started.run.saleOfferId;
    if (!saleOfferId) {
      throw new Error("Started run did not expose its sale offer.");
    }
    const inventory = inventoryKeys(saleOfferId);
    await redisClient.hset(inventory.state, { remainingStock: "850", reservedStock: "150" });
    await redisClient.hset(inventory.reservationOutcomes, "api_sold_out_decision", "23");
    const reportFixture = trafficCompletionFixture({
      runId: started.run.runId,
      status: "succeeded",
      exitCode: 0,
      completedAt: "2026-06-20T00:00:12.000Z",
      plannedRequests: 10,
      correlationId: "corr-post-enrichment",
    });
    const report: TrafficCompletionReport = {
      ...reportFixture,
      httpSummary: {
        ...reportFixture.httpSummary,
        startedRequests: 10,
        completedRequests: 10,
        interruptedRequests: 0,
        unstartedRequests: 0,
      },
      trafficDeliverySummary: {
        plannedRequests: 10,
        startedRequests: 10,
        completedRequests: 10,
        interruptedRequests: 0,
        unstartedRequests: 0,
        trafficMode: "buyer-spike",
        plannedBuyers: 10,
        scheduledRatePerSecond: null,
        configuredDurationSeconds: null,
        preAllocatedVUs: null,
        maxVUs: null,
        droppedIterations: 0,
        notes: [],
      },
      apiRequestLifecycleSummary: {
        ...reportFixture.apiRequestLifecycleSummary,
        startedRequests: 10,
        completedRequests: 10,
        interruptedRequests: 0,
        unstartedRequests: 0,
      },
    };

    await expect(service.recordTrafficCompletion(report)).rejects.toThrow(
      "injected failure before terminal summary persistence",
    );
    const [committedFinalization] = await db
      .select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, started.run.runId));
    const [committedSoldOut] = await db
      .select()
      .from(demoRunReservationOutcomes)
      .where(eq(demoRunReservationOutcomes.runId, started.run.runId));
    const authoritativeOutcome = structuredClone(committedFinalization?.trafficOutcomeSummary);
    const authoritativeSnapshot = (authoritativeOutcome as { terminalInventorySnapshot?: unknown })
      .terminalInventorySnapshot;

    expect(committedFinalization?.completionEnrichmentStatus).toBe("completed");
    expect(committedFinalization?.trafficDeliverySummary).toMatchObject({
      trafficDeliveryStatus: "complete",
      startedRequests: 10,
      unstartedRequests: 0,
    });
    expect(committedFinalization?.loadRunDiagnosticsSummary).toEqual(
      report.loadRunDiagnosticsSummary,
    );
    expect(authoritativeOutcome).toMatchObject({
      businessOutcomeAtTrafficCompletion: enrichmentBusinessOutcome,
      terminalInventorySnapshot: {
        saleOfferId,
        remainingStock: 850,
        reservedStock: 150,
        acceptedReservations: 149,
        soldOutRejections: 23,
        capturedAt: "2026-06-20T00:00:10.000Z",
      },
    });
    expect(committedSoldOut?.count).toBe(23);
    expect(await db.select().from(demoRunSummaries)).toHaveLength(0);

    await redisClient.unlink(
      inventory.state,
      inventory.reservations,
      inventory.reservationExpirations,
      inventory.pendingPersistence,
      inventory.pendingPersistenceRecords,
      inventory.events,
      inventory.reservationOutcomes,
      inventory.reservationThroughput,
      runSaleEligibilityKey(started.run.runId),
    );

    await expect(service.recordTrafficCompletion(report)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(service.recordTrafficCompletion(report)).resolves.toMatchObject({
      status: "completed",
    });
    const [afterRedelivery] = await db
      .select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, started.run.runId));
    const [soldOutAfterRedelivery] = await db
      .select()
      .from(demoRunReservationOutcomes)
      .where(eq(demoRunReservationOutcomes.runId, started.run.runId));
    const summaries = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, started.run.runId));

    expect(afterRedelivery?.trafficOutcomeSummary).toEqual(authoritativeOutcome);
    expect(soldOutAfterRedelivery?.count).toBe(23);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.terminalInventorySnapshot).toEqual({
      saleOfferId,
      startingStock: 1_000,
      remainingStock: 850,
      reservedStock: 150,
      acceptedReservations: 0,
      soldOutRejections: 23,
      pendingPersistenceCount: 0,
      capturedAt: "2026-06-20T00:00:15.000Z",
      source: "redis",
    });
    expect(summaries[0]?.terminalInventorySnapshot).not.toEqual(authoritativeSnapshot);
    expect(summaries[0]?.loadRunDiagnosticsSummary).toEqual(report.loadRunDiagnosticsSummary);
    expect(captureReadCount).toBe(1);
    expect(readBusinessOutcome).toHaveBeenCalledOnce();
    expect(writePrepared).toHaveBeenCalledTimes(2);
  });

  it("keeps a claimed completion non-terminal until enrichment durably concludes", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    let releaseEnrichment: () => void = () => undefined;
    let enrichmentEntered: () => void = () => undefined;
    const enrichmentGate = new Promise<void>((resolve) => {
      releaseEnrichment = resolve;
    });
    const enrichmentEnteredPromise = new Promise<void>((resolve) => {
      enrichmentEntered = resolve;
    });
    const businessOutcomeReader = {
      read: async () => {
        enrichmentEntered();
        await enrichmentGate;
        return emptyBusinessOutcomeSummary();
      },
    };
    const finalizationService = new DemoRunFinalizationService({
      db,
      redis: redisClient,
      logger: createSilentLogger("api"),
      pendingPersistenceReconciler: noOpPendingPersistenceReconciler(),
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      terminalInventoryRead: createTerminalInventoryRead(redisClient),
      terminalInventoryReadTimeoutMs: 2_000,
      drainTimeoutSeconds: 300,
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });
    const service = createStartService(requireConnection(connection), redisClient, {
      businessOutcomeReader,
      finalizationService,
    });
    const started = await service.startRun(
      completionStartCommand(10),
      "corr-pending-enrichment-start",
    );
    const report: TrafficCompletionReport = {
      ...trafficCompletionFixture({
        runId: started.run.runId,
        status: "succeeded",
        exitCode: 0,
        completedAt: "2026-06-20T00:00:12.000Z",
        plannedRequests: 10,
        correlationId: "corr-pending-enrichment",
      }),
      httpSummary: {
        ...trafficCompletionFixture({
          runId: started.run.runId,
          status: "succeeded",
          exitCode: 0,
          completedAt: "2026-06-20T00:00:12.000Z",
          plannedRequests: 10,
          correlationId: "corr-pending-enrichment",
        }).httpSummary,
        startedRequests: 10,
        completedRequests: 10,
        interruptedRequests: 0,
        unstartedRequests: 0,
      },
      trafficDeliverySummary: {
        plannedRequests: 10,
        startedRequests: 10,
        completedRequests: 10,
        interruptedRequests: 0,
        unstartedRequests: 0,
        trafficMode: "buyer-spike",
        plannedBuyers: 10,
        scheduledRatePerSecond: null,
        configuredDurationSeconds: null,
        preAllocatedVUs: null,
        maxVUs: null,
        droppedIterations: 0,
        notes: [],
      },
      apiRequestLifecycleSummary: {
        plannedRequests: 10,
        startedRequests: 10,
        completedRequests: 10,
        interruptedRequests: 0,
        unstartedRequests: 0,
        failedRequests: 0,
      },
    };

    try {
      const completion = service.recordTrafficCompletion(report);
      await enrichmentEnteredPromise;
      const [pending] = await db
        .select()
        .from(demoRunFinalizations)
        .where(eq(demoRunFinalizations.runId, started.run.runId));

      expect(pending?.completionEnrichmentStatus).toBe("pending");
      await expect(
        finalizationService.finalizeRun(started.run.runId, report.correlationId),
      ).resolves.toMatchObject({ status: "draining" });
      expect(
        await db
          .select()
          .from(demoRunSummaries)
          .where(eq(demoRunSummaries.runId, started.run.runId)),
      ).toHaveLength(0);

      releaseEnrichment();
      await expect(completion).resolves.toMatchObject({ status: "completed" });
      const [concluded] = await db
        .select()
        .from(demoRunFinalizations)
        .where(eq(demoRunFinalizations.runId, started.run.runId));
      const [summary] = await db
        .select()
        .from(demoRunSummaries)
        .where(eq(demoRunSummaries.runId, started.run.runId));

      expect(concluded?.completionEnrichmentStatus).toBe("completed");
      expect(summary?.terminalInventorySnapshot).toEqual(
        (concluded?.trafficOutcomeSummary as Record<string, unknown>)?.terminalInventorySnapshot,
      );
    } finally {
      releaseEnrichment();
    }
  });

  it("repairs enrichment that failed after the durable claim on redelivery", async () => {
    const db = requireConnection(connection).db;
    let businessReadCount = 0;
    const finalizeRun = vi.fn(async () => null);
    const businessOutcomeReader = {
      read: async () => {
        businessReadCount += 1;
        if (businessReadCount === 1) {
          throw new Error("injected failure before enrichment persistence");
        }
        return emptyBusinessOutcomeSummary();
      },
    };
    const completionEnrichmentService = new TrafficCompletionEnrichmentService({
      db,
      redis: requireRedis(redis),
      businessOutcomeReader,
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      businessOutcomeReader,
      completionEnrichmentService,
      finalizationService: { finalizeRun, finalizeReadyRuns: async () => 0 },
    });
    const started = await service.startRun(
      completionStartCommand(10),
      "corr-enrichment-repair-start",
    );
    const report = trafficCompletionFixture({
      runId: started.run.runId,
      status: "succeeded",
      exitCode: 0,
      completedAt: "2026-06-20T00:00:12.000Z",
      plannedRequests: 10,
      correlationId: "corr-enrichment-repair",
    });

    await expect(service.recordTrafficCompletion(report)).rejects.toThrow(
      "injected failure before enrichment persistence",
    );
    let [finalization] = await db
      .select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, started.run.runId));
    expect(finalization?.completionEnrichmentStatus).toBe("pending");
    expect(finalizeRun).not.toHaveBeenCalled();

    await expect(service.recordTrafficCompletion(report)).resolves.toMatchObject({
      status: "draining",
    });
    [finalization] = await db
      .select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, started.run.runId));
    expect(finalization?.completionEnrichmentStatus).toBe("completed");
    expect(finalizeRun).toHaveBeenCalledOnce();
    expect(businessReadCount).toBe(2);
  });

  it("repairs abandoned pending enrichment through periodic reconciliation", async () => {
    const db = requireConnection(connection).db;
    let businessReadCount = 0;
    const businessOutcomeReader = {
      read: async () => {
        businessReadCount += 1;
        if (businessReadCount === 1) {
          throw new Error("injected abandoned enrichment");
        }
        return emptyBusinessOutcomeSummary();
      },
    };
    const completionEnrichmentService = new TrafficCompletionEnrichmentService({
      db,
      redis: requireRedis(redis),
      businessOutcomeReader,
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      businessOutcomeReader,
      completionEnrichmentService,
      finalizationService: { finalizeRun: async () => null, finalizeReadyRuns: async () => 0 },
    });
    const started = await service.startRun(
      completionStartCommand(10),
      "corr-periodic-enrichment-start",
    );
    const report = trafficCompletionFixture({
      runId: started.run.runId,
      status: "succeeded",
      exitCode: 0,
      completedAt: "2026-06-20T00:00:12.000Z",
      plannedRequests: 10,
      correlationId: "corr-periodic-enrichment",
    });

    await expect(service.recordTrafficCompletion(report)).rejects.toThrow(
      "injected abandoned enrichment",
    );
    await expect(completionEnrichmentService.reconcilePendingEnrichments()).resolves.toBe(1);
    const [finalization] = await db
      .select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, started.run.runId));

    expect(finalization?.completionEnrichmentStatus).toBe("completed");
    expect(businessReadCount).toBe(2);
  });

  it("keeps a completed enrichment capture failure immutable while finalization captures terminal inventory", async () => {
    const db = requireConnection(connection).db;
    const redisClient = requireRedis(redis);
    let failCapture = true;
    let captureReadCount = 0;
    const captureRedis = new Proxy(redisClient, {
      get(target, property) {
        if (property === "hgetall") {
          return async (...args: Parameters<typeof target.hgetall>) => {
            captureReadCount += 1;
            if (failCapture) {
              throw new Error("injected Redis capture failure");
            }
            return target.hgetall(...args);
          };
        }
        const value = target[property as keyof typeof target];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof redisClient;
    const businessOutcomeReader = { read: async () => emptyBusinessOutcomeSummary() };
    const completionEnrichmentService = new TrafficCompletionEnrichmentService({
      db,
      redis: captureRedis,
      businessOutcomeReader,
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });
    const finalizationService = new DemoRunFinalizationService({
      db,
      redis: redisClient,
      logger: createSilentLogger("api"),
      pendingPersistenceReconciler: noOpPendingPersistenceReconciler(),
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(db),
      terminalInventoryRead: createTerminalInventoryRead(redisClient),
      terminalInventoryReadTimeoutMs: 2_000,
      drainTimeoutSeconds: 300,
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });
    const service = createStartService(requireConnection(connection), redisClient, {
      businessOutcomeReader,
      completionEnrichmentService,
      finalizationService,
    });
    const started = await service.startRun(completionStartCommand(10), "corr-no-snapshot-start");
    const report: TrafficCompletionReport = {
      ...trafficCompletionFixture({
        runId: started.run.runId,
        status: "succeeded",
        exitCode: 0,
        completedAt: "2026-06-20T00:00:12.000Z",
        plannedRequests: 10,
        correlationId: "corr-no-snapshot",
      }),
      httpSummary: {
        ...trafficCompletionFixture({
          runId: started.run.runId,
          status: "succeeded",
          exitCode: 0,
          completedAt: "2026-06-20T00:00:12.000Z",
          plannedRequests: 10,
          correlationId: "corr-no-snapshot",
        }).httpSummary,
        startedRequests: 10,
        completedRequests: 10,
        interruptedRequests: 0,
        unstartedRequests: 0,
      },
      trafficDeliverySummary: {
        plannedRequests: 10,
        startedRequests: 10,
        completedRequests: 10,
        interruptedRequests: 0,
        unstartedRequests: 0,
        trafficMode: "buyer-spike",
        plannedBuyers: 10,
        scheduledRatePerSecond: null,
        configuredDurationSeconds: null,
        preAllocatedVUs: null,
        maxVUs: null,
        droppedIterations: 0,
        notes: [],
      },
      apiRequestLifecycleSummary: {
        plannedRequests: 10,
        startedRequests: 10,
        completedRequests: 10,
        interruptedRequests: 0,
        unstartedRequests: 0,
        failedRequests: 0,
      },
    };

    await expect(service.recordTrafficCompletion(report)).resolves.toMatchObject({
      status: "completed",
    });
    failCapture = false;
    await expect(service.recordTrafficCompletion(report)).resolves.toMatchObject({
      status: "completed",
    });
    const [finalization] = await db
      .select()
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, started.run.runId));
    const [summary] = await db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, started.run.runId));

    expect(finalization?.completionEnrichmentStatus).toBe("completed");
    expect(finalization?.trafficOutcomeSummary).not.toHaveProperty("terminalInventorySnapshot");
    expect(summary?.terminalInventorySnapshot).toMatchObject({
      saleOfferId: started.run.saleOfferId,
      source: "redis",
    });
    expect(captureReadCount).toBe(1);
  });

  it("returns the reset run when a delayed orchestrator acknowledgement loses activation CAS", async () => {
    const startConnection = requireConnection(connection);
    const resetConnection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 2 });
    let releaseTrafficStart: (() => void) | undefined;
    let trafficStartEntered: (() => void) | undefined;
    const trafficStartEnteredPromise = new Promise<void>((resolve) => {
      trafficStartEntered = resolve;
    });
    const trafficStartReleasePromise = new Promise<void>((resolve) => {
      releaseTrafficStart = resolve;
    });

    const service = createStartService(startConnection, requireRedis(redis), {
      trafficExecutionGateway: {
        start: async (request) => {
          trafficStartEntered?.();
          await trafficStartReleasePromise;
          return {
            runId: request.runId,
            status: "active",
            startedAt: "2026-06-20T00:00:11.000Z",
            correlationId: request.correlationId,
          };
        },
      },
    });
    const resetService = new DemoMaintenanceService({
      db: resetConnection.db,
      terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(resetConnection.db),
      redis: requireRedis(redis),
      queueMaintenance: {
        cleanResetOwnedQueues: async () => ({ cleanedQueueCount: 0, cleanedJobCount: 0 }),
        acquireGeneratedRunQuiescence: async () => ({ release: async () => undefined }),
        preflightGeneratedRun: async () => undefined,
        cleanGeneratedRun: async () => ({ deletedJobCount: 0 }),
      },
      deleteGeneratedRunDurable,
      deleteGeneratedRunRedisState,
      prepareGeneratedRunTeardown,
      completeGeneratedRunTeardown,
      clearErpCircuitBreakerState: async () => undefined,
      trafficAborter: { abortCurrent: async () => ({ outcome: "no_current_run" }) },
      dashboardLiveStateReset: new RedisDashboardTrafficMetricStore(requireRedis(redis)),
      resetWorkflowFence: new PostgresDemoResetWorkflowFence(resetConnection.sql),
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:20.000Z"),
    });

    try {
      const startPromise = service.startRun(
        { presetSlug: "preview-1k", operatorMode: "admin" },
        "corr-delayed-start",
      );
      await trafficStartEnteredPromise;

      const resetResponse = await resetService.reset("corr-reset-race");
      expect(resetResponse.failedRunCount).toBe(1);

      releaseTrafficStart?.();
      const startResponse = await startPromise;

      expect(startResponse.run).toMatchObject({
        runId: "77777777-7777-4777-8777-777777777777",
        status: "failed",
        trafficStatus: "failed",
        failureReason: "admin_reset",
        finalizedAt: "2026-06-20T00:00:20.000Z",
      });
      const [run] = await startConnection.db
        .select()
        .from(demoRuns)
        .where(eq(demoRuns.id, "77777777-7777-4777-8777-777777777777"));
      const [summary] = await startConnection.db
        .select()
        .from(demoRunSummaries)
        .where(eq(demoRunSummaries.runId, "77777777-7777-4777-8777-777777777777"));
      expect(run).toMatchObject({ status: "failed", failureReason: "admin_reset" });
      expect(summary).toMatchObject({
        status: "failed",
        failureReason: "admin_reset",
        endedAt: new Date("2026-06-20T00:00:20.000Z"),
      });
    } finally {
      releaseTrafficStart?.();
      await resetConnection.close();
    }
  });
});

function surge10kSnapshot(): AcceptedRunConfigSnapshot {
  return {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 10_000,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 2,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 1000,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 150,
      maxTps: 250,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 2000,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 10,
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
    },
  };
}

function requireTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for API tests.");
  }

  return databaseUrl;
}

function requireConnection(
  connection: ReturnType<typeof createDatabaseConnection> | null,
): ReturnType<typeof createDatabaseConnection> {
  if (!connection) {
    throw new Error("Test database connection was not initialized.");
  }

  return connection;
}

function requireTestRedisUrl(): string {
  const redisUrl = process.env.TEST_REDIS_URL;

  if (!redisUrl) {
    throw new Error("TEST_REDIS_URL is required for API demo-run tests.");
  }

  return redisUrl;
}

function requireRedis(
  redis: ReturnType<typeof createRedisClient> | null,
): ReturnType<typeof createRedisClient> {
  if (!redis) {
    throw new Error("Test Redis client was not initialized.");
  }

  return redis;
}

function createPresetManagementService(
  connection: ReturnType<typeof createDatabaseConnection>,
  deploymentHardCaps = publicRuntimePolicy().deploymentHardCaps,
  database = connection.db,
): DemoRunService {
  return new DemoRunService({
    db: database,
    terminalRunWriter: new PostgresTerminalDemoRunSummaryWriter(connection.db),
    redis: {} as never,
    trafficExecutionGateway: {
      start: async () => ({
        runId: "unused",
        status: "active",
        startedAt: "unused",
        correlationId: "unused",
      }),
    },
    publicRunBudgetStore: {
      reserve: async () => ({
        outcome: "allowed",
        reservation: {
          reservationId: "unused",
          globalKey: "g",
          visitorKey: "v",
          reservationKey: "r",
        },
      }),
      release: async () => undefined,
    },
    trafficMetricStore: {} as never,
    businessOutcomeReader: { read: async () => emptyBusinessOutcomeSummary() },
    completionEnrichmentService: { completePendingEnrichment: async () => "not_found" },
    finalizationService: noOpFinalizationService(),
    apiBaseUrl: "http://api.test",
    buyEndpointPath: "/buy",
    logger: createSilentLogger("api"),
    publicClientCookieSecret: publicCookieSecret,
    deploymentHardCaps,
    now: () => new Date("2026-06-20T00:00:10.000Z"),
    generateId: () => "66666666-6666-4666-8666-666666666666",
  });
}

function createMetricIngestionService(options: {
  appendAndPublishIfLive: RedisDashboardTrafficMetricStore["appendAndPublishIfLive"];
  warn: ReturnType<typeof vi.fn>;
  run?: { status: string; trafficStatus: string } | null;
}): DemoRunService {
  const selectedRun =
    options.run === undefined ? { status: "active", trafficStatus: "active" } : options.run;
  const database: Record<string, unknown> = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: async () => (selectedRun ? [selectedRun] : []),
          }),
        }),
      }),
    }),
  };
  database.transaction = async (operation: (tx: typeof database) => Promise<unknown>) =>
    operation(database);

  return new DemoRunService({
    db: database as never,
    redis: {} as never,
    trafficExecutionGateway: {} as never,
    publicRunBudgetStore: {} as never,
    trafficMetricStore: {
      appendAndPublishIfLive: options.appendAndPublishIfLive,
    } as RedisDashboardTrafficMetricStore,
    businessOutcomeReader: {} as never,
    completionEnrichmentService: {} as never,
    terminalRunWriter: {} as never,
    finalizationService: noOpFinalizationService(),
    apiBaseUrl: "http://api.test",
    buyEndpointPath: "/buy",
    logger: { warn: options.warn } as never,
    publicClientCookieSecret: publicCookieSecret,
    deploymentHardCaps: publicRuntimePolicy().deploymentHardCaps,
  });
}

function interceptNextSelectResult(
  database: ReturnType<typeof createDatabaseConnection>["db"],
  afterSelect: () => Promise<void>,
): ReturnType<typeof createDatabaseConnection>["db"] {
  let shouldIntercept = true;

  function wrapQueryBuilder<T extends object>(builder: T): T {
    return new Proxy(builder, {
      get(target, property) {
        if (property === "then") {
          return (
            onFulfilled?: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) =>
            Promise.resolve(target)
              .then(async (result) => {
                if (shouldIntercept) {
                  shouldIntercept = false;
                  await afterSelect();
                }
                return result;
              })
              .then(onFulfilled, onRejected);
        }

        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;

        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args) as unknown;
          return typeof result === "object" && result !== null ? wrapQueryBuilder(result) : result;
        };
      },
    });
  }

  return new Proxy(database, {
    get(target, property) {
      if (property === "select") {
        return (...args: unknown[]) =>
          wrapQueryBuilder(
            Reflect.apply(target.select, target, args) as ReturnType<typeof target.select>,
          );
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function createStartService(
  connection: ReturnType<typeof createDatabaseConnection>,
  redis: ReturnType<typeof createRedisClient>,
  overrides: {
    trafficExecutionGateway?: ConstructorParameters<
      typeof DemoRunService
    >[0]["trafficExecutionGateway"];
    publicRunBudgetStore?: ConstructorParameters<typeof DemoRunService>[0]["publicRunBudgetStore"];
    terminalRunWriter?: ConstructorParameters<typeof DemoRunService>[0]["terminalRunWriter"];
    businessOutcomeReader?: ConstructorParameters<
      typeof DemoRunService
    >[0]["businessOutcomeReader"];
    finalizationService?: ConstructorParameters<typeof DemoRunService>[0]["finalizationService"];
    completionEnrichmentService?: ConstructorParameters<
      typeof DemoRunService
    >[0]["completionEnrichmentService"];
    logger?: ConstructorParameters<typeof DemoRunService>[0]["logger"];
    trafficMetricStore?: ConstructorParameters<typeof DemoRunService>[0]["trafficMetricStore"];
  } = {},
): DemoRunService {
  const ids = [
    "77777777-7777-4777-8777-777777777777",
    "77777777-7777-4777-8777-777777777778",
    "77777777-7777-4777-8777-777777777779",
    "77777777-7777-4777-8777-777777777780",
  ];

  const businessOutcomeReader = overrides.businessOutcomeReader ?? {
    read: async () => emptyBusinessOutcomeSummary(),
  };
  const logger = overrides.logger ?? createSilentLogger("api");
  const completionEnrichmentService =
    overrides.completionEnrichmentService ??
    new TrafficCompletionEnrichmentService({
      db: connection.db,
      redis,
      businessOutcomeReader,
      logger,
      now: () => new Date("2026-06-20T00:00:10.000Z"),
    });

  return new DemoRunService({
    db: connection.db,
    terminalRunWriter:
      overrides.terminalRunWriter ?? new PostgresTerminalDemoRunSummaryWriter(connection.db),
    redis,
    trafficExecutionGateway: overrides.trafficExecutionGateway ?? {
      start: async (request) => ({
        runId: request.runId,
        status: "active",
        startedAt: "2026-06-20T00:00:11.000Z",
        correlationId: request.correlationId,
      }),
    },
    publicRunBudgetStore: overrides.publicRunBudgetStore ?? {
      reserve: async () => ({
        outcome: "allowed",
        reservation: {
          reservationId: "unused",
          globalKey: "g",
          visitorKey: "v",
          reservationKey: "r",
        },
      }),
      release: async () => undefined,
    },
    trafficMetricStore: overrides.trafficMetricStore ?? ({} as never),
    businessOutcomeReader,
    completionEnrichmentService,
    finalizationService: overrides.finalizationService ?? {
      finalizeRun: async () => null,
      finalizeReadyRuns: async () => 0,
    },
    apiBaseUrl: "http://api.test",
    buyEndpointPath: "/buy",
    logger,
    publicClientCookieSecret: publicCookieSecret,
    deploymentHardCaps: publicRuntimePolicy().deploymentHardCaps,
    now: () => new Date("2026-06-20T00:00:10.000Z"),
    generateId: () => {
      const id = ids.shift();
      if (!id) {
        throw new Error("Start-service ID sequence exhausted.");
      }
      return id;
    },
  });
}

function redisUnavailable(): ReturnType<typeof createRedisClient> {
  return {
    hget: async () => {
      throw new Error("Redis unavailable during initialization.");
    },
    eval: async () => {
      throw new Error("Redis unavailable during cleanup.");
    },
    hgetall: async () => {
      throw new Error("Redis unavailable during snapshot capture.");
    },
    publish: async () => {
      throw new Error("Redis unavailable during event publication.");
    },
  } as unknown as ReturnType<typeof createRedisClient>;
}

function noOpFinalizationService() {
  return {
    finalizeRun: async () => null,
    finalizeReadyRuns: async () => 0,
  };
}

function noOpPendingPersistenceReconciler() {
  return {
    reconcileSaleOffer: async () => ({
      found: 0,
      materialized: 0,
      reconciled: 0,
      reversed: 0,
      failed: 0,
    }),
  };
}

function expectBuyerSpikeTrafficConfig(
  trafficConfig: TrafficConfig,
): Extract<TrafficConfig, { mode: "buyer-spike" }> {
  if (trafficConfig.mode !== "buyer-spike") {
    throw new Error(`Expected buyer-spike traffic config, received ${trafficConfig.mode}.`);
  }

  return trafficConfig;
}

async function readPresetRow(
  connection: ReturnType<typeof createDatabaseConnection>,
  slug: string,
): Promise<typeof demoPresets.$inferSelect> {
  const presets = await connection.db.select().from(demoPresets);
  const preset = presets.find((candidate) => candidate.slug === slug);

  if (!preset) {
    throw new Error(`Expected seeded preset ${slug}.`);
  }

  return preset;
}

function emptyBusinessOutcomeSummary(): BusinessOutcomeSummary {
  return {
    acceptedReservations: 0,
    soldOutRejections: 0,
    queuedOrders: 0,
    processingOrders: 0,
    retryingOrders: 0,
    confirmedOrders: 0,
    failedOrders: 0,
    pendingPersistenceCount: 0,
    notificationsRecorded: 0,
  };
}

function completionStartCommand(plannedRequests: number) {
  return {
    presetSlug: "preview-1k",
    operatorMode: "admin" as const,
    configOverride: {
      trafficConfig: {
        mode: "buyer-spike" as const,
        buyerCount: plannedRequests,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 2,
        quantityPerAttempt: 1,
      },
    },
  };
}

function trafficCompletionFixture(input: {
  runId: string;
  status: "succeeded" | "failed";
  exitCode: number;
  errorMessage?: string;
  completedAt: string;
  plannedRequests: number;
  correlationId: string;
}): TrafficCompletionReport {
  return {
    runId: input.runId,
    status: input.status,
    exitCode: input.exitCode,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    httpSummary: {
      plannedRequests: input.plannedRequests,
      startedRequests: 0,
      completedRequests: 0,
      interruptedRequests: 0,
      unstartedRequests: input.plannedRequests,
      failedRequests: 0,
      acceptedResponses: 0,
      soldOutResponses: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    trafficOutcomeSummary: {},
    trafficDeliverySummary: {
      plannedRequests: input.plannedRequests,
      startedRequests: 0,
      completedRequests: 0,
      interruptedRequests: 0,
      unstartedRequests: input.plannedRequests,
      trafficMode: "buyer-spike",
      plannedBuyers: input.plannedRequests,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: input.plannedRequests,
      notes: [],
    },
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    loadRunDiagnosticsSummary: runnerDiagnosticsFixture(input.completedAt, input.plannedRequests),
    apiRequestLifecycleSummary: {
      plannedRequests: input.plannedRequests,
      startedRequests: 0,
      completedRequests: 0,
      interruptedRequests: 0,
      unstartedRequests: input.plannedRequests,
      failedRequests: 0,
    },
    completedAt: input.completedAt,
    correlationId: input.correlationId,
  };
}

function runnerDiagnosticsFixture(
  completedAt = "2026-06-20T00:00:12.000Z",
  plannedRequests = 10_000,
): TrafficCompletionReport["loadRunDiagnosticsSummary"] {
  return {
    startedAt: "2026-06-20T00:00:11.000Z",
    completedAt,
    nproc: null,
    ulimitNofile: null,
    processMaxOpenFiles: null,
    networkDiagnostics: null,
    k6Version: null,
    executionPlan: {
      trafficMode: "buyer-spike",
      buyerCount: plannedRequests,
      duplicateEachBuyerAttempt: false,
      iterationsPerVu: 1,
      plannedEmittedAttempts: plannedRequests,
      startDelaySeconds: 0,
      maxDurationSeconds: 2,
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
      unexpectedResponses: "summary_export",
      droppedIterations: "summary_export",
      completedIterations: "summary_export",
    },
    summaryExportWarnings: [],
  };
}

async function seedStartFixtures(
  connection: ReturnType<typeof createDatabaseConnection>,
): Promise<void> {
  await connection.db.insert(products).values({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sku: "START-GATING-001",
    slug: "start-gating-product",
    name: "Start Gating Product",
    isActive: true,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await seedPresetFixtures(connection);
  await connection.db.insert(publicRuntimePolicies).values({
    id: "active",
    policy: publicRuntimePolicyMutable(),
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
}

async function seedExistingRun(
  connection: ReturnType<typeof createDatabaseConnection>,
  input: {
    runId: string;
    status: "starting" | "active" | "draining" | "completed" | "failed";
  },
): Promise<void> {
  await connection.db.insert(demoRuns).values({
    id: input.runId,
    presetId: "33333333-3333-4333-8333-333333333331",
    presetName: "Preview 1k",
    operatorMode: "admin",
    status: input.status,
    trafficStatus: trafficStatusForRunStatus(input.status),
    configSnapshot: surge10kSnapshot(),
    startedAt: new Date("2026-06-20T00:00:00.000Z"),
    ...(input.status === "draining" || input.status === "completed" || input.status === "failed"
      ? { trafficEndedAt: new Date("2026-06-20T00:00:05.000Z") }
      : {}),
    ...(input.status === "completed" || input.status === "failed"
      ? { finalizedAt: new Date("2026-06-20T00:00:06.000Z") }
      : {}),
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:06.000Z"),
  });
}

function trafficStatusForRunStatus(
  status: "starting" | "active" | "draining" | "completed" | "failed",
): "starting" | "active" | "succeeded" | "failed" {
  if (status === "starting" || status === "active") {
    return status;
  }
  if (status === "failed") {
    return "failed";
  }

  return "succeeded";
}

function existingRunId(status: "starting" | "active" | "draining" | "completed" | "failed") {
  const suffix = {
    starting: "1",
    active: "2",
    draining: "3",
    completed: "4",
    failed: "5",
  }[status];

  return `55555555-5555-4555-8555-55555555555${suffix}`;
}

async function seedPresetFixtures(
  connection: ReturnType<typeof createDatabaseConnection>,
): Promise<void> {
  const now = new Date("2026-06-20T00:00:00.000Z");
  const snapshot = surge10kSnapshot();

  await connection.db.insert(demoPresets).values([
    {
      id: "33333333-3333-4333-8333-333333333331",
      slug: "preview-1k",
      visibility: "public",
      isEditable: false,
      isCustom: false,
      display: {
        name: "Preview 1k",
        description: "Preview run.",
        sortOrder: 10,
        outcomeFocus: ["happy_path"],
      },
      ...snapshot,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "33333333-3333-4333-8333-333333333335",
      slug: "public-custom",
      visibility: "public",
      isEditable: false,
      isCustom: true,
      display: {
        name: "Public Custom",
        description: "Public custom base.",
        sortOrder: 20,
        outcomeFocus: [],
      },
      ...snapshot,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "44444444-4444-4444-8444-444444444443",
      slug: "custom",
      visibility: "admin",
      isEditable: true,
      isCustom: true,
      display: {
        name: "Custom",
        description: "Editable scratch preset.",
        sortOrder: 120,
        outcomeFocus: [],
      },
      ...snapshot,
      createdAt: now,
      updatedAt: now,
    },
  ]);
}

function publicRuntimePolicy(): PublicRuntimePolicy {
  return {
    isPublicRunBudgetEnforced: true,
    publicRunBudget: {
      windowSeconds: 300,
      perVisitorMaxStarts: 2,
      globalMaxStarts: 6,
    },
    publicCustomDefaults: {
      ...surge10kSnapshot(),
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 500,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 10,
        quantityPerAttempt: 1,
      },
      erpConfig: {
        latencyMs: 100,
        maxTps: 100,
        errorRate: 0,
        forcedOutage: false,
        requestTimeoutMs: 2000,
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
    },
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
      maxErpMaxTps: 100,
      maxErpErrorRate: 0.25,
      allowForcedOutage: false,
      allowedTrafficModes: ["buyer-spike", "steady-arrival-rate"],
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

function publicRuntimePolicyMutable() {
  const policy = publicRuntimePolicy();

  return {
    isPublicRunBudgetEnforced: policy.isPublicRunBudgetEnforced,
    publicRunBudget: policy.publicRunBudget,
    publicCustomDefaults: policy.publicCustomDefaults,
    publicCustomLimits: policy.publicCustomLimits,
  };
}

function createTerminalInventoryRead(redis: ReturnType<typeof createRedisClient>) {
  return {
    read: ({ saleOfferId, observedAt }: { saleOfferId: string; observedAt: Date }) =>
      getInventoryStatus(redis, saleOfferId, observedAt),
  };
}
