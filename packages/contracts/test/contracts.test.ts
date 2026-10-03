import { describe, expect, it } from "vitest";
import {
  type AcceptedRunConfigSnapshot,
  acceptedRunConfigSnapshotSchema,
  acceptedRunConfigWriteSchema,
  adminDeleteRunHistoryRequestSchema,
  adminDeleteRunHistoryResponseSchema,
  adminGeneratedRunTeardownParamsSchema,
  adminGeneratedRunTeardownPath,
  adminGeneratedRunTeardownPathTemplate,
  adminGeneratedRunTeardownResponseSchema,
  adminPresetListPath,
  adminPresetListResponseSchema,
  adminPublicRuntimePolicyPath,
  adminPublicRuntimePolicyResponseSchema,
  adminPublicRuntimePolicyUpdateRequestSchema,
  adminRunHistoryDetailPath,
  adminRunHistoryDetailPathTemplate,
  adminRunHistoryDetailResponseSchema,
  archiveAdminPresetRequestSchema,
  archiveAdminPresetResponseSchema,
  automaticRunResetDeadlineSeconds,
  buyRequestSchema,
  buyResponseSchema,
  collectAcceptedRunConfigSnapshotViolations,
  collectPublicRuntimePolicyMutableViolations,
  collectPublicRuntimePolicyViolations,
  countUnavailableLoadRunDiagnosticProbes,
  dashboardLiveUpdateExpectedIntervalMs,
  dashboardProjectionDirtySignalSchema,
  dashboardProjectionSchema,
  dashboardProjectionSchemaName,
  dashboardProjectionScopeId,
  dashboardProjectionScopeSchema,
  dashboardRecoveryQuerySchema,
  demoRunOperatorModeHeaderName,
  demoRunSnapshotSchema,
  deriveLoadExecutionPlan,
  deriveRecordedReplyCount,
  deriveRunResult,
  destructiveResetReasonValues,
  emptyHttpTimingBreakdownSummary,
  emptyRequestArrivalSummary,
  erpConfirmationLookupPath,
  erpConfirmationPath,
  erpConfirmationRequestSchema,
  erpConfirmationResponseSchema,
  errorPayloadCodes,
  errorPayloadSchema,
  hasObservedRequestArrivals,
  healthReadyPath,
  healthResponseSchema,
  internalLoadMetricIngestPath,
  internalRunFailureReasonSchema,
  internalTrafficCompletionPath,
  inventoryStatusSchema,
  inventoryUpdatedEventPayloadSchema,
  loadExecutionPlanSchema,
  loadMetricIngestRequestSchema,
  loadRunDiagnosticsSummarySchema,
  loadRunIdHeaderName,
  maximumAutomaticallyDerivedVUs,
  metricNameValues,
  nonnegativeIntegerSchema,
  nonnegativeNumberMinimum,
  orderProcessBullMqQueueName,
  orderProcessJobSchema,
  orderProcessQueueName,
  orderStatusParamsSchema,
  orderStatusRequestSchema,
  orderStatusResponseSchema,
  type PublicRuntimePolicy,
  percentageMaximum,
  percentageMinimum,
  percentageSchema,
  positiveIntegerMinimum,
  positiveIntegerSchema,
  publicPresetListPath,
  publicRunHistoryDetailResponseSchema,
  publicRuntimePolicyMutableSchema,
  publicRuntimePolicyPath,
  publicRuntimePolicyPersistedSchema,
  publicRuntimePolicySchema,
  publicVisitorIdHeaderName,
  queueStatusSchema,
  requestArrivalSummarySchema,
  reservationDecisionValues,
  reservationRejectedResponseSchema,
  reservationTimingMeasurementSchema,
  resolveConstantArrivalVus,
  runErpOutcomeSummarySchema,
  runHistoryDetailParamsSchema,
  runHistoryDetailPath,
  runHistoryDetailPathTemplate,
  runHistoryExceptionSummarySchema,
  runHistoryListQuerySchema,
  runHistoryListResponseSchema,
  runHistoryPath,
  runHistorySummarySchema,
  securedReservationHoldSchema,
  serverReservationTimingSummarySchema,
  sharedRuntimeStatusSchema,
  startDemoRunPath,
  startDemoRunRequestSchema,
  stockReservationDecisionSchema,
  toPublicRunFailureCategory,
  trafficCompletionAcknowledgementSchema,
  trafficCompletionDeliverySummarySchema,
  trafficCompletionReportSchema,
  trafficDeliverySummarySchema,
  trafficExecutionAbortPath,
  trafficExecutionAbortRequestSchema,
  trafficExecutionAbortResponseSchema,
  trafficExecutionStartPath,
  trafficExecutionStartRequestSchema,
  trafficExecutionStatusPath,
  trafficExecutionStatusResponseSchema,
  trafficHttpSummarySchema,
  transportAttemptCountsSchema,
} from "../src/index.js";

const timestamp = "2026-06-20T12:00:00.000Z";

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const result: Partial<T> = { ...value };
  delete result[key];
  return result as Omit<T, K>;
}
const correlationId = "corr-test-1";
const saleOfferId = "22222222-2222-4222-8222-222222222222";
const runId = "55555555-5555-4555-8555-555555555555";
const serverReservationTimingSummary = serverReservationTimingSummarySchema.parse({
  redisAtomicReservation: { sampleCount: 10, averageMs: 0.7, p95Ms: 1 },
  reserveOrderService: { sampleCount: 10, averageMs: 12, p95Ms: 25 },
});

describe("intrinsic numeric contract bounds", () => {
  it("exports the same bounds enforced by the canonical primitive schemas", () => {
    expect(positiveIntegerSchema.safeParse(positiveIntegerMinimum).success).toBe(true);
    expect(positiveIntegerSchema.safeParse(positiveIntegerMinimum - 1).success).toBe(false);
    expect(positiveIntegerSchema.safeParse(positiveIntegerMinimum + 0.5).success).toBe(false);
    expect(nonnegativeIntegerSchema.safeParse(nonnegativeNumberMinimum).success).toBe(true);
    expect(nonnegativeIntegerSchema.safeParse(nonnegativeNumberMinimum - 1).success).toBe(false);
    expect(percentageSchema.safeParse(percentageMinimum).success).toBe(true);
    expect(percentageSchema.safeParse(percentageMaximum).success).toBe(true);
    expect(percentageSchema.safeParse(percentageMaximum + 0.01).success).toBe(false);
  });
});

describe("accepted run configuration", () => {
  const snapshot = {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 1,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 1,
      quantityPerAttempt: 1,
    },
    inventoryConfig: { startingStock: 1 },
    erpConfig: { latencyMs: 0, maxTps: 1, errorRate: 0, forcedOutage: false },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 1,
    },
  };

  it("accepts a valid accepted run configuration", () => {
    expect(acceptedRunConfigSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("enforces the deployment concurrency cap strictly", () => {
    expect(
      acceptedRunConfigSnapshotSchema.safeParse({
        ...snapshot,
        backpressureConfig: { ...snapshot.backpressureConfig, orderProcessConcurrency: 11 },
      }).success,
    ).toBe(false);
    expect(
      acceptedRunConfigSnapshotSchema.safeParse({
        ...snapshot,
        backpressureConfig: { ...snapshot.backpressureConfig, unknown: true },
      }).success,
    ).toBe(false);
  });

  it("rejects unsupported run-config fields and engine knobs instead of falling back", () => {
    const unsupportedErpConfig = {
      ...snapshot,
      erpConfig: { ...snapshot.erpConfig, requestTimeoutMs: 2000 },
    };
    expect(acceptedRunConfigSnapshotSchema.safeParse(unsupportedErpConfig).success).toBe(false);
    expect(acceptedRunConfigWriteSchema.safeParse(unsupportedErpConfig).success).toBe(false);
    expect(
      acceptedRunConfigSnapshotSchema.safeParse({
        ...snapshot,
        backpressureConfig: {
          ...snapshot.backpressureConfig,
          pendingPersistenceRetryAfterSeconds: 30,
          retryPolicy: { maxAttempts: 1, initialBackoffMs: 0 },
          drainTimeoutSeconds: 300,
          circuitBreakerFailureThreshold: 5,
          circuitBreakerResetTimeoutMs: 10_000,
        },
      }).success,
    ).toBe(false);
  });
});

describe("traffic ownership contracts", () => {
  it("defines strict run-fenced status and completion acknowledgements", () => {
    expect(trafficExecutionStatusPath).toBe("/traffic/status/:runId");
    expect(
      trafficExecutionStatusResponseSchema.parse({
        runId: "55555555-5555-4555-8555-555555555555",
        state: "accepted",
        bootId: "11111111-1111-4111-8111-111111111111",
        version: "unknown",
        acceptedAt: "2026-06-20T00:00:01.000Z",
        observedAt: "2026-06-20T00:00:02.000Z",
        correlationId: "contract-test",
      }),
    ).toMatchObject({ state: "accepted" });
    expect(
      trafficCompletionAcknowledgementSchema.parse({
        runId: "55555555-5555-4555-8555-555555555555",
        acknowledged: true,
        correlationId: "contract-test",
      }),
    ).toMatchObject({ acknowledged: true });
  });
});

describe("shared lifecycle vocabulary", () => {
  it("exposes the dashboard metric names", () => {
    expect(metricNameValues).toEqual([
      "traffic.request_arrival_rate",
      "traffic.response_completion_rate",
      "traffic.attempts_dispatched",
      "traffic.latency",
      "traffic.failure_rate",
    ]);
  });
});

describe("request-arrival evidence", () => {
  it("round-trips a bounded series and rejects inconsistent truncation metadata", () => {
    const summary = {
      firstAttemptStartedAt: timestamp,
      peakArrivalRatePerSecond: 10,
      peakArrivalWindowSeconds: 1,
      dispatchDurationSeconds: 0.25,
      arrivalRateSeries: [{ windowStartedAt: timestamp, ratePerSecond: 10 }],
      arrivalWindowCountObserved: 2,
      arrivalWindowCountRetained: 1,
      arrivalSeriesLimit: 120 as const,
    };

    expect(requestArrivalSummarySchema.parse(summary)).toEqual(summary);
    expect(
      requestArrivalSummarySchema.safeParse({
        ...summary,
        arrivalWindowCountRetained: 2,
      }).success,
    ).toBe(false);
    expect(
      requestArrivalSummarySchema.safeParse({
        ...summary,
        arrivalRateSeries: Array.from({ length: 121 }, () => summary.arrivalRateSeries[0]),
        arrivalWindowCountObserved: 121,
        arrivalWindowCountRetained: 121,
      }).success,
    ).toBe(false);
  });

  it("separates an absence of observation from a measured zero arrival rate", () => {
    expect(hasObservedRequestArrivals(emptyRequestArrivalSummary)).toBe(false);
    // A summary can retain no window and still prove the generator started attempts.
    expect(
      hasObservedRequestArrivals({
        ...emptyRequestArrivalSummary,
        firstAttemptStartedAt: timestamp,
      }),
    ).toBe(true);
    expect(
      hasObservedRequestArrivals({
        ...emptyRequestArrivalSummary,
        arrivalWindowCountObserved: 1,
      }),
    ).toBe(true);
  });
});

describe("run lifecycle contracts", () => {
  it("validates the fenced traffic abort control contract", () => {
    expect(trafficExecutionAbortPath).toBe("/traffic/current/abort");
    expect(trafficExecutionAbortRequestSchema.parse({})).toEqual({});
    expect(trafficExecutionAbortRequestSchema.parse({ reason: "  reset  " }).reason).toBe("reset");
    expect(
      trafficExecutionAbortRequestSchema.parse({ reason: "x".repeat(500) }).reason,
    ).toHaveLength(500);
    expect(() => trafficExecutionAbortRequestSchema.parse({ runId: "not-a-uuid" })).toThrow();
    expect(() => trafficExecutionAbortRequestSchema.parse({ reason: "x".repeat(501) })).toThrow();
    expect(
      trafficExecutionAbortResponseSchema.parse({
        outcome: "current_run_aborted",
        requestedRunId: runId,
        abortedRunId: runId,
        observedAt: timestamp,
        correlationId,
      }),
    ).toBeTruthy();
    expect(() =>
      trafficExecutionAbortResponseSchema.parse({
        outcome: "current_run_aborted",
        observedAt: timestamp,
        correlationId,
      }),
    ).toThrow();
    expect(() =>
      trafficExecutionAbortResponseSchema.parse({
        outcome: "current_run_aborted",
        requestedRunId: runId,
        abortedRunId: "66666666-6666-4666-8666-666666666666",
        observedAt: timestamp,
        correlationId,
      }),
    ).toThrow();
  });
  it("enforces resolved execution-plan and diagnostic count invariants", () => {
    const { terminalMetricSources: _terminalMetricSources, ...fullyUnavailableDiagnostics } =
      loadRunDiagnosticsSummarySchema.parse(runnerDiagnostics());
    expect(countUnavailableLoadRunDiagnosticProbes(fullyUnavailableDiagnostics)).toBe(
      countUnavailableLoadRunDiagnosticProbes(null),
    );
    expect(() =>
      loadExecutionPlanSchema.parse({
        ...runnerDiagnostics().executionPlan,
        plannedEmittedAttempts: 9,
      }),
    ).toThrow();
    expect(
      loadExecutionPlanSchema.parse({
        trafficMode: "constant-arrival-rate",
        ratePerSecond: 5,
        durationSeconds: 2,
        plannedEmittedAttempts: 10,
        startDelaySeconds: 0,
        preAllocatedVus: 3,
        maxVus: 10,
      }),
    ).toBeTruthy();
    expect(() =>
      loadRunDiagnosticsSummarySchema.parse({
        ...runnerDiagnostics(),
        networkDiagnostics: { ipLocalPortRange: null, tcpTwReuse: null, tcpTimestamps: null },
      }),
    ).toThrow();
    expect(() =>
      loadRunDiagnosticsSummarySchema.parse({
        ...runnerDiagnostics(),
        stderrLines: ["line"],
        stderrLineCountRetained: 0,
      }),
    ).toThrow();
    expect(() =>
      loadRunDiagnosticsSummarySchema.parse({
        ...runnerDiagnostics(),
        stderrLineTruncatedCount: 1,
        stderrLineCountObserved: 0,
      }),
    ).toThrow();
    expect(() =>
      loadExecutionPlanSchema.parse({
        ...runnerDiagnostics().executionPlan,
        iterationsPerVu: 2,
        plannedEmittedAttempts: 20,
      }),
    ).toThrow();
    expect(() =>
      loadExecutionPlanSchema.parse({
        trafficMode: "constant-arrival-rate",
        ratePerSecond: 5,
        durationSeconds: 2,
        plannedEmittedAttempts: 10,
        startDelaySeconds: 0,
        preAllocatedVus: 11,
        maxVus: 10,
      }),
    ).toThrow();
    expect(() =>
      loadRunDiagnosticsSummarySchema.parse({
        ...runnerDiagnostics(),
        networkDiagnostics: {
          ipLocalPortRange: "32768 60999 trailing",
          tcpTwReuse: null,
          tcpTimestamps: null,
        },
      }),
    ).toThrow();
    expect(() =>
      loadRunDiagnosticsSummarySchema.parse({
        ...runnerDiagnostics(),
        completedAt: "2026-06-20T11:59:59.000Z",
      }),
    ).toThrow();
    expect(
      loadRunDiagnosticsSummarySchema.parse({
        ...runnerDiagnostics(),
        liveMetricLoss: { sampleCount: 12, batchCount: 2 },
      }).liveMetricLoss,
    ).toEqual({ sampleCount: 12, batchCount: 2 });
    expect(() =>
      loadRunDiagnosticsSummarySchema.parse({
        ...runnerDiagnostics(),
        liveMetricLoss: { sampleCount: -1, batchCount: 1 },
      }),
    ).toThrow();
  });
  it("validates populated, partial, unavailable, and invalid generator capacity", () => {
    const populated = {
      memTotalBytes: 8_589_934_592,
      memAvailableBytes: 6_442_450_944,
      swapTotalBytes: 0,
      cgroupMemoryLimitBytes: 4_294_967_296,
      cgroupMemoryLimitUnlimited: false,
      cgroupCpuQuota: 1.5,
      cgroupCpuQuotaUnlimited: false,
    };
    expect(
      loadRunDiagnosticsSummarySchema.parse({
        ...runnerDiagnostics(),
        generatorCapacity: populated,
      }).generatorCapacity,
    ).toEqual(populated);
    expect(
      loadRunDiagnosticsSummarySchema.parse({
        ...runnerDiagnostics(),
        generatorCapacity: {
          ...populated,
          memTotalBytes: null,
          memAvailableBytes: null,
          cgroupMemoryLimitBytes: null,
          cgroupMemoryLimitUnlimited: true,
          cgroupCpuQuota: null,
          cgroupCpuQuotaUnlimited: null,
        },
      }).generatorCapacity,
    ).toMatchObject({ swapTotalBytes: 0, cgroupMemoryLimitUnlimited: true });
    expect(() =>
      loadRunDiagnosticsSummarySchema.parse({
        ...runnerDiagnostics(),
        generatorCapacity: {
          memTotalBytes: null,
          memAvailableBytes: null,
          swapTotalBytes: null,
          cgroupMemoryLimitBytes: null,
          cgroupMemoryLimitUnlimited: null,
          cgroupCpuQuota: null,
          cgroupCpuQuotaUnlimited: null,
        },
      }),
    ).toThrow();
    for (const cgroupCpuQuota of [-1, Number.POSITIVE_INFINITY]) {
      expect(() =>
        loadRunDiagnosticsSummarySchema.parse({
          ...runnerDiagnostics(),
          generatorCapacity: {
            ...populated,
            cgroupCpuQuota,
          },
        }),
      ).toThrow();
    }
    expect(() =>
      loadRunDiagnosticsSummarySchema.parse({
        ...runnerDiagnostics(),
        generatorCapacity: { ...populated, cgroupCpuQuotaUnlimited: null },
      }),
    ).toThrow();
  });
  it("validates sampled generator utilisation and rejects unavailable or invalid blocks", () => {
    const populated = {
      peakK6RssBytes: 268_435_456,
      peakCgroupMemoryBytes: 536_870_912,
      minimumHostMemAvailableBytes: 4_294_967_296,
      peakCpuUtilisationPercent: 100,
      meanCpuUtilisationPercent: 75,
      peakCgroupSwapBytes: 0,
      finalMemoryEventsHighCount: 0,
      finalMemoryEventsMaxCount: 0,
      finalMemoryEventsOomKillCount: 0,
      sampleCount: 5,
      effectiveIntervalMs: 1_000,
    };
    expect(
      loadRunDiagnosticsSummarySchema.parse({
        ...runnerDiagnostics(),
        generatorUtilisation: populated,
      }).generatorUtilisation,
    ).toEqual(populated);
    expect(
      loadRunDiagnosticsSummarySchema.parse({
        ...runnerDiagnostics(),
        generatorUtilisation: {
          ...populated,
          peakK6RssBytes: null,
          peakCpuUtilisationPercent: null,
          meanCpuUtilisationPercent: null,
        },
      }).generatorUtilisation,
    ).toMatchObject({ peakCgroupSwapBytes: 0, sampleCount: 5 });
    expect(() =>
      loadRunDiagnosticsSummarySchema.parse({
        ...runnerDiagnostics(),
        generatorUtilisation: {
          peakK6RssBytes: null,
          peakCgroupMemoryBytes: null,
          minimumHostMemAvailableBytes: null,
          peakCpuUtilisationPercent: null,
          meanCpuUtilisationPercent: null,
          peakCgroupSwapBytes: null,
          finalMemoryEventsHighCount: null,
          finalMemoryEventsMaxCount: null,
          finalMemoryEventsOomKillCount: null,
          sampleCount: 1,
          effectiveIntervalMs: 1_000,
        },
      }),
    ).toThrow();
    for (const invalid of [
      { sampleCount: 0 },
      { effectiveIntervalMs: 0 },
      { peakCpuUtilisationPercent: Number.POSITIVE_INFINITY },
    ]) {
      expect(() =>
        loadRunDiagnosticsSummarySchema.parse({
          ...runnerDiagnostics(),
          generatorUtilisation: { ...populated, ...invalid },
        }),
      ).toThrow();
    }
  });
  it("validates run-attributed load payloads with colon-shaped correlation IDs", () => {
    expect(
      trafficExecutionStartRequestSchema.parse({
        runId,
        saleOfferId,
        apiBaseUrl: "http://api.local",
        correlationId,
        configSnapshot: acceptedRunSnapshot(),
      }),
    ).toMatchObject({ runId, saleOfferId, correlationId });

    expect(() =>
      trafficExecutionStartRequestSchema.parse({
        runId,
        saleOfferId,
        apiBaseUrl: "http://api.local",
        correlationId: `run:${runId}:buyer:1`,
        configSnapshot: acceptedRunSnapshot(),
      }),
    ).not.toThrow();
  });

  it("keeps constant-arrival VU overrides all-or-nothing and validates their relationship", () => {
    const request = {
      runId,
      saleOfferId,
      apiBaseUrl: "http://api.local",
      correlationId,
      configSnapshot: {
        ...acceptedRunSnapshot(),
        trafficConfig: {
          mode: "constant-arrival-rate",
          ratePerSecond: 10,
          startDelaySeconds: 0,
          durationSeconds: 2,
          quantityPerAttempt: 1,
          k6Vus: { preAllocatedVus: 10, maxVus: 10 },
        },
      },
    };

    expect(trafficExecutionStartRequestSchema.safeParse(request).success).toBe(true);
    expect(
      trafficExecutionStartRequestSchema.safeParse({
        ...request,
        configSnapshot: {
          ...request.configSnapshot,
          trafficConfig: {
            ...request.configSnapshot.trafficConfig,
            k6Vus: { preAllocatedVus: 10 },
          },
        },
      }).success,
    ).toBe(false);

    const contradictory = trafficExecutionStartRequestSchema.safeParse({
      ...request,
      configSnapshot: {
        ...request.configSnapshot,
        trafficConfig: {
          ...request.configSnapshot.trafficConfig,
          k6Vus: { preAllocatedVus: 11, maxVus: 10 },
        },
      },
    });
    expect(contradictory.success).toBe(false);
    if (!contradictory.success) {
      expect(contradictory.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["configSnapshot", "trafficConfig", "k6Vus", "maxVus"],
          message: "maxVus must be greater than or equal to preAllocatedVus.",
        }),
      );
    }
  });

  it("separates traffic completion from API-owned terminal demo-run state", () => {
    const report = trafficCompletionReportSchema.parse({
      runId,
      status: "succeeded",
      exitCode: 0,
      transportAttemptCounts: {
        plannedRequests: 10,
        startedRequests: 10,
        completedRequests: 10,
        interruptedRequests: 0,
        unstartedRequests: 0,
      },
      httpSummary: {
        failedRequests: 0,
        acceptedResponses: 2,
        soldOutResponses: 8,
        transportFailures: 0,
        unexpectedResponses: 0,
        p95LatencyMs: 25,
        failureRate: 0,
      },
      trafficOutcomeSummary: {},
      trafficDeliverySummary: {
        trafficMode: "buyer-spike",
        plannedBuyers: 10,
        scheduledRatePerSecond: null,
        configuredDurationSeconds: null,
        preAllocatedVUs: null,
        maxVUs: null,
        droppedIterations: 0,
        requestArrivalSummary: emptyRequestArrivalSummary,
        notes: [],
      },
      httpTimingBreakdownSummary: {
        ...emptyHttpTimingBreakdownSummary,
        waiting: { averageMs: 10, p95Ms: 20 },
      },
      loadRunDiagnosticsSummary: {
        ...runnerDiagnostics(),
        terminalMetricSources: {
          startedRequests: "summary_export",
          completedRequests: "summary_export",
          acceptedResponses: "point_stream",
          soldOutResponses: "summary_export",
          transportFailures: "summary_export" as const,
          unexpectedResponses: null,
          droppedIterations: "summary_export",
          completedIterations: "summary_export",
        },
        summaryExportWarnings: ["k6_outcome_counter_point_stream_fallback_used"],
      },
      completedAt: timestamp,
      correlationId,
    });

    expect(report.status).toBe("succeeded");
    expect(report.httpTimingBreakdownSummary.waiting?.p95Ms).toBe(20);
    expect(report.loadRunDiagnosticsSummary.terminalMetricSources?.acceptedResponses).toBe(
      "point_stream",
    );
    expect(() => demoRunSnapshotSchema.parse({ ...report, status: "completed" })).toThrow();
  });

  it("derives recorded replies from completed attempts and transport failures", () => {
    expect(
      deriveRecordedReplyCount(
        {
          plannedRequests: 10,
          startedRequests: 10,
          completedRequests: 8,
          interruptedRequests: 2,
          unstartedRequests: 0,
        },
        3,
      ),
    ).toBe(5);
  });

  it("requires reservation timing values when samples are present", () => {
    expect(() =>
      reservationTimingMeasurementSchema.parse({
        sampleCount: 0,
        averageMs: 0,
        p95Ms: null,
      }),
    ).toThrow();
  });

  it("binds demo-run lifecycle states to their legal timestamp shapes", () => {
    const baseRun = {
      runId,
      presetId: "22222222-2222-4222-8222-222222222222",
      presetName: "Preview 1k",
      operatorMode: "public",
      saleOfferId,
      configSnapshot: acceptedRunSnapshot(),
      startedAt: timestamp,
      autoResetAt: new Date(
        new Date(timestamp).getTime() + automaticRunResetDeadlineSeconds * 1000,
      ).toISOString(),
    };
    expect(automaticRunResetDeadlineSeconds).toBe(900);
    expect(destructiveResetReasonValues).toEqual(["admin_reset", "auto_reset"]);
    expect(internalRunFailureReasonSchema.parse("auto_reset")).toBe("auto_reset");
    expect(toPublicRunFailureCategory("auto_reset")).toBe("automatic_reset");
    expect(
      demoRunSnapshotSchema.parse({ ...baseRun, status: "starting", trafficStatus: "starting" })
        .autoResetAt,
    ).toBe(baseRun.autoResetAt);
    expect(
      demoRunSnapshotSchema.safeParse({
        ...baseRun,
        status: "starting",
        trafficStatus: "starting",
        autoResetAt: "invalid",
      }).success,
    ).toBe(false);
    const trafficStartedAt = "2026-06-20T12:00:01.000Z";
    const trafficEndedAt = "2026-06-20T12:00:02.000Z";
    const finalizedAt = "2026-06-20T12:00:03.000Z";
    const legalSnapshots = [
      { ...baseRun, status: "starting", trafficStatus: "starting" },
      { ...baseRun, status: "active", trafficStatus: "active", trafficStartedAt },
      {
        ...baseRun,
        status: "draining",
        trafficStatus: "succeeded",
        trafficStartedAt,
        trafficEndedAt,
      },
      {
        ...baseRun,
        status: "completed",
        trafficStatus: "succeeded",
        trafficStartedAt,
        trafficEndedAt,
        finalizedAt,
      },
      {
        ...baseRun,
        status: "failed",
        trafficStatus: "failed",
        finalizedAt,
        failureCategory: "traffic",
      },
      {
        ...baseRun,
        status: "failed",
        trafficStatus: "failed",
        trafficStartedAt,
        finalizedAt,
        failureCategory: "operator",
      },
      {
        ...baseRun,
        status: "failed",
        trafficStatus: "succeeded",
        trafficStartedAt,
        trafficEndedAt,
        finalizedAt,
        failureCategory: "traffic",
      },
    ];

    for (const snapshot of legalSnapshots) {
      expect(demoRunSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(demoRunSnapshotSchema.safeParse({ ...snapshot, dataDiscarded: true }).success).toBe(
        snapshot.status === "failed",
      );
    }

    const incoherentSnapshots = [
      { ...baseRun, status: "starting", trafficStatus: "starting", trafficStartedAt },
      { ...baseRun, status: "active", trafficStatus: "active" },
      {
        ...baseRun,
        status: "draining",
        trafficStatus: "succeeded",
        trafficStartedAt,
      },
      {
        ...baseRun,
        status: "completed",
        trafficStatus: "succeeded",
        trafficStartedAt,
        trafficEndedAt,
      },
      {
        ...baseRun,
        status: "completed",
        trafficStatus: "succeeded",
        trafficStartedAt,
        trafficEndedAt,
        finalizedAt,
        failureCategory: "traffic",
      },
      {
        ...baseRun,
        status: "failed",
        trafficStatus: "failed",
        trafficEndedAt,
        finalizedAt,
        failureCategory: "traffic",
      },
      {
        ...baseRun,
        status: "failed",
        trafficStatus: "succeeded",
        finalizedAt,
        failureCategory: "traffic",
      },
    ];

    for (const snapshot of incoherentSnapshots) {
      expect(demoRunSnapshotSchema.safeParse(snapshot).success).toBe(false);
    }
  });

  it("accepts unclassified completion evidence but requires status in stored history", () => {
    const evidence = {
      trafficMode: "buyer-spike" as const,
      plannedBuyers: 10,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 1,
      requestArrivalSummary: emptyRequestArrivalSummary,
      notes: [],
    };
    expect(trafficCompletionDeliverySummarySchema.parse(evidence)).not.toHaveProperty(
      "trafficDeliveryStatus",
    );
    expect(() => trafficDeliverySummarySchema.parse(evidence)).toThrow();
    expect(
      trafficDeliverySummarySchema.parse({
        ...evidence,
        completedIterations: null,
        trafficDeliveryStatus: "warning",
      }),
    ).toEqual({
      ...evidence,
      completedIterations: null,
      trafficDeliveryStatus: "warning",
    });
    expect(() =>
      trafficCompletionDeliverySummarySchema.parse({ ...evidence, plannedRequests: 10 }),
    ).toThrow();
  });

  it("rejects transport-attempt counts that break either reconciliation equation", () => {
    const coherent = {
      plannedRequests: 10,
      startedRequests: 9,
      completedRequests: 7,
      interruptedRequests: 2,
      unstartedRequests: 1,
    };
    expect(transportAttemptCountsSchema.safeParse(coherent).success).toBe(true);

    const brokenPlan = transportAttemptCountsSchema.safeParse({
      ...coherent,
      unstartedRequests: 2,
    });
    expect(brokenPlan.success).toBe(false);
    if (!brokenPlan.success) {
      expect(brokenPlan.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["unstartedRequests"],
          message: "plannedRequests must equal startedRequests + unstartedRequests",
        }),
      );
    }

    const brokenStarted = transportAttemptCountsSchema.safeParse({
      ...coherent,
      interruptedRequests: 1,
    });
    expect(brokenStarted.success).toBe(false);
    if (!brokenStarted.success) {
      expect(brokenStarted.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["interruptedRequests"],
          message: "startedRequests must equal completedRequests + interruptedRequests",
        }),
      );
    }

    const httpSummary = {
      failedRequests: 0,
      acceptedResponses: 2,
      soldOutResponses: 5,
      transportFailures: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    };
    expect(trafficHttpSummarySchema.safeParse(httpSummary).success).toBe(true);
    expect(
      trafficHttpSummarySchema.safeParse({
        ...httpSummary,
        failedRequests: 3,
        transportFailures: 2,
        unexpectedResponses: 1,
      }).success,
    ).toBe(true);
    expect(
      trafficHttpSummarySchema.safeParse({
        ...httpSummary,
        failedRequests: 2,
        transportFailures: 2,
        unexpectedResponses: 1,
      }).success,
    ).toBe(false);
    expect(trafficHttpSummarySchema.safeParse({ ...httpSummary, ...coherent }).success).toBe(false);
  });

  it("keeps one canonical transport count object on completion reports", () => {
    const report = trafficCompletionReportSchema.parse({
      runId,
      status: "succeeded",
      exitCode: 0,
      transportAttemptCounts: {
        plannedRequests: 10,
        startedRequests: 10,
        completedRequests: 8,
        interruptedRequests: 2,
        unstartedRequests: 0,
      },
      httpSummary: {
        failedRequests: 0,
        acceptedResponses: 2,
        soldOutResponses: 6,
        transportFailures: 0,
        unexpectedResponses: 0,
        failureRate: 0,
      },
      trafficOutcomeSummary: {},
      trafficDeliverySummary: {
        trafficMode: "buyer-spike",
        plannedBuyers: 10,
        scheduledRatePerSecond: null,
        configuredDurationSeconds: null,
        preAllocatedVUs: null,
        maxVUs: null,
        droppedIterations: 0,
        requestArrivalSummary: emptyRequestArrivalSummary,
        notes: [],
      },
      httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
      loadRunDiagnosticsSummary: runnerDiagnostics(),
      completedAt: timestamp,
      correlationId,
    });
    expect(report.transportAttemptCounts.interruptedRequests).toBe(2);

    const brokenEquation = trafficCompletionReportSchema.safeParse({
      ...report,
      transportAttemptCounts: { ...report.transportAttemptCounts, unstartedRequests: 1 },
    });
    expect(brokenEquation.success).toBe(false);
    if (!brokenEquation.success) {
      expect(brokenEquation.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["transportAttemptCounts", "unstartedRequests"],
          message: "plannedRequests must equal startedRequests + unstartedRequests",
        }),
      );
    }
  });
});

describe("queue contracts", () => {
  it("keeps the semantic queue name distinct from the BullMQ physical name", () => {
    expect(orderProcessQueueName).toBe("orders:process");
    expect(orderProcessBullMqQueueName).toBe("orders-process");
  });

  it("validates an order-processing job payload", () => {
    expect(
      orderProcessJobSchema.parse({
        orderId: "11111111-1111-4111-8111-111111111111",
        publicOrderId: "ord_test",
        reservationId: "33333333-3333-4333-8333-333333333333",
        saleOfferId,
        correlationId,
        runId,
        quantity: 1,
        queuedAt: timestamp,
        processingGeneration: 0,
      }),
    ).toMatchObject({ publicOrderId: "ord_test", quantity: 1 });

    expect(() =>
      orderProcessJobSchema.parse({
        orderId: "not-a-uuid",
        correlationId,
      }),
    ).toThrow();
  });

  it("validates the bounded queue health projection", () => {
    const status = queueStatusSchema.parse({
      name: "orders:process",
      connectivity: "reachable",
      depth: 8,
      counts: { waiting: 3, prioritized: 1, paused: 2, delayed: 2, active: 4, failed: 9 },
      oldestWaitingAgeSeconds: 8.5,
      failedJobs: {
        totalCount: 9,
        recent: [
          {
            jobId: "order-1",
            jobName: "order.process",
            attemptsMade: 2,
            failedReason: "ERP unavailable",
            failedAt: timestamp,
          },
        ],
        inspectionLimit: 20,
        inspectionTruncated: false,
      },
      observedAt: timestamp,
    });

    expect(status.depth).toBe(8);
    expect(status.failedJobs.totalCount).toBe(9);
    expect(() => queueStatusSchema.parse({ ...status, physicalName: "orders-process" })).toThrow();
    expect(
      queueStatusSchema.safeParse({
        ...status,
        observedAt: undefined,
        updatedAt: timestamp,
      }).success,
    ).toBe(false);
  });
});

describe("public order-status contracts", () => {
  const response = {
    correlationId,
    publicOrderId: "ord_public_1",
    saleOfferId,
    reservation: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expiresAt: "2026-06-20T12:15:00.000Z",
    },
    order: {
      status: "queued" as const,
      queuedAt: timestamp,
      processingAt: null,
      confirmedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessage: null,
    },
    consistencyLagMs: null,
    timeline: [
      {
        eventName: "future.event.name",
        label: "future.event.name",
        occurredAt: timestamp,
      },
    ],
  };

  it("strictly validates lookup params and the service request", () => {
    expect(orderStatusParamsSchema.parse({ publicOrderId: " ord_public_1 " })).toEqual({
      publicOrderId: "ord_public_1",
    });
    expect(
      orderStatusRequestSchema.parse({ publicOrderId: "ord_public_1", correlationId }),
    ).toEqual({ publicOrderId: "ord_public_1", correlationId });
    expect(() => orderStatusParamsSchema.parse({ publicOrderId: "" })).toThrow();
    expect(() =>
      orderStatusRequestSchema.parse({ publicOrderId: "ord_public_1", leaked: true }),
    ).toThrow();
  });

  it.each([
    ["queued", null],
    ["processing", null],
    ["confirmed", 120_000],
    ["failed", null],
  ] as const)("accepts the %s read model", (status, consistencyLagMs) => {
    const parsed = orderStatusResponseSchema.parse({
      ...response,
      order: {
        ...response.order,
        status,
        processingAt: status === "queued" ? null : "2026-06-20T12:01:00.000Z",
        confirmedAt: status === "confirmed" ? "2026-06-20T12:02:00.000Z" : null,
        failedAt: status === "failed" ? "2026-06-20T12:02:00.000Z" : null,
        failureCode: status === "failed" ? "erp_rejected" : null,
        failureMessage: status === "failed" ? "ERP rejected the order" : null,
      },
      consistencyLagMs,
    });

    expect(parsed.order.status).toBe(status);
  });

  it("rejects malformed, unknown, negative, and leaked response data", () => {
    expect(() =>
      orderStatusResponseSchema.parse({ ...response, saleOfferId: "not-a-uuid" }),
    ).toThrow();
    expect(() =>
      orderStatusResponseSchema.parse({
        ...response,
        order: { ...response.order, queuedAt: "not-a-timestamp" },
      }),
    ).toThrow();
    expect(() =>
      orderStatusResponseSchema.parse({ ...response, customerStatus: "queued" }),
    ).toThrow();
    expect(() =>
      orderStatusResponseSchema.parse({
        ...response,
        order: { ...response.order, status: "paid" },
      }),
    ).toThrow();
    expect(() => orderStatusResponseSchema.parse({ ...response, consistencyLagMs: -1 })).toThrow();
    expect(() =>
      orderStatusResponseSchema.parse({ ...response, internalOrderId: runId }),
    ).toThrow();
  });
});

describe("shared error and health contracts", () => {
  it("validates readiness responses with checks", () => {
    const response = healthResponseSchema.parse({
      service: "api",
      status: "degraded",
      timestamp,
      uptimeSeconds: 12,
      checks: [{ name: "redis_url_configured", status: "degraded" }],
    });

    expect(healthReadyPath).toBe("/health/ready");
    expect(response.checks[0]?.name).toBe("redis_url_configured");
  });
});

describe("canonical error-code vocabulary", () => {
  it("keeps the exact schema-driving list duplicate-free and lowercase snake-case", () => {
    const seen = new Set<string>();
    for (const code of errorPayloadCodes) {
      expect(seen.has(code), `duplicate code ${code}`).toBe(false);
      expect(code, `format for code ${code}`).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
      seen.add(code);
    }
  });

  it("keeps detailed policy causes out of the public HTTP vocabulary", () => {
    expect(errorPayloadCodes).toContain("invalid_run_configuration");
    expect(errorPayloadCodes).toContain("invalid_runtime_policy");
    expect(errorPayloadCodes.some((code) => code.startsWith("deployment_"))).toBe(false);
    expect(errorPayloadCodes.some((code) => code.startsWith("public_custom_default_"))).toBe(false);
  });

  it("requires the strict envelope with code, message, correlationId, and timestamp", () => {
    const valid = {
      code: "invalid_request",
      message: "Invalid request.",
      correlationId,
      timestamp,
    };
    expect(() => errorPayloadSchema.parse(valid)).not.toThrow();
    expect(() => errorPayloadSchema.parse({ ...valid, code: "notfound" })).toThrow();
    expect(() =>
      errorPayloadSchema.parse({ message: valid.message, correlationId, timestamp }),
    ).toThrow();
    expect(() =>
      errorPayloadSchema.parse({ code: valid.code, correlationId, timestamp }),
    ).toThrow();
    expect(() =>
      errorPayloadSchema.parse({ code: valid.code, message: valid.message, timestamp }),
    ).toThrow();
    expect(() =>
      errorPayloadSchema.parse({ code: valid.code, message: valid.message, correlationId }),
    ).toThrow();
  });

  it("accepts structured details and rejects extra top-level keys", () => {
    expect(() =>
      errorPayloadSchema.parse({
        ...{ code: "invalid_request", message: "Invalid request.", correlationId, timestamp },
        details: { issues: [{ path: "quantity" }] },
      }),
    ).not.toThrow();
    expect(() =>
      errorPayloadSchema.parse({
        code: "invalid_request",
        message: "Invalid request.",
        correlationId,
        timestamp,
        extra: true,
      }),
    ).toThrow();
  });
});

describe("ERP contracts", () => {
  it("defines the worker-facing confirmation endpoint and payloads", () => {
    expect(erpConfirmationPath).toBe("/confirmations");
    expect(erpConfirmationLookupPath).toBe("/confirmations/:idempotencyKey");
    expect(
      erpConfirmationRequestSchema.parse({
        orderId: "11111111-1111-4111-8111-111111111111",
        publicOrderId: "ord_test",
        reservationId: "33333333-3333-4333-8333-333333333333",
        saleOfferId,
        runId,
        idempotencyKey: "erp-confirmation:11111111-1111-4111-8111-111111111111",
        erpConfig: {
          latencyMs: 25,
          maxTps: 50,
          errorRate: 0.1,
          forcedOutage: false,
        },
        correlationId,
        quantity: 1,
      }),
    ).toMatchObject({
      publicOrderId: "ord_test",
      correlationId,
      idempotencyKey: "erp-confirmation:11111111-1111-4111-8111-111111111111",
      erpConfig: { latencyMs: 25, maxTps: 50, errorRate: 0.1, forcedOutage: false },
    });

    expect(
      erpConfirmationResponseSchema.parse({
        status: "succeeded",
        confirmationId: "erp_confirmation_test",
        httpStatus: 200,
        latencyMs: 15,
        timestamp,
      }),
    ).toMatchObject({ status: "succeeded", httpStatus: 200 });

    expect(
      erpConfirmationResponseSchema.parse({
        status: "failed",
        httpStatus: 503,
        errorCode: "erp_unavailable",
        errorMessage: "The ERP is temporarily unavailable.",
        latencyMs: 25,
        timestamp,
      }),
    ).toMatchObject({ status: "failed", errorCode: "erp_unavailable" });

    expect(() =>
      erpConfirmationResponseSchema.parse({
        status: "timed_out",
        errorCode: "erp_request_timeout",
        errorMessage: "The worker timed out the ERP request.",
        latencyMs: 2000,
        timestamp,
      }),
    ).toThrow();

    const incoherentResponses = [
      {
        status: "succeeded",
        httpStatus: 200,
        latencyMs: 15,
        timestamp,
      },
      {
        status: "succeeded",
        confirmationId: "erp_confirmation_test",
        httpStatus: 200,
        errorCode: "unexpected_error",
        latencyMs: 15,
        timestamp,
      },
      {
        status: "failed",
        confirmationId: "erp_confirmation_test",
        httpStatus: 503,
        errorCode: "erp_unavailable",
        errorMessage: "The ERP is temporarily unavailable.",
        latencyMs: 25,
        timestamp,
      },
      {
        status: "failed",
        httpStatus: 503,
        errorCode: "erp_unavailable",
        latencyMs: 25,
        timestamp,
      },
    ];
    for (const response of incoherentResponses) {
      expect(erpConfirmationResponseSchema.safeParse(response).success).toBe(false);
    }
  });

  it("validates run ERP outcomes", () => {
    const runOutcome = runErpOutcomeSummarySchema.parse({
      runId,
      latestAttempt: {
        runId,
        status: "failed",
        finishedAt: timestamp,
      },
      recentAttemptWindowSeconds: 60,
      recentAttemptCount: 8,
      recentFailureCount: 3,
      recentTimeoutCount: 1,
      recentAttemptCoverage: "retained_history",
      attemptRetentionLimitPerOrder: 32,
      cumulativeOutcomeCounts: {
        capacityRejected: 12,
        temporarilyUnavailable: 4,
        uncertainResult: 2,
      },
      observedAt: timestamp,
    });
    expect(runOutcome.runId).toBe(runId);
    expect(
      runErpOutcomeSummarySchema.safeParse({ ...runOutcome, circuitReadStatus: "available" })
        .success,
    ).toBe(false);
  });
});

describe("buy and dashboard contracts", () => {
  it("owns strict dashboard projection scopes and dirty signals", () => {
    expect(dashboardLiveUpdateExpectedIntervalMs).toBe(2_000);
    const scope = { runId, saleOfferId };
    const signal = {
      type: "dashboard.projection.dirty" as const,
      correlationId,
      scope,
    };

    expect(dashboardProjectionScopeSchema.parse(scope)).toEqual(scope);
    expect(dashboardProjectionDirtySignalSchema.parse(signal)).toEqual(signal);
    for (const invalidSignal of [
      { ...signal, extra: true },
      { ...signal, correlationId: "" },
      { ...signal, scope: { runId } },
      { ...signal, scope: { ...scope, runId: "not-a-uuid" } },
      { ...signal, scope: { ...scope, extra: true } },
    ]) {
      expect(dashboardProjectionDirtySignalSchema.safeParse(invalidSignal).success).toBe(false);
    }
  });

  it("defines bounded inventory drain and sold-out projections without conflating units", () => {
    const inventory = {
      saleOfferId,
      allocatedStock: 20,
      remainingStock: 12,
      reservedStock: 8,
      pendingPersistenceCount: 0,
      expiredReservationCount: 0,
      oldestPendingPersistenceAgeSeconds: 0,
      reservationThroughput: {
        windowSeconds: 60,
        successfulReservationCount: 4,
        peakRatePerSecond: 4,
        peakWindowSeconds: 1,
        unit: "reservations_per_second",
        measuredAt: timestamp,
      },
      soldOutPressure: {
        rejectionCount: 9,
        latestObservedAt: timestamp,
      },
      observedAt: "2026-06-20T12:00:10.000Z",
      lastUpdatedAt: timestamp,
    };
    expect(
      inventoryStatusSchema.parse(inventory).reservationThroughput.successfulReservationCount,
    ).toBe(4);
    expect(inventoryStatusSchema.safeParse({ ...inventory, observedAt: undefined }).success).toBe(
      false,
    );
  });

  it("keeps initialization events valid and gives reservation events explicit count and quantity", () => {
    const baseEvent = {
      eventName: "inventory.updated" as const,
      saleOfferId,
      allocatedStock: 20,
      remainingStock: 20,
      reservedStock: 0,
      source: "initialization",
      occurredAt: timestamp,
    };

    expect(() => inventoryUpdatedEventPayloadSchema.parse(baseEvent)).not.toThrow();
    expect(() =>
      inventoryUpdatedEventPayloadSchema.parse({
        ...baseEvent,
        remainingStock: 18,
        reservedStock: 2,
        reservationCount: 1,
        reservedQuantity: 2,
        source: "reservation",
      }),
    ).not.toThrow();
    expect(() =>
      inventoryUpdatedEventPayloadSchema.parse({ ...baseEvent, reservationCount: 1 }),
    ).toThrow();
    expect(() =>
      inventoryUpdatedEventPayloadSchema.parse({ ...baseEvent, source: "reservation" }),
    ).toThrow();
  });

  it("defaults buy quantity while preserving caller identifiers", () => {
    const request = buyRequestSchema.parse({
      saleOfferId,
      runId,
      idempotencyKey: "buyer-1-attempt-1",
      correlationId,
    });

    expect(request.quantity).toBe(1);
    expect(request.runId).toBe(runId);
    expect(loadRunIdHeaderName).toBe("x-load-run-id");
  });

  it("validates accepted and sold-out reservation outcomes", () => {
    const accepted = {
      outcome: "reservation_secured",
      correlationId,
      timestamp,
      reservation: {
        runId: "44444444-4444-4444-8444-444444444444",
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        saleOfferId,
        correlationId: "original-correlation",
        quantity: 1,
        reservationToken: "reservation-token",
        securedAt: timestamp,
        expiresAt: "2026-06-20T12:15:00.000Z",
      },
      order: {
        runId: "44444444-4444-4444-8444-444444444444",
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        publicOrderId: "ord_contract",
        saleOfferId,
        reservationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        correlationId: "original-correlation",
        quantity: 1,
        status: "queued",
        queuedAt: timestamp,
      },
    } as const;
    expect(buyResponseSchema.parse(accepted).outcome).toBe("reservation_secured");
    expect(() => buyResponseSchema.parse({ ...accepted, outcome: "idempotent_replay" })).toThrow();
    expect(() =>
      buyResponseSchema.parse({
        ...accepted,
        order: { ...accepted.order, status: "confirmed", confirmedAt: timestamp },
      }),
    ).toThrow();
    expect(() =>
      buyResponseSchema.parse({
        ...accepted,
        order: {
          ...accepted.order,
          status: "failed",
          failedAt: timestamp,
          failureCode: "erp_rejected",
          failureMessage: "Rejected",
        },
      }),
    ).toThrow();
    expect(() =>
      buyResponseSchema.parse({ ...accepted, simulatedStatus: "reservation_secured" }),
    ).toThrow();

    expect(
      buyResponseSchema.parse({
        outcome: "sold_out",
        correlationId,
        timestamp,
        reservation: null,
        order: null,
      }).outcome,
    ).toBe("sold_out");
  });

  it("exposes the canonical decision vocabulary for run closures", () => {
    expect(reservationDecisionValues).toContain("run_not_accepting_traffic");
  });

  it.each([
    "sold_out",
    "run_not_accepting_traffic",
    "inventory_not_initialized",
    "idempotency_conflict",
  ] as const)("parses the %s rejection from its outcome alone", (outcome) => {
    const payload = {
      outcome,
      correlationId,
      timestamp,
      reservation: null,
      order: null,
    };
    const parsed = reservationRejectedResponseSchema.parse(payload);
    expect(parsed.outcome).toBe(outcome);
    expect(parsed.reservation).toBeNull();
    expect(parsed.order).toBeNull();
    expect(buyResponseSchema.parse(payload).outcome).toBe(outcome);
  });

  it("rejects internal and duplicate rejection vocabulary", () => {
    const base = {
      correlationId,
      timestamp,
      reservation: null,
      order: null,
    } as const;

    expect(() =>
      reservationRejectedResponseSchema.parse({
        ...base,
        outcome: "idempotent_replay",
      }),
    ).toThrow();

    expect(() =>
      reservationRejectedResponseSchema.parse({
        ...base,
        outcome: "idempotency_conflict",
        reason: "idempotency_conflict",
      }),
    ).toThrow();

    expect(() =>
      reservationRejectedResponseSchema.parse({
        ...base,
        outcome: "sold_out",
        simulatedStatus: "sold_out",
      }),
    ).toThrow();
  });

  it("validates stable Redis stock reservation decisions", () => {
    const reservation = securedReservationHoldSchema.parse({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      saleOfferId,
      correlationId,
      runId,
      quantity: 2,
      reservationToken: "reservation-token",
      securedAt: timestamp,
      expiresAt: "2026-06-20T12:15:00.000Z",
    });

    expect(
      stockReservationDecisionSchema.parse({
        outcome: "reservation_secured",
        reservation,
      }),
    ).toEqual({ outcome: "reservation_secured", reservation });
    expect(
      stockReservationDecisionSchema.parse({
        outcome: "idempotency_conflict",
        reservation: null,
      }).outcome,
    ).toBe("idempotency_conflict");
    expect(
      stockReservationDecisionSchema.parse({
        outcome: "run_not_accepting_traffic",
        reservation: null,
      }).outcome,
    ).toBe("run_not_accepting_traffic");
  });

  it("validates dashboard projections for the operator view", () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const saleOfferId = "22222222-2222-4222-8222-222222222222";
    const currentRun = {
      runId,
      presetId: "33333333-3333-4333-8333-333333333333",
      presetName: "Preview 1k",
      operatorMode: "public" as const,
      status: "active" as const,
      trafficStatus: "active" as const,
      saleOfferId,
      configSnapshot: acceptedRunSnapshot(),
      startedAt: timestamp,
      autoResetAt: new Date(
        new Date(timestamp).getTime() + automaticRunResetDeadlineSeconds * 1000,
      ).toISOString(),
      trafficStartedAt: timestamp,
    };
    const recovery = dashboardProjectionSchema.parse({
      schema: dashboardProjectionSchemaName,
      resetRecoveryRunId: null,
      resetRecovery: "ready",
      correlationId,
      scopeId: dashboardProjectionScopeId({ runId, saleOfferId }),
      revision: 1,
      scope: { runId, saleOfferId },
      currentRun,
      inventory: null,
      recentMetrics: [],
      erp: null,
      systemStatus: null,
      businessOutcome: {
        acceptedReservations: 10,
        reservedUnits: 10,
        soldOutRejections: 20,
        queuedOrders: 4,
        processingOrders: 3,
        retryingOrders: 2,
        confirmedOrders: 2,
        failedOrders: 1,
        pendingPersistenceCount: 0,
        notificationsRecorded: 0,
      },
      consistencyLag: {
        confirmedOrderCount: 2,
        pendingConfirmationCount: 3,
        averageLagMs: 225,
        p95LagMs: 350,
        maxLagMs: 375,
        oldestPendingAgeSeconds: 12.5,
        measuredAt: timestamp,
      },
      recoveredAt: timestamp,
    });

    expect(recovery.businessOutcome?.retryingOrders).toBe(2);
    expect(recovery.consistencyLag?.p95LagMs).toBe(350);
    const runErp = runErpOutcomeSummarySchema.parse({
      runId,
      latestAttempt: {
        runId,
        status: "succeeded",
        finishedAt: timestamp,
      },
      recentAttemptWindowSeconds: 60,
      recentAttemptCount: 1,
      recentFailureCount: 0,
      recentTimeoutCount: 0,
      observedAt: timestamp,
    });
    expect(
      dashboardProjectionSchema.safeParse({
        ...recovery,
        erp: { ...runErp, runId: "55555555-5555-4555-8555-555555555555" },
      }).success,
    ).toBe(false);
    expect(
      dashboardProjectionSchema.safeParse({
        ...recovery,
        erp: {
          ...runErp,
          latestAttempt: {
            ...runErp.latestAttempt,
            runId: "55555555-5555-4555-8555-555555555555",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      dashboardProjectionSchema.safeParse({
        ...recovery,
        recentCompletionOutcomes: [],
      }).success,
    ).toBe(false);
    for (const field of [
      "orderId",
      "errorCode",
      "errorMessage",
      "httpStatus",
      "attemptNumber",
      "latencyMs",
    ]) {
      expect(
        dashboardProjectionSchema.safeParse({
          ...recovery,
          erp: {
            ...runErp,
            latestAttempt: { ...runErp.latestAttempt, [field]: 1 },
          },
        }).success,
      ).toBe(false);
    }
    expect(dashboardProjectionSchema.safeParse(omit(recovery, "correlationId")).success).toBe(
      false,
    );
  });

  it("requires a complete optional known scope for dashboard recovery", () => {
    const knownScope = {
      knownRunId: "11111111-1111-4111-8111-111111111111",
      knownSaleOfferId: "22222222-2222-4222-8222-222222222222",
    };
    expect(dashboardRecoveryQuerySchema.parse({})).toEqual({});
    expect(dashboardRecoveryQuerySchema.parse(knownScope)).toEqual(knownScope);
    expect(
      dashboardRecoveryQuerySchema.safeParse({ knownRunId: knownScope.knownRunId }).success,
    ).toBe(false);
    expect(
      dashboardRecoveryQuerySchema.safeParse({
        knownSaleOfferId: knownScope.knownSaleOfferId,
      }).success,
    ).toBe(false);
  });

  it("requires projection identity and revision metadata", () => {
    const idleProjection = {
      schema: dashboardProjectionSchemaName,
      resetRecoveryRunId: null,
      resetRecovery: "ready",
      correlationId,
      scopeId: dashboardProjectionScopeId(null),
      revision: 1,
      scope: null,
      currentRun: null,
      inventory: null,
      recentMetrics: [],
      erp: null,
      systemStatus: null,
      businessOutcome: null,
      consistencyLag: null,
      transportAttemptCounts: null,
      httpSummary: null,
      requestArrivalSummary: null,
      runSignalTimelineSummary: null,
      runtimeProgress: null,
      recoveredAt: timestamp,
    };

    expect(dashboardProjectionSchema.parse(idleProjection)).toEqual(idleProjection);
    expect(
      dashboardProjectionSchema.parse({
        ...idleProjection,
        resetRecoveryRunId: "11111111-1111-4111-8111-111111111111",
      }).resetRecovery,
    ).toBe("ready");
    expect(
      dashboardProjectionSchema.parse({
        ...idleProjection,
        resetRecoveryRunId: "11111111-1111-4111-8111-111111111111",
        resetRecovery: "incomplete",
      }).resetRecovery,
    ).toBe("incomplete");
    expect(dashboardProjectionSchema.safeParse(omit(idleProjection, "resetRecovery")).success).toBe(
      false,
    );

    expect(
      dashboardProjectionSchema.parse(omit(idleProjection, "httpSummary")).httpSummary,
    ).toBeNull();
    for (const metadata of ["schema", "scopeId", "revision"] as const) {
      const missingMetadata = omit(idleProjection, metadata);
      expect(dashboardProjectionSchema.safeParse(missingMetadata).success).toBe(false);
    }
  });

  it("rejects run-owned data from idle projections", () => {
    const systemStatus = sharedRuntimeStatusSchema.parse({
      queue: {
        name: "orders:process",
        connectivity: "reachable",
        depth: 0,
        counts: { waiting: 0, prioritized: 0, paused: 0, delayed: 0, active: 0, failed: 0 },
        oldestWaitingAgeSeconds: null,
        failedJobs: {
          totalCount: 0,
          recent: [],
          inspectionLimit: 20,
          inspectionTruncated: false,
        },
        observedAt: timestamp,
      },
    });
    const idleProjection = dashboardProjectionSchema.parse({
      schema: dashboardProjectionSchemaName,
      resetRecoveryRunId: null,
      resetRecovery: "ready",
      correlationId,
      scopeId: dashboardProjectionScopeId(null),
      revision: 1,
      scope: null,
      currentRun: null,
      inventory: null,
      recentMetrics: [],
      erp: null,
      systemStatus,
      businessOutcome: null,
      consistencyLag: null,
      transportAttemptCounts: null,
      httpSummary: null,
      requestArrivalSummary: null,
      runSignalTimelineSummary: null,
      recoveredAt: timestamp,
    });

    for (const [field, value] of [
      ["recentMetrics", [{ metricName: "traffic.latency", value: 10, unit: "ms", timestamp }]],
      [
        "erp",
        {
          runId,
          latestAttempt: null,
          recentAttemptWindowSeconds: 60,
          recentAttemptCount: 0,
          recentFailureCount: 0,
          recentTimeoutCount: 0,
          observedAt: timestamp,
        },
      ],
      [
        "businessOutcome",
        {
          acceptedReservations: 1,
          reservedUnits: 1,
          soldOutRejections: 0,
          queuedOrders: 0,
          processingOrders: 0,
          retryingOrders: 0,
          confirmedOrders: 0,
          failedOrders: 0,
          pendingPersistenceCount: 0,
          notificationsRecorded: 0,
        },
      ],
    ] as const) {
      const result = dashboardProjectionSchema.safeParse({ ...idleProjection, [field]: value });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({ code: "custom", path: [field] }),
        );
      }
    }
  });

  it("rejects dashboard projection metadata that disagrees with the selected run", () => {
    const currentRun = {
      runId: "11111111-1111-4111-8111-111111111111",
      presetId: "22222222-2222-4222-8222-222222222222",
      presetName: "Preview 1k",
      operatorMode: "public" as const,
      status: "active" as const,
      trafficStatus: "active" as const,
      saleOfferId: "33333333-3333-4333-8333-333333333333",
      configSnapshot: acceptedRunSnapshot(),
      startedAt: timestamp,
      autoResetAt: new Date(
        new Date(timestamp).getTime() + automaticRunResetDeadlineSeconds * 1000,
      ).toISOString(),
      trafficStartedAt: timestamp,
    };
    const scope = { runId: currentRun.runId, saleOfferId: currentRun.saleOfferId };
    const baseRecovery = dashboardProjectionSchema.parse({
      schema: dashboardProjectionSchemaName,
      resetRecoveryRunId: null,
      resetRecovery: "ready",
      correlationId,
      scopeId: dashboardProjectionScopeId(scope),
      revision: 2,
      scope,
      currentRun,
      inventory: null,
      recentMetrics: [],
      erp: null,
      systemStatus: null,
      businessOutcome: null,
      consistencyLag: null,
      recoveredAt: timestamp,
    });

    for (const [change, path] of [
      [
        { currentRun: { ...currentRun, runId: "44444444-4444-4444-8444-444444444444" } },
        ["scope", "runId"],
      ],
      [{ scope: null, scopeId: dashboardProjectionScopeId(null) }, ["scope"]],
      [{ currentRun: null }, ["scope"]],
      [
        { currentRun: { ...currentRun, saleOfferId: "44444444-4444-4444-8444-444444444444" } },
        ["scope", "saleOfferId"],
      ],
    ] as const) {
      const result = dashboardProjectionSchema.safeParse({ ...baseRecovery, ...change });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({ code: "custom", path }),
        );
      }
    }
  });

  it("rejects noncanonical projection identity and scope metadata", () => {
    const parsed = dashboardProjectionSchema.safeParse({
      schema: dashboardProjectionSchemaName,
      resetRecoveryRunId: null,
      resetRecovery: "ready",
      correlationId,
      scopeId: "run:ambiguous",
      revision: 1,
      scope: null,
      currentRun: null,
      inventory: null,
      erp: null,
      systemStatus: null,
      businessOutcome: null,
      consistencyLag: null,
      recoveredAt: timestamp,
    });

    expect(parsed.success).toBe(false);
  });
});

describe("public runtime policy contract", () => {
  it("bounds each live metric ingestion batch to the producer maximum", () => {
    const sample = {
      metricName: "traffic.latency" as const,
      value: 10,
      unit: "ms",
      timestamp,
    };
    const input = {
      batchId: "77777777-7777-4777-8777-777777777777",
      runId: "55555555-5555-4555-8555-555555555551",
      correlationId: "metric-bound",
      samples: Array.from({ length: 100 }, () => sample),
      observedAt: timestamp,
    };
    expect(loadMetricIngestRequestSchema.parse(input).samples).toHaveLength(100);
    expect(loadMetricIngestRequestSchema.safeParse({ ...input, batchId: undefined }).success).toBe(
      false,
    );
    expect(
      loadMetricIngestRequestSchema.safeParse({ ...input, batchId: "not-a-uuid" }).success,
    ).toBe(false);
    expect(() =>
      loadMetricIngestRequestSchema.parse({ ...input, samples: [...input.samples, sample] }),
    ).toThrow();
  });

  it("defines demo-run and load-execution API boundaries", () => {
    expect(publicPresetListPath).toBe("/demo/presets/public");
    expect(publicRuntimePolicyPath).toBe("/demo/runtime-policy");
    expect(adminPublicRuntimePolicyPath).toBe("/admin/demo/runtime-policy");
    expect(startDemoRunPath).toBe("/demo/runs/start");
    expect(runHistoryPath).toBe("/demo/runs/history");
    expect(demoRunOperatorModeHeaderName).toBe("x-demo-operator-mode");
    expect(publicVisitorIdHeaderName).toBe("x-public-visitor-id");
    expect(trafficExecutionStartPath).toBe("/traffic/start");
    expect(internalLoadMetricIngestPath).toBe("/internal/load/metrics");
    expect(internalTrafficCompletionPath).toBe("/internal/load/completion");
    expect(startDemoRunRequestSchema.parse({ presetSlug: "preview-1k" })).toEqual({
      presetSlug: "preview-1k",
    });
    expect(() =>
      startDemoRunRequestSchema.parse({
        presetSlug: "preview-1k",
        operatorMode: "admin",
      }),
    ).toThrow();
  });

  it("validates paginated run history reads and protected deletion commands", () => {
    const summary = runHistorySummarySchema.parse({
      id: "77777777-7777-4777-8777-777777777777",
      runId,
      presetName: "Preview 1k",
      status: "completed",
      replayPossible: false,
      startedAt: timestamp,
      endedAt: timestamp,
      transportAttemptCounts: {
        plannedRequests: 10,
        startedRequests: 10,
        completedRequests: 10,
        interruptedRequests: 0,
        unstartedRequests: 0,
      },
      httpSummary: {
        failedRequests: 0,
        acceptedResponses: 6,
        soldOutResponses: 4,
        transportFailures: 0,
        unexpectedResponses: 0,
        p95LatencyMs: 42,
        failureRate: 0,
      },
      trafficDeliverySummary: {
        trafficMode: "buyer-spike",
        plannedBuyers: 10,
        scheduledRatePerSecond: null,
        configuredDurationSeconds: null,
        preAllocatedVUs: null,
        maxVUs: null,
        droppedIterations: 0,
        completedIterations: 10,
        requestArrivalSummary: emptyRequestArrivalSummary,
        trafficDeliveryStatus: "complete",
        notes: [],
      },
      serverReservationTimingSummary,
      businessOutcomeSummary: {
        acceptedReservations: 6,
        reservedUnits: 10,
        soldOutRejections: 4,
        queuedOrders: 0,
        processingOrders: 0,
        retryingOrders: 0,
        confirmedOrders: 5,
        failedOrders: 1,
        pendingPersistenceCount: 0,
        notificationsRecorded: 5,
      },
      terminalInventorySnapshot: {
        saleOfferId,
        startingStock: 10,
        remainingStock: 0,
        reservedStock: 10,
        acceptedReservations: 6,
        soldOutRejections: 4,
        pendingPersistenceCount: 0,
        capturedAt: timestamp,
        source: "redis",
      },
      runSignalTimelineSummary: null,
      capturedAt: timestamp,
    });
    const history = runHistoryListResponseSchema.parse({
      summaries: [
        {
          runId,
          presetName: "Preview 1k",
          occurredAt: timestamp,
          overallDurationMs: 0,
          resultOutcome: "completed-with-order-failures",
          plannedAttempts: 10,
          startingStock: 10,
          uniqueReservations: 6,
          soldOutRejections: 4,
          confirmedOrders: 5,
          failedOrders: 1,
          convergenceDurationSeconds: null,
        },
      ],
      page: 1,
      pageSize: 10,
      totalCount: 1,
      timestamp,
    });

    expect(runHistoryListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 10 });
    expect(runHistoryListQuerySchema.parse({ page: "2", pageSize: "5" })).toEqual({
      page: 2,
      pageSize: 5,
    });
    expect(history.summaries[0]?.runId).toBe(runId);
    expect(history.summaries[0]).not.toHaveProperty("reservationToken");
    expect(history.summaries[0]).not.toHaveProperty("idempotencyKey");
    const listSummary = history.summaries[0];
    if (!listSummary) throw new Error("Expected compact run history fixture.");
    expect(() =>
      runHistoryListResponseSchema.parse({
        ...history,
        summaries: [omit(listSummary, "startingStock")],
      }),
    ).toThrow();

    expect(runHistoryDetailPathTemplate).toBe("/demo/runs/history/:runId");
    expect(runHistoryDetailPath(runId)).toBe(`/demo/runs/history/${runId}`);
    expect(runHistoryDetailParamsSchema.parse({ runId })).toEqual({ runId });
    expect(adminGeneratedRunTeardownPath(runId)).toBe(`/admin/demo/runs/${runId}`);
    expect(adminGeneratedRunTeardownPathTemplate).toBe("/admin/demo/runs/:runId");
    expect(adminGeneratedRunTeardownParamsSchema.parse({ runId })).toEqual({ runId });
    expect(() => adminGeneratedRunTeardownParamsSchema.parse({ runId: "bad" })).toThrow();
    expect(
      adminGeneratedRunTeardownResponseSchema.parse({
        outcome: "already_absent",
        runId,
        cleanedAt: timestamp,
        correlationId: "contract-test",
      }).outcome,
    ).toBe("already_absent");
    expect(
      adminGeneratedRunTeardownResponseSchema.parse({
        outcome: "deleted",
        runId,
        saleOfferId,
        cleanup: { redisKeysDeleted: 3, queueJobsDeleted: 2 },
        cleanedAt: timestamp,
        correlationId: "contract-test",
      }),
    ).toMatchObject({ outcome: "deleted", saleOfferId });

    const {
      id: _summaryId,
      failureCategory: _failureCategory,
      terminalInventorySnapshot,
      ...publicSummary
    } = summary;
    const sanitizedInventory = terminalInventorySnapshot
      ? (({ saleOfferId: _inventorySaleOfferId, source: _inventorySource, ...inventory }) =>
          inventory)(terminalInventorySnapshot)
      : undefined;
    const { notes: _deliveryNotes, ...publicDeliverySummary } =
      publicSummary.trafficDeliverySummary;
    const detail = publicRunHistoryDetailResponseSchema.parse({
      failureDiagnostic: null,
      summary: {
        ...publicSummary,
        trafficDeliverySummary: publicDeliverySummary,
        ...(sanitizedInventory ? { terminalInventorySnapshot: sanitizedInventory } : {}),
      },
      run: {
        runId,
        presetName: "Preview 1k",
        operatorMode: "public",
        status: "completed",
        trafficStatus: "succeeded",
        configSnapshot: {
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
        },
        startedAt: timestamp,
        trafficStartedAt: timestamp,
        trafficEndedAt: timestamp,
        finalizedAt: timestamp,
      },
      httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
      result: deriveRunResult({
        runStatus: "completed",
        failureCategory: null,
        startingStock: 10,
        remainingStock: 0,
        durable: {
          reservedUnits: 10,
          uniqueReservations: 6,
          soldOutDecisions: 4,
          confirmedOrders: 5,
          failedOrders: 1,
          queuedOrders: 0,
          processingOrders: 0,
          durablePendingPersistenceRecords: 0,
          notificationsRecorded: 5,
        },
        heldReservationsAwaitingPersistence: 0,
        replayPossible: false,
        generator: {
          transportAttemptCounts: summary.transportAttemptCounts,
          httpSummary: summary.httpSummary,
        },
      }),
      overallDurationMs: 0,
      plannedAttempts: 10,
      erpAttempts: {
        totalCount: 1,
        byStatus: { succeeded: 1, failed: 0, timedOut: 0 },
        averageLatencyMs: 25,
        p95LatencyMs: 25,
      },
      runSignalTimelineSummary: null,
      timestamp,
    });
    expect(detail.summary.runId).toBe(runId);
    expect(detail.plannedAttempts).toBe(10);
    expect(detail.erpAttempts.averageLatencyMs).toBe(25);
    const { plannedAttempts: _plannedAttempts, ...detailWithoutPlannedAttempts } = detail;
    expect(
      publicRunHistoryDetailResponseSchema.safeParse(detailWithoutPlannedAttempts).success,
    ).toBe(false);
    expect(adminRunHistoryDetailPathTemplate).toBe("/admin/demo/runs/history/:runId");
    expect(adminRunHistoryDetailPath(runId)).toBe(`/admin/demo/runs/history/${runId}`);
    expect(() =>
      adminRunHistoryDetailResponseSchema.parse({
        failureDiagnostic: null,
        summary,
        run: {
          ...detail.run,
          presetId: "33333333-3333-4333-8333-333333333333",
          saleOfferId,
          autoResetAt: new Date(
            new Date(timestamp).getTime() + automaticRunResetDeadlineSeconds * 1000,
          ).toISOString(),
        },
        overallDurationMs: null,
        exceptionSummary: {
          maximumClassification: detail.result.maximumClassification,
          brokenInvariants: 0,
          failedOrders: 0,
          pendingWork: 0,
          partialDelivery: 0,
          generatorWarnings: 0,
        },
        httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
        loadRunDiagnosticsSummary: runnerDiagnostics(),
        erpAttemptSummary: detail.erpAttempts,
        runSignalTimelineSummary: null,
        timestamp,
      }),
    ).not.toThrow();
    expect(adminRunHistoryDetailResponseSchema.shape.overallDurationMs.parse(null)).toBeNull();
    expect(() => adminRunHistoryDetailResponseSchema.shape.overallDurationMs.parse(-1)).toThrow();
    const exceptionSummary = {
      maximumClassification: "correctness_failure" as const,
      brokenInvariants: 1,
      failedOrders: 2,
      pendingWork: 3,
      partialDelivery: 1,
      generatorWarnings: 4,
    };
    expect(runHistoryExceptionSummarySchema.parse(exceptionSummary)).toEqual(exceptionSummary);
    expect(() =>
      runHistoryExceptionSummarySchema.parse({ ...exceptionSummary, pendingWork: -1 }),
    ).toThrow();
    expect(() =>
      publicRunHistoryDetailResponseSchema.parse({
        ...detail,
        loadRunDiagnosticsSummary: runnerDiagnostics(),
      }),
    ).toThrow();
    expect(() =>
      publicRunHistoryDetailResponseSchema.parse({
        ...detail,
        orders: { totalCount: 0, records: [] },
      }),
    ).toThrow();
    for (const privateCollection of ["orders", "notifications", "events", "eventTimeline"]) {
      expect(() =>
        publicRunHistoryDetailResponseSchema.parse({
          ...detail,
          [privateCollection]: { totalCount: 0, limit: 20, truncated: false, records: [] },
        }),
      ).toThrow();
    }
    expect(() =>
      publicRunHistoryDetailResponseSchema.parse({
        ...detail,
        erpAttempts: { ...detail.erpAttempts, records: [] },
      }),
    ).toThrow();
    expect(() =>
      publicRunHistoryDetailResponseSchema.parse({
        ...detail,
        summary: {
          ...detail.summary,
          trafficDeliverySummary: {
            ...detail.summary.trafficDeliverySummary,
            notes: ["private-delivery-diagnostic-marker"],
          },
        },
      }),
    ).toThrow();
    expect(
      publicRunHistoryDetailResponseSchema.parse({
        ...detail,
        erpAttempts: {
          totalCount: 0,
          byStatus: { succeeded: 0, failed: 0, timedOut: 0 },
          averageLatencyMs: null,
          p95LatencyMs: null,
        },
      }).erpAttempts.p95LatencyMs,
    ).toBeNull();
    expect(() =>
      publicRunHistoryDetailResponseSchema.parse({
        ...detail,
        run: { ...detail.run, saleOfferId },
      }),
    ).toThrow();

    expect(adminDeleteRunHistoryRequestSchema.parse({ runIds: [runId] })).toEqual({
      runIds: [runId],
    });
    expect(
      adminDeleteRunHistoryRequestSchema.parse({
        deleteAllConfirmation: "DELETE",
      }),
    ).toEqual({ deleteAllConfirmation: "DELETE" });
    expect(() => adminDeleteRunHistoryRequestSchema.parse({})).toThrow();
    expect(() =>
      adminDeleteRunHistoryRequestSchema.parse({
        runIds: [runId],
        deleteAllConfirmation: "DELETE",
      }),
    ).toThrow();
    expect(
      adminDeleteRunHistoryResponseSchema.parse({
        deletedSummaryCount: 1,
        deletedAt: timestamp,
        correlationId,
      }),
    ).toMatchObject({ deletedSummaryCount: 1 });
  });

  it.each([
    {
      name: "a public limit above its deployment cap",
      update: (policy: ReturnType<typeof semanticRuntimePolicy>) => {
        policy.publicCustomLimits.maxTotalRequests = 101;
      },
      code: "public_limit_total_requests_exceeds_deployment_cap",
      path: ["publicCustomLimits", "maxTotalRequests"],
    },
    {
      name: "an ERP minimum above its maximum",
      update: (policy: ReturnType<typeof semanticRuntimePolicy>) => {
        policy.publicCustomLimits.minErpMaxTps = 11;
      },
      code: "public_erp_tps_limit_invalid",
      path: ["publicCustomLimits", "minErpMaxTps"],
    },
    {
      name: "preallocated VUs above max VUs",
      update: (policy: ReturnType<typeof semanticRuntimePolicy>) => {
        policy.publicCustomLimits.maxPreAllocatedVus = 11;
      },
      code: "public_vus_limit_invalid",
      path: ["publicCustomLimits", "maxPreAllocatedVus"],
    },
    {
      name: "a structurally valid default above an updated public limit",
      update: (policy: ReturnType<typeof semanticRuntimePolicy>) => {
        policy.publicCustomLimits.maxBuyers = 5;
      },
      code: "public_custom_default_public_buyers_exceeded",
      path: ["publicCustomDefaults", "trafficConfig", "buyerCount"],
    },
  ])("rejects $name with stable violation vocabulary", ({ update, code, path }) => {
    const policy = semanticRuntimePolicy();
    update(policy);

    expect(collectPublicRuntimePolicyViolations(policy)[0]).toMatchObject({ code, path });
    const parsed = publicRuntimePolicySchema.safeParse(policy);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(path);
    }
  });

  it("orders persisted relationship violations before public-default violations", () => {
    const { deploymentHardCaps: _deploymentHardCaps, ...mutable } = semanticRuntimePolicy();
    mutable.publicCustomLimits.maxPreAllocatedVus = 11;
    mutable.publicCustomLimits.maxBuyers = 5;

    expect(collectPublicRuntimePolicyMutableViolations(mutable)).toEqual([
      {
        code: "public_vus_limit_invalid",
        message: "Public preallocated VUs cannot exceed max VUs.",
        details: { maxPreAllocatedVus: 11, maxVus: 10 },
        path: ["publicCustomLimits", "maxPreAllocatedVus"],
      },
      {
        code: "public_custom_default_public_buyers_exceeded",
        message: "Public custom defaults must fit within the active public runtime policy.",
        details: { value: 10, cap: 5 },
        path: ["publicCustomDefaults", "trafficConfig", "buyerCount"],
      },
    ]);
  });

  it("preserves effective policy violation order without duplicating default causes", () => {
    const policy = semanticRuntimePolicy();
    policy.publicCustomLimits.maxTotalRequests = 101;
    policy.publicCustomLimits.maxPreAllocatedVus = 11;
    policy.publicCustomLimits.maxBuyers = 5;
    policy.deploymentHardCaps.maxBuyers = 7;

    expect(collectPublicRuntimePolicyViolations(policy)).toEqual([
      {
        code: "public_limit_total_requests_exceeds_deployment_cap",
        message: "Accepted run configuration exceeds a configured cap.",
        details: { value: 101, cap: 100 },
        path: ["publicCustomLimits", "maxTotalRequests"],
      },
      {
        code: "public_vus_limit_invalid",
        message: "Public preallocated VUs cannot exceed max VUs.",
        details: { maxPreAllocatedVus: 11, maxVus: 10 },
        path: ["publicCustomLimits", "maxPreAllocatedVus"],
      },
      {
        code: "public_custom_default_deployment_buyers_exceeded",
        message: "Public custom defaults must fit within the active public runtime policy.",
        details: { value: 10, cap: 7 },
        path: ["publicCustomDefaults", "trafficConfig", "buyerCount"],
      },
      {
        code: "public_custom_default_public_buyers_exceeded",
        message: "Public custom defaults must fit within the active public runtime policy.",
        details: { value: 10, cap: 5 },
        path: ["publicCustomDefaults", "trafficConfig", "buyerCount"],
      },
    ]);

    const parsed = publicRuntimePolicySchema.safeParse(policy);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.map((issue) =>
          "params" in issue &&
          issue.params &&
          typeof issue.params === "object" &&
          "violationCode" in issue.params
            ? issue.params.violationCode
            : undefined,
        ),
      ).toEqual([
        "public_limit_total_requests_exceeds_deployment_cap",
        "public_vus_limit_invalid",
        "public_custom_default_deployment_buyers_exceeded",
        "public_custom_default_public_buyers_exceeded",
      ]);
    }
  });

  it("validates strict persisted mutable policy without deployment caps", () => {
    const effective = semanticRuntimePolicy();
    const { deploymentHardCaps, ...mutable } = effective;

    expect(collectPublicRuntimePolicyMutableViolations(mutable)).toEqual([]);
    expect(publicRuntimePolicyPersistedSchema.parse(mutable)).toEqual(mutable);
    expect(() =>
      publicRuntimePolicyPersistedSchema.parse({ ...mutable, deploymentHardCaps }),
    ).toThrow(/Unrecognized key.*deploymentHardCaps/i);

    mutable.publicCustomLimits.maxBuyers = 5;
    expect(collectPublicRuntimePolicyMutableViolations(mutable)[0]).toMatchObject({
      code: "public_custom_default_public_buyers_exceeded",
      path: ["publicCustomDefaults", "trafficConfig", "buyerCount"],
    });
    expect(publicRuntimePolicyPersistedSchema.safeParse(mutable).success).toBe(false);
  });

  it("validates automatic default VUs against deployment caps only for effective policy", () => {
    const effective = semanticRuntimePolicy();
    effective.publicCustomDefaults.trafficConfig = {
      mode: "constant-arrival-rate",
      ratePerSecond: 6,
      startDelaySeconds: 0,
      durationSeconds: 1,
      quantityPerAttempt: 1,
    };
    effective.deploymentHardCaps.maxPreAllocatedVus = 10;
    effective.deploymentHardCaps.maxVus = 10;
    const { deploymentHardCaps: _deploymentHardCaps, ...mutable } = effective;

    expect(collectPublicRuntimePolicyMutableViolations(mutable)).toEqual([]);
    expect(publicRuntimePolicyPersistedSchema.safeParse(mutable).success).toBe(true);
    expect(collectPublicRuntimePolicyViolations(effective)).toEqual([
      {
        code: "public_custom_default_deployment_max_vus_exceeded",
        message: "Public custom defaults must fit within the active public runtime policy.",
        details: { value: 12, cap: 10 },
        path: ["publicCustomDefaults", "trafficConfig", "k6Vus", "maxVus"],
      },
    ]);

    const parsed = publicRuntimePolicySchema.safeParse(effective);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]).toMatchObject({
        path: ["publicCustomDefaults", "trafficConfig", "k6Vus", "maxVus"],
        params: {
          violationCode: "public_custom_default_deployment_max_vus_exceeded",
          details: { value: 12, cap: 10 },
        },
      });
    }
  });

  it("resolves automatic constant-arrival VUs with one capped neutral rule", () => {
    expect(maximumAutomaticallyDerivedVUs).toBe(10_000);
    expect(resolveConstantArrivalVus({ ratePerSecond: 4_999 })).toEqual({
      preAllocatedVus: 4_999,
      maxVus: 9_998,
    });
    expect(resolveConstantArrivalVus({ ratePerSecond: 5_000 })).toEqual({
      preAllocatedVus: 5_000,
      maxVus: 10_000,
    });
    expect(resolveConstantArrivalVus({ ratePerSecond: 5_001 })).toEqual({
      preAllocatedVus: 5_001,
      maxVus: 10_000,
    });
    expect(resolveConstantArrivalVus({ ratePerSecond: 12_000 })).toEqual({
      preAllocatedVus: 10_000,
      maxVus: 10_000,
    });
    expect(
      resolveConstantArrivalVus({
        ratePerSecond: 12_000,
        k6Vus: { preAllocatedVus: 12_000, maxVus: 15_000 },
      }),
    ).toEqual({ preAllocatedVus: 12_000, maxVus: 15_000 });
  });

  it.each([
    {
      ratePerSecond: 51,
      maxPreAllocatedVus: 50,
      maxVus: 200,
      expectedCode: "deployment_preallocated_vus_exceeded",
      expectedDetails: { value: 51, cap: 50 },
    },
    {
      ratePerSecond: 26,
      maxPreAllocatedVus: 50,
      maxVus: 50,
      expectedCode: "deployment_max_vus_exceeded",
      expectedDetails: { value: 52, cap: 50 },
    },
  ])("applies the $expectedCode deployment cap to automatically derived VUs", (fixture) => {
    const policy = semanticRuntimePolicy();
    policy.deploymentHardCaps.maxPreAllocatedVus = fixture.maxPreAllocatedVus;
    policy.deploymentHardCaps.maxVus = fixture.maxVus;
    const snapshot: AcceptedRunConfigSnapshot = {
      ...acceptedRunSnapshot(),
      trafficConfig: {
        mode: "constant-arrival-rate",
        ratePerSecond: fixture.ratePerSecond,
        startDelaySeconds: 0,
        durationSeconds: 1,
        quantityPerAttempt: 1,
      },
    };

    expect(collectPublicRuntimePolicyViolations(policy)).toEqual([]);
    expect(
      collectAcceptedRunConfigSnapshotViolations(snapshot, policy, {
        operatorMode: "admin",
        enforcePublicCustomLimits: false,
      }),
    ).toEqual([
      expect.objectContaining({ code: fixture.expectedCode, details: fixture.expectedDetails }),
    ]);
  });

  it("keeps automatic VUs outside public-custom VU caps while retaining deployment checks", () => {
    const policy = semanticRuntimePolicy();
    const snapshot: AcceptedRunConfigSnapshot = {
      ...acceptedRunSnapshot(),
      trafficConfig: {
        mode: "constant-arrival-rate",
        ratePerSecond: 20,
        startDelaySeconds: 0,
        durationSeconds: 1,
        quantityPerAttempt: 1,
      },
    };

    expect(
      collectAcceptedRunConfigSnapshotViolations(snapshot, policy, {
        operatorMode: "public",
        enforcePublicCustomLimits: true,
      }).filter((violation) => violation.code.includes("vus_exceeded")),
    ).toEqual([]);
  });

  it("does not derive a request rate for buyer-spike traffic", () => {
    const policy = semanticRuntimePolicy();
    policy.publicCustomLimits.maxRequestsPerSecond = 5;
    policy.deploymentHardCaps.maxRequestsPerSecond = 5;
    const snapshot: AcceptedRunConfigSnapshot = {
      ...acceptedRunSnapshot(),
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 90,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 1,
        quantityPerAttempt: 1,
      },
    };

    expect(
      collectAcceptedRunConfigSnapshotViolations(snapshot, policy, {
        operatorMode: "public",
        enforcePublicCustomLimits: true,
      }),
    ).toEqual([]);
  });

  it("accepts protected public custom configuration when it matches policy defaults", () => {
    const policy = semanticRuntimePolicy();

    expect(
      collectAcceptedRunConfigSnapshotViolations(policy.publicCustomDefaults, policy, {
        operatorMode: "public",
        enforcePublicCustomLimits: true,
      }),
    ).toEqual([]);
  });

  it.each([
    {
      code: "public_backpressure_override_not_allowed",
      path: ["backpressureConfig"],
      change: (snapshot: AcceptedRunConfigSnapshot) => {
        snapshot.backpressureConfig.orderProcessConcurrency += 1;
      },
    },
  ] as const)("rejects $code for public custom without changing admin validation", (fixture) => {
    const policy = semanticRuntimePolicy();
    const snapshot = acceptedRunSnapshot();
    fixture.change(snapshot);

    expect(
      collectAcceptedRunConfigSnapshotViolations(snapshot, policy, {
        operatorMode: "public",
        enforcePublicCustomLimits: true,
      }),
    ).toContainEqual(
      expect.objectContaining({
        code: fixture.code,
        path: fixture.path,
      }),
    );
    expect(
      collectAcceptedRunConfigSnapshotViolations(snapshot, policy, {
        operatorMode: "admin",
        enforcePublicCustomLimits: false,
      }),
    ).toEqual([]);
  });

  it("still bounds buyer-spike volume through the buyer and total request caps", () => {
    const policy = semanticRuntimePolicy();
    policy.publicCustomLimits.maxRequestsPerSecond = 5;
    policy.deploymentHardCaps.maxRequestsPerSecond = 5;
    const snapshot: AcceptedRunConfigSnapshot = {
      ...acceptedRunSnapshot(),
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 150,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 1,
        quantityPerAttempt: 1,
      },
    };

    const codes = collectAcceptedRunConfigSnapshotViolations(snapshot, policy, {
      operatorMode: "public",
      enforcePublicCustomLimits: true,
    }).map((violation) => violation.code);

    expect(codes).toContain("public_buyers_exceeded");
    expect(codes).toContain("public_total_requests_exceeded");
    expect(codes).toContain("deployment_buyers_exceeded");
    expect(codes).toContain("deployment_total_requests_exceeded");
    expect(codes).not.toContain("public_request_rate_exceeded");
    expect(codes).not.toContain("deployment_request_rate_exceeded");
  });

  it.each([
    {
      scope: "public",
      enforcePublicCustomLimits: true,
      expectedCode: "public_request_rate_exceeded",
    },
    {
      scope: "deployment",
      enforcePublicCustomLimits: false,
      expectedCode: "deployment_request_rate_exceeded",
    },
  ] as const)("enforces the $scope request rate cap on configured arrival rates", (fixture) => {
    const policy = semanticRuntimePolicy();
    policy.publicCustomLimits.maxRequestsPerSecond = 5;
    policy.deploymentHardCaps.maxRequestsPerSecond = 5;
    const snapshot: AcceptedRunConfigSnapshot = {
      ...acceptedRunSnapshot(),
      trafficConfig: {
        mode: "constant-arrival-rate",
        ratePerSecond: 50,
        startDelaySeconds: 0,
        durationSeconds: 1,
        quantityPerAttempt: 1,
      },
    };

    expect(
      collectAcceptedRunConfigSnapshotViolations(snapshot, policy, {
        operatorMode: "public",
        enforcePublicCustomLimits: fixture.enforcePublicCustomLimits,
      }),
    ).toContainEqual(
      expect.objectContaining({
        code: fixture.expectedCode,
        details: { value: 50, cap: 5 },
        path: ["trafficConfig", "ratePerSecond"],
      }),
    );
  });

  it("does not derive a request rate for buyer-spike public custom defaults", () => {
    const policy = semanticRuntimePolicy();
    policy.publicCustomLimits.maxRequestsPerSecond = 5;
    policy.publicCustomDefaults.trafficConfig = {
      mode: "buyer-spike",
      buyerCount: 90,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 1,
      quantityPerAttempt: 1,
    };
    const { deploymentHardCaps: _deploymentHardCaps, ...mutable } = policy;

    expect(collectPublicRuntimePolicyMutableViolations(mutable)).toEqual([]);
  });

  it.each([
    ["maxTotalRequests", "maxTotalRequests", "public_limit_total_requests_exceeds_deployment_cap"],
    [
      "maxRequestsPerSecond",
      "maxRequestsPerSecond",
      "public_limit_request_rate_exceeds_deployment_cap",
    ],
    [
      "maxTrafficDurationSeconds",
      "maxTrafficDurationSeconds",
      "public_limit_duration_exceeds_deployment_cap",
    ],
    [
      "maxTrafficStartDelaySeconds",
      "maxTrafficStartDelaySeconds",
      "public_limit_start_delay_exceeds_deployment_cap",
    ],
    ["maxBuyers", "maxBuyers", "public_limit_buyers_exceeds_deployment_cap"],
    [
      "maxPreAllocatedVus",
      "maxPreAllocatedVus",
      "public_limit_preallocated_vus_exceeds_deployment_cap",
    ],
    ["maxVus", "maxVus", "public_limit_max_vus_exceeds_deployment_cap"],
  ] as const)("reports the $2 deployment-cap violation on $0", (limitField, capField, expectedCode) => {
    const policy = semanticRuntimePolicy();
    policy.deploymentHardCaps[capField] = policy.publicCustomLimits[limitField] - 1;

    expect(collectPublicRuntimePolicyViolations(policy)[0]).toMatchObject({
      code: expectedCode,
      path: ["publicCustomLimits", limitField],
    });
  });

  it("validates protected public runtime policy reads and update requests", () => {
    const policy = publicRuntimePolicySchema.parse({
      estimatedDemoOccupancyCeilingSeconds: 600,
      isPublicRunBudgetEnforced: true,
      publicRunBudget: {
        windowSeconds: 120,
        perVisitorMaxStarts: 1,
        globalMaxStarts: 3,
      },
      publicCustomDefaults: acceptedRunSnapshot(),
      publicCustomLimits: {
        maxTotalRequests: 1000,
        maxBuyers: 1000,
        maxRequestsPerSecond: 100,
        maxTrafficDurationSeconds: 30,
        maxTrafficStartDelaySeconds: 5,
        maxPreAllocatedVus: 100,
        maxVus: 200,
        maxStartingStock: 500,
        maxErpLatencyMs: 500,
        minErpMaxTps: 1,
        maxErpMaxTps: 50,
        maxErpErrorRate: 0.1,
        allowForcedOutage: false,
        allowedTrafficModes: ["buyer-spike"],
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
    });
    const mutable = publicRuntimePolicyMutableSchema.parse({
      estimatedDemoOccupancyCeilingSeconds: policy.estimatedDemoOccupancyCeilingSeconds,
      isPublicRunBudgetEnforced: policy.isPublicRunBudgetEnforced,
      publicRunBudget: policy.publicRunBudget,
      publicCustomDefaults: policy.publicCustomDefaults,
      publicCustomLimits: policy.publicCustomLimits,
    });
    const update = adminPublicRuntimePolicyUpdateRequestSchema.parse({
      policy: mutable,
      correlationId,
    });
    const response = adminPublicRuntimePolicyResponseSchema.parse({
      id: "active",
      policy,
      updatedAt: timestamp,
      correlationId,
      timestamp,
    });

    expect(update.policy).not.toHaveProperty("deploymentHardCaps");
    expect(update.correlationId).toBe(correlationId);
    expect(response.policy.deploymentHardCaps.maxBuyers).toBe(100_000);
    expect(() =>
      adminPublicRuntimePolicyUpdateRequestSchema.parse({
        policy: {
          ...mutable,
          publicCustomLimits: { ...mutable.publicCustomLimits, allowedTrafficModes: [] },
        },
      }),
    ).toThrow();
  });

  it("validates load-orchestrator start and traffic completion payloads", () => {
    const configSnapshot = {
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 200,
        duplicateEachBuyerAttempt: true,
        startDelaySeconds: 0,
        maxDurationSeconds: 5,
        quantityPerAttempt: 1,
      },
      inventoryConfig: {
        startingStock: 200,
      },
      erpConfig: {
        latencyMs: 50,
        maxTps: 200,
        errorRate: 0,
        forcedOutage: false,
      },
      backpressureConfig: {
        queueName: "orders:process",
        physicalQueueName: "orders-process",
        orderProcessConcurrency: 5,
      },
    };

    expect(
      trafficExecutionStartRequestSchema.parse({
        runId,
        saleOfferId,
        apiBaseUrl: "http://localhost:4000",
        correlationId,
        configSnapshot,
      }).configSnapshot.trafficConfig.mode,
    ).toBe("buyer-spike");

    expect(
      trafficCompletionReportSchema.parse({
        runId,
        status: "succeeded",
        exitCode: 0,
        transportAttemptCounts: {
          plannedRequests: 400,
          startedRequests: 400,
          completedRequests: 400,
          interruptedRequests: 0,
          unstartedRequests: 0,
        },
        httpSummary: {
          failedRequests: 0,
          acceptedResponses: 200,
          soldOutResponses: 200,
          transportFailures: 0,
          unexpectedResponses: 0,
          p95LatencyMs: 42,
          failureRate: 0,
        },
        trafficOutcomeSummary: {},
        trafficDeliverySummary: {
          trafficMode: "buyer-spike",
          plannedBuyers: 200,
          scheduledRatePerSecond: null,
          configuredDurationSeconds: null,
          preAllocatedVUs: null,
          maxVUs: null,
          droppedIterations: 0,
          requestArrivalSummary: emptyRequestArrivalSummary,
          notes: [],
        },
        httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
        loadRunDiagnosticsSummary: {
          ...runnerDiagnostics(),
          executionPlan: {
            trafficMode: "buyer-spike",
            buyerCount: 200,
            duplicateEachBuyerAttempt: true,
            iterationsPerVu: 2,
            plannedEmittedAttempts: 400,
            startDelaySeconds: 0,
            maxDurationSeconds: 5,
          },
        },
        completedAt: timestamp,
        correlationId,
      }).httpSummary.acceptedResponses,
    ).toBe(200);
  });

  it("derives canonical buyer-spike and constant-arrival execution identities", () => {
    expect(
      deriveLoadExecutionPlan({
        mode: "buyer-spike",
        buyerCount: 7,
        duplicateEachBuyerAttempt: true,
        startDelaySeconds: 2,
        maxDurationSeconds: 9,
        quantityPerAttempt: 1,
      }),
    ).toEqual({
      trafficMode: "buyer-spike",
      buyerCount: 7,
      duplicateEachBuyerAttempt: true,
      iterationsPerVu: 2,
      plannedEmittedAttempts: 14,
      startDelaySeconds: 2,
      maxDurationSeconds: 9,
    });
    expect(
      deriveLoadExecutionPlan({
        mode: "constant-arrival-rate",
        ratePerSecond: 12,
        startDelaySeconds: 3,
        durationSeconds: 4,
        quantityPerAttempt: 1,
        k6Vus: { preAllocatedVus: 5, maxVus: 8 },
      }),
    ).toEqual({
      trafficMode: "constant-arrival-rate",
      ratePerSecond: 12,
      durationSeconds: 4,
      plannedEmittedAttempts: 48,
      startDelaySeconds: 3,
      preAllocatedVus: 5,
      maxVus: 8,
    });
  });
});

describe("admin preset archive contracts", () => {
  it("keeps the preset list and archive operation on the shared admin path", () => {
    expect(adminPresetListPath).toBe("/admin/demo/presets");
  });

  it("requires a trimmed non-empty archive slug and stays strict", () => {
    expect(archiveAdminPresetRequestSchema.parse({ slug: "  preview-copy  " })).toEqual({
      slug: "preview-copy",
    });
    expect(() => archiveAdminPresetRequestSchema.parse({ slug: "   " })).toThrow();
    expect(() => archiveAdminPresetRequestSchema.parse({})).toThrow();
    expect(() =>
      archiveAdminPresetRequestSchema.parse({ slug: "preview-copy", extra: true }),
    ).toThrow();
  });

  it("requires valid ISO timestamps in the archive response and stays strict", () => {
    const response = archiveAdminPresetResponseSchema.parse({
      slug: "preview-copy",
      archivedAt: timestamp,
      timestamp,
    });
    expect(response.slug).toBe("preview-copy");
    expect(response.archivedAt).toBe(timestamp);
    expect(() =>
      archiveAdminPresetResponseSchema.parse({
        slug: "preview-copy",
        archivedAt: "not-a-timestamp",
        timestamp,
      }),
    ).toThrow();
    expect(() =>
      archiveAdminPresetResponseSchema.parse({ slug: "preview-copy", archivedAt: timestamp }),
    ).toThrow();
    expect(() =>
      archiveAdminPresetResponseSchema.parse({
        slug: "preview-copy",
        archivedAt: timestamp,
        timestamp,
        extra: true,
      }),
    ).toThrow();
  });

  it("requires the server-computed canArchive capability on admin list items", () => {
    const preset = acceptedRunSnapshot();
    const listablePreset = {
      id: "33333333-3333-4333-8333-333333333331",
      slug: "preview-copy",
      visibility: "admin",
      isEditable: true,
      isCustom: false,
      canArchive: true,
      display: {
        name: "Preview Copy",
        description: "Operator duplicate.",
        sortOrder: 50,
        outcomeFocus: [],
      },
      ...preset,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(
      adminPresetListResponseSchema.parse({
        presets: [listablePreset],
        timestamp,
      }).presets[0]?.canArchive,
    ).toBe(true);

    const { canArchive: _removed, ...withoutCapability } = listablePreset;
    expect(() =>
      adminPresetListResponseSchema.parse({ presets: [withoutCapability], timestamp }),
    ).toThrow();
    expect(() =>
      adminPresetListResponseSchema.parse({
        presets: [{ ...listablePreset, extra: true }],
        timestamp,
      }),
    ).toThrow();
  });
});

function acceptedRunSnapshot(): AcceptedRunConfigSnapshot {
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

function runnerDiagnostics() {
  return {
    startedAt: timestamp,
    completedAt: timestamp,
    nproc: null,
    ulimitNofile: null,
    processMaxOpenFiles: null,
    generatorCapacity: null,
    generatorUtilisation: null,
    networkDiagnostics: null,
    k6Version: null,
    executionPlan: {
      trafficMode: "buyer-spike",
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
    stderrRetainedLineLimit: 50,
    stderrLineTruncationLength: 500,
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

function semanticRuntimePolicy(): PublicRuntimePolicy {
  return {
    estimatedDemoOccupancyCeilingSeconds: 600,
    isPublicRunBudgetEnforced: true,
    publicRunBudget: { windowSeconds: 300, perVisitorMaxStarts: 2, globalMaxStarts: 6 },
    publicCustomDefaults: acceptedRunSnapshot(),
    publicCustomLimits: {
      maxTotalRequests: 100,
      maxBuyers: 100,
      maxRequestsPerSecond: 100,
      maxTrafficDurationSeconds: 100,
      maxTrafficStartDelaySeconds: 10,
      maxPreAllocatedVus: 10,
      maxVus: 10,
      maxStartingStock: 100,
      maxErpLatencyMs: 100,
      minErpMaxTps: 1,
      maxErpMaxTps: 10,
      maxErpErrorRate: 0.25,
      allowForcedOutage: false,
      allowedTrafficModes: ["buyer-spike", "constant-arrival-rate"],
    },
    deploymentHardCaps: {
      estimatedDemoOccupancyCeilingSeconds: 600,
      maxBuyers: 100,
      maxTotalRequests: 100,
      maxRequestsPerSecond: 100,
      maxTrafficDurationSeconds: 100,
      maxTrafficStartDelaySeconds: 10,
      maxPreAllocatedVus: 100,
      maxVus: 100,
    },
  };
}
