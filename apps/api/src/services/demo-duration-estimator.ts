import {
  conservativeDurationEstimatorIdentity,
  type EstimatorBottleneck,
  type EstimatorInput,
  type EstimatorResult,
  erpDispatchEnginePolicyIdentity,
  estimatedDemoOccupancyCeilingSeconds,
  orderProcessConcurrencyHardCap,
} from "@checkout-surge/contracts";

/**
 * Provisional, chosen by task 15 from small measurements, frozen only by task 20.
 * These are estimator assumptions about engine policy v1, not worker settings.
 * They are neither worst-case bounds nor confidence intervals.
 */
export const conservativeDurationEstimatorConstants = {
  latencyOverheadFloorMs: 50,
  assumedInitialLaunchRatePerSec: 2,
  assumedRampPerSecondSquared: 0.1,
  assumedLaunchRateCeilingPerSec: 20,
  adaptationMargin: 2,
  transientErrorDemandMargin: 1.25,
  transientErrorCooldownSeconds: 5,
  settlementOverheadSeconds: 15,
  supportedMaximumErrorRate: 0.3,
} as const;

/** Worker startup enforces deployment concurrency >= the accepted per-run cap. */
export function effectiveEstimatorWorkerConcurrency(orderProcessConcurrency: number): number {
  return Math.min(orderProcessConcurrency, orderProcessConcurrencyHardCap);
}

/** Pure estimate of acceptance-to-settlement occupancy; inputs are already parsed. */
export function estimateDemoDuration(
  input: EstimatorInput,
  effectiveCeilingSeconds: number = estimatedDemoOccupancyCeilingSeconds,
): EstimatorResult {
  const constants = conservativeDurationEstimatorConstants;
  const base = {
    estimatorIdentity: conservativeDurationEstimatorIdentity,
    policyIdentity: erpDispatchEnginePolicyIdentity,
    effectiveCeilingSeconds,
    assumptions: [
      {
        code: "provisional_policy_v1",
        detail:
          "Task 15 small-measurement pacing, retry and settlement assumptions; frozen only by task 20. No confidence claim; constant declared conditions and one run are assumed.",
      },
      {
        code: "effective_concurrency",
        detail: `C is min(per-run concurrency, ${orderProcessConcurrencyHardCap}); worker startup requires deployment concurrency at least ${orderProcessConcurrencyHardCap}. Input C=${input.effectiveWorkerConcurrency}.`,
      },
      {
        code: "unique_acceptable_orders",
        detail:
          "All planned unique intents may arrive; duplicate buyer attempts share an idempotency key. Stock is divided by traffic quantityPerAttempt (the generated request quantity), not inventory quantityPerCheckout.",
      },
      {
        code: "transient_errors",
        detail:
          "p is a fraction in [0, 1]; independent errors use 1/(1-p), a demand margin and a scope cooldown per excess call. Finite chaos changes are not modeled.",
      },
    ],
  };
  // Support checks precede the zero-work shortcut, including for empty stock.
  if (
    input.declaredErpForcedOutage ||
    input.errorRateAssumption > constants.supportedMaximumErrorRate
  ) {
    return {
      ...base,
      decision: "rejected",
      bottleneck: "unestimable",
      unestimableReason: input.declaredErpForcedOutage
        ? "declared_permanent_outage"
        : "error_rate_above_policy_maximum",
      reasons: [
        input.declaredErpForcedOutage
          ? "Disable the declared permanent ERP outage to obtain a finite estimate."
          : "Lower the declared error rate to 30% or less to obtain a supported estimate.",
      ],
    };
  }

  const traffic = input.trafficConfig;
  const trafficBudget =
    traffic.mode === "buyer-spike" ? traffic.maxDurationSeconds : traffic.durationSeconds;
  const uniqueIntents =
    traffic.mode === "buyer-spike"
      ? traffic.buyerCount
      : traffic.ratePerSecond * traffic.durationSeconds;
  const orders = Math.min(
    uniqueIntents,
    Math.floor(input.inventoryConfig.startingStock / traffic.quantityPerAttempt),
  );
  const trafficOccupancy = traffic.startDelaySeconds + trafficBudget;
  const latencySeconds = (input.declaredErpLatencyMs + constants.latencyOverheadFloorMs) / 1000;
  const concurrencyRate = input.effectiveWorkerConcurrency / latencySeconds;
  const idealRate = Math.min(input.declaredErpCapacityPerSecond, concurrencyRate);
  const rate = Math.min(idealRate, constants.assumedLaunchRateCeilingPerSec);
  let erpSeconds = 0;
  if (orders > 0) {
    const demand =
      input.errorRateAssumption === 0
        ? orders
        : (orders / (1 - input.errorRateAssumption)) * constants.transientErrorDemandMargin;
    const initialRate = Math.min(constants.assumedInitialLaunchRatePerSec, rate);
    const ramp = constants.assumedRampPerSecondSquared;
    const rampSeconds = (rate - initialRate) / ramp;
    const rampDemand = initialRate * rampSeconds + (ramp * rampSeconds ** 2) / 2;
    const processingSeconds =
      demand <= rampDemand
        ? (Math.sqrt(initialRate ** 2 + 2 * ramp * demand) - initialRate) / ramp
        : rampSeconds + (demand - rampDemand) / rate;
    erpSeconds =
      processingSeconds * constants.adaptationMargin +
      (demand - orders) * constants.transientErrorCooldownSeconds;
  }
  // Ties favor traffic, then declared capacity, then pacing. For C/L, declared
  // latency >= 1 s attributes the constraint to latency, otherwise concurrency.
  const bottleneck: EstimatorBottleneck =
    trafficOccupancy >= erpSeconds
      ? "traffic_dispatch"
      : rate === input.declaredErpCapacityPerSecond
        ? "erp_capacity"
        : rate === constants.assumedLaunchRateCeilingPerSec
          ? "adaptive_pacing"
          : input.declaredErpLatencyMs >= 1000
            ? "erp_latency"
            : "worker_concurrency";
  const conservativeDurationSeconds =
    trafficOccupancy + erpSeconds + constants.settlementOverheadSeconds;
  const decision = conservativeDurationSeconds <= effectiveCeilingSeconds ? "admitted" : "rejected";
  const guidance = {
    traffic_dispatch: "Shorten the traffic duration or start delay.",
    erp_capacity: "Increase declared ERP capacity or reduce acceptable orders/stock.",
    adaptive_pacing:
      "Reduce acceptable orders/stock; higher declared capacity alone cannot remove the assumed pacing limit.",
    erp_latency: "Lower declared ERP latency or reduce acceptable orders/stock.",
    worker_concurrency:
      "Increase per-run concurrency up to 10, lower ERP latency, or reduce acceptable orders/stock.",
  };
  return {
    ...base,
    decision,
    bottleneck,
    explanatoryDurationSeconds:
      traffic.startDelaySeconds + Math.max(trafficBudget, orders === 0 ? 0 : orders / idealRate),
    conservativeDurationSeconds,
    reasons:
      decision === "admitted"
        ? []
        : [
            `${bottleneck}: ${guidance[bottleneck]}${input.errorRateAssumption > 0 ? " Lower the error rate to reduce retry demand and cooldown time." : ""}`,
          ],
  };
}
