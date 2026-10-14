import type {
  EstimateAdmissionRejectionDetails,
  EstimatorBottleneck,
  EstimatorResult,
  EstimatorUnestimableReason,
} from "@checkout-surge/contracts";
import { getTranslation, type Locale } from "../i18n/translate";

export const estimateBottleneckLabels = {
  traffic_dispatch: "Traffic dispatch",
  erp_capacity: "ERP capacity",
  worker_concurrency: "Concurrent order processing",
  erp_latency: "ERP response delay",
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
  locale: Locale = "en",
): string[] {
  const t = getTranslation(locale);
  const reason = "unestimableReason" in result ? result.unestimableReason : undefined;
  const duration =
    "conservativeDurationSeconds" in result ? result.conservativeDurationSeconds : undefined;
  return [
    t("Configuration not allowed."),
    ...(reason
      ? [
          mode === "admin" && reason === "declared_permanent_outage"
            ? t("The declared permanent ERP outage prevents a finite estimate.")
            : t(estimateUnestimableLabels[reason]),
        ]
      : duration !== undefined
        ? [
            t("Conservative duration: {v0} seconds.", {
              v0: String(
                duration.toLocaleString(locale === "fr" ? "fr-FR" : "en-US", {
                  maximumFractionDigits: 2,
                }),
              ),
            }),
          ]
        : []),
    t("Demo limit: {v0} seconds.", {
      v0: String(
        result.effectiveCeilingSeconds.toLocaleString(locale === "fr" ? "fr-FR" : "en-US", {
          maximumFractionDigits: 2,
        }),
      ),
    }),
    t("Bottleneck: {v0}.", { v0: String(t(estimateBottleneckLabels[result.bottleneck])) }),
    // Public visitors cannot change outage or internal policy settings.
    ...(mode === "public" && (reason || result.bottleneck === "declared_outage")
      ? [
          reason === "error_rate_above_policy_maximum"
            ? t("Lower the error rate and try again.")
            : t("Choose another scenario or try again when the demo is available."),
        ]
      : (result.reasons ?? []).map((reason) => t(reason))),
  ];
}
