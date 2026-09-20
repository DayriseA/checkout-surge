import type { AcceptedRunConfigSnapshot, InventoryStatus } from "@checkout-surge/contracts";
import type { demoRuns } from "@checkout-surge/db";
import { describe, expect, it } from "vitest";
import {
  emptyBusinessOutcomeSummary,
  toDemoRunSnapshot,
  toRedisTerminalInventorySnapshot,
} from "../src/services/demo-run-projections.js";

const configSnapshot: AcceptedRunConfigSnapshot = {
  trafficConfig: {
    mode: "buyer-spike",
    buyerCount: 10,
    startDelaySeconds: 0,
    duplicateEachBuyerAttempt: false,
    maxDurationSeconds: 1,
    quantityPerAttempt: 1,
  },
  inventoryConfig: { startingStock: 5, quantityPerCheckout: 1, reservationHoldMinutes: 5 },
  erpConfig: {
    latencyMs: 100,
    maxTps: 10,
    errorRate: 0,
    forcedOutage: false,
    requestTimeoutMs: 1_000,
  },
  backpressureConfig: {
    queueName: "orders:process",
    physicalQueueName: "orders-process",
    orderProcessConcurrency: 2,
    retryPolicy: { maxAttempts: 3, initialBackoffMs: 100 },
    drainTimeoutSeconds: 30,
    pendingPersistenceRetryAfterSeconds: 5,
    circuitBreakerFailureThreshold: 3,
    circuitBreakerResetTimeoutMs: 1_000,
  },
};

describe("demo-run projections", () => {
  it("maps the full durable run row through the canonical snapshot schema", () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      presetId: "22222222-2222-4222-8222-222222222222",
      presetName: "Scarcity spike",
      operatorMode: "admin",
      status: "failed",
      trafficStatus: "failed",
      configSnapshot,
      correlationId: null,
      saleOfferId: "33333333-3333-4333-8333-333333333333",
      startedAt: new Date("2026-07-21T10:00:00.000Z"),
      trafficStartedAt: new Date("2026-07-21T10:00:01.000Z"),
      trafficEndedAt: new Date("2026-07-21T10:00:02.000Z"),
      finalizedAt: new Date("2026-07-21T10:00:03.000Z"),
      adminResetCompletedAt: null,
      administrativeStop: null,
      failureReason: "traffic_failed",
      createdAt: new Date("2026-07-21T09:59:59.000Z"),
      updatedAt: new Date("2026-07-21T10:00:03.000Z"),
    } satisfies typeof demoRuns.$inferSelect;

    expect(toDemoRunSnapshot(row)).toEqual({
      runId: row.id,
      presetId: row.presetId,
      presetName: row.presetName,
      operatorMode: "admin",
      status: "failed",
      trafficStatus: "failed",
      saleOfferId: row.saleOfferId,
      configSnapshot,
      startedAt: "2026-07-21T10:00:00.000Z",
      trafficStartedAt: "2026-07-21T10:00:01.000Z",
      trafficEndedAt: "2026-07-21T10:00:02.000Z",
      finalizedAt: "2026-07-21T10:00:03.000Z",
      failureCategory: "traffic",
    });
  });

  it("projects live Redis inventory with its own sold-out evidence", () => {
    const inventory: InventoryStatus = {
      saleOfferId: "33333333-3333-4333-8333-333333333333",
      allocatedStock: 5,
      remainingStock: 1,
      reservedStock: 4,
      pendingPersistenceCount: 2,
      expiredReservationCount: 0,
      oldestPendingPersistenceAgeSeconds: 3,
      reservationThroughput: {
        windowSeconds: 60,
        successfulReservationCount: 4,
        peakRatePerSecond: 4,
        peakWindowSeconds: 1,
        unit: "reservations_per_second",
        measuredAt: "2026-07-21T10:00:02.000Z",
      },
      soldOutPressure: {
        rejectionCount: 7,
        latestObservedAt: "2026-07-21T10:00:02.000Z",
      },
      observedAt: "2026-07-21T10:00:03.000Z",
      lastUpdatedAt: "2026-07-21T10:00:02.000Z",
    };

    expect(
      toRedisTerminalInventorySnapshot({
        saleOfferId: inventory.saleOfferId,
        inventory,
        businessOutcome: { acceptedReservations: 4 },
        capturedAt: new Date("2026-07-21T10:00:03.000Z"),
      }),
    ).toEqual({
      saleOfferId: inventory.saleOfferId,
      startingStock: 5,
      remainingStock: 1,
      reservedStock: 4,
      acceptedReservations: 4,
      soldOutRejections: 7,
      pendingPersistenceCount: 2,
      capturedAt: "2026-07-21T10:00:03.000Z",
      source: "redis",
    });
  });

  it("builds the canonical zero-evidence business outcome", () => {
    expect(emptyBusinessOutcomeSummary()).toEqual({
      acceptedReservations: 0,
      reservedUnits: 0,
      soldOutRejections: 0,
      queuedOrders: 0,
      processingOrders: 0,
      retryingOrders: 0,
      confirmedOrders: 0,
      failedOrders: 0,
      businessRejectedOrders: 0,
      technicallyFailedOrders: 0,
      administrativelyDisposedOrders: 0,
      pendingPersistenceCount: 0,
      notificationsRecorded: 0,
    });
  });
});
