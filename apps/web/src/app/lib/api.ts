import {
  type AdminRunHistoryDetailResponse,
  adminRunHistoryDetailPath,
  adminRunHistoryDetailResponseSchema,
  type ComparisonDetailResponse,
  comparisonDetailPath,
  comparisonDetailResponseSchema,
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
  publicVisitorIdHeaderName,
  type RunHistoryListResponse,
  runHistoryDetailPath,
  runHistoryListResponseSchema,
  runHistoryPath,
} from "@checkout-surge/contracts";
import { publicVisitorCookieName } from "@checkout-surge/contracts/public-visitor-credential";
import { cookies } from "next/headers";
import {
  type BackendRead,
  type CompletedBackendRead,
  type ContractSchema,
  readBackendResponse,
} from "./backend-read";
import { comparisonReportMissing } from "./presentation/comparison";
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

  // Public props carry only the presentation inputs they need. Correlation, transport status,
  // backend messages, and diagnostic details remain in the canonical transport response and are
  // not serialized into the public client tree.
  return {
    presets: publicRead(presets),
    readiness: publicReadiness(readiness),
    runtimePolicy: publicRead(runtimePolicy),
    recovery: pendingDashboardRecovery(),
  };
}

function publicReadiness(
  read: CompletedBackendRead<HealthResponse>,
): CompletedBackendRead<HealthResponse> {
  if (read.status === "unavailable") return publicRead(read);
  return {
    status: "available",
    data: { ...read.data, checks: [] },
  };
}

function publicRead<T>(read: CompletedBackendRead<T>): CompletedBackendRead<T> {
  if (read.status === "available") return { status: "available", data: read.data };
  return {
    status: "unavailable",
    ...(read.errorCode === undefined ? {} : { errorCode: read.errorCode }),
    ...(read.retryAfterMs === undefined ? {} : { retryAfterMs: read.retryAfterMs }),
  };
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

export async function getComparisonDetail(
  comparisonId: string,
): Promise<CompletedBackendRead<ComparisonDetailResponse>> {
  const visitorCredential = (await cookies()).get(publicVisitorCookieName)?.value;
  const read = await readJson(
    `${apiBaseUrl()}${comparisonDetailPath(comparisonId)}`,
    comparisonDetailResponseSchema.refine((detail) => detail.comparisonId === comparisonId),
    visitorCredential ? { [publicVisitorIdHeaderName]: visitorCredential } : {},
  );
  // Preserve only the canonical absence status needed to stop client report checks.
  return comparisonReportMissing(read)
    ? { status: "unavailable", httpStatus: 404, errorCode: "resource_not_found" }
    : publicRead(read);
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
