import {
  type AcceptedRunConfigSnapshot,
  type BusinessOutcomeSummary,
  materializedAcceptedRunConfigSnapshotSchema,
  materializedBusinessOutcomeSummarySchema,
  type TerminalInventorySnapshot,
  terminalInventorySnapshotSchema,
} from "@checkout-surge/contracts";
import type { z } from "zod";

export function parsePersistedAcceptedRunConfigSnapshot(
  value: unknown,
  context: string,
): AcceptedRunConfigSnapshot {
  return parsePersistedState(
    materializedAcceptedRunConfigSnapshotSchema,
    value,
    context,
    "configSnapshot",
  );
}

export function parsePersistedBusinessOutcomeSummary(
  value: unknown,
  context: string,
): BusinessOutcomeSummary {
  const persisted =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== "administrativelyDisposedOrders"),
        )
      : value;
  return parsePersistedState(
    materializedBusinessOutcomeSummarySchema,
    persisted,
    context,
    "businessOutcomeSummary",
  );
}

export function parsePersistedTerminalInventorySnapshot(
  value: unknown,
  context: string,
): TerminalInventorySnapshot {
  return parsePersistedState(
    terminalInventorySnapshotSchema,
    value,
    context,
    "terminalInventorySnapshot",
  );
}

export function parsePersistedState<T>(
  schema: z.ZodType<T>,
  value: unknown,
  context: string,
  field: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `${[field, ...issue.path].join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid persisted ${field} for ${context}: ${issues}`, {
    cause: result.error,
  });
}
