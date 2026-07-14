import type { PublicRuntimePolicy } from "./demo.js";
import type { ErrorPayloadCode } from "./error.js";
import type { OperatorMode } from "./lifecycle.js";
import {
  type AcceptedRunConfigSnapshot,
  resolveSteadyArrivalVus,
  type TrafficConfig,
} from "./load.js";

export interface PublicRuntimePolicyViolation {
  code: ErrorPayloadCode;
  message: string;
  details?: Record<string, unknown>;
  path: (string | number)[];
}

export function calculatePlannedRequests(trafficConfig: TrafficConfig): number {
  if (trafficConfig.mode === "buyer-spike") {
    return trafficConfig.buyerCount * (trafficConfig.duplicateEachBuyerAttempt ? 2 : 1);
  }

  return trafficConfig.ratePerSecond * trafficConfig.durationSeconds;
}

export function collectAcceptedRunConfigSnapshotViolations(
  snapshot: AcceptedRunConfigSnapshot,
  policy: PublicRuntimePolicy,
  options: { operatorMode: OperatorMode; enforcePublicCustomLimits: boolean },
): PublicRuntimePolicyViolation[] {
  const violations: PublicRuntimePolicyViolation[] = [];
  const traffic = snapshot.trafficConfig;
  const totalRequests = calculatePlannedRequests(traffic);
  const requestRate = calculateRequestRate(traffic);
  const durationSeconds = calculateTrafficDurationSeconds(traffic);
  collectDeploymentSnapshotViolations(snapshot, policy, violations, {
    totalRequests,
    requestRate,
    durationSeconds,
  });

  if (options.operatorMode !== "public" || !options.enforcePublicCustomLimits) {
    return violations;
  }

  collectPublicCustomSnapshotViolations(snapshot, policy, violations, {
    totalRequests,
    requestRate,
    durationSeconds,
  });
  return violations;
}

export function collectPublicRuntimePolicyViolations(
  policy: PublicRuntimePolicy,
): PublicRuntimePolicyViolation[] {
  const violations: PublicRuntimePolicyViolation[] = [];
  collectPublicLimitCapViolations(policy, violations);
  collectLimitRelationshipViolations(policy, violations);
  collectDefaultSnapshotViolations(policy, violations);
  return violations;
}

function collectDeploymentSnapshotViolations(
  snapshot: AcceptedRunConfigSnapshot,
  policy: PublicRuntimePolicy,
  violations: PublicRuntimePolicyViolation[],
  trafficMetrics: { totalRequests: number; requestRate: number; durationSeconds: number },
): void {
  const traffic = snapshot.trafficConfig;
  const caps = policy.deploymentHardCaps;
  const resolvedK6Vus =
    traffic.mode === "steady-arrival-rate" ? resolveSteadyArrivalVus(traffic) : undefined;

  addCapViolation(
    violations,
    trafficMetrics.totalRequests,
    caps.maxTotalRequests,
    "deployment_total_requests_exceeded",
    ["trafficConfig"],
  );
  addCapViolation(
    violations,
    trafficMetrics.requestRate,
    caps.maxRequestsPerSecond,
    "deployment_request_rate_exceeded",
    requestRatePath(traffic),
  );
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
  if (resolvedK6Vus) {
    addCapViolation(
      violations,
      resolvedK6Vus.preAllocatedVus,
      caps.maxPreAllocatedVus,
      "deployment_preallocated_vus_exceeded",
      ["trafficConfig", "k6Vus", "preAllocatedVus"],
    );
    addCapViolation(violations, resolvedK6Vus.maxVus, caps.maxVus, "deployment_max_vus_exceeded", [
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
  policy: PublicRuntimePolicy,
  violations: PublicRuntimePolicyViolation[],
  trafficMetrics: { totalRequests: number; requestRate: number; durationSeconds: number },
): void {
  const traffic = snapshot.trafficConfig;
  const limits = policy.publicCustomLimits;
  const k6Vus = traffic.mode === "steady-arrival-rate" ? traffic.k6Vus : undefined;

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
  addCapViolation(
    violations,
    trafficMetrics.requestRate,
    limits.maxRequestsPerSecond,
    "public_request_rate_exceeded",
    requestRatePath(traffic),
  );
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
  policy: PublicRuntimePolicy,
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
  policy: PublicRuntimePolicy,
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

function collectDefaultSnapshotViolations(
  policy: PublicRuntimePolicy,
  violations: PublicRuntimePolicyViolation[],
): void {
  const causes = collectAcceptedRunConfigSnapshotViolations(policy.publicCustomDefaults, policy, {
    operatorMode: "public",
    enforcePublicCustomLimits: true,
  });
  for (const cause of causes) {
    violations.push({
      code: `public_custom_default_${cause.code}` as ErrorPayloadCode,
      message: "Public custom defaults must fit within the active public runtime policy.",
      ...(cause.details ? { details: cause.details } : {}),
      path: ["publicCustomDefaults", ...cause.path],
    });
  }
}

function calculateRequestRate(trafficConfig: TrafficConfig): number {
  return trafficConfig.mode === "steady-arrival-rate"
    ? trafficConfig.ratePerSecond
    : Math.ceil(trafficConfig.buyerCount / Math.max(trafficConfig.maxDurationSeconds, 1));
}

function calculateTrafficDurationSeconds(trafficConfig: TrafficConfig): number {
  return trafficConfig.mode === "steady-arrival-rate"
    ? trafficConfig.durationSeconds
    : trafficConfig.maxDurationSeconds;
}

function requestRatePath(trafficConfig: TrafficConfig): string[] {
  return [
    "trafficConfig",
    trafficConfig.mode === "steady-arrival-rate" ? "ratePerSecond" : "buyerCount",
  ];
}

function durationPath(trafficConfig: TrafficConfig): string[] {
  return [
    "trafficConfig",
    trafficConfig.mode === "steady-arrival-rate" ? "durationSeconds" : "maxDurationSeconds",
  ];
}

function addCapViolation(
  violations: PublicRuntimePolicyViolation[],
  value: number,
  cap: number,
  code: ErrorPayloadCode,
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
