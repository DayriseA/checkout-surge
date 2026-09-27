import {
  type EstimatorBottleneck,
  type EstimatorInput,
  type EstimatorResult,
  erpDispatchSafetyMargin,
  estimatedDemoOccupancyCeilingSeconds,
  orderProcessConcurrencyHardCap,
} from "@checkout-surge/contracts";

/**
 * Defaults measured on the reference host ("Docker 29.6.1-1 on Linux/WSL2,
 * 16 visible CPUs, 7,637 MiB RAM, one worker"); they are meant to be re-measured per
 * deployment and overridden through the API environment.
 * Estimator allowances include full durable job execution and settlement.
 * They are neither worst-case bounds nor confidence intervals.
 */
export const conservativeDurationEstimatorConstants = {
  // C: 177.78 ms at 50 ms ERP latency; surge: 231.71 ms at 150 ms.
  // 130 ms covers the larger observed per-job overhead (127.78 ms).
  latencyOverheadFloorMs: 130,
  transientErrorDemandMargin: 1.25,
  // Mock injected 503s send Retry-After: 1, honored by worker availability guidance.
  // With demand ×1.25, D estimates 68.618 s > 20.894 s measured (60 orders, ten 503s).
  perExcessAttemptPauseSeconds: 1,
  settlementOverheadSeconds: 15,
  supportedMaximumErrorRate: 0.3,
} as const;

/** Host-dependent allowances the deployment may override; the policy bound stays in code. */
export interface DurationEstimatorConstants {
  latencyOverheadFloorMs: number;
  settlementOverheadSeconds: number;
  transientErrorDemandMargin: number;
  perExcessAttemptPauseSeconds: number;
}

/** Worker startup enforces deployment concurrency >= the accepted per-run cap. */
export function effectiveEstimatorWorkerConcurrency(orderProcessConcurrency: number): number {
  return Math.min(orderProcessConcurrency, orderProcessConcurrencyHardCap);
}

/** Pure estimate of acceptance-to-settlement occupancy; inputs are already parsed. */
export function estimateDemoDuration(
  input: EstimatorInput,
  effectiveCeilingSeconds: number = estimatedDemoOccupancyCeilingSeconds,
  constants: DurationEstimatorConstants = conservativeDurationEstimatorConstants,
): EstimatorResult {
  const base = {
    effectiveCeilingSeconds,
    assumptions: [
      {
        code: "provisional_declared_capacity_v2",
        detail:
          "Job overhead, retry and settlement allowances are deployment-configured defaults applied with the shared dispatch safety margin. No confidence claim; constant declared conditions and one run are assumed.",
      },
      {
        code: "effective_concurrency",
        detail: `C is min(per-run concurrency, ${orderProcessConcurrencyHardCap}); worker startup requires deployment concurrency at least ${orderProcessConcurrencyHardCap}. Input C=${input.effectiveWorkerConcurrency}.`,
      },
      {
        code: "unique_acceptable_orders",
        detail:
          "All planned unique intents may arrive; duplicate buyer attempts share an idempotency key. Stock is divided by traffic quantityPerAttempt (the generated request quantity).",
      },
      {
        code: "transient_errors",
        detail:
          "p is a fraction in [0, 1]; independent errors use 1/(1-p), a demand margin and a Retry-After pause per excess attempt. Finite chaos changes are not modeled.",
      },
    ],
  };
  // Support checks precede the zero-work shortcut, including for empty stock.
  if (
    input.declaredErpForcedOutage ||
    input.errorRateAssumption > conservativeDurationEstimatorConstants.supportedMaximumErrorRate
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
  const dispatchRate = input.declaredErpCapacityPerSecond * (1 - erpDispatchSafetyMargin);
  const rate = Math.min(dispatchRate, concurrencyRate);
  let erpSeconds = 0;
  if (orders > 0) {
    const demand =
      input.errorRateAssumption === 0
        ? orders
        : (orders / (1 - input.errorRateAssumption)) * constants.transientErrorDemandMargin;
    erpSeconds = demand / rate + (demand - orders) * constants.perExcessAttemptPauseSeconds;
  }
  // Ties favor traffic, then declared capacity. For C/L, declared latency >= 1 s
  // attributes the constraint to latency, otherwise concurrency.
  const bottleneck: EstimatorBottleneck =
    trafficOccupancy >= erpSeconds
      ? "traffic_dispatch"
      : rate === dispatchRate
        ? "erp_capacity"
        : input.declaredErpLatencyMs >= 1000
          ? "erp_latency"
          : "worker_concurrency";
  const conservativeDurationSeconds =
    trafficOccupancy + erpSeconds + constants.settlementOverheadSeconds;
  const decision = conservativeDurationSeconds <= effectiveCeilingSeconds ? "admitted" : "rejected";
  const guidance = {
    traffic_dispatch: "Shorten the traffic duration or start delay.",
    erp_capacity: "Increase declared ERP capacity or reduce acceptable orders/stock.",
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
            `${bottleneck}: ${guidance[bottleneck]}${input.errorRateAssumption > 0 ? " Lower the error rate to reduce retry demand and pause time." : ""}`,
          ],
  };
}
