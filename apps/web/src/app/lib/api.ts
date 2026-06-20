import {
  type DashboardRecoveryResponse,
  dashboardRecoveryResponseSchema,
  type HealthResponse,
  healthResponseSchema,
  type LivenessResponse,
  livenessResponseSchema,
} from "@checkout-surge/contracts";

const DEFAULT_API_BASE_URL = "http://localhost:4000";

interface ContractSchema<T> {
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
    };

export interface DashboardBackendSnapshot {
  liveness: BackendRead<LivenessResponse>;
  readiness: BackendRead<HealthResponse>;
  recovery: BackendRead<DashboardRecoveryResponse>;
}

function apiBaseUrl(): string {
  return (process.env.API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown API read failure";
}

async function readApi<T>(path: string, schema: ContractSchema<T>): Promise<BackendRead<T>> {
  let response: Response;

  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch (error) {
    return {
      status: "unavailable",
      reason: errorReason(error),
    };
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch (error) {
    return {
      status: "unavailable",
      httpStatus: response.status,
      reason: `API returned non-JSON data: ${errorReason(error)}`,
    };
  }

  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    return {
      status: "unavailable",
      httpStatus: response.status,
      reason: `API response did not match the shared contract: ${parsed.error.message}`,
    };
  }

  return {
    status: "available",
    data: parsed.data,
    httpStatus: response.status,
  };
}

export async function getDashboardBackendSnapshot(): Promise<DashboardBackendSnapshot> {
  const [liveness, readiness, recovery] = await Promise.all([
    readApi("/health/live", livenessResponseSchema),
    readApi("/health/ready", healthResponseSchema),
    readApi("/dashboard/recovery", dashboardRecoveryResponseSchema),
  ]);

  return { liveness, readiness, recovery };
}
