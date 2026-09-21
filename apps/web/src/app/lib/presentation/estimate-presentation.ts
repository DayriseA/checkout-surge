import type {
  EstimateAdmissionRejectionDetails,
  EstimatorBottleneck,
  EstimatorResult,
  EstimatorUnestimableReason,
} from "@checkout-surge/contracts";

export const estimateBottleneckLabels = {
  traffic_dispatch: "Traffic dispatch",
  erp_capacity: "ERP capacity",
  worker_concurrency: "Concurrent order processing",
  erp_latency: "ERP response delay",
  adaptive_pacing: "Adaptive processing pace",
  declared_outage: "ERP availability",
  unestimable: "No supported estimate",
} satisfies Record<EstimatorBottleneck, string>;

export const estimateUnestimableLabels = {
  declared_permanent_outage: "ERP availability prevents a supported estimate.",
  error_rate_above_policy_maximum: "The error rate is too high for a supported estimate.",
  unsupported_scenario: "This scenario does not have a supported estimate.",
} satisfies Record<EstimatorUnestimableReason, string>;

export function estimateRejectionCopy(
  result: EstimatorResult | EstimateAdmissionRejectionDetails,
  mode: "public" | "admin",
): string[] {
  const reason = "unestimableReason" in result ? result.unestimableReason : undefined;
  const duration =
    "conservativeDurationSeconds" in result ? result.conservativeDurationSeconds : undefined;
  return [
    "Configuration not allowed.",
    ...(reason
      ? [
          mode === "admin" && reason === "declared_permanent_outage"
            ? "The declared permanent ERP outage prevents a finite estimate."
            : estimateUnestimableLabels[reason],
        ]
      : duration !== undefined
        ? [
            `Conservative duration: ${duration.toLocaleString("en-US", { maximumFractionDigits: 2 })} seconds.`,
          ]
        : []),
    `Demo limit: ${result.effectiveCeilingSeconds.toLocaleString("en-US", { maximumFractionDigits: 2 })} seconds.`,
    `Bottleneck: ${estimateBottleneckLabels[result.bottleneck]}.`,
    // Public visitors cannot change outage or internal policy settings.
    ...(mode === "public" && (reason || result.bottleneck === "declared_outage")
      ? [
          reason === "error_rate_above_policy_maximum"
            ? "Lower the error rate and try again."
            : "Choose another scenario or try again when the demo is available.",
        ]
      : (result.reasons ?? [])),
  ];
}
