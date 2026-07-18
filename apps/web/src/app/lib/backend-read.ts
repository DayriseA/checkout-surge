import { type ErrorPayloadCode, errorPayloadSchema } from "@checkout-surge/contracts";

export interface ContractSchema<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

export type BackendRead<T> =
  | {
      status: "available";
      data: T;
      httpStatus: number;
    }
  | {
      status: "unavailable";
      reason: string;
      httpStatus?: number;
      errorCode?: ErrorPayloadCode;
      correlationId?: string;
      retryAfterMs?: number;
    };

interface BackendResponseMessages {
  invalidError: string;
  invalidSuccess: string;
}

const maximumRetryAfterMs = 5 * 60 * 1_000;

export async function readBackendResponse<T>(
  response: Response,
  schema: ContractSchema<T>,
  messages: BackendResponseMessages,
): Promise<BackendRead<T>> {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  const payload = await readJsonBody(response);

  if (!response.ok) {
    if (!payload.ok) {
      return unavailable(response.status, messages.invalidError, retryAfterMs);
    }
    const parsedError = errorPayloadSchema.safeParse(payload.value);
    if (!parsedError.success) {
      return unavailable(response.status, messages.invalidError, retryAfterMs);
    }
    return {
      status: "unavailable",
      reason: parsedError.data.message,
      httpStatus: response.status,
      errorCode: parsedError.data.code,
      correlationId: parsedError.data.correlationId,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }

  if (!payload.ok) {
    return unavailable(response.status, messages.invalidSuccess);
  }
  const parsedSuccess = schema.safeParse(payload.value);
  if (!parsedSuccess.success) {
    return unavailable(response.status, messages.invalidSuccess);
  }
  return {
    status: "available",
    data: parsedSuccess.data,
    httpStatus: response.status,
  };
}

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const seconds = Number(value.trim());
  if (!Number.isSafeInteger(seconds)) return undefined;
  return Math.min(seconds * 1_000, maximumRetryAfterMs);
}

function unavailable(
  httpStatus: number,
  reason: string,
  retryAfterMs?: number,
): BackendRead<never> {
  return {
    status: "unavailable",
    reason,
    httpStatus,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

async function readJsonBody(
  response: Response,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false };
  }
}
