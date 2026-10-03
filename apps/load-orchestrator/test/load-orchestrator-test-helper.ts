import type { TrafficExecutionStartRequest } from "@checkout-surge/contracts";
import { processBootId } from "../src/application/traffic-execution-service.js";
import type { LoadOrchestratorConfig } from "../src/runtime/config.js";

export function trafficExecutionStartRequestFixture(): TrafficExecutionStartRequest {
  return {
    runId: "55555555-5555-4555-8555-555555555555",
    saleOfferId: "22222222-2222-4222-8222-222222222222",
    apiBaseUrl: "http://localhost:4000",
    expectedBootId: processBootId,
    correlationId: "corr-load-test",
    configSnapshot: {
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 200,
        duplicateEachBuyerAttempt: true,
        startDelaySeconds: 1,
        maxDurationSeconds: 5,
        quantityPerAttempt: 1,
      },
      inventoryConfig: {
        startingStock: 200,
      },
      erpConfig: {
        latencyMs: 50,
        maxTps: 200,
        errorRate: 0,
        forcedOutage: false,
      },
      backpressureConfig: {
        queueName: "orders:process",
        physicalQueueName: "orders-process",
        orderProcessConcurrency: 5,
      },
    },
  };
}

export function createLoadOrchestratorConfig(
  overrides: Partial<LoadOrchestratorConfig> = {},
): LoadOrchestratorConfig {
  return {
    runnerLifecycleEnabled: false,
    commitSha: "unknown",
    host: "127.0.0.1",
    port: 4200,
    apiBaseUrl: "http://localhost:4000",
    k6Binary: "k6",
    k6CancellationTimeoutMs: 10_000,
    completionDeliveryRetryIntervalMs: 5_000,
    controlServiceToken: "test-token",
    stateDirectory: "/tmp/checkout-surge-test-state",
    ...overrides,
  };
}

export async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Timed out waiting for ${description}.`);
}
