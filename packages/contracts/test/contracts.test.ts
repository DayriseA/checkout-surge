import { describe, expect, it } from "vitest";
import {
  acceptedRunConfigSnapshotSchema,
  adminDeleteRunHistoryRequestSchema,
  adminDeleteRunHistoryResponseSchema,
  adminDemoResetResponseSchema,
  adminPublicRuntimePolicyPath,
  adminPublicRuntimePolicyResponseSchema,
  adminPublicRuntimePolicyUpdateRequestSchema,
  buyRequestSchema,
  buyResponseSchema,
  controlServiceTokenHeaderName,
  dashboardEventSchema,
  dashboardEventsPath,
  dashboardEventsRedisChannel,
  dashboardRecoveryPath,
  dashboardRecoveryResponseSchema,
  demoRunOperatorModeHeaderName,
  demoRunSnapshotSchema,
  demoRunStatusValues,
  erpChaosResetPath,
  erpChaosStatusPath,
  erpConfirmationPath,
  erpConfirmationRequestSchema,
  erpConfirmationResponseSchema,
  erpResilienceStatusPath,
  erpResilienceStatusSchema,
  errorPayloadSchema,
  healthResponseSchema,
  internalLoadMetricIngestPath,
  internalTrafficCompletionPath,
  inventoryStatusSchema,
  inventoryUpdatedEventPayloadSchema,
  loadRunIdHeaderName,
  metricNameValues,
  orderProcessBullMqQueueName,
  orderProcessJobSchema,
  orderProcessQueueName,
  orderStatusValues,
  publicPresetListPath,
  publicRuntimePolicyMutableSchema,
  publicRuntimePolicyPath,
  publicRuntimePolicySchema,
  publicVisitorIdHeaderName,
  queueStatusSchema,
  reservationStatusValues,
  runHistoryDetailParamsSchema,
  runHistoryDetailPath,
  runHistoryDetailPathTemplate,
  runHistoryDetailResponseSchema,
  runHistoryListQuerySchema,
  runHistoryListResponseSchema,
  runHistoryPath,
  securedReservationHoldSchema,
  startDemoRunPath,
  startDemoRunRequestSchema,
  stockReservationDecisionSchema,
  trafficCompletionAcknowledgementSchema,
  trafficCompletionReportSchema,
  trafficDeliveryStatusValues,
  trafficExecutionStartPath,
  trafficExecutionStartRequestSchema,
  trafficExecutionStatusPath,
  trafficExecutionStatusResponseSchema,
  trafficExecutionStatusValues,
} from "../src/index.js";

const timestamp = "2026-06-20T12:00:00.000Z";
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
      httpTimingBreakdownSummary: {},
      loadRunDiagnosticsSummary: {},
      apiRequestLifecycleSummary: {},
      completedAt: timestamp,
      correlationId,
    });

    expect(report.status).toBe("succeeded");
    expect(() => demoRunSnapshotSchema.parse({ ...report, status: "completed" })).toThrow();
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
        simulatedStatus: "sold_out",
      }).outcome,
    ).toBe("quantity_invalid");
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

  it("validates dashboard recovery projections for the operator view", () => {
    const recovery = dashboardRecoveryResponseSchema.parse({
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
});

describe("public runtime policy contract", () => {
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
        httpTimingBreakdownSummary: {},
        loadRunDiagnosticsSummary: {},
        apiRequestLifecycleSummary: {},
        completedAt: timestamp,
        correlationId,
      }).httpSummary.acceptedResponses,
    ).toBe(200);
  });
});

function acceptedRunSnapshot() {
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
