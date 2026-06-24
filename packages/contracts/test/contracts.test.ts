import { describe, expect, it } from "vitest";
import {
  adminDemoResetResponseSchema,
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
  publicRuntimePolicyPath,
  publicRuntimePolicySchema,
  publicVisitorIdHeaderName,
  queueStatusSchema,
  reservationStatusValues,
  runHistoryPath,
  securedReservationHoldSchema,
  startDemoRunPath,
  startDemoRunRequestSchema,
  stockReservationDecisionSchema,
  trafficCompletionReportSchema,
  trafficDeliveryStatusValues,
  trafficExecutionStartPath,
  trafficExecutionStartRequestSchema,
  trafficExecutionStatusValues,
} from "../src/index.js";

const timestamp = "2026-06-20T12:00:00.000Z";
const correlationId = "corr-test-1";
const saleOfferId = "22222222-2222-4222-8222-222222222222";
const runId = "55555555-5555-4555-8555-555555555555";

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
          drainTimeoutSeconds: 300,
          pendingPersistenceRetryAfterSeconds: 30,
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
        drainTimeoutSeconds: 300,
        pendingPersistenceRetryAfterSeconds: 30,
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
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
    },
  };
}
