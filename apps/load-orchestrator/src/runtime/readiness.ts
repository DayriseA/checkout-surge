import { execFile } from "node:child_process";
import { healthResponseSchema, type ReadinessCheck } from "@checkout-surge/contracts";
import type { LoadOrchestratorConfig } from "./config.js";

export interface LoadOrchestratorReadiness {
  checks(): Promise<ReadinessCheck[]>;
}

export interface LoadOrchestratorReadinessOptions {
  fetch?: typeof fetch;
  apiReadinessPath?: string;
  apiReadinessTimeoutMs?: number;
  k6CheckTimeoutMs?: number;
  checkExecutable?: (
    binary: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<{ ok: boolean; message?: string }>;
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
        await k6BinaryCheck(
          config.k6Binary,
          options.checkExecutable ?? checkK6Executable,
          options.k6CheckTimeoutMs ?? 3_000,
        ),
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

async function k6BinaryCheck(
  k6Binary: string,
  checker: NonNullable<LoadOrchestratorReadinessOptions["checkExecutable"]>,
  timeoutMs: number,
): Promise<ReadinessCheck> {
  let result: Awaited<ReturnType<typeof checker>>;
  try {
    result = await checker(k6Binary, ["version"], timeoutMs);
  } catch {
    return {
      name: "k6_binary_executable",
      status: "unavailable",
      message: "Configured k6 binary could not be checked.",
    };
  }
  return result.ok
    ? { name: "k6_binary_executable", status: "ok" }
    : {
        name: "k6_binary_executable",
        status: "unavailable",
        message: result.message ?? "Configured k6 binary is unavailable.",
      };
}

export function checkK6Executable(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        binary,
        args,
        {
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          shell: false,
          encoding: "utf8",
          maxBuffer: 16 * 1_024,
        },
        (error) => {
          if (!error) {
            resolve({ ok: true });
          } else if (error.killed && error.signal === "SIGKILL") {
            resolve({ ok: false, message: `k6 version timed out after ${timeoutMs}ms.` });
          } else if (error.signal) {
            resolve({ ok: false, message: `k6 version exited with signal ${error.signal}.` });
          } else if (typeof error.code === "number") {
            resolve({ ok: false, message: `k6 version exited with code ${error.code}.` });
          } else {
            resolve({ ok: false, message: "Configured k6 binary could not be executed." });
          }
        },
      );
    } catch {
      resolve({ ok: false, message: "Configured k6 binary could not be executed." });
    }
  });
}
