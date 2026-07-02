import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { healthResponseSchema, type ReadinessCheck } from "@checkout-surge/contracts";
import type { LoadOrchestratorConfig } from "./config.js";

export interface LoadOrchestratorReadiness {
  checks(): Promise<ReadinessCheck[]>;
}

export interface LoadOrchestratorReadinessOptions {
  fetch?: typeof fetch;
  apiReadinessPath?: string;
  apiReadinessTimeoutMs?: number;
}

const apiReadinessCheckName = "api_readiness_reachable";
const defaultApiReadinessPath = "/health/ready";
const defaultApiReadinessTimeoutMs = 2000;

export function createLoadOrchestratorReadiness(
  config: LoadOrchestratorConfig,
  options: LoadOrchestratorReadinessOptions = {},
): LoadOrchestratorReadiness {
  const fetchApi = options.fetch ?? fetch;
  const apiReadinessPath = options.apiReadinessPath ?? defaultApiReadinessPath;
  const apiReadinessTimeoutMs = options.apiReadinessTimeoutMs ?? defaultApiReadinessTimeoutMs;

  return {
    async checks() {
      return [
        await apiReadinessCheck(config.apiBaseUrl, {
          fetch: fetchApi,
          path: apiReadinessPath,
          timeoutMs: apiReadinessTimeoutMs,
        }),
        {
          name: "preset_traffic_start_enabled",
          status: "ok",
        },
        await k6BinaryCheck(config.k6Binary),
      ];
    },
  };
}

async function apiReadinessCheck(
  apiBaseUrl: string,
  options: { fetch: typeof fetch; path: string; timeoutMs: number },
): Promise<ReadinessCheck> {
  const trimmedApiBaseUrl = apiBaseUrl.trim();
  if (!trimmedApiBaseUrl) {
    return {
      name: apiReadinessCheckName,
      status: "unavailable",
      message: "API_BASE_URL is not configured.",
    };
  }

  const url = joinUrl(trimmedApiBaseUrl, options.path);

  let response: Response;
  try {
    response = await fetchWithTimeout(options.fetch, url, options.timeoutMs);
  } catch (error) {
    return {
      name: apiReadinessCheckName,
      status: "unavailable",
      message: error instanceof Error ? error.message : "API readiness request failed.",
    };
  }

  if (!response.ok) {
    return {
      name: apiReadinessCheckName,
      status: "unavailable",
      message: `API readiness returned HTTP ${response.status}.`,
    };
  }

  try {
    const body = healthResponseSchema.parse(await response.json());
    if (body.status !== "ok") {
      return {
        name: apiReadinessCheckName,
        status: "unavailable",
        message: `API readiness status=${body.status}.`,
      };
    }
  } catch (error) {
    return {
      name: apiReadinessCheckName,
      status: "unavailable",
      message:
        error instanceof Error
          ? `API readiness response was invalid: ${error.message}`
          : "API readiness response was invalid.",
    };
  }

  return {
    name: apiReadinessCheckName,
    status: "ok",
  };
}

async function fetchWithTimeout(
  fetchApi: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchApi(url, { signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new Error(`API readiness check timed out after ${timeoutMs}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBaseUrl}${normalizedPath}`;
}

async function k6BinaryCheck(k6Binary: string): Promise<ReadinessCheck> {
  if (k6Binary.includes("/")) {
    try {
      await access(k6Binary, constants.X_OK);
      return { name: "k6_binary_executable", status: "ok" };
    } catch (error) {
      return {
        name: "k6_binary_executable",
        status: "unavailable",
        message: error instanceof Error ? error.message : "Configured k6 binary is not executable.",
      };
    }
  }

  return {
    name: "k6_binary_executable",
    status: "degraded",
    message: "Readiness cannot verify PATH binaries until execution starts.",
  };
}
