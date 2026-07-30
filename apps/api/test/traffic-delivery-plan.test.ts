import type { AcceptedRunConfigSnapshot } from "@checkout-surge/contracts";
import { emptyRequestArrivalSummary } from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import {
  syntheticFailedTrafficSummary,
  syntheticTrafficDeliverySummary,
} from "../src/services/traffic-delivery-plan.js";

const baseSnapshot = {
  trafficConfig: {
    mode: "constant-arrival-rate",
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
  it("uses the shared capped automatic constant-arrival VU resolution", () => {
    expect(syntheticTrafficDeliverySummary(baseSnapshot, ["not started"])).toMatchObject({
      preAllocatedVUs: 5_001,
      maxVUs: 10_000,
      notes: ["not started"],
    });
  });

  it("marks every planned attempt unstarted with a failed delivery status", () => {
    expect(syntheticTrafficDeliverySummary(baseSnapshot, [])).toMatchObject({
      trafficDeliveryStatus: "failed",
    });
  });

  it("builds one zero-attempt failed transport summary", () => {
    expect(syntheticFailedTrafficSummary(baseSnapshot, ["not started"])).toEqual({
      transportAttemptCounts: {
        plannedRequests: 10_002,
        startedRequests: 0,
        completedRequests: 0,
        interruptedRequests: 0,
        unstartedRequests: 10_002,
      },
      httpSummary: {
        failedRequests: 0,
        acceptedResponses: 0,
        soldOutResponses: 0,
        transportFailures: 0,
        unexpectedResponses: 0,
        failureRate: 0,
      },
      trafficDeliverySummary: {
        trafficMode: "constant-arrival-rate",
        plannedBuyers: null,
        scheduledRatePerSecond: 5_001,
        configuredDurationSeconds: 2,
        preAllocatedVUs: 5_001,
        maxVUs: 10_000,
        droppedIterations: 0,
        completedIterations: 0,
        requestArrivalSummary: emptyRequestArrivalSummary,
        trafficDeliveryStatus: "failed",
        notes: ["not started"],
      },
    });
  });

  it("preserves explicit constant-arrival VUs in synthetic diagnostics", () => {
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
