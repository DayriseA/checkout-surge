import type {
  AcceptedRunConfigSnapshot,
  DeploymentHardCaps,
  PublicRuntimePolicyMutable,
} from "@checkout-surge/contracts";

export const deploymentHardCapsFixture: DeploymentHardCaps = {
  estimatedDemoOccupancyCeilingSeconds: 600,
  maxBuyers: 100_000,
  maxTotalRequests: 100_000,
  maxRequestsPerSecond: 10_000,
  maxTrafficDurationSeconds: 300,
  maxTrafficStartDelaySeconds: 30,
  maxPreAllocatedVus: 10_000,
  maxVus: 10_000,
};

export function acceptedRunConfigSnapshotFixture(): AcceptedRunConfigSnapshot {
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
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 10,
      pendingPersistenceRetryAfterSeconds: 30,
    },
  };
}

export function publicRuntimePolicyMutableFixture(): PublicRuntimePolicyMutable {
  return {
    estimatedDemoOccupancyCeilingSeconds: 600,
    isPublicRunBudgetEnforced: true,
    publicRunBudget: {
      windowSeconds: 300,
      perVisitorMaxStarts: 2,
      globalMaxStarts: 6,
    },
    publicCustomDefaults: {
      ...acceptedRunConfigSnapshotFixture(),
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 500,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 10,
        quantityPerAttempt: 1,
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
      maxErpMaxTps: 300,
      maxErpErrorRate: 0.25,
      allowForcedOutage: false,
      allowedTrafficModes: ["buyer-spike", "constant-arrival-rate"],
    },
  };
}
