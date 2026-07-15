import { describe, expect, it } from "vitest";
import {
  type AcceptedRunConfigSnapshot,
  acceptedRunConfigSnapshotSchema,
  adminDeleteRunHistoryRequestSchema,
  adminDeleteRunHistoryResponseSchema,
  adminDemoResetResponseSchema,
  adminGeneratedRunTeardownParamsSchema,
  adminGeneratedRunTeardownPath,
  adminGeneratedRunTeardownPathTemplate,
  adminGeneratedRunTeardownResponseSchema,
  adminPresetListPath,
  adminPresetListResponseSchema,
  adminPublicRuntimePolicyPath,
  adminPublicRuntimePolicyResponseSchema,
  adminPublicRuntimePolicyUpdateRequestSchema,
  archiveAdminPresetRequestSchema,
  archiveAdminPresetResponseSchema,
  buyOutcomeHeaderName,
  buyOutcomeHeaderValueSchema,
  buyRejectionReasonHeaderName,
  buyRejectionReasonHeaderValueSchema,
  buyRequestSchema,
  buyResponseSchema,
  collectAcceptedRunConfigSnapshotViolations,
  collectPublicRuntimePolicyViolations,
  controlServiceTokenHeaderName,
  dashboardEventSchema,
  dashboardEventsPath,
  dashboardEventsRedisChannel,
  dashboardRecoveryPath,
  dashboardRecoveryResponseSchema,
  demoRunOperatorModeHeaderName,
  demoRunSnapshotSchema,
  demoRunStatusValues,
  directSnapshotViolationCodes,
  type ErrorPayloadCode,
  emptyHttpTimingBreakdownSummary,
  erpChaosResetPath,
  erpChaosStatusPath,
  erpConfirmationPath,
  erpConfirmationRequestSchema,
  erpConfirmationResponseSchema,
  erpResilienceStatusPath,
  erpResilienceStatusSchema,
  errorPayloadCodeSchema,
  errorPayloadCodes,
  errorPayloadSchema,
  healthResponseSchema,
  internalLoadMetricIngestPath,
  internalTrafficCompletionPath,
  inventoryStatusSchema,
  inventoryUpdatedEventPayloadSchema,
  loadExecutionPlanSchema,
  loadMetricIngestRequestSchema,
  loadRunDiagnosticsSummarySchema,
  loadRunIdHeaderName,
  maximumAutomaticallyDerivedVUs,
  metricNameValues,
  orderProcessBullMqQueueName,
  orderProcessJobSchema,
  orderProcessQueueName,
  orderStatusValues,
  type PublicRuntimePolicy,
  publicPresetListPath,
  publicRuntimePolicyMutableSchema,
  publicRuntimePolicyPath,
  publicRuntimePolicySchema,
  publicVisitorIdHeaderName,
  queueStatusSchema,
  reservationDecisionValues,
  reservationRejectedResponseSchema,
  reservationStatusValues,
  resolveSteadyArrivalVus,
  runHistoryDetailParamsSchema,
  runHistoryDetailPath,
  runHistoryDetailPathTemplate,
  runHistoryDetailResponseSchema,
  runHistoryListQuerySchema,
  runHistoryListResponseSchema,
  runHistoryPath,
  securedReservationHoldSchema,
  simulatedPurchaseStatusValues,
  startDemoRunPath,
  startDemoRunRequestSchema,
  stockReservationDecisionSchema,
  trafficCompletionAcknowledgementSchema,
  trafficCompletionDeliverySummarySchema,
  trafficCompletionReportSchema,
  trafficDeliveryStatusValues,
  trafficDeliverySummarySchema,
  trafficExecutionAbortPath,
  trafficExecutionAbortRequestSchema,
  trafficExecutionAbortResponseSchema,
  trafficExecutionStartPath,
  trafficExecutionStartRequestSchema,
  trafficExecutionStatusPath,
  trafficExecutionStatusResponseSchema,
  trafficExecutionStatusValues,
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

describe("accepted run breaker configuration", () => {
  const snapshot = {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 1,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 1,
      quantityPerAttempt: 1,
    },
    inventoryConfig: { startingStock: 1, quantityPerCheckout: 1, reservationHoldMinutes: 1 },
    erpConfig: { latencyMs: 0, maxTps: 1, errorRate: 0, forcedOutage: false, requestTimeoutMs: 1 },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 1,
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 0 },
      drainTimeoutSeconds: 1,
      pendingPersistenceRetryAfterSeconds: 1,
      circuitBreakerFailureThreshold: 2,
      circuitBreakerResetTimeoutMs: 100,
    },
  };

  it("accepts positive integer breaker configuration", () => {
    expect(acceptedRunConfigSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("enforces strict retry policy and the deployment concurrency cap", () => {
    expect(
      acceptedRunConfigSnapshotSchema.safeParse({
        ...snapshot,
        backpressureConfig: { ...snapshot.backpressureConfig, orderProcessConcurrency: 11 },
      }).success,
    ).toBe(false);
    expect(
      acceptedRunConfigSnapshotSchema.safeParse({
        ...snapshot,
        backpressureConfig: {
          ...snapshot.backpressureConfig,
          retryPolicy: { maxAttempts: 0, initialBackoffMs: 0 },
        },
      }).success,
    ).toBe(false);
    expect(
      acceptedRunConfigSnapshotSchema.safeParse({
        ...snapshot,
        backpressureConfig: {
          ...snapshot.backpressureConfig,
          retryPolicy: { maxAttempts: 1, initialBackoffMs: 0, unknown: true },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["circuitBreakerFailureThreshold", 0],
    ["circuitBreakerFailureThreshold", -1],
    ["circuitBreakerFailureThreshold", 1.5],
    ["circuitBreakerResetTimeoutMs", 0],
    ["circuitBreakerResetTimeoutMs", -1],
    ["circuitBreakerResetTimeoutMs", 1.5],
  ] as const)("rejects invalid %s value %s", (field, value) => {
    expect(
      acceptedRunConfigSnapshotSchema.safeParse({
        ...snapshot,
        backpressureConfig: {
          ...snapshot.backpressureConfig,
          [field]: value,
        },
      }).success,
    ).toBe(false);
  });

  it("requires both breaker fields and remains strict", () => {
    const { circuitBreakerFailureThreshold: _missingThreshold, ...withoutThreshold } =
      snapshot.backpressureConfig;
    const { circuitBreakerResetTimeoutMs: _missing, ...withoutReset } = snapshot.backpressureConfig;
    expect(
      acceptedRunConfigSnapshotSchema.safeParse({
        ...snapshot,
        backpressureConfig: withoutThreshold,
      }).success,
    ).toBe(false);
    expect(
      acceptedRunConfigSnapshotSchema.safeParse({ ...snapshot, backpressureConfig: withoutReset })
        .success,
    ).toBe(false);
    expect(
      acceptedRunConfigSnapshotSchema.safeParse({
        ...snapshot,
        backpressureConfig: { ...snapshot.backpressureConfig, unknown: true },
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
  it("keeps reservation and order states distinct", () => {
    expect(reservationStatusValues).toEqual(["secured", "rejected", "released", "expired"]);
    expect(orderStatusValues).toEqual(["queued", "processing", "confirmed", "failed"]);
    expect(demoRunStatusValues).toEqual(["starting", "active", "draining", "completed", "failed"]);
    expect(trafficExecutionStatusValues).toEqual([
      "not_started",
      "starting",
      "active",
      "succeeded",
      "failed",
    ]);
    expect(trafficDeliveryStatusValues).toEqual(["complete", "warning", "degraded", "failed"]);
  });

  it("exposes the documented dashboard metric names", () => {
    expect(metricNameValues).toContain("traffic.scheduled_request_rate");
    expect(metricNameValues).toContain("queue.depth");
    expect(metricNameValues).toContain("inventory.sold_out_rejection");
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
    expect(() =>
      loadExecutionPlanSchema.parse({
        ...runnerDiagnostics().executionPlan,
        plannedEmittedAttempts: 9,
      }),
    ).toThrow();
    expect(
      loadExecutionPlanSchema.parse({
        trafficMode: "steady-arrival-rate",
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
        trafficMode: "steady-arrival-rate",
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
  });
  it("validates run-attributed buy and load payloads without deriving identity from correlation IDs", () => {
    expect(loadRunIdHeaderName).toBe("x-load-run-id");

    expect(
      buyRequestSchema.parse({
        saleOfferId,
        runId,
        idempotencyKey: "run-attributed-buy",
        quantity: 1,
        correlationId,
      }),
    ).toMatchObject({ saleOfferId, runId });

    expect(
      trafficExecutionStartRequestSchema.parse({
        runId,
        saleOfferId,
        apiBaseUrl: "http://api.local",
        buyEndpointPath: "/buy",
        correlationId,
        configSnapshot: acceptedRunSnapshot(),
      }),
    ).toMatchObject({ runId, saleOfferId, correlationId });

    expect(() =>
      trafficExecutionStartRequestSchema.parse({
        runId,
        saleOfferId,
        apiBaseUrl: "http://api.local",
        buyEndpointPath: "/buy",
        correlationId: `run:${runId}:buyer:1`,
        configSnapshot: acceptedRunSnapshot(),
      }),
    ).not.toThrow();
  });

  it("keeps steady-arrival VU overrides all-or-nothing and validates their relationship", () => {
    const request = {
      runId,
      saleOfferId,
      apiBaseUrl: "http://api.local",
      buyEndpointPath: "/buy",
      correlationId,
      configSnapshot: {
        ...acceptedRunSnapshot(),
        trafficConfig: {
          mode: "steady-arrival-rate",
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
      httpSummary: {
        plannedRequests: 10,
        emittedRequests: 10,
        completedRequests: 10,
        failedRequests: 0,
        acceptedResponses: 2,
        soldOutResponses: 8,
        unexpectedResponses: 0,
        p95LatencyMs: 25,
        failureRate: 0,
      },
      trafficOutcomeSummary: {},
      trafficDeliverySummary: {
        plannedRequests: 10,
        emittedRequests: 10,
        droppedIterations: 0,
        trafficDeliveryStatus: "complete",
        notes: [],
      },
      httpTimingBreakdownSummary: {
        ...emptyHttpTimingBreakdownSummary,
        waiting: { averageMs: 10, p95Ms: 20 },
      },
      loadRunDiagnosticsSummary: {
        ...runnerDiagnostics(),
        terminalMetricSources: {
          emittedRequests: "summary_export",
          completedRequests: "summary_export",
          acceptedResponses: "point_stream",
          soldOutResponses: "summary_export",
          unexpectedResponses: null,
          droppedIterations: "summary_export",
          completedIterations: "summary_export",
        },
        summaryExportWarnings: ["k6_outcome_counter_point_stream_fallback_used"],
      },
      apiRequestLifecycleSummary: {},
      completedAt: timestamp,
      correlationId,
    });

    expect(report.status).toBe("succeeded");
    expect(report.httpTimingBreakdownSummary.waiting?.p95Ms).toBe(20);
    expect(report.loadRunDiagnosticsSummary.terminalMetricSources?.acceptedResponses).toBe(
      "point_stream",
    );
    expect(() => demoRunSnapshotSchema.parse({ ...report, status: "completed" })).toThrow();
    expect(() =>
      trafficCompletionReportSchema.parse({
        ...report,
        httpTimingBreakdownSummary: { p95LatencyMs: 20 },
      }),
    ).toThrow();
    const {
      terminalMetricSources: _terminalMetricSources,
      summaryExportWarnings: _summaryExportWarnings,
      ...legacyDiagnostics
    } = report.loadRunDiagnosticsSummary;
    expect(() => loadRunDiagnosticsSummarySchema.parse(legacyDiagnostics)).not.toThrow();
    expect(() =>
      trafficCompletionReportSchema.parse({
        ...report,
        loadRunDiagnosticsSummary: legacyDiagnostics,
      }),
    ).toThrow();
  });

  it("accepts unclassified completion evidence but requires status in stored history", () => {
    const evidence = {
      plannedRequests: 10,
      emittedRequests: 9,
      droppedIterations: 1,
      notes: [],
    };
    expect(trafficCompletionDeliverySummarySchema.parse(evidence)).not.toHaveProperty(
      "trafficDeliveryStatus",
    );
    expect(() => trafficDeliverySummarySchema.parse(evidence)).toThrow();
    expect(
      trafficDeliverySummarySchema.parse({ ...evidence, trafficDeliveryStatus: "warning" }),
    ).toEqual({
      ...evidence,
      trafficMode: null,
      plannedBuyers: null,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      completedIterations: null,
      unstartedIterations: null,
      requestShortfall: null,
      trafficDeliveryStatus: "warning",
    });
    expect(() =>
      trafficCompletionDeliverySummarySchema.parse({ ...evidence, plannedRequests: 0 }),
    ).toThrow();
  });

  it("validates admin reset as a recovery result rather than a traffic lifecycle event", () => {
    expect(
      adminDemoResetResponseSchema.parse({
        failedRunCount: 1,
        closedSaleOfferCount: 1,
        cleanedQueueCount: 2,
        cleanedJobCount: 3,
        resetAt: timestamp,
        correlationId,
      }),
    ).toMatchObject({ failedRunCount: 1, closedSaleOfferCount: 1 });
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
      retryPressure: {
        inspectedJobCount: 4,
        inspectionLimit: 100,
        retryingJobCount: 2,
        retryAttemptCount: 3,
        inspectionTruncated: true,
      },
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
      updatedAt: timestamp,
    });

    expect(status.depth).toBe(8);
    expect(status.retryPressure.inspectionTruncated).toBe(true);
    expect(status.failedJobs.totalCount).toBe(9);
    expect(() => queueStatusSchema.parse({ ...status, physicalName: "orders-process" })).toThrow();
  });
});

describe("shared error and health contracts", () => {
  it("validates the canonical error payload", () => {
    expect(() =>
      errorPayloadSchema.parse({
        code: "invalid_request",
        message: "Invalid request.",
        correlationId,
        timestamp,
      }),
    ).not.toThrow();

    expect(() =>
      errorPayloadSchema.parse({
        code: "invalid_request",
        message: "Invalid request.",
        timestamp,
      }),
    ).toThrow();
  });

  it("validates readiness responses with checks", () => {
    const response = healthResponseSchema.parse({
      service: "api",
      status: "degraded",
      timestamp,
      uptimeSeconds: 12,
      checks: [{ name: "redis_url_configured", status: "degraded" }],
    });

    expect(response.checks[0]?.name).toBe("redis_url_configured");
  });
});

describe("canonical error-code vocabulary", () => {
  it("accepts every declared code through the enum schema", () => {
    for (const code of errorPayloadCodes) {
      expect(errorPayloadCodeSchema.safeParse(code).success, `code ${code}`).toBe(true);
    }
  });

  it("contains no duplicate codes", () => {
    const seen = new Set<string>();
    for (const code of errorPayloadCodes) {
      expect(seen.has(code), `duplicate code ${code}`).toBe(false);
      seen.add(code);
    }
  });

  it("rejects unknown, typo, and drifted codes", () => {
    for (const code of ["notfound", "internal-error", "internal_error ", "preset_not_foundd", ""]) {
      expect(errorPayloadCodeSchema.safeParse(code).success, `code "${code}"`).toBe(false);
    }
  });

  it("keeps every public_custom_default code aligned with a direct snapshot violation code", () => {
    const expectedPrefixed = directSnapshotViolationCodes.map(
      (code) => `public_custom_default_${code}`,
    );
    const actualPrefixed = errorPayloadCodes.filter((code) =>
      code.startsWith("public_custom_default_"),
    );
    expect(actualPrefixed.sort()).toEqual([...expectedPrefixed].sort());
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

  it("narrows the inferred code type to the declared vocabulary", () => {
    const sample: ErrorPayloadCode = "internal_error";
    expect(errorPayloadCodeSchema.parse(sample)).toBe("internal_error");
  });
});

describe("ERP contracts", () => {
  it("defines the worker-facing confirmation endpoint and payloads", () => {
    expect(erpConfirmationPath).toBe("/confirmations");
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
  });

  it("defines chaos control paths and service-token header", () => {
    expect(erpChaosStatusPath).toBe("/chaos");
    expect(erpChaosResetPath).toBe("/chaos/reset");
    expect(erpResilienceStatusPath).toBe("/erp/status");
    expect(controlServiceTokenHeaderName).toBe("x-control-service-token");
  });

  it("validates operator-facing ERP resilience status", () => {
    expect(
      erpResilienceStatusSchema.parse({
        status: "degraded",
        reason: "erp_retries_pending",
        circuit: {
          state: "half_open",
          consecutiveFailureCount: 5,
          failureThreshold: 5,
          resetTimeoutMs: 10_000,
          openedAt: "2026-06-20T00:00:00.000Z",
          nextAttemptAt: "2026-06-20T00:00:10.000Z",
          halfOpenProbeInFlight: true,
          updatedAt: timestamp,
        },
        retryPressure: {
          retryingJobCount: 2,
          retryAttemptCount: 4,
          inspectedJobCount: 10,
          inspectionLimit: 100,
          inspectionTruncated: false,
        },
        latestAttempt: {
          orderId: "11111111-1111-4111-8111-111111111111",
          runId: null,
          attemptNumber: 3,
          status: "failed",
          httpStatus: 503,
          errorCode: "erp_unavailable",
          errorMessage: "The ERP is temporarily unavailable.",
          latencyMs: 125,
          finishedAt: timestamp,
        },
        recentAttemptWindowSeconds: 60,
        recentAttemptCount: 8,
        recentFailureCount: 3,
        recentTimeoutCount: 1,
        confirmationDelay: {
          processingOrderCount: 4,
          oldestProcessingAgeSeconds: 12.5,
          recentConfirmedCount: 6,
          averageConfirmationDelayMs: 275,
        },
        updatedAt: timestamp,
      }).status,
    ).toBe("degraded");
  });
});

describe("buy and dashboard contracts", () => {
  it("defines bounded inventory drain and sold-out projections without conflating units", () => {
    expect(
      inventoryStatusSchema.parse({
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
          rate: 4 / 60,
          unit: "reservations_per_second",
          measuredAt: timestamp,
        },
        soldOutPressure: {
          rejectionCount: 9,
          latestObservedAt: timestamp,
        },
        lastUpdatedAt: timestamp,
      }).reservationThroughput.successfulReservationCount,
    ).toBe(4);
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

  it("exposes canonical buy classification header names and values", () => {
    expect(buyOutcomeHeaderName).toBe("x-checkout-outcome");
    expect(buyRejectionReasonHeaderName).toBe("x-checkout-rejection-reason");

    for (const outcome of reservationDecisionValues) {
      expect(buyOutcomeHeaderValueSchema.parse(outcome)).toBe(outcome);
    }
    for (const reason of [
      "sold_out",
      "inventory_not_initialized",
      "quantity_invalid",
      "run_not_accepting_traffic",
      "idempotency_conflict",
    ] as const) {
      expect(buyRejectionReasonHeaderValueSchema.parse(reason)).toBe(reason);
    }

    expect(() => buyOutcomeHeaderValueSchema.parse("unrelated_outcome")).toThrow();
    expect(() => buyRejectionReasonHeaderValueSchema.parse("unrelated_reason")).toThrow();
  });

  it("validates accepted and sold-out reservation outcomes", () => {
    const accepted = {
      outcome: "reservation_secured",
      correlationId,
      timestamp,
      reservation: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        saleOfferId,
        correlationId: "original-correlation",
        quantity: 1,
        status: "secured",
        reservationToken: "reservation-token",
        securedAt: timestamp,
        expiresAt: "2026-06-20T12:15:00.000Z",
      },
      order: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        publicOrderId: "ord_contract",
        saleOfferId,
        reservationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        correlationId: "original-correlation",
        quantity: 1,
        status: "queued",
        queuedAt: timestamp,
      },
      simulatedStatus: "reservation_secured",
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
      buyResponseSchema.parse({
        ...accepted,
        reservation: { ...accepted.reservation, status: "released" },
      }),
    ).toThrow();

    expect(
      buyResponseSchema.parse({
        outcome: "sold_out",
        reason: "sold_out",
        correlationId,
        timestamp,
        reservation: null,
        order: null,
        simulatedStatus: "sold_out",
      }).outcome,
    ).toBe("sold_out");
    expect(
      buyResponseSchema.parse({
        outcome: "quantity_invalid",
        reason: "quantity_invalid",
        correlationId,
        timestamp,
        reservation: null,
        order: null,
        simulatedStatus: null,
      }).outcome,
    ).toBe("quantity_invalid");
  });

  it("exposes the canonical decision and presentation vocabulary for run closures", () => {
    expect(reservationDecisionValues).toContain("run_not_accepting_traffic");
    expect(simulatedPurchaseStatusValues).toContain("sale_not_active");
  });

  it.each([
    { outcome: "sold_out", simulatedStatus: "sold_out" },
    { outcome: "run_not_accepting_traffic", simulatedStatus: "sale_not_active" },
    { outcome: "inventory_not_initialized", simulatedStatus: null },
    { outcome: "idempotency_conflict", simulatedStatus: null },
    { outcome: "quantity_invalid", simulatedStatus: null },
  ] as const)("parses the $outcome rejection with its exact reason and presentation", ({
    outcome,
    simulatedStatus,
  }) => {
    const payload = {
      outcome,
      reason: outcome,
      correlationId,
      timestamp,
      reservation: null,
      order: null,
      simulatedStatus,
    };
    const parsed = reservationRejectedResponseSchema.parse(payload);
    expect(parsed.outcome).toBe(outcome);
    expect(parsed.reason).toBe(outcome);
    expect(parsed.reservation).toBeNull();
    expect(parsed.order).toBeNull();
    expect(parsed.simulatedStatus).toBe(simulatedStatus);
    expect(buyResponseSchema.parse(payload).outcome).toBe(outcome);
  });

  it("rejects invalid outcome, reason, and presentation cross-pairs", () => {
    const base = {
      correlationId,
      timestamp,
      reservation: null,
      order: null,
    } as const;

    expect(() =>
      reservationRejectedResponseSchema.parse({
        ...base,
        outcome: "idempotency_conflict",
        reason: "idempotency_conflict",
        simulatedStatus: "sold_out",
      }),
    ).toThrow();

    expect(() =>
      reservationRejectedResponseSchema.parse({
        ...base,
        outcome: "idempotency_conflict",
        reason: "sold_out",
        simulatedStatus: null,
      }),
    ).toThrow();

    expect(() =>
      reservationRejectedResponseSchema.parse({
        ...base,
        outcome: "run_not_accepting_traffic",
        reason: "run_not_accepting_traffic",
        simulatedStatus: "sold_out",
      }),
    ).toThrow();

    expect(() =>
      reservationRejectedResponseSchema.parse({
        ...base,
        outcome: "run_not_accepting_traffic",
        reason: "run_not_accepting_traffic",
        simulatedStatus: null,
      }),
    ).toThrow();

    expect(() =>
      reservationRejectedResponseSchema.parse({
        ...base,
        outcome: "sold_out",
        reason: "sold_out",
        simulatedStatus: null,
      }),
    ).toThrow();
  });

  it("requires an explicit null simulatedStatus rather than omitting the field", () => {
    const { simulatedStatus: _omitted, ...withoutSimulatedStatus } = {
      outcome: "idempotency_conflict",
      reason: "idempotency_conflict",
      correlationId,
      timestamp,
      reservation: null,
      order: null,
      simulatedStatus: null,
    };
    expect(() => reservationRejectedResponseSchema.parse(withoutSimulatedStatus)).toThrow();
  });

  it("validates stable Redis stock reservation decisions", () => {
    const reservation = securedReservationHoldSchema.parse({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      saleOfferId,
      correlationId,
      runId,
      quantity: 2,
      status: "secured",
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

  it("validates transport-neutral dashboard events", () => {
    expect(dashboardEventsPath).toBe("/dashboard/events");
    expect(dashboardRecoveryPath).toBe("/dashboard/recovery");
    expect(dashboardEventsRedisChannel).toBe("dashboard-events");

    const event = dashboardEventSchema.parse({
      type: "traffic.metric",
      eventId: "77777777-7777-4777-8777-777777777777",
      runId,
      metricName: "traffic.latency",
      value: 42,
      unit: "ms",
      occurredAt: timestamp,
    });

    expect(event.type).toBe("traffic.metric");

    expect(
      dashboardEventSchema.parse({
        type: "business.outcome.updated",
        eventId: "88888888-8888-4888-8888-888888888888",
        runId,
        saleOfferId,
        correlationId,
        occurredAt: timestamp,
        outcome: {
          acceptedReservations: 10,
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
      }).type,
    ).toBe("business.outcome.updated");
  });

  it("strictly validates linked per-order transition and consistency-lag events", () => {
    const statusBase = {
      type: "order.status.updated",
      eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      runId,
      correlationId,
      occurredAt: timestamp,
      orderId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      publicOrderId: "ord-live",
      saleOfferId,
      attemptNumber: 2,
      attemptsMade: 1,
    } as const;
    const statuses = [
      { ...statusBase, eventName: "order.processing", previousStatus: "queued", status: "processing" },
      { ...statusBase, eventName: "order.confirmed", previousStatus: "processing", status: "confirmed" },
      { ...statusBase, eventName: "order.failed", previousStatus: "processing", status: "failed" },
    ] as const;
    for (const status of statuses) expect(dashboardEventSchema.parse(status).type).toBe("order.status.updated");
    const confirmedStatus = statuses[1];
    const lag = {
      type: "order.consistency_lag.observed",
      eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      confirmedTransitionEventId: confirmedStatus.eventId,
      runId,
      correlationId,
      occurredAt: timestamp,
      metricName: "order.consistency_lag",
      value: 125,
      unit: "ms",
      observedAt: timestamp,
      orderId: confirmedStatus.orderId,
      publicOrderId: confirmedStatus.publicOrderId,
      saleOfferId,
      startedAt: "2026-06-20T11:59:59.875Z",
      confirmedAt: timestamp,
    } as const;

    expect(dashboardEventSchema.parse(lag).type).toBe("order.consistency_lag.observed");
    expect(dashboardEventSchema.parse({ ...lag, startedAt: "2026-06-20T12:00:00.001Z", value: 0 }).value).toBe(0);
    expect(dashboardEventSchema.parse({
      ...lag,
      occurredAt: "2026-07-01T00:00:00.000Z",
      observedAt: "2026-07-01T00:00:00.000Z",
      confirmedAt: "2026-07-01T00:00:00.000Z",
      startedAt: "2026-06-01T00:00:00.000Z",
      value: 2_592_000_000,
    }).value).toBe(2_592_000_000);

    const invalidEvents = [
      omit(statuses[0], "orderId"),
      omit(statuses[0], "publicOrderId"),
      omit(statuses[0], "saleOfferId"),
      omit(statuses[0], "correlationId"),
      { ...statuses[0], eventName: "erp.attempt.failed" },
      { ...statuses[0], eventName: "order.failed" },
      { ...statuses[0], status: "queued" },
      { ...statuses[0], occurredAt: "not-a-timestamp" },
      { ...statuses[0], extra: true },
      { ...lag, metricName: "traffic.latency" },
      { ...lag, unit: "seconds" },
      { ...lag, value: -1 },
      { ...lag, value: Number.POSITIVE_INFINITY },
      { ...lag, value: 124 },
      { ...lag, startedAt: "not-a-timestamp" },
      { ...lag, confirmedTransitionEventId: lag.eventId },
      omit(lag, "orderId"),
      omit(lag, "publicOrderId"),
      omit(lag, "saleOfferId"),
      omit(lag, "correlationId"),
    ];
    for (const invalid of invalidEvents) expect(dashboardEventSchema.safeParse(invalid).success).toBe(false);
  });

  it("validates dashboard recovery projections for the operator view", () => {
    const recovery = dashboardRecoveryResponseSchema.parse({
      correlationId,
      scope: null,
      currentRun: null,
      inventory: null,
      recentMetrics: [],
      queue: null,
      erp: null,
      businessOutcome: {
        acceptedReservations: 10,
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
      recentCompletionOutcomes: [
        {
          orderId: "11111111-1111-4111-8111-111111111111",
          publicOrderId: "ord_recent",
          saleOfferId: "22222222-2222-4222-8222-222222222222",
          correlationId: "corr-recent",
          orderStatus: "confirmed",
          displayStatus: "notification_recorded",
          queuedAt: timestamp,
          processingAt: timestamp,
          confirmedAt: timestamp,
          notificationRecordedAt: timestamp,
          latestErpAttemptStatus: "succeeded",
          latestEventAt: timestamp,
        },
      ],
      recoveredAt: timestamp,
    });

    expect(recovery.businessOutcome?.retryingOrders).toBe(2);
    expect(recovery.consistencyLag?.p95LagMs).toBe(350);
    expect(recovery.recentCompletionOutcomes[0]?.displayStatus).toBe("notification_recorded");
  });

  it("rejects dashboard recovery metadata that disagrees with the selected run", () => {
    const currentRun = {
      runId: "11111111-1111-4111-8111-111111111111",
      presetId: "22222222-2222-4222-8222-222222222222",
      presetName: "Preview 1k",
      operatorMode: "public" as const,
      status: "active" as const,
      trafficStatus: "active" as const,
      saleOfferId: "33333333-3333-4333-8333-333333333333",
      configSnapshot: acceptedRunSnapshot(),
    };
    const baseRecovery = {
      correlationId,
      currentRun,
      inventory: null,
      recentMetrics: [],
      queue: null,
      erp: null,
      businessOutcome: null,
      consistencyLag: null,
      recentCompletionOutcomes: [],
      recoveredAt: timestamp,
    };

    expect(() =>
      dashboardRecoveryResponseSchema.parse({
        ...baseRecovery,
        scope: {
          runId: "44444444-4444-4444-8444-444444444444",
          saleOfferId: currentRun.saleOfferId,
        },
      }),
    ).toThrow();
    expect(() => dashboardRecoveryResponseSchema.parse({ ...baseRecovery, scope: null })).toThrow();
    expect(() =>
      dashboardRecoveryResponseSchema.parse({
        ...baseRecovery,
        currentRun: null,
        scope: { runId: currentRun.runId, saleOfferId: currentRun.saleOfferId },
      }),
    ).toThrow();
    expect(() =>
      dashboardRecoveryResponseSchema.parse({
        ...baseRecovery,
        scope: { runId: currentRun.runId, saleOfferId: null },
      }),
    ).toThrow();
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
      runId: "55555555-5555-4555-8555-555555555551",
      correlationId: "metric-bound",
      samples: Array.from({ length: 100 }, () => sample),
      observedAt: timestamp,
    };
    expect(loadMetricIngestRequestSchema.parse(input).samples).toHaveLength(100);
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
    const history = runHistoryListResponseSchema.parse({
      summaries: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          runId,
          presetName: "Preview 1k",
          status: "completed",
          startedAt: timestamp,
          endedAt: timestamp,
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
          businessOutcomeSummary: {
            acceptedReservations: 6,
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
          capturedAt: timestamp,
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

    const summary = history.summaries[0];
    if (!summary) {
      throw new Error("Expected run history summary fixture.");
    }

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

    const detail = runHistoryDetailResponseSchema.parse({
      summary,
      run: {
        runId,
        presetId: "33333333-3333-4333-8333-333333333333",
        presetName: "Preview 1k",
        operatorMode: "public",
        status: "completed",
        trafficStatus: "succeeded",
        saleOfferId,
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
            drainTimeoutSeconds: 300,
            pendingPersistenceRetryAfterSeconds: 30,
            circuitBreakerFailureThreshold: 5,
            circuitBreakerResetTimeoutMs: 10_000,
          },
        },
        startedAt: timestamp,
        trafficStartedAt: timestamp,
        trafficEndedAt: timestamp,
        finalizedAt: timestamp,
      },
      orders: {
        totalCount: 1,
        limit: 20,
        truncated: false,
        records: [
          {
            orderId: "99999999-9999-4999-8999-999999999991",
            publicOrderId: "ord_history_1",
            saleOfferId,
            correlationId,
            quantity: 1,
            status: "confirmed",
            queuedAt: timestamp,
            processingAt: timestamp,
            confirmedAt: timestamp,
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
            correlationId,
            attemptNumber: 1,
            status: "succeeded",
            httpStatus: 200,
            latencyMs: 25,
            startedAt: timestamp,
            finishedAt: timestamp,
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
            recordedAt: timestamp,
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
            saleOfferId,
            correlationId,
            orderId: "99999999-9999-4999-8999-999999999991",
            publicOrderId: "ord_history_1",
            occurredAt: timestamp,
          },
        ],
      },
      timestamp,
    });

    expect(detail.summary.runId).toBe(runId);
    expect(detail.orders.records[0]).not.toHaveProperty("reservationToken");
    expect(detail.orders.records[0]).not.toHaveProperty("idempotencyKey");
    expect(detail.eventTimeline.records[0]).not.toHaveProperty("payload");
    expect(() =>
      runHistoryDetailResponseSchema.parse({
        ...detail,
        orders: {
          ...detail.orders,
          records: [{ ...detail.orders.records[0], reservationToken: "private-token" }],
        },
      }),
    ).toThrow();
    expect(() =>
      runHistoryDetailResponseSchema.parse({
        ...detail,
        eventTimeline: {
          ...detail.eventTimeline,
          records: [{ ...detail.eventTimeline.records[0], payload: { private: true } }],
        },
      }),
    ).toThrow();

    expect(adminDeleteRunHistoryRequestSchema.parse({ runIds: [runId] })).toEqual({
      runIds: [runId],
    });
    expect(
      adminDeleteRunHistoryRequestSchema.parse({
        deleteAllConfirmation: "DELETE_ALL_RUN_SUMMARIES",
      }),
    ).toEqual({ deleteAllConfirmation: "DELETE_ALL_RUN_SUMMARIES" });
    expect(() => adminDeleteRunHistoryRequestSchema.parse({})).toThrow();
    expect(() =>
      adminDeleteRunHistoryRequestSchema.parse({
        runIds: [runId],
        deleteAllConfirmation: "DELETE_ALL_RUN_SUMMARIES",
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

  it("covers public budget, custom caps, and deployment hard caps", () => {
    const policy = publicRuntimePolicySchema.parse({
      isPublicRunBudgetEnforced: true,
      publicRunBudget: {
        windowSeconds: 300,
        perVisitorMaxStarts: 2,
        globalMaxStarts: 6,
      },
      publicCustomDefaults: {
        trafficConfig: {
          mode: "buyer-spike",
          buyerCount: 500,
          duplicateEachBuyerAttempt: false,
          startDelaySeconds: 0,
          maxDurationSeconds: 10,
          quantityPerAttempt: 1,
        },
        inventoryConfig: {
          startingStock: 100,
          quantityPerCheckout: 1,
          reservationHoldMinutes: 15,
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
    });

    expect(policy.publicCustomLimits.maxStartingStock).toBe(1000);
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

  it("resolves automatic steady-arrival VUs with one capped neutral rule", () => {
    expect(maximumAutomaticallyDerivedVUs).toBe(10_000);
    expect(resolveSteadyArrivalVus({ ratePerSecond: 4_999 })).toEqual({
      preAllocatedVus: 4_999,
      maxVus: 9_998,
    });
    expect(resolveSteadyArrivalVus({ ratePerSecond: 5_000 })).toEqual({
      preAllocatedVus: 5_000,
      maxVus: 10_000,
    });
    expect(resolveSteadyArrivalVus({ ratePerSecond: 5_001 })).toEqual({
      preAllocatedVus: 5_001,
      maxVus: 10_000,
    });
    expect(resolveSteadyArrivalVus({ ratePerSecond: 12_000 })).toEqual({
      preAllocatedVus: 10_000,
      maxVus: 10_000,
    });
    expect(
      resolveSteadyArrivalVus({
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
        mode: "steady-arrival-rate",
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
        mode: "steady-arrival-rate",
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
        quantityPerCheckout: 1,
        reservationHoldMinutes: 15,
      },
      erpConfig: {
        latencyMs: 50,
        maxTps: 200,
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
    };

    expect(
      trafficExecutionStartRequestSchema.parse({
        runId,
        saleOfferId,
        apiBaseUrl: "http://localhost:4000",
        buyEndpointPath: "/buy",
        correlationId,
        configSnapshot,
      }).configSnapshot.trafficConfig.mode,
    ).toBe("buyer-spike");

    expect(
      trafficCompletionReportSchema.parse({
        runId,
        status: "succeeded",
        exitCode: 0,
        httpSummary: {
          plannedRequests: 400,
          emittedRequests: 400,
          completedRequests: 400,
          failedRequests: 0,
          acceptedResponses: 200,
          soldOutResponses: 200,
          unexpectedResponses: 0,
          p95LatencyMs: 42,
          failureRate: 0,
        },
        trafficOutcomeSummary: {},
        trafficDeliverySummary: {
          plannedRequests: 400,
          emittedRequests: 400,
          droppedIterations: 0,
          trafficDeliveryStatus: "complete",
          notes: [],
        },
        httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
        loadRunDiagnosticsSummary: runnerDiagnostics(),
        apiRequestLifecycleSummary: {},
        completedAt: timestamp,
        correlationId,
      }).httpSummary.acceptedResponses,
    ).toBe(200);
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
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
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
      emittedRequests: "summary_export" as const,
      completedRequests: "summary_export" as const,
      acceptedResponses: "summary_export" as const,
      soldOutResponses: "summary_export" as const,
      unexpectedResponses: "summary_export" as const,
      droppedIterations: "summary_export" as const,
      completedIterations: "summary_export" as const,
    },
    summaryExportWarnings: [],
  };
}

function semanticRuntimePolicy(): PublicRuntimePolicy {
  return {
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
      allowedTrafficModes: ["buyer-spike", "steady-arrival-rate"],
    },
    deploymentHardCaps: {
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
