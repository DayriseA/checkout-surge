import { describe, expect, it } from "vitest";
import {
  buyRequestSchema,
  buyResponseSchema,
  controlServiceTokenHeaderName,
  dashboardEventSchema,
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
  inventoryStatusSchema,
  inventoryUpdatedEventPayloadSchema,
  metricNameValues,
  orderProcessBullMqQueueName,
  orderProcessJobSchema,
  orderProcessQueueName,
  orderStatusValues,
  publicRuntimePolicySchema,
  queueStatusSchema,
  reservationStatusValues,
  securedReservationHoldSchema,
  stockReservationDecisionSchema,
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
  });

  it("exposes the documented dashboard metric names", () => {
    expect(metricNameValues).toContain("traffic.scheduled_request_rate");
    expect(metricNameValues).toContain("queue.depth");
    expect(metricNameValues).toContain("inventory.sold_out_rejection");
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
        correlationId,
        quantity: 1,
      }),
    ).toMatchObject({ publicOrderId: "ord_test", correlationId });

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
  });
});

describe("public runtime policy contract", () => {
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
          maxTps: 150,
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
});
