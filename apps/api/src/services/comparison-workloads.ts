import {
  type AcceptedRunConfigSnapshot,
  acceptedRunConfigWriteSchema,
  type RunExecutionMode,
} from "@checkout-surge/contracts";

/** Task 02 candidates, awaiting calibration on the common hosted runtime before publication. */
export function comparisonWorkloads(): [
  { executionMode: RunExecutionMode; name: string; snapshot: AcceptedRunConfigSnapshot },
  { executionMode: RunExecutionMode; name: string; snapshot: AcceptedRunConfigSnapshot },
  { executionMode: RunExecutionMode; name: string; snapshot: AcceptedRunConfigSnapshot },
  { executionMode: RunExecutionMode; name: string; snapshot: AcceptedRunConfigSnapshot },
] {
  const redis = {
    trafficConfig: {
      mode: "constant-arrival-rate",
      ratePerSecond: 1000,
      startDelaySeconds: 0,
      durationSeconds: 10,
      quantityPerAttempt: 1,
      k6Vus: { preAllocatedVus: 10000, maxVus: 10000 },
    },
    inventoryConfig: { startingStock: 1 },
    erpConfig: { latencyMs: 0, maxTps: 1000, errorRate: 0, forcedOutage: false },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 5,
    },
  };
  const queue = {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 5000,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 80,
      quantityPerAttempt: 1,
    },
    inventoryConfig: { startingStock: 500 },
    erpConfig: { latencyMs: 100, maxTps: 20, errorRate: 0, forcedOutage: false },
    backpressureConfig: redis.backpressureConfig,
  };
  return [
    {
      executionMode: "demo",
      name: "Redis comparison: Redis",
      snapshot: acceptedRunConfigWriteSchema.parse(redis),
    },
    {
      executionMode: "without_redis",
      name: "Redis comparison: PostgreSQL",
      snapshot: acceptedRunConfigWriteSchema.parse(redis),
    },
    {
      executionMode: "demo",
      name: "Order queue comparison: queued ERP",
      snapshot: acceptedRunConfigWriteSchema.parse(queue),
    },
    {
      executionMode: "without_order_queue",
      name: "Order queue comparison: inline ERP",
      snapshot: acceptedRunConfigWriteSchema.parse(queue),
    },
  ];
}
