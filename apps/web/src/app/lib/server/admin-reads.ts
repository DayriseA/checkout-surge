import "server-only";

import {
  type AdminPresetListResponse,
  type AdminPublicRuntimePolicyResponse,
  adminPresetListPath,
  adminPresetListResponseSchema,
  adminPublicRuntimePolicyPath,
  adminPublicRuntimePolicyResponseSchema,
  controlServiceTokenHeaderName,
  type ErpChaosStatus,
  erpChaosStatusPath,
  erpChaosStatusSchema,
  type HealthResponse,
  healthReadyPath,
  healthResponseSchema,
} from "@checkout-surge/contracts";
import type { BackendRead } from "../api";
import { type ContractSchema, readBackendResponse } from "../backend-read";
import { webServerConfig } from "./config";

async function readProtectedJson<T>(
  url: string,
  schema: ContractSchema<T>,
  acceptedContractStatuses?: readonly number[],
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

  return readBackendResponse(response, schema, {
    ...(acceptedContractStatuses ? { acceptedContractStatuses } : {}),
    invalidError: "Admin backend returned an invalid error response.",
    invalidSuccess: "Admin backend response did not match the expected contract.",
  });
}

export function readAdminReadiness(): Promise<BackendRead<HealthResponse>> {
  return readProtectedJson(
    `${webServerConfig().apiBaseUrl}${healthReadyPath}`,
    healthResponseSchema,
    [503],
  );
}

export function readAdminPresets(): Promise<BackendRead<AdminPresetListResponse>> {
  return readProtectedJson(
    `${webServerConfig().apiBaseUrl}${adminPresetListPath}`,
    adminPresetListResponseSchema,
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
