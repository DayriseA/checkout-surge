import type {
  AcceptedRunConfigSnapshot,
  DemoPresetContract,
  PublicRuntimePolicy,
  PublicRuntimePolicyMutable,
} from "@checkout-surge/contracts";

export type TrafficMode = DemoPresetContract["trafficConfig"]["mode"];
export type RunConfigBase = Pick<
  AcceptedRunConfigSnapshot,
  "trafficConfig" | "inventoryConfig" | "erpConfig" | "backpressureConfig"
>;

export interface RunConfigDraft {
  mode: TrafficMode;
  buyerCount: string;
  duplicateEachBuyerAttempt: boolean;
  maxDurationSeconds: string;
  ratePerSecond: string;
  durationSeconds: string;
  startDelaySeconds: string;
  preAllocatedVus: string;
  maxVus: string;
  startingStock: string;
  quantityPerCheckout: string;
  reservationHoldMinutes: string;
  erpLatencyMs: string;
  erpMaxTps: string;
  erpErrorRate: string;
  erpForcedOutage: boolean;
  erpRequestTimeoutMs: string;
  orderProcessConcurrency: string;
  drainTimeoutSeconds: string;
  pendingPersistenceRetryAfterSeconds: string;
  circuitBreakerFailureThreshold: string;
  circuitBreakerResetTimeoutMs: string;
}

export interface PresetDraft extends RunConfigDraft {
  displayName: string;
  description: string;
  sortOrder: string;
}

export interface RuntimePolicyDraft extends RunConfigDraft {
  isPublicRunBudgetEnforced: boolean;
  budgetWindowSeconds: string;
  perVisitorMaxStarts: string;
  globalMaxStarts: string;
  maxTotalRequests: string;
  maxBuyers: string;
  maxRequestsPerSecond: string;
  maxTrafficDurationSeconds: string;
  maxTrafficStartDelaySeconds: string;
  maxPreAllocatedVus: string;
  maxPublicVus: string;
  maxStartingStock: string;
  maxErpLatencyMs: string;
  minErpMaxTps: string;
  maxErpMaxTps: string;
  maxErpErrorRate: string;
  allowForcedOutage: boolean;
  allowBuyerSpike: boolean;
  allowConstantArrivalRate: boolean;
}

export function draftFromPreset(preset: DemoPresetContract): PresetDraft {
  return {
    displayName: preset.display.name,
    description: preset.display.description,
    sortOrder: String(preset.display.sortOrder),
    ...draftFromConfigSnapshot(preset),
  };
}

export function draftFromRuntimePolicy(policy: PublicRuntimePolicy): RuntimePolicyDraft {
  return {
    isPublicRunBudgetEnforced: policy.isPublicRunBudgetEnforced,
    budgetWindowSeconds: String(policy.publicRunBudget.windowSeconds),
    perVisitorMaxStarts: String(policy.publicRunBudget.perVisitorMaxStarts),
    globalMaxStarts: String(policy.publicRunBudget.globalMaxStarts),
    ...draftFromConfigSnapshot(policy.publicCustomDefaults),
    maxTotalRequests: String(policy.publicCustomLimits.maxTotalRequests),
    maxBuyers: String(policy.publicCustomLimits.maxBuyers),
    maxRequestsPerSecond: String(policy.publicCustomLimits.maxRequestsPerSecond),
    maxTrafficDurationSeconds: String(policy.publicCustomLimits.maxTrafficDurationSeconds),
    maxTrafficStartDelaySeconds: String(policy.publicCustomLimits.maxTrafficStartDelaySeconds),
    maxPreAllocatedVus: String(policy.publicCustomLimits.maxPreAllocatedVus),
    maxPublicVus: String(policy.publicCustomLimits.maxVus),
    maxStartingStock: String(policy.publicCustomLimits.maxStartingStock),
    maxErpLatencyMs: String(policy.publicCustomLimits.maxErpLatencyMs),
    minErpMaxTps: String(policy.publicCustomLimits.minErpMaxTps),
    maxErpMaxTps: String(policy.publicCustomLimits.maxErpMaxTps),
    maxErpErrorRate: String(policy.publicCustomLimits.maxErpErrorRate),
    allowForcedOutage: policy.publicCustomLimits.allowForcedOutage,
    allowBuyerSpike: policy.publicCustomLimits.allowedTrafficModes.includes("buyer-spike"),
    allowConstantArrivalRate:
      policy.publicCustomLimits.allowedTrafficModes.includes("constant-arrival-rate"),
  };
}

export function draftFromConfigSnapshot(config: RunConfigBase): RunConfigDraft {
  const traffic = config.trafficConfig;
  const constantArrivalVus = traffic.mode === "constant-arrival-rate" ? traffic.k6Vus : undefined;
  return {
    mode: traffic.mode,
    buyerCount: traffic.mode === "buyer-spike" ? String(traffic.buyerCount) : "1000",
    duplicateEachBuyerAttempt:
      traffic.mode === "buyer-spike" ? traffic.duplicateEachBuyerAttempt : false,
    maxDurationSeconds: traffic.mode === "buyer-spike" ? String(traffic.maxDurationSeconds) : "10",
    ratePerSecond: traffic.mode === "constant-arrival-rate" ? String(traffic.ratePerSecond) : "50",
    durationSeconds:
      traffic.mode === "constant-arrival-rate" ? String(traffic.durationSeconds) : "10",
    startDelaySeconds: String(traffic.startDelaySeconds),
    preAllocatedVus: String(constantArrivalVus?.preAllocatedVus ?? 10),
    maxVus: String(constantArrivalVus?.maxVus ?? 50),
    startingStock: String(config.inventoryConfig.startingStock),
    quantityPerCheckout: String(config.inventoryConfig.quantityPerCheckout),
    reservationHoldMinutes: String(config.inventoryConfig.reservationHoldMinutes),
    erpLatencyMs: String(config.erpConfig.latencyMs),
    erpMaxTps: String(config.erpConfig.maxTps),
    erpErrorRate: String(config.erpConfig.errorRate),
    erpForcedOutage: config.erpConfig.forcedOutage,
    erpRequestTimeoutMs: String(config.erpConfig.requestTimeoutMs),
    orderProcessConcurrency: String(config.backpressureConfig.orderProcessConcurrency),
    drainTimeoutSeconds: String(config.backpressureConfig.drainTimeoutSeconds),
    pendingPersistenceRetryAfterSeconds: String(
      config.backpressureConfig.pendingPersistenceRetryAfterSeconds,
    ),
    circuitBreakerFailureThreshold: String(
      config.backpressureConfig.circuitBreakerFailureThreshold,
    ),
    circuitBreakerResetTimeoutMs: String(config.backpressureConfig.circuitBreakerResetTimeoutMs),
  };
}

export function policyFromDraft(
  draft: RuntimePolicyDraft,
  currentPolicy: PublicRuntimePolicy,
): PublicRuntimePolicyMutable {
  return {
    isPublicRunBudgetEnforced: draft.isPublicRunBudgetEnforced,
    publicRunBudget: {
      windowSeconds: parseInteger(draft.budgetWindowSeconds, 1),
      perVisitorMaxStarts: parseInteger(draft.perVisitorMaxStarts, 1),
      globalMaxStarts: parseInteger(draft.globalMaxStarts, 1),
    },
    publicCustomDefaults: configFromDraft(draft, currentPolicy.publicCustomDefaults),
    publicCustomLimits: {
      maxTotalRequests: parseInteger(draft.maxTotalRequests, 1),
      maxBuyers: parseInteger(draft.maxBuyers, 1),
      maxRequestsPerSecond: parseInteger(draft.maxRequestsPerSecond, 1),
      maxTrafficDurationSeconds: parseInteger(draft.maxTrafficDurationSeconds, 1),
      maxTrafficStartDelaySeconds: parseInteger(draft.maxTrafficStartDelaySeconds, 0),
      maxPreAllocatedVus: parseInteger(draft.maxPreAllocatedVus, 1),
      maxVus: parseInteger(draft.maxPublicVus, 1),
      maxStartingStock: parseInteger(draft.maxStartingStock, 1),
      maxErpLatencyMs: parseInteger(draft.maxErpLatencyMs, 0),
      minErpMaxTps: parseInteger(draft.minErpMaxTps, 1),
      maxErpMaxTps: parseInteger(draft.maxErpMaxTps, 1),
      maxErpErrorRate: parseNumber(draft.maxErpErrorRate, 0),
      allowForcedOutage: draft.allowForcedOutage,
      allowedTrafficModes: [
        ...(draft.allowBuyerSpike ? (["buyer-spike"] as const) : []),
        ...(draft.allowConstantArrivalRate ? (["constant-arrival-rate"] as const) : []),
      ],
    },
  };
}

export function configFromDraft(
  draft: RunConfigDraft,
  base: RunConfigBase,
): AcceptedRunConfigSnapshot {
  return {
    trafficConfig:
      draft.mode === "buyer-spike"
        ? {
            mode: "buyer-spike",
            buyerCount: parseInteger(draft.buyerCount, 1),
            duplicateEachBuyerAttempt: draft.duplicateEachBuyerAttempt,
            startDelaySeconds: parseInteger(draft.startDelaySeconds, 0),
            maxDurationSeconds: parseInteger(draft.maxDurationSeconds, 1),
            quantityPerAttempt: base.trafficConfig.quantityPerAttempt,
          }
        : {
            mode: "constant-arrival-rate",
            ratePerSecond: parseInteger(draft.ratePerSecond, 1),
            startDelaySeconds: parseInteger(draft.startDelaySeconds, 0),
            durationSeconds: parseInteger(draft.durationSeconds, 1),
            quantityPerAttempt: base.trafficConfig.quantityPerAttempt,
            k6Vus: {
              preAllocatedVus: parseInteger(draft.preAllocatedVus, 1),
              maxVus: parseInteger(draft.maxVus, 1),
            },
          },
    inventoryConfig: {
      startingStock: parseInteger(draft.startingStock, 0),
      quantityPerCheckout: parseInteger(draft.quantityPerCheckout, 1),
      reservationHoldMinutes: parseInteger(draft.reservationHoldMinutes, 1),
    },
    erpConfig: {
      latencyMs: parseInteger(draft.erpLatencyMs, 0),
      maxTps: parseInteger(draft.erpMaxTps, 1),
      errorRate: parseNumber(draft.erpErrorRate, 0),
      forcedOutage: draft.erpForcedOutage,
      requestTimeoutMs: parseInteger(draft.erpRequestTimeoutMs, 1),
    },
    backpressureConfig: {
      ...base.backpressureConfig,
      orderProcessConcurrency: parseInteger(draft.orderProcessConcurrency, 1),
      drainTimeoutSeconds: parseInteger(draft.drainTimeoutSeconds, 1),
      pendingPersistenceRetryAfterSeconds: parseInteger(
        draft.pendingPersistenceRetryAfterSeconds,
        1,
      ),
      circuitBreakerFailureThreshold: parseInteger(draft.circuitBreakerFailureThreshold, 1),
      circuitBreakerResetTimeoutMs: parseInteger(draft.circuitBreakerResetTimeoutMs, 1),
    },
  };
}

export function parseInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export function parseNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
