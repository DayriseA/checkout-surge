import {
  type EstimateAdmissionRejectionDetails,
  type EstimatorResult,
  estimateAdmissionRejectionDetailsSchema,
} from "@checkout-surge/contracts";

export function estimateFixture(
  kind: "allowed" | "over_ceiling" | "unestimable" = "allowed",
): EstimatorResult {
  const base = {
    assumptions: [],
    estimatorIdentity: { name: "conservative-duration-estimator", version: 1 },
    policyIdentity: { name: "adaptive-erp-admission", version: 1 },
    effectiveCeilingSeconds: 600,
  };
  return kind === "unestimable"
    ? {
        ...base,
        decision: "rejected",
        bottleneck: "unestimable",
        unestimableReason: "declared_permanent_outage",
        reasons: ["Disable the declared permanent ERP outage to obtain a finite estimate."],
      }
    : {
        ...base,
        decision: kind === "allowed" ? "admitted" : "rejected",
        bottleneck: "erp_capacity",
        explanatoryDurationSeconds: 100,
        conservativeDurationSeconds: kind === "allowed" ? 600 : 600.001,
        reasons:
          kind === "allowed"
            ? []
            : ["Increase declared ERP capacity or reduce acceptable orders/stock."],
      };
}

export function estimateRejectionFixture(
  kind: "over_ceiling" | "unestimable",
): EstimateAdmissionRejectionDetails {
  const {
    decision: _decision,
    explanatoryDurationSeconds: _duration,
    ...details
  } = estimateFixture(kind);
  return estimateAdmissionRejectionDetailsSchema.parse({ ...details, reason: kind });
}
