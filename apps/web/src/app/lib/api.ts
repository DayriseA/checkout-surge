import {
  type AdminRunHistoryDetailResponse,
  adminRunHistoryDetailPath,
  adminRunHistoryDetailResponseSchema,
  controlServiceTokenHeaderName,
  type DashboardProjection,
  type HealthResponse,
  healthResponseSchema,
  type LivenessResponse,
  livenessResponseSchema,
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
import { type BackendRead, type ContractSchema, readBackendResponse } from "./backend-read";
import { webServerConfig } from "./server/config";

export type { BackendRead } from "./backend-read";

export interface DashboardBackendSnapshot {
  liveness: BackendRead<LivenessResponse>;
  readiness: BackendRead<HealthResponse>;
  recovery: BackendRead<DashboardProjection>;
}

export interface PublicDemoSurface {
  presets: BackendRead<PublicPresetListResponse>;
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
): Promise<BackendRead<T>> {
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
    invalidError: "Backend returned an invalid error response.",
    invalidSuccess: "Backend response did not match the expected contract.",
  });
}

export function pendingDashboardRecovery(): BackendRead<DashboardProjection> {
  return {
    status: "unavailable",
    reason: "Authoritative run state is loading.",
  };
}

export async function getDashboardBackendSnapshot(): Promise<DashboardBackendSnapshot> {
  const apiBase = apiBaseUrl();
  const [liveness, readiness] = await Promise.all([
    readJson(`${apiBase}/health/live`, livenessResponseSchema),
    readJson(`${apiBase}/health/ready`, healthResponseSchema),
  ]);

  return { liveness, readiness, recovery: pendingDashboardRecovery() };
}

export async function getPublicDemoSurface(): Promise<PublicDemoSurface> {
  const apiBase = apiBaseUrl();
  const [presets, runtimePolicy] = await Promise.all([
    readJson(`${apiBase}${publicPresetListPath}`, publicPresetListResponseSchema),
    readJson(`${apiBase}${publicRuntimePolicyPath}`, publicRuntimePolicyResponseSchema),
  ]);

  return { presets, runtimePolicy, recovery: pendingDashboardRecovery() };
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

export async function getRunHistoryDetail(
  runId: string,
): Promise<BackendRead<PublicRunHistoryDetailResponse>> {
  return readJson(
    `${apiBaseUrl()}${runHistoryDetailPath(runId)}`,
    publicRunHistoryDetailResponseSchema,
  );
}

export async function getAdminRunHistoryDetail(
  runId: string,
): Promise<BackendRead<AdminRunHistoryDetailResponse>> {
  return readJson(
    `${apiBaseUrl()}${adminRunHistoryDetailPath(runId)}`,
    adminRunHistoryDetailResponseSchema,
    { [controlServiceTokenHeaderName]: webServerConfig().controlServiceToken },
  );
}
