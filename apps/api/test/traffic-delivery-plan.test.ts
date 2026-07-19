import type { AcceptedRunConfigSnapshot } from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import { syntheticTrafficDeliverySummary } from "../src/services/traffic-delivery-plan.js";

const baseSnapshot = {
  trafficConfig: {
    mode: "steady-arrival-rate",
    ratePerSecond: 5_001,
    startDelaySeconds: 0,
    durationSeconds: 2,
    quantityPerAttempt: 1,
  },
  inventoryConfig: { startingStock: 1, quantityPerCheckout: 1, reservationHoldMinutes: 1 },
  erpConfig: {
    latencyMs: 0,
    maxTps: 1,
    errorRate: 0,
    forcedOutage: false,
    requestTimeoutMs: 1,
  },
  backpressureConfig: {
    queueName: "orders:process",
    physicalQueueName: "orders-process",
    orderProcessConcurrency: 1,
    retryPolicy: { maxAttempts: 1, initialBackoffMs: 0 },
    drainTimeoutSeconds: 1,
    pendingPersistenceRetryAfterSeconds: 1,
    circuitBreakerFailureThreshold: 1,
    circuitBreakerResetTimeoutMs: 1,
  },
} satisfies AcceptedRunConfigSnapshot;

describe("synthetic traffic delivery plan", () => {
  it("uses the shared capped automatic steady-arrival VU resolution", () => {
    expect(syntheticTrafficDeliverySummary(baseSnapshot, ["not started"])).toMatchObject({
      plannedRequests: 10_002,
      startedRequests: 0,
      completedRequests: 0,
      interruptedRequests: 0,
      unstartedRequests: 10_002,
      preAllocatedVUs: 5_001,
      maxVUs: 10_000,
      notes: ["not started"],
    });
  });

  it("marks every planned attempt unstarted with a failed delivery status", () => {
    expect(syntheticTrafficDeliverySummary(baseSnapshot, [])).toMatchObject({
      startedRequests: 0,
      completedRequests: 0,
      interruptedRequests: 0,
      unstartedRequests: 10_002,
      trafficDeliveryStatus: "failed",
    });
  });

  it("preserves explicit steady-arrival VUs in synthetic diagnostics", () => {
    const snapshot: AcceptedRunConfigSnapshot = {
      ...baseSnapshot,
      trafficConfig: {
        ...baseSnapshot.trafficConfig,
        k6Vus: { preAllocatedVus: 3_000, maxVus: 5_000 },
      },
    };

    expect(syntheticTrafficDeliverySummary(snapshot, [])).toMatchObject({
      preAllocatedVUs: 3_000,
      maxVUs: 5_000,
    });
  });
});
