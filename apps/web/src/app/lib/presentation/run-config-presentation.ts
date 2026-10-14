import {
  type AcceptedRunConfigSnapshot,
  calculatePlannedRequests,
  type DemoPresetContract,
  type TrafficConfig,
} from "@checkout-surge/contracts";
import { getTranslation, type Locale } from "../i18n/translate";
import { formatCount, formatDurationMs } from "./format";
import { outcomeFocusLabel } from "./public-vocabulary";

export function plannedTotalAttempts(traffic: TrafficConfig): number {
  return calculatePlannedRequests(traffic);
}

export function deriveRunConfigFacts(config: AcceptedRunConfigSnapshot, locale: Locale = "en") {
  const t = getTranslation(locale);
  const traffic = config.trafficConfig;
  const uniqueAttempts =
    traffic.mode === "buyer-spike"
      ? traffic.buyerCount
      : traffic.ratePerSecond * traffic.durationSeconds;
  const plannedAttempts = plannedTotalAttempts(traffic);
  const hasDuplicateAttempts = traffic.mode === "buyer-spike" && traffic.duplicateEachBuyerAttempt;

  return {
    uniqueAttempts,
    plannedAttempts,
    surgeLabel: t(traffic.mode === "buyer-spike" ? "Buyers" : "Planned attempts"),
    surgeValue: formatCount(uniqueAttempts, locale) ?? t("not configured"),
    demandLabel: t(
      traffic.mode === "buyer-spike" ? "Buyers / planned attempts" : "Planned attempts",
    ),
    demandValue:
      traffic.mode === "buyer-spike"
        ? `${formatCount(traffic.buyerCount, locale)} / ${formatCount(plannedAttempts, locale)}`
        : (formatCount(plannedAttempts, locale) ?? t("not configured")),
    hasDuplicateAttempts,
    duplicateAttempts: t(
      hasDuplicateAttempts
        ? "Yes — every buyer sends the same request twice"
        : traffic.mode === "buyer-spike"
          ? "No — one request per buyer"
          : "No",
    ),
    erpDelay: formatDurationMs(config.erpConfig.latencyMs, locale) ?? t("not configured"),
    erpCapacity: t("{count} orders/s", {
      count: formatCount(config.erpConfig.maxTps, locale) ?? t("not configured"),
    }),
    startingStock: formatCount(config.inventoryConfig.startingStock, locale) ?? t("not configured"),
    workerBackpressure: t("{count} workers; excess work waits in the queue", {
      count:
        formatCount(config.backpressureConfig.orderProcessConcurrency, locale) ??
        t("not configured"),
    }),
  };
}

export function presetDistinguishingBehavior(
  preset: DemoPresetContract,
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  if (
    preset.trafficConfig.mode === "buyer-spike" &&
    preset.trafficConfig.duplicateEachBuyerAttempt
  ) {
    return t("Each buyer tries twice");
  }
  const focus = preset.display.outcomeFocus[0];
  return t(focus ? outcomeFocusLabel(focus) : preset.display.description);
}

export function presetOutcomeFocus(preset: DemoPresetContract, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return preset.display.outcomeFocus.map((focus) => t(outcomeFocusLabel(focus))).join(" · ");
}
