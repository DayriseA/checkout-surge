export type CustomErrorGroup = "traffic" | "stock" | "erp" | "advanced" | "form";

export interface InvalidCustomRunControl {
  controlId: string;
  message: string;
}

export interface CustomRunSummaryEntry {
  fieldError?: string;
  fieldId?: string;
  group: CustomErrorGroup;
  key: string;
  message: string;
  targetId: string;
}

export interface CustomFormError {
  group: CustomErrorGroup;
  message: string;
  targetId: string;
}

const fields = {
  "custom-buyers": { group: "traffic", label: "Buyer count" },
  "custom-rate": { group: "traffic", label: "Arrival rate" },
  "custom-duration": { group: "traffic", label: "Traffic duration" },
  "custom-stock": { group: "stock", label: "Starting stock" },
  "custom-erp-delay": { group: "erp", label: "Delay per order" },
  "custom-erp-capacity": { group: "erp", label: "Capacity" },
  "custom-erp-error-rate": { group: "erp", label: "Failure rate" },
  "custom-safety-cutoff": { group: "advanced", label: "Safety cutoff" },
  "custom-start-delay": { group: "advanced", label: "Start delay" },
} as const satisfies Record<string, { group: CustomErrorGroup; label: string }>;

const pathToFieldId = {
  "trafficConfig.buyerCount": "custom-buyers",
  "trafficConfig.ratePerSecond": "custom-rate",
  "trafficConfig.durationSeconds": "custom-duration",
  "trafficConfig.maxDurationSeconds": "custom-safety-cutoff",
  "trafficConfig.startDelaySeconds": "custom-start-delay",
  "inventoryConfig.startingStock": "custom-stock",
  "erpConfig.latencyMs": "custom-erp-delay",
  "erpConfig.maxTps": "custom-erp-capacity",
  "erpConfig.errorRate": "custom-erp-error-rate",
} as const satisfies Record<string, keyof typeof fields>;

const groupErrors: Record<CustomErrorGroup, CustomFormError> = {
  traffic: {
    group: "traffic",
    message: "Review the Buyers settings and keep the traffic within the available limits.",
    targetId: "custom-traffic-validation-error",
  },
  stock: {
    group: "stock",
    message: "Review the Stock settings and keep values within the available limits.",
    targetId: "custom-stock-validation-error",
  },
  erp: {
    group: "erp",
    message: "Review the Slow ERP settings and keep values within the available limits.",
    targetId: "custom-erp-validation-error",
  },
  advanced: {
    group: "advanced",
    message: "Review the Advanced protection settings and keep values within supported limits.",
    targetId: "custom-advanced-validation-error",
  },
  form: {
    group: "form",
    message: "Review the custom run settings and try again.",
    targetId: "custom-form-error",
  },
};

export function presentInvalidCustomRunControls(
  controls: readonly InvalidCustomRunControl[],
): CustomRunSummaryEntry[] {
  return controls.flatMap(({ controlId, message }) => {
    const field = fields[controlId as keyof typeof fields];
    return field
      ? [
          {
            fieldId: controlId,
            fieldError: message,
            group: field.group,
            key: controlId,
            message: `${field.label}: ${message}`,
            targetId: controlId,
          },
        ]
      : [];
  });
}

export function presentCustomRunIssues(
  paths: ReadonlyArray<readonly unknown[]>,
): CustomRunSummaryEntry[] {
  const entries = paths.map((path) => {
    const fieldId = fieldIdForPath(path);
    if (fieldId) {
      const field = fields[fieldId];
      const fieldError = `Use an available value for ${field.label}.`;
      return {
        fieldId,
        fieldError,
        group: field.group,
        key: fieldId,
        message: `${field.label}: ${fieldError}`,
        targetId: fieldId,
      };
    }

    const error = customValidationError([path]);
    return {
      group: error.group,
      key: error.targetId,
      message: error.message,
      targetId: error.targetId,
    };
  });

  return entries.filter(
    (entry, index) => entries.findIndex((candidate) => candidate.key === entry.key) === index,
  );
}

export function customValidationError(paths: ReadonlyArray<readonly unknown[]>): CustomFormError {
  const group = paths.map(customErrorGroup).find((candidate) => candidate !== "form") ?? "form";
  return groupErrors[group];
}

export function customErrorGroup(path: readonly unknown[]): CustomErrorGroup {
  const field = path.at(-1);
  if (path.includes("backpressureConfig")) return "advanced";
  if (path.includes("trafficConfig")) {
    return field === "maxDurationSeconds" || field === "startDelaySeconds" ? "advanced" : "traffic";
  }
  if (path.includes("inventoryConfig")) {
    return field === "reservationHoldMinutes" ? "advanced" : "stock";
  }
  if (path.includes("erpConfig")) {
    return field === "requestTimeoutMs" || field === "forcedOutage" ? "advanced" : "erp";
  }
  return "form";
}

function fieldIdForPath(path: readonly unknown[]): keyof typeof fields | undefined {
  const normalized = path.filter((part): part is string => typeof part === "string");
  const key = normalized.slice(-2).join(".");
  return pathToFieldId[key as keyof typeof pathToFieldId];
}
