import "server-only";

import {
  type AdminPresetListResponse,
  type AdminPublicRuntimePolicyResponse,
  adminPresetListPath,
  adminPresetListResponseSchema,
  adminPublicRuntimePolicyPath,
  adminPublicRuntimePolicyResponseSchema,
  type DashboardRecoveryResponse,
  dashboardRecoveryPath,
  dashboardRecoveryResponseSchema,
  type ErpChaosStatus,
  erpChaosStatusPath,
  erpChaosStatusSchema,
  controlServiceTokenHeaderName,
} from "@checkout-surge/contracts";
import type { BackendRead } from "../api";
import { webServerConfig } from "./config";

interface ContractSchema<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

async function readProtectedJson<T>(
  url: string,
  schema: ContractSchema<T>,
): Promise<BackendRead<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        [controlServiceTokenHeaderName]: webServerConfig().controlServiceToken,
      },
    });
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : "Admin read failed.",
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return {
      status: "unavailable",
      httpStatus: response.status,
      reason: error instanceof Error ? error.message : "Admin backend returned non-JSON data.",
    };
  }
  if (!response.ok) {
    return { status: "unavailable", httpStatus: response.status, reason: errorMessage(payload) };
  }
  const parsed = schema.safeParse(payload);
  return parsed.success
    ? { status: "available", data: parsed.data, httpStatus: response.status }
    : {
        status: "unavailable",
        httpStatus: response.status,
        reason: `Admin response did not match the shared contract: ${parsed.error.message}`,
      };
}

export function readAdminPresets(): Promise<BackendRead<AdminPresetListResponse>> {
  return readProtectedJson(
    `${webServerConfig().apiBaseUrl}${adminPresetListPath}`,
    adminPresetListResponseSchema,
  );
}

export function readAdminRecovery(): Promise<BackendRead<DashboardRecoveryResponse>> {
  return readProtectedJson(
    `${webServerConfig().apiBaseUrl}${dashboardRecoveryPath}`,
    dashboardRecoveryResponseSchema,
  );
}

export function readAdminRuntimePolicy(): Promise<BackendRead<AdminPublicRuntimePolicyResponse>> {
  return readProtectedJson(
    `${webServerConfig().apiBaseUrl}${adminPublicRuntimePolicyPath}`,
    adminPublicRuntimePolicyResponseSchema,
  );
}

export function readAdminErpChaos(): Promise<BackendRead<ErpChaosStatus>> {
  return readProtectedJson(
    `${webServerConfig().mockErpBaseUrl}${erpChaosStatusPath}`,
    erpChaosStatusSchema,
  );
}

function errorMessage(payload: unknown): string {
  return typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
    ? payload.message
    : "Admin backend request failed.";
}
