import { type BackendRead, type ContractSchema, readBackendResponse } from "../backend-read";

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

  return readBackendResponse(response, schema, {
    invalidError: "Dashboard returned an invalid error response.",
    invalidSuccess: "Dashboard response did not match the expected contract.",
  });
}
