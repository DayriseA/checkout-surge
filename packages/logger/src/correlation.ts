import { randomUUID } from "node:crypto";
import { correlationIdSchema } from "@checkout-surge/contracts";

export const correlationIdHeaderName = "x-correlation-id" as const;

export interface NormalizeCorrelationIdOptions {
  generate?: () => string;
}

export type HeaderValue = string | string[] | number | undefined | null;

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

export function getCorrelationIdFromHeaders(
  headers: Record<string, HeaderValue>,
  options: NormalizeCorrelationIdOptions = {},
): string {
  const headerValue = readHeader(headers, correlationIdHeaderName);
  return normalizeCorrelationId(headerValue, options);
}

export function withCorrelationId<TFields extends Record<string, unknown>>(
  fields: TFields,
  correlationId: string,
): TFields & { correlationId: string } {
  return {
    ...fields,
    correlationId,
  };
}

export function readHeader(headers: Record<string, HeaderValue>, headerName: string): HeaderValue {
  const directValue = headers[headerName];

  if (directValue !== undefined) {
    return directValue;
  }

  const lowerName = headerName.toLowerCase();
  const matchingKey = Object.keys(headers).find((key) => key.toLowerCase() === lowerName);

  return matchingKey ? headers[matchingKey] : undefined;
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
