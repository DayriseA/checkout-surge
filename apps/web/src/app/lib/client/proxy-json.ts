import type { BackendRead } from "../api";

export interface ContractSchema<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

export async function readProxyJson<T>(
  path: string,
  schema: ContractSchema<T>,
  init?: RequestInit,
): Promise<BackendRead<T>> {
  let response: Response;
  const { headers, ...requestInit } = init ?? {};

  try {
    response = await fetch(path, {
      ...requestInit,
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...headers,
      },
    });
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : "Dashboard request failed.",
    };
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch (error) {
    return {
      status: "unavailable",
      httpStatus: response.status,
      reason: error instanceof Error ? error.message : "Dashboard returned non-JSON data.",
    };
  }

  if (!response.ok) {
    return {
      status: "unavailable",
      httpStatus: response.status,
      reason: errorMessageFromPayload(payload),
    };
  }

  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    return {
      status: "unavailable",
      httpStatus: response.status,
      reason: `Dashboard response did not match the shared contract: ${parsed.error.message}`,
    };
  }

  return {
    status: "available",
    data: parsed.data,
    httpStatus: response.status,
  };
}

function errorMessageFromPayload(payload: unknown): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return payload.message;
  }

  return "Dashboard request failed.";
}
