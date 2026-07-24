import { randomUUID } from "node:crypto";
import { correlationIdSchema } from "@checkout-surge/contracts";

export const correlationIdHeaderName = "x-correlation-id" as const;

export interface NormalizeCorrelationIdOptions {
  generate?: () => string;
}

export function createCorrelationId(): string {
  return randomUUID();
}

export function normalizeCorrelationId(
  value: unknown,
  options: NormalizeCorrelationIdOptions = {},
): string {
  const candidate = firstHeaderValue(value);
  const parsed = candidate ? correlationIdSchema.safeParse(candidate) : null;

  if (parsed?.success) {
    return parsed.data;
  }

  return (options.generate ?? createCorrelationId)();
}

function firstHeaderValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    return firstHeaderValue(value[0]);
  }

  if (typeof value === "number") {
    return value.toString();
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
