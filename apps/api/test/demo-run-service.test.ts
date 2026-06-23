import type { AcceptedRunConfigSnapshot, PublicRuntimePolicy } from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import {
  DemoRunValidationError,
  validateAcceptedRunSnapshot,
} from "../src/services/demo-run-service.js";

describe("demo-run service validation", () => {
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
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
    },
  };
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
  };
}
