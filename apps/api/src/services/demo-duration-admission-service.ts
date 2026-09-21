import {
  type AcceptedRunConfigSnapshot,
  type EstimatorInput,
  type EstimatorResult,
  estimateAdmissionRejectionDetailsSchema,
  type PublicRuntimePolicy,
} from "@checkout-surge/contracts";
import {
  effectiveEstimatorWorkerConcurrency,
  estimateDemoDuration,
} from "./demo-duration-estimator.js";
import { DemoRunValidationError } from "./demo-run-validation-error.js";

export function estimatorInputFromSnapshot(snapshot: AcceptedRunConfigSnapshot): EstimatorInput {
  return {
    trafficConfig: snapshot.trafficConfig,
    inventoryConfig: snapshot.inventoryConfig,
    effectiveWorkerConcurrency: effectiveEstimatorWorkerConcurrency(
      snapshot.backpressureConfig.orderProcessConcurrency,
    ),
    declaredErpCapacityPerSecond: snapshot.erpConfig.maxTps,
    declaredErpLatencyMs: snapshot.erpConfig.latencyMs,
    declaredErpForcedOutage: snapshot.erpConfig.forcedOutage,
    errorRateAssumption: snapshot.erpConfig.errorRate,
  };
}

export function estimateAcceptedDemoRun(
  snapshot: AcceptedRunConfigSnapshot,
  policy: PublicRuntimePolicy,
): EstimatorResult {
  return estimateDemoDuration(
    estimatorInputFromSnapshot(snapshot),
    policy.estimatedDemoOccupancyCeilingSeconds,
  );
}

export function requireEstimatedDurationAdmission(result: EstimatorResult): void {
  if (result.decision === "admitted") return;
  const { decision: _decision, explanatoryDurationSeconds: _explanatory, ...details } = result;
  throw new DemoRunValidationError(
    "estimated_duration_rejected",
    "The scenario cannot fit within the estimated demo occupancy ceiling.",
    estimateAdmissionRejectionDetailsSchema.parse({
      ...details,
      reason: result.unestimableReason ? "unestimable" : "over_ceiling",
    }),
  );
}
