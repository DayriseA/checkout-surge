import type { PublicRuntimePolicy, PublicRuntimePolicyMutable } from "./demo.js";
import type { OperatorMode } from "./lifecycle.js";
import {
  type AcceptedRunConfigSnapshot,
  deriveLoadExecutionPlan,
  type TrafficConfig,
} from "./load.js";

export const directSnapshotViolationCodes = [
  "deployment_buyers_exceeded",
  "deployment_duration_exceeded",
  "deployment_max_vus_exceeded",
  "deployment_preallocated_vus_exceeded",
  "deployment_request_rate_exceeded",
  "deployment_start_delay_exceeded",
  "deployment_total_requests_exceeded",
  "public_backpressure_override_not_allowed",
  "public_buyers_exceeded",
  "public_duration_exceeded",
  "public_erp_error_rate_exceeded",
  "public_erp_latency_exceeded",
  "public_erp_tps_exceeded",
  "public_forced_outage_not_allowed",
  "public_max_vus_exceeded",
  "public_preallocated_vus_exceeded",
  "public_request_rate_exceeded",
  "public_start_delay_exceeded",
  "public_starting_stock_exceeded",
  "public_total_requests_exceeded",
  "public_traffic_mode_not_allowed",
] as const;

const runtimePolicyDefinitionViolationCodes = [
  "public_erp_tps_limit_invalid",
  "public_limit_estimated_demo_occupancy_exceeds_deployment_cap",
  "public_limit_buyers_exceeds_deployment_cap",
  "public_limit_duration_exceeds_deployment_cap",
  "public_limit_max_vus_exceeds_deployment_cap",
  "public_limit_preallocated_vus_exceeds_deployment_cap",
  "public_limit_request_rate_exceeds_deployment_cap",
  "public_limit_start_delay_exceeds_deployment_cap",
  "public_limit_total_requests_exceeds_deployment_cap",
  "public_vus_limit_invalid",
] as const;

export type PublicRuntimePolicyViolationCode =
  | (typeof directSnapshotViolationCodes)[number]
  | (typeof runtimePolicyDefinitionViolationCodes)[number]
  | `public_custom_default_${(typeof directSnapshotViolationCodes)[number]}`;

export interface PublicRuntimePolicyViolation {
  code: PublicRuntimePolicyViolationCode;
  message: string;
  details?: Record<string, unknown>;
  path: (string | number)[];
}

export function calculatePlannedRequests(trafficConfig: TrafficConfig): number {
  return deriveLoadExecutionPlan(trafficConfig).plannedEmittedAttempts;
}

export function collectAcceptedRunConfigSnapshotViolations(
  snapshot: AcceptedRunConfigSnapshot,
  policy: PublicRuntimePolicy,
  options: { operatorMode: OperatorMode; enforcePublicCustomLimits: boolean },
): PublicRuntimePolicyViolation[] {
  const violations: PublicRuntimePolicyViolation[] = [];
  const traffic = snapshot.trafficConfig;
  const totalRequests = calculatePlannedRequests(traffic);
  const requestRate = resolveConfiguredRequestRate(traffic);
  const durationSeconds = calculateTrafficDurationSeconds(traffic);
  collectDeploymentSnapshotViolations(snapshot, policy, violations, {
    totalRequests,
    requestRate,
    durationSeconds,
  });

  if (options.operatorMode !== "public" || !options.enforcePublicCustomLimits) {
    return violations;
  }

  collectPublicProtectedConfigViolations(snapshot, policy.publicCustomDefaults, violations);
  collectPublicCustomSnapshotViolations(snapshot, policy, violations, {
    totalRequests,
    requestRate,
    durationSeconds,
  });
  return violations;
}

function collectPublicProtectedConfigViolations(
  snapshot: AcceptedRunConfigSnapshot,
  defaults: AcceptedRunConfigSnapshot,
  violations: PublicRuntimePolicyViolation[],
): void {
  const backpressure = snapshot.backpressureConfig;
  const defaultBackpressure = defaults.backpressureConfig;
  if (
    backpressure.queueName !== defaultBackpressure.queueName ||
    backpressure.physicalQueueName !== defaultBackpressure.physicalQueueName ||
    backpressure.orderProcessConcurrency !== defaultBackpressure.orderProcessConcurrency
  ) {
    violations.push({
      code: "public_backpressure_override_not_allowed",
      message: "Public custom backpressure configuration must match policy defaults.",
      path: ["backpressureConfig"],
    });
  }
}

export function collectPublicRuntimePolicyViolations(
  policy: PublicRuntimePolicy,
): PublicRuntimePolicyViolation[] {
  const violations: PublicRuntimePolicyViolation[] = [];
  collectPublicLimitCapViolations(policy, violations);
  collectLimitRelationshipViolations(policy, violations);
  collectEffectiveDefaultSnapshotViolations(policy, violations);
  return violations;
}

/**
 * Validates the policy semantics that are intrinsic to the persisted mutable
 * values and therefore do not depend on one deployment's environment caps.
 */
export function collectPublicRuntimePolicyMutableViolations(
  policy: PublicRuntimePolicyMutable,
): PublicRuntimePolicyViolation[] {
  const violations: PublicRuntimePolicyViolation[] = [];
  collectLimitRelationshipViolations(policy, violations);
  collectMutableDefaultSnapshotViolations(policy, violations);
  return violations;
}

function collectDeploymentSnapshotViolations(
  snapshot: AcceptedRunConfigSnapshot,
  policy: PublicRuntimePolicy,
  violations: PublicRuntimePolicyViolation[],
  trafficMetrics: { totalRequests: number; requestRate: number | null; durationSeconds: number },
): void {
  const traffic = snapshot.trafficConfig;
  const caps = policy.deploymentHardCaps;
  // Absent VUs are resolved by the API after this validation, within these caps.
  const k6Vus = traffic.mode === "constant-arrival-rate" ? traffic.k6Vus : undefined;

  addCapViolation(
    violations,
    trafficMetrics.totalRequests,
    caps.maxTotalRequests,
    "deployment_total_requests_exceeded",
    ["trafficConfig"],
  );
  if (trafficMetrics.requestRate !== null) {
    addCapViolation(
      violations,
      trafficMetrics.requestRate,
      caps.maxRequestsPerSecond,
      "deployment_request_rate_exceeded",
      ["trafficConfig", "ratePerSecond"],
    );
  }
  addCapViolation(
    violations,
    trafficMetrics.durationSeconds,
    caps.maxTrafficDurationSeconds,
    "deployment_duration_exceeded",
    durationPath(traffic),
  );
  addCapViolation(
    violations,
    traffic.startDelaySeconds,
    caps.maxTrafficStartDelaySeconds,
    "deployment_start_delay_exceeded",
    ["trafficConfig", "startDelaySeconds"],
  );

  if (traffic.mode === "buyer-spike") {
    addCapViolation(violations, traffic.buyerCount, caps.maxBuyers, "deployment_buyers_exceeded", [
      "trafficConfig",
      "buyerCount",
    ]);
  }
  if (k6Vus) {
    addCapViolation(
      violations,
      k6Vus.preAllocatedVus,
      caps.maxPreAllocatedVus,
      "deployment_preallocated_vus_exceeded",
      ["trafficConfig", "k6Vus", "preAllocatedVus"],
    );
    addCapViolation(violations, k6Vus.maxVus, caps.maxVus, "deployment_max_vus_exceeded", [
      "trafficConfig",
      "k6Vus",
      "maxVus",
    ]);
  }
}

function collectPublicLimitCapViolations(
  policy: PublicRuntimePolicy,
  violations: PublicRuntimePolicyViolation[],
): void {
  const caps = policy.deploymentHardCaps;
  const limits = policy.publicCustomLimits;

  addCapViolation(
    violations,
    policy.estimatedDemoOccupancyCeilingSeconds,
    caps.estimatedDemoOccupancyCeilingSeconds,
    "public_limit_estimated_demo_occupancy_exceeds_deployment_cap",
    ["estimatedDemoOccupancyCeilingSeconds"],
  );
  addCapViolation(
    violations,
    limits.maxTotalRequests,
    caps.maxTotalRequests,
    "public_limit_total_requests_exceeds_deployment_cap",
    ["publicCustomLimits", "maxTotalRequests"],
  );
  addCapViolation(
    violations,
    limits.maxRequestsPerSecond,
    caps.maxRequestsPerSecond,
    "public_limit_request_rate_exceeds_deployment_cap",
    ["publicCustomLimits", "maxRequestsPerSecond"],
  );
  addCapViolation(
    violations,
    limits.maxTrafficDurationSeconds,
    caps.maxTrafficDurationSeconds,
    "public_limit_duration_exceeds_deployment_cap",
    ["publicCustomLimits", "maxTrafficDurationSeconds"],
  );
  addCapViolation(
    violations,
    limits.maxTrafficStartDelaySeconds,
    caps.maxTrafficStartDelaySeconds,
    "public_limit_start_delay_exceeds_deployment_cap",
    ["publicCustomLimits", "maxTrafficStartDelaySeconds"],
  );
  addCapViolation(
    violations,
    limits.maxBuyers,
    caps.maxBuyers,
    "public_limit_buyers_exceeds_deployment_cap",
    ["publicCustomLimits", "maxBuyers"],
  );
  addCapViolation(
    violations,
    limits.maxPreAllocatedVus,
    caps.maxPreAllocatedVus,
    "public_limit_preallocated_vus_exceeds_deployment_cap",
    ["publicCustomLimits", "maxPreAllocatedVus"],
  );
  addCapViolation(
    violations,
    limits.maxVus,
    caps.maxVus,
    "public_limit_max_vus_exceeds_deployment_cap",
    ["publicCustomLimits", "maxVus"],
  );
}

function collectPublicCustomSnapshotViolations(
  snapshot: AcceptedRunConfigSnapshot,
  policy: Pick<PublicRuntimePolicyMutable, "publicCustomLimits">,
  violations: PublicRuntimePolicyViolation[],
  trafficMetrics: { totalRequests: number; requestRate: number | null; durationSeconds: number },
): void {
  const traffic = snapshot.trafficConfig;
  const limits = policy.publicCustomLimits;
  const k6Vus = traffic.mode === "constant-arrival-rate" ? traffic.k6Vus : undefined;

  if (!limits.allowedTrafficModes.includes(traffic.mode)) {
    violations.push({
      code: "public_traffic_mode_not_allowed",
      message: "Traffic mode is not allowed for public runs.",
      path: ["trafficConfig", "mode"],
    });
  }
  addCapViolation(
    violations,
    trafficMetrics.totalRequests,
    limits.maxTotalRequests,
    "public_total_requests_exceeded",
    ["trafficConfig"],
  );
  if (trafficMetrics.requestRate !== null) {
    addCapViolation(
      violations,
      trafficMetrics.requestRate,
      limits.maxRequestsPerSecond,
      "public_request_rate_exceeded",
      ["trafficConfig", "ratePerSecond"],
    );
  }
  addCapViolation(
    violations,
    trafficMetrics.durationSeconds,
    limits.maxTrafficDurationSeconds,
    "public_duration_exceeded",
    durationPath(traffic),
  );
  addCapViolation(
    violations,
    traffic.startDelaySeconds,
    limits.maxTrafficStartDelaySeconds,
    "public_start_delay_exceeded",
    ["trafficConfig", "startDelaySeconds"],
  );
  addCapViolation(
    violations,
    snapshot.inventoryConfig.startingStock,
    limits.maxStartingStock,
    "public_starting_stock_exceeded",
    ["inventoryConfig", "startingStock"],
  );
  addCapViolation(
    violations,
    snapshot.erpConfig.latencyMs,
    limits.maxErpLatencyMs,
    "public_erp_latency_exceeded",
    ["erpConfig", "latencyMs"],
  );

  collectPublicErpViolations(snapshot, policy, violations);
  if (traffic.mode === "buyer-spike") {
    addCapViolation(violations, traffic.buyerCount, limits.maxBuyers, "public_buyers_exceeded", [
      "trafficConfig",
      "buyerCount",
    ]);
  }
  if (k6Vus) {
    addCapViolation(
      violations,
      k6Vus.preAllocatedVus,
      limits.maxPreAllocatedVus,
      "public_preallocated_vus_exceeded",
      ["trafficConfig", "k6Vus", "preAllocatedVus"],
    );
    addCapViolation(violations, k6Vus.maxVus, limits.maxVus, "public_max_vus_exceeded", [
      "trafficConfig",
      "k6Vus",
      "maxVus",
    ]);
  }
}

function collectPublicErpViolations(
  snapshot: AcceptedRunConfigSnapshot,
  policy: Pick<PublicRuntimePolicyMutable, "publicCustomLimits">,
  violations: PublicRuntimePolicyViolation[],
): void {
  const limits = policy.publicCustomLimits;
  if (
    snapshot.erpConfig.maxTps < limits.minErpMaxTps ||
    snapshot.erpConfig.maxTps > limits.maxErpMaxTps
  ) {
    violations.push({
      code: "public_erp_tps_exceeded",
      message: "ERP TPS is outside public custom limits.",
      path: ["erpConfig", "maxTps"],
    });
  }
  if (snapshot.erpConfig.errorRate > limits.maxErpErrorRate) {
    violations.push({
      code: "public_erp_error_rate_exceeded",
      message: "ERP error rate exceeds public custom limits.",
      path: ["erpConfig", "errorRate"],
    });
  }
  if (snapshot.erpConfig.forcedOutage && !limits.allowForcedOutage) {
    violations.push({
      code: "public_forced_outage_not_allowed",
      message: "Forced outage is not allowed for public runs.",
      path: ["erpConfig", "forcedOutage"],
    });
  }
}

function collectLimitRelationshipViolations(
  policy: PublicRuntimePolicyMutable,
  violations: PublicRuntimePolicyViolation[],
): void {
  const limits = policy.publicCustomLimits;
  if (limits.minErpMaxTps > limits.maxErpMaxTps) {
    violations.push({
      code: "public_erp_tps_limit_invalid",
      message: "Public ERP TPS minimum cannot exceed the maximum.",
      details: { minErpMaxTps: limits.minErpMaxTps, maxErpMaxTps: limits.maxErpMaxTps },
      path: ["publicCustomLimits", "minErpMaxTps"],
    });
  }
  if (limits.maxPreAllocatedVus > limits.maxVus) {
    violations.push({
      code: "public_vus_limit_invalid",
      message: "Public preallocated VUs cannot exceed max VUs.",
      details: { maxPreAllocatedVus: limits.maxPreAllocatedVus, maxVus: limits.maxVus },
      path: ["publicCustomLimits", "maxPreAllocatedVus"],
    });
  }
}

function collectMutableDefaultSnapshotViolations(
  policy: PublicRuntimePolicyMutable,
  violations: PublicRuntimePolicyViolation[],
): void {
  const causes: PublicRuntimePolicyViolation[] = [];
  collectPublicCustomSnapshotViolations(
    policy.publicCustomDefaults,
    policy,
    causes,
    defaultSnapshotTrafficMetrics(policy),
  );
  appendWrappedDefaultViolations(causes, violations);
}

function collectEffectiveDefaultSnapshotViolations(
  policy: PublicRuntimePolicy,
  violations: PublicRuntimePolicyViolation[],
): void {
  const causes = collectAcceptedRunConfigSnapshotViolations(policy.publicCustomDefaults, policy, {
    operatorMode: "public",
    enforcePublicCustomLimits: true,
  });
  appendWrappedDefaultViolations(causes, violations);
}

function defaultSnapshotTrafficMetrics(policy: PublicRuntimePolicyMutable): {
  totalRequests: number;
  requestRate: number | null;
  durationSeconds: number;
} {
  const traffic = policy.publicCustomDefaults.trafficConfig;
  return {
    totalRequests: calculatePlannedRequests(traffic),
    requestRate: resolveConfiguredRequestRate(traffic),
    durationSeconds: calculateTrafficDurationSeconds(traffic),
  };
}

function appendWrappedDefaultViolations(
  causes: PublicRuntimePolicyViolation[],
  violations: PublicRuntimePolicyViolation[],
): void {
  for (const cause of causes) {
    violations.push({
      code: `public_custom_default_${cause.code}` as PublicRuntimePolicyViolationCode,
      message: "Public custom defaults must fit within the active public runtime policy.",
      ...(cause.details ? { details: cause.details } : {}),
      path: ["publicCustomDefaults", ...cause.path],
    });
  }
}

/**
 * Reports the configured arrival rate, or `null` for modes that have none.
 *
 * `buyer-spike` runs on k6's `per-vu-iterations` executor, which dispatches as
 * fast as the host allows. Its `maxDurationSeconds` is a dispatch cutoff, not
 * an arrival window, so no rate can be derived from it.
 */
function resolveConfiguredRequestRate(trafficConfig: TrafficConfig): number | null {
  return trafficConfig.mode === "constant-arrival-rate" ? trafficConfig.ratePerSecond : null;
}

function calculateTrafficDurationSeconds(trafficConfig: TrafficConfig): number {
  return trafficConfig.mode === "constant-arrival-rate"
    ? trafficConfig.durationSeconds
    : trafficConfig.maxDurationSeconds;
}

function durationPath(trafficConfig: TrafficConfig): string[] {
  return [
    "trafficConfig",
    trafficConfig.mode === "constant-arrival-rate" ? "durationSeconds" : "maxDurationSeconds",
  ];
}

function addCapViolation(
  violations: PublicRuntimePolicyViolation[],
  value: number,
  cap: number,
  code: PublicRuntimePolicyViolationCode,
  path: (string | number)[],
): void {
  if (value > cap) {
    violations.push({
      code,
      message: "Accepted run configuration exceeds a configured cap.",
      details: { value, cap },
      path,
    });
  }
}
