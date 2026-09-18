import {
  type AcceptedRunConfigSnapshot,
  calculatePlannedRequests,
  type DemoPresetContract,
  type TrafficConfig,
} from "@checkout-surge/contracts";
import { formatCount, formatDurationMs } from "./format";
import { outcomeFocusLabel } from "./public-vocabulary";

export function plannedTotalAttempts(traffic: TrafficConfig): number {
  return calculatePlannedRequests(traffic);
}

export function deriveRunConfigFacts(config: AcceptedRunConfigSnapshot) {
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
    surgeLabel: traffic.mode === "buyer-spike" ? "Buyers" : "Planned attempts",
    surgeValue: formatCount(uniqueAttempts) ?? "not configured",
    demandLabel: traffic.mode === "buyer-spike" ? "Buyers / planned attempts" : "Planned attempts",
    demandValue:
      traffic.mode === "buyer-spike"
        ? `${formatCount(traffic.buyerCount)} / ${formatCount(plannedAttempts)}`
        : (formatCount(plannedAttempts) ?? "not configured"),
    hasDuplicateAttempts,
    duplicateAttempts: hasDuplicateAttempts
      ? "Yes — every buyer sends the same request twice"
      : traffic.mode === "buyer-spike"
        ? "No — one request per buyer"
        : "No",
    erpDelay: formatDurationMs(config.erpConfig.latencyMs) ?? "not configured",
    erpCapacity: `${formatCount(config.erpConfig.maxTps) ?? "not configured"} orders/s`,
    startingStock: formatCount(config.inventoryConfig.startingStock) ?? "not configured",
    workerBackpressure: `${formatCount(config.backpressureConfig.orderProcessConcurrency) ?? "not configured"} workers; excess work waits in the queue`,
  };
}

export function presetDistinguishingBehavior(preset: DemoPresetContract): string {
  if (
    preset.trafficConfig.mode === "buyer-spike" &&
    preset.trafficConfig.duplicateEachBuyerAttempt
  ) {
    return "Each buyer tries twice";
  }
  const focus = preset.display.outcomeFocus[0];
  return focus ? outcomeFocusLabel(focus) : preset.display.description;
}

export function presetOutcomeFocus(preset: DemoPresetContract): string {
  return preset.display.outcomeFocus.map(outcomeFocusLabel).join(" · ");
}
