import {
  type AdminRunHistoryDetailResponse,
  adminRunHistoryDetailPath,
  adminRunHistoryDetailResponseSchema,
  controlServiceTokenHeaderName,
  type DashboardProjection,
  type HealthResponse,
  healthReadyPath,
  healthResponseSchema,
  type PublicPresetListResponse,
  type PublicRunHistoryDetailResponse,
  type PublicRuntimePolicyResponse,
  publicPresetListPath,
  publicPresetListResponseSchema,
  publicRunHistoryDetailResponseSchema,
  publicRuntimePolicyPath,
  publicRuntimePolicyResponseSchema,
  type RunHistoryListResponse,
  runHistoryDetailPath,
  runHistoryListResponseSchema,
  runHistoryPath,
} from "@checkout-surge/contracts";
import {
  type BackendRead,
  type CompletedBackendRead,
  type ContractSchema,
  readBackendResponse,
} from "./backend-read";
import { webServerConfig } from "./server/config";

export type { BackendRead, CompletedBackendRead } from "./backend-read";

export interface PublicDemoSurface {
  presets: BackendRead<PublicPresetListResponse>;
  readiness: BackendRead<HealthResponse>;
  runtimePolicy: BackendRead<PublicRuntimePolicyResponse>;
  recovery: BackendRead<DashboardProjection>;
}

function apiBaseUrl(): string {
  return webServerConfig().apiBaseUrl;
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown API read failure";
}

async function readJson<T>(
  url: string,
  schema: ContractSchema<T>,
  headers: Record<string, string> = {},
  acceptedContractStatuses?: readonly number[],
): Promise<CompletedBackendRead<T>> {
  let response: Response;

  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json", ...headers },
    });
  } catch (error) {
    return {
      status: "unavailable",
      reason: errorReason(error),
    };
  }

  return readBackendResponse(response, schema, {
    ...(acceptedContractStatuses ? { acceptedContractStatuses } : {}),
    invalidError: "Backend returned an invalid error response.",
    invalidSuccess: "Backend response did not match the expected contract.",
  });
}

export function pendingDashboardRecovery(): BackendRead<DashboardProjection> {
  return { status: "loading" };
}

export async function getPublicDemoSurface(): Promise<PublicDemoSurface> {
  const apiBase = apiBaseUrl();
  const [presets, readiness, runtimePolicy] = await Promise.all([
    readJson(`${apiBase}${publicPresetListPath}`, publicPresetListResponseSchema),
    readJson(`${apiBase}${healthReadyPath}`, healthResponseSchema, {}, [503]),
    readJson(`${apiBase}${publicRuntimePolicyPath}`, publicRuntimePolicyResponseSchema),
  ]);

  return { presets, readiness, runtimePolicy, recovery: pendingDashboardRecovery() };
}

export async function getRunHistoryPage(
  page: number,
  pageSize: number,
): Promise<CompletedBackendRead<RunHistoryListResponse>> {
  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });

  return readJson(
    `${apiBaseUrl()}${runHistoryPath}?${query.toString()}`,
    runHistoryListResponseSchema,
  );
}

export async function getRunHistoryDetail(
  runId: string,
): Promise<CompletedBackendRead<PublicRunHistoryDetailResponse>> {
  return readJson(
    `${apiBaseUrl()}${runHistoryDetailPath(runId)}`,
    publicRunHistoryDetailResponseSchema,
  );
}

export async function getAdminRunHistoryDetail(
  runId: string,
): Promise<CompletedBackendRead<AdminRunHistoryDetailResponse>> {
  return readJson(
    `${apiBaseUrl()}${adminRunHistoryDetailPath(runId)}`,
    adminRunHistoryDetailResponseSchema,
    { [controlServiceTokenHeaderName]: webServerConfig().controlServiceToken },
  );
}
