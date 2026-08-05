import type {
  AcceptedRunConfigSnapshot,
  DemoPresetContract,
  DeploymentHardCaps,
  ErpChaosConfig,
  ErpChaosSafetyCaps,
  PublicRuntimePolicy,
  PublicRuntimePolicyMutable,
} from "@checkout-surge/contracts";
import {
  acceptedRunConfigSnapshotSchema,
  collectAcceptedRunConfigSnapshotViolations,
  collectPublicRuntimePolicyMutableViolations,
  demoPresetDisplaySchema,
  erpChaosConfigSchema,
  publicRuntimePolicyMutableSchema,
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

export type AdminDraftField = keyof RuntimePolicyDraft | keyof PresetDraft | keyof ErpChaosConfig;
export type DraftErrorCode =
  | "required"
  | "not_a_number"
  | "not_an_integer"
  | "below_min"
  | "above_max"
  | "server_rejected";
export interface DraftFieldError {
  code: DraftErrorCode;
  message: string;
}
export interface DraftFormError {
  message: string;
  fields: string[];
}
export interface DraftValidationResult<T> {
  values?: T;
  fieldErrors: Record<string, DraftFieldError>;
  formErrors: DraftFormError[];
}

interface NumericRule {
  field: string;
  label: string;
  min?: number;
  max?: number;
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

export function buildPolicyFromDraft(
  draft: RuntimePolicyDraft,
  currentPolicy: PublicRuntimePolicy,
): DraftValidationResult<PublicRuntimePolicyMutable> {
  const rules: NumericRule[] = [
    ...runConfigRules(draft.mode, currentPolicy.deploymentHardCaps),
    rule("budgetWindowSeconds", "Budget window"),
    rule("perVisitorMaxStarts", "Per-visitor starts"),
    rule("globalMaxStarts", "Global starts"),
    rule(
      "maxTotalRequests",
      "Maximum total requests",
      undefined,
      currentPolicy.deploymentHardCaps.maxTotalRequests,
    ),
    rule("maxBuyers", "Maximum buyers", undefined, currentPolicy.deploymentHardCaps.maxBuyers),
    rule(
      "maxRequestsPerSecond",
      "Maximum requests per second",
      undefined,
      currentPolicy.deploymentHardCaps.maxRequestsPerSecond,
    ),
    rule(
      "maxTrafficDurationSeconds",
      "Maximum traffic duration",
      undefined,
      currentPolicy.deploymentHardCaps.maxTrafficDurationSeconds,
    ),
    rule(
      "maxTrafficStartDelaySeconds",
      "Maximum start delay",
      undefined,
      currentPolicy.deploymentHardCaps.maxTrafficStartDelaySeconds,
    ),
    rule(
      "maxPreAllocatedVus",
      "Maximum preallocated VUs",
      undefined,
      currentPolicy.deploymentHardCaps.maxPreAllocatedVus,
    ),
    rule("maxPublicVus", "Maximum VUs", undefined, currentPolicy.deploymentHardCaps.maxVus),
    rule("maxStartingStock", "Maximum starting stock"),
    rule("maxErpLatencyMs", "Maximum ERP latency"),
    rule("minErpMaxTps", "Minimum ERP TPS"),
    rule("maxErpMaxTps", "Maximum ERP TPS"),
    rule("maxErpErrorRate", "Maximum ERP error rate"),
  ];
  const parsed = parseNumericDraft(draft, rules);
  if (!parsed.values) return { fieldErrors: parsed.fieldErrors, formErrors: parsed.formErrors };
  const number = parsed.values;
  const configResult = buildConfigFromParsed(draft, currentPolicy.publicCustomDefaults, number);
  const policy: PublicRuntimePolicyMutable = {
    isPublicRunBudgetEnforced: draft.isPublicRunBudgetEnforced,
    publicRunBudget: {
      windowSeconds: requiredNumber(number, "budgetWindowSeconds"),
      perVisitorMaxStarts: requiredNumber(number, "perVisitorMaxStarts"),
      globalMaxStarts: requiredNumber(number, "globalMaxStarts"),
    },
    publicCustomDefaults: configResult,
    publicCustomLimits: {
      maxTotalRequests: requiredNumber(number, "maxTotalRequests"),
      maxBuyers: requiredNumber(number, "maxBuyers"),
      maxRequestsPerSecond: requiredNumber(number, "maxRequestsPerSecond"),
      maxTrafficDurationSeconds: requiredNumber(number, "maxTrafficDurationSeconds"),
      maxTrafficStartDelaySeconds: requiredNumber(number, "maxTrafficStartDelaySeconds"),
      maxPreAllocatedVus: requiredNumber(number, "maxPreAllocatedVus"),
      maxVus: requiredNumber(number, "maxPublicVus"),
      maxStartingStock: requiredNumber(number, "maxStartingStock"),
      maxErpLatencyMs: requiredNumber(number, "maxErpLatencyMs"),
      minErpMaxTps: requiredNumber(number, "minErpMaxTps"),
      maxErpMaxTps: requiredNumber(number, "maxErpMaxTps"),
      maxErpErrorRate: requiredNumber(number, "maxErpErrorRate"),
      allowForcedOutage: draft.allowForcedOutage,
      allowedTrafficModes: [
        ...(draft.allowBuyerSpike ? (["buyer-spike"] as const) : []),
        ...(draft.allowConstantArrivalRate ? (["constant-arrival-rate"] as const) : []),
      ],
    },
  };
  const policyParse = publicRuntimePolicyMutableSchema.safeParse(policy);
  const contractErrors = policyParse.success
    ? emptyDraftErrors()
    : contractDraftErrors(policyParse.error.issues, rules, policyDraftField);
  const fieldErrors = {
    ...dynamicBoundErrors(number, rules),
    ...contractErrors.fieldErrors,
  };
  const formErrors: DraftFormError[] = collectPublicRuntimePolicyMutableViolations(policy).map(
    (violation) => ({
      message: policyViolationMessage(violation.code),
      fields: policyViolationFields(violation.code, violation.path, draft.mode),
    }),
  );
  if (!draft.allowBuyerSpike && !draft.allowConstantArrivalRate) {
    formErrors.push({
      message: "Allow at least one public traffic mode.",
      fields: ["allowBuyerSpike", "allowConstantArrivalRate"],
    });
  }
  if (
    configResult.trafficConfig.mode === "constant-arrival-rate" &&
    configResult.trafficConfig.k6Vus &&
    configResult.trafficConfig.k6Vus.maxVus < configResult.trafficConfig.k6Vus.preAllocatedVus
  ) {
    formErrors.push({
      message: "Maximum VUs must be greater than or equal to preallocated VUs.",
      fields: ["preAllocatedVus", "maxVus"],
    });
  }
  formErrors.push(...contractErrors.formErrors);
  return Object.keys(fieldErrors).length === 0 && formErrors.length === 0
    ? { values: policy, fieldErrors: {}, formErrors: [] }
    : { fieldErrors, formErrors };
}

export function buildConfigFromDraft(
  draft: RunConfigDraft,
  base: RunConfigBase,
  policy?: PublicRuntimePolicy,
): DraftValidationResult<AcceptedRunConfigSnapshot> {
  const rules = runConfigRules(draft.mode, policy?.deploymentHardCaps);
  const parsed = parseNumericDraft(draft, rules);
  if (!parsed.values) return { fieldErrors: parsed.fieldErrors, formErrors: parsed.formErrors };
  const values = buildConfigFromParsed(draft, base, parsed.values);
  const configParse = acceptedRunConfigSnapshotSchema.safeParse(values);
  const contractErrors = configParse.success
    ? emptyDraftErrors()
    : contractDraftErrors(configParse.error.issues, rules, configDraftField);
  const fieldErrors = {
    ...dynamicBoundErrors(parsed.values, rules),
    ...contractErrors.fieldErrors,
  };
  const formErrors: DraftFormError[] =
    draft.mode === "constant-arrival-rate" &&
    values.trafficConfig.mode === "constant-arrival-rate" &&
    values.trafficConfig.k6Vus &&
    values.trafficConfig.k6Vus.maxVus < values.trafficConfig.k6Vus.preAllocatedVus
      ? [
          {
            message: "Maximum VUs must be greater than or equal to preallocated VUs.",
            fields: ["preAllocatedVus", "maxVus"],
          },
        ]
      : [];
  if (policy) {
    for (const violation of collectAcceptedRunConfigSnapshotViolations(values, policy, {
      operatorMode: "admin",
      enforcePublicCustomLimits: false,
    })) {
      if (violation.code !== "deployment_total_requests_exceeded") continue;
      const computedTotal = violation.details?.value;
      const permittedMaximum = violation.details?.cap;
      formErrors.push({
        message:
          typeof computedTotal === "number" && typeof permittedMaximum === "number"
            ? `This configuration creates ${computedTotal} requests; the permitted maximum is ${permittedMaximum} requests.`
            : `Total requests exceed the permitted maximum of ${policy.deploymentHardCaps.maxTotalRequests} requests.`,
        fields:
          draft.mode === "buyer-spike"
            ? ["buyerCount", "duplicateEachBuyerAttempt"]
            : ["ratePerSecond", "durationSeconds"],
      });
    }
  }
  formErrors.push(...contractErrors.formErrors);
  return Object.keys(fieldErrors).length === 0 && formErrors.length === 0
    ? { values, fieldErrors: {}, formErrors: [] }
    : { fieldErrors, formErrors };
}

export function buildErpChaosFromDraft(
  draft: { latencyMs: string; maxTps: string; errorRate: string; forcedOutage: boolean },
  caps: ErpChaosSafetyCaps,
): DraftValidationResult<ErpChaosConfig> {
  const rules = [
    rule("latencyMs", "Latency", undefined, caps.maxLatencyMs),
    rule("maxTps", "Maximum TPS", caps.minMaxTps),
    rule("errorRate", "Error rate", undefined, caps.maxErrorRate),
  ];
  const parsed = parseNumericDraft(draft, rules);
  if (!parsed.values) return { fieldErrors: parsed.fieldErrors, formErrors: parsed.formErrors };
  const values = {
    latencyMs: requiredNumber(parsed.values, "latencyMs"),
    maxTps: requiredNumber(parsed.values, "maxTps"),
    errorRate: requiredNumber(parsed.values, "errorRate"),
    forcedOutage: draft.forcedOutage,
  };
  const chaosParse = erpChaosConfigSchema.safeParse(values);
  const contractErrors = chaosParse.success
    ? emptyDraftErrors()
    : contractDraftErrors(chaosParse.error.issues, rules, directDraftField);
  const fieldErrors = {
    ...dynamicBoundErrors(parsed.values, rules),
    ...contractErrors.fieldErrors,
  };
  if (Object.keys(fieldErrors).length > 0 || contractErrors.formErrors.length > 0) {
    return { fieldErrors, formErrors: contractErrors.formErrors };
  }
  if (draft.forcedOutage && !caps.allowForcedOutage) {
    return {
      fieldErrors: {},
      formErrors: [
        {
          message: "Forced outage is disabled by the effective safety caps.",
          fields: ["forcedOutage"],
        },
      ],
    };
  }
  return {
    values,
    fieldErrors: {},
    formErrors: [],
  };
}

export function buildSortOrder(value: string): DraftValidationResult<number> {
  const rules = [rule("sortOrder", "Sort order")];
  const parsed = parseNumericDraft({ sortOrder: value }, rules);
  if (!parsed.values) return { fieldErrors: parsed.fieldErrors, formErrors: parsed.formErrors };
  const sortOrder = requiredNumber(parsed.values, "sortOrder");
  const displayParse = demoPresetDisplaySchema.safeParse({
    name: "Draft",
    description: "Draft",
    sortOrder,
    outcomeFocus: [],
  });
  const contractErrors = displayParse.success
    ? emptyDraftErrors()
    : contractDraftErrors(displayParse.error.issues, rules, directDraftField);
  return Object.keys(contractErrors.fieldErrors).length === 0 &&
    contractErrors.formErrors.length === 0
    ? { values: sortOrder, fieldErrors: {}, formErrors: [] }
    : contractErrors;
}

function buildConfigFromParsed(
  draft: RunConfigDraft,
  base: RunConfigBase,
  number: Record<string, number>,
): AcceptedRunConfigSnapshot {
  return {
    trafficConfig:
      draft.mode === "buyer-spike"
        ? {
            mode: "buyer-spike",
            buyerCount: requiredNumber(number, "buyerCount"),
            duplicateEachBuyerAttempt: draft.duplicateEachBuyerAttempt,
            startDelaySeconds: requiredNumber(number, "startDelaySeconds"),
            maxDurationSeconds: requiredNumber(number, "maxDurationSeconds"),
            quantityPerAttempt: base.trafficConfig.quantityPerAttempt,
          }
        : {
            mode: "constant-arrival-rate",
            ratePerSecond: requiredNumber(number, "ratePerSecond"),
            startDelaySeconds: requiredNumber(number, "startDelaySeconds"),
            durationSeconds: requiredNumber(number, "durationSeconds"),
            quantityPerAttempt: base.trafficConfig.quantityPerAttempt,
            k6Vus: {
              preAllocatedVus: requiredNumber(number, "preAllocatedVus"),
              maxVus: requiredNumber(number, "maxVus"),
            },
          },
    inventoryConfig: {
      startingStock: requiredNumber(number, "startingStock"),
      quantityPerCheckout: requiredNumber(number, "quantityPerCheckout"),
      reservationHoldMinutes: requiredNumber(number, "reservationHoldMinutes"),
    },
    erpConfig: {
      latencyMs: requiredNumber(number, "erpLatencyMs"),
      maxTps: requiredNumber(number, "erpMaxTps"),
      errorRate: requiredNumber(number, "erpErrorRate"),
      forcedOutage: draft.erpForcedOutage,
      requestTimeoutMs: requiredNumber(number, "erpRequestTimeoutMs"),
    },
    backpressureConfig: {
      ...base.backpressureConfig,
      orderProcessConcurrency: requiredNumber(number, "orderProcessConcurrency"),
      drainTimeoutSeconds: requiredNumber(number, "drainTimeoutSeconds"),
      pendingPersistenceRetryAfterSeconds: requiredNumber(
        number,
        "pendingPersistenceRetryAfterSeconds",
      ),
      circuitBreakerFailureThreshold: requiredNumber(number, "circuitBreakerFailureThreshold"),
      circuitBreakerResetTimeoutMs: requiredNumber(number, "circuitBreakerResetTimeoutMs"),
    },
  };
}

function parseNumericDraft(
  draft: object,
  rules: NumericRule[],
): DraftValidationResult<Record<string, number>> {
  const values: Record<string, number> = {};
  const fieldErrors: Record<string, DraftFieldError> = {};
  for (const numericRule of rules) {
    const raw = String((draft as Record<string, unknown>)[numericRule.field] ?? "");
    const trimmed = raw.trim();
    if (trimmed === "") {
      fieldErrors[numericRule.field] = {
        code: "required",
        message: `${numericRule.label} is required.`,
      };
      continue;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      fieldErrors[numericRule.field] = {
        code: "not_a_number",
        message: `${numericRule.label} must be a finite number.`,
      };
    } else {
      values[numericRule.field] = parsed;
    }
  }
  return Object.keys(fieldErrors).length === 0
    ? { values, fieldErrors, formErrors: [] }
    : { fieldErrors, formErrors: [] };
}

interface ContractIssue {
  code: string;
  path: readonly PropertyKey[];
  minimum?: unknown;
  maximum?: unknown;
}

type DraftErrors = Pick<DraftValidationResult<unknown>, "fieldErrors" | "formErrors">;

function emptyDraftErrors(): DraftErrors {
  return { fieldErrors: {}, formErrors: [] };
}

function contractDraftErrors(
  issues: readonly ContractIssue[],
  rules: NumericRule[],
  fieldFromPath: (path: readonly PropertyKey[]) => string | undefined,
): DraftErrors {
  const labels = new Map(rules.map(({ field, label }) => [field, label]));
  const fieldErrors: Record<string, DraftFieldError> = {};
  let hasUnexpectedIssue = false;
  for (const issue of issues) {
    const field = fieldFromPath(issue.path);
    const label = field ? labels.get(field) : undefined;
    const error = label ? contractIssueError(issue, label) : undefined;
    if (field && error) {
      if (!fieldErrors[field] || error.code === "not_an_integer") fieldErrors[field] = error;
    } else if (!isHandledRelationshipIssue(issue)) {
      hasUnexpectedIssue = true;
    }
  }
  return {
    fieldErrors,
    formErrors: hasUnexpectedIssue
      ? [{ message: "Review the configuration values and try again.", fields: [] }]
      : [],
  };
}

function contractIssueError(issue: ContractIssue, label: string): DraftFieldError | undefined {
  if (issue.code === "invalid_type") {
    return { code: "not_an_integer", message: `${label} must be a whole number.` };
  }
  if (issue.code === "too_small" && typeof issue.minimum === "number") {
    return {
      code: "below_min",
      message: `${label} must be at least ${issue.minimum}.`,
    };
  }
  if (issue.code === "too_big" && typeof issue.maximum === "number") {
    return {
      code: "above_max",
      message: `${label} must be at most ${issue.maximum}.`,
    };
  }
  return undefined;
}

function isHandledRelationshipIssue(issue: ContractIssue): boolean {
  const field = String(issue.path.at(-1) ?? "");
  return (
    (issue.code === "custom" && field === "maxVus" && issue.path.includes("k6Vus")) ||
    field === "allowedTrafficModes"
  );
}

function dynamicBoundErrors(
  values: Record<string, number>,
  rules: NumericRule[],
): Record<string, DraftFieldError> {
  const errors: Record<string, DraftFieldError> = {};
  for (const { field, label, min, max } of rules) {
    const value = values[field];
    if (value === undefined) continue;
    if (min !== undefined && value < min) {
      errors[field] = { code: "below_min", message: `${label} must be at least ${min}.` };
    } else if (max !== undefined && value > max) {
      errors[field] = { code: "above_max", message: `${label} must be at most ${max}.` };
    }
  }
  return errors;
}

function directDraftField(path: readonly PropertyKey[]): string | undefined {
  const field = path.at(-1);
  return typeof field === "string" ? field : undefined;
}

function configDraftField(path: readonly PropertyKey[]): string | undefined {
  const field = directDraftField(path);
  if (!field) return undefined;
  if (!path.includes("erpConfig")) return field;
  return field === "latencyMs"
    ? "erpLatencyMs"
    : field === "maxTps"
      ? "erpMaxTps"
      : field === "errorRate"
        ? "erpErrorRate"
        : field === "requestTimeoutMs"
          ? "erpRequestTimeoutMs"
          : field;
}

function policyDraftField(path: readonly PropertyKey[]): string | undefined {
  const field = directDraftField(path);
  if (!field) return undefined;
  if (path.includes("publicCustomDefaults")) return configDraftField(path);
  if (path.includes("publicRunBudget")) {
    return field === "windowSeconds" ? "budgetWindowSeconds" : field;
  }
  if (path.includes("publicCustomLimits") && field === "maxVus") return "maxPublicVus";
  return field;
}

function requiredNumber(values: Record<string, number>, field: string): number {
  const value = values[field];
  if (value === undefined) throw new Error(`Validated numeric field ${field} is missing.`);
  return value;
}

function rule(field: string, label: string, min?: number, max?: number): NumericRule {
  return {
    field,
    label,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
}

function runConfigRules(mode: TrafficMode, hardCaps?: DeploymentHardCaps): NumericRule[] {
  return [
    ...(mode === "buyer-spike"
      ? [
          rule("buyerCount", "Buyer count", undefined, hardCaps?.maxBuyers),
          rule(
            "maxDurationSeconds",
            "Maximum duration",
            undefined,
            hardCaps?.maxTrafficDurationSeconds,
          ),
        ]
      : [
          rule("ratePerSecond", "Requests per second", undefined, hardCaps?.maxRequestsPerSecond),
          rule("durationSeconds", "Duration", undefined, hardCaps?.maxTrafficDurationSeconds),
          rule("preAllocatedVus", "Preallocated VUs", undefined, hardCaps?.maxPreAllocatedVus),
          rule("maxVus", "Maximum VUs", undefined, hardCaps?.maxVus),
        ]),
    rule("startDelaySeconds", "Start delay", undefined, hardCaps?.maxTrafficStartDelaySeconds),
    rule("startingStock", "Starting stock"),
    rule("quantityPerCheckout", "Quantity per checkout"),
    rule("reservationHoldMinutes", "Reservation hold"),
    rule("erpLatencyMs", "ERP latency"),
    rule("erpMaxTps", "ERP maximum TPS"),
    rule("erpErrorRate", "ERP error rate"),
    rule("erpRequestTimeoutMs", "ERP timeout"),
    rule("orderProcessConcurrency", "Worker concurrency"),
    rule("drainTimeoutSeconds", "Drain timeout"),
    rule("pendingPersistenceRetryAfterSeconds", "Persistence retry"),
    rule("circuitBreakerFailureThreshold", "Circuit failure threshold"),
    rule("circuitBreakerResetTimeoutMs", "Circuit reset timeout"),
  ];
}

function policyViolationFields(
  code: string,
  path: (string | number)[],
  mode: TrafficMode,
): string[] {
  const cause = code.replace(/^public_custom_default_/, "");
  switch (cause) {
    case "public_vus_limit_invalid":
      return ["maxPreAllocatedVus", "maxPublicVus"];
    case "public_erp_tps_limit_invalid":
      return ["minErpMaxTps", "maxErpMaxTps"];
    case "public_buyers_exceeded":
      return ["buyerCount", "maxBuyers"];
    case "public_total_requests_exceeded":
      return mode === "buyer-spike"
        ? ["buyerCount", "duplicateEachBuyerAttempt", "maxTotalRequests"]
        : ["ratePerSecond", "durationSeconds", "maxTotalRequests"];
    case "public_request_rate_exceeded":
      return ["ratePerSecond", "maxRequestsPerSecond"];
    case "public_duration_exceeded":
      return [
        mode === "buyer-spike" ? "maxDurationSeconds" : "durationSeconds",
        "maxTrafficDurationSeconds",
      ];
    case "public_start_delay_exceeded":
      return ["startDelaySeconds", "maxTrafficStartDelaySeconds"];
    case "public_starting_stock_exceeded":
      return ["startingStock", "maxStartingStock"];
    case "public_erp_latency_exceeded":
      return ["erpLatencyMs", "maxErpLatencyMs"];
    case "public_erp_tps_exceeded":
      return ["erpMaxTps", "minErpMaxTps", "maxErpMaxTps"];
    case "public_erp_error_rate_exceeded":
      return ["erpErrorRate", "maxErpErrorRate"];
    case "public_forced_outage_not_allowed":
      return ["erpForcedOutage", "allowForcedOutage"];
    case "public_preallocated_vus_exceeded":
      return ["preAllocatedVus", "maxPreAllocatedVus"];
    case "public_max_vus_exceeded":
      return ["maxVus", "maxPublicVus"];
    case "public_traffic_mode_not_allowed":
      return ["mode", mode === "buyer-spike" ? "allowBuyerSpike" : "allowConstantArrivalRate"];
    default: {
      const field = String(path.at(-1) ?? "");
      return /^[A-Za-z][A-Za-z0-9]*$/.test(field) ? [field] : [];
    }
  }
}

function policyViolationMessage(code: string): string {
  if (code === "public_vus_limit_invalid") {
    return "Maximum preallocated VUs cannot exceed maximum VUs.";
  }
  if (code === "public_erp_tps_limit_invalid") {
    return "Minimum ERP TPS cannot exceed maximum ERP TPS.";
  }
  return "Public custom defaults must fit within the active public limits and deployment caps.";
}
