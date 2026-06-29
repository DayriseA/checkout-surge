import {
  type DashboardRecoveryResponse,
  dashboardRecoveryResponseSchema,
  type ErpChaosStatus,
  erpChaosStatusPath,
  erpChaosStatusSchema,
  type HealthResponse,
  healthResponseSchema,
  type LivenessResponse,
  livenessResponseSchema,
  type RunHistoryListResponse,
  runHistoryListResponseSchema,
  runHistoryPath,
} from "@checkout-surge/contracts";

const DEFAULT_API_BASE_URL = "http://localhost:4000";
const DEFAULT_MOCK_ERP_BASE_URL = "http://localhost:4100";

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
  erpChaos: BackendRead<ErpChaosStatus>;
}

function apiBaseUrl(): string {
  return (process.env.API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

function mockErpBaseUrl(): string {
  return (process.env.MOCK_ERP_BASE_URL ?? DEFAULT_MOCK_ERP_BASE_URL).replace(/\/+$/, "");
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown API read failure";
}

async function readJson<T>(url: string, schema: ContractSchema<T>): Promise<BackendRead<T>> {
  let response: Response;

  try {
    response = await fetch(url, {
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
  const apiBase = apiBaseUrl();
  const mockErpBase = mockErpBaseUrl();
  const [liveness, readiness, recovery, erpChaos] = await Promise.all([
    readJson(`${apiBase}/health/live`, livenessResponseSchema),
    readJson(`${apiBase}/health/ready`, healthResponseSchema),
    readJson(`${apiBase}/dashboard/recovery`, dashboardRecoveryResponseSchema),
    readJson(`${mockErpBase}${erpChaosStatusPath}`, erpChaosStatusSchema),
  ]);

  return { liveness, readiness, recovery, erpChaos };
}

export async function getRunHistoryPage(
  page: number,
  pageSize: number,
): Promise<BackendRead<RunHistoryListResponse>> {
  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });

  return readJson(
    `${apiBaseUrl()}${runHistoryPath}?${query.toString()}`,
    runHistoryListResponseSchema,
  );
}
