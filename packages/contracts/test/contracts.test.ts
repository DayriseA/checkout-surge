import { describe, expect, it } from "vitest";
import {
  buyRequestSchema,
  buyResponseSchema,
  dashboardEventSchema,
  demoRunStatusValues,
  errorPayloadSchema,
  healthResponseSchema,
  inventoryStatusSchema,
  inventoryUpdatedEventPayloadSchema,
  metricNameValues,
  orderStatusValues,
  publicRuntimePolicySchema,
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
