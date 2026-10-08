import {
  type CapacityAssessment,
  type CapacityVerdict,
  type EstimateAdmissionRejectionDetails,
  type EstimatorResult,
  estimateAdmissionRejectionDetailsSchema,
} from "@checkout-surge/contracts";

export function capacityFixture(
  verdict: CapacityVerdict = "expected_to_complete",
): CapacityAssessment {
  return {
    mode: "buyer-spike",
    verdict,
    buyerCount: 5_000,
    startingStock: 500,
    acceptedOrders: 500,
    timeToServeSeconds: { expected_to_complete: 12, at_the_limit: 27, expected_to_fail: 36 }[
      verdict
    ],
    windowSeconds: 30,
    ...(verdict === "expected_to_complete"
      ? {}
      : { fit: { buyerCount: 3_000, startingStock: 200, maxDurationSeconds: 45 } }),
  };
}

/** A preview response: the duration estimate and the capacity assessment. */
export function previewFixture(
  kind: Parameters<typeof estimateFixture>[0] = "allowed",
  verdict: CapacityVerdict = "expected_to_complete",
  automaticVus: number | null = null,
) {
  return { result: estimateFixture(kind), capacity: capacityFixture(verdict), automaticVus };
}

export function estimateFixture(
  kind: "allowed" | "over_ceiling" | "unestimable" = "allowed",
): EstimatorResult {
  const base = {
    assumptions: [],
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
