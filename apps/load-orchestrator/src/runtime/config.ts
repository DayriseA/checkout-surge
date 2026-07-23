import {
  defaultK6CancellationTimeoutMs,
  maxK6CancellationTimeoutMs,
} from "../application/k6-child-process-supervisor.js";

export interface LoadOrchestratorConfig {
  host: string;
  port: number;
  apiBaseUrl: string;
  buyEndpointPath: string;
  k6Binary: string;
  k6CancellationTimeoutMs: number;
  controlServiceToken: string;
  stateDirectory: string;
}

const unsafeControlServiceTokens = new Set([
  "change-me-shared-control-token",
  "change-me-control-service-token",
]);

export function loadLoadOrchestratorConfig(env: NodeJS.ProcessEnv): LoadOrchestratorConfig {
  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port: parsePositiveInteger(env.PORT, "PORT", 4200),
    apiBaseUrl: parseUrl(env.API_BASE_URL, "API_BASE_URL", "http://localhost:4000"),
    buyEndpointPath: parsePath(env.BUY_ENDPOINT_PATH, "BUY_ENDPOINT_PATH", "/buy"),
    k6Binary: env.K6_BINARY?.trim() || "k6",
    k6CancellationTimeoutMs: parsePositiveInteger(
      env.K6_CANCELLATION_TIMEOUT_MS,
      "K6_CANCELLATION_TIMEOUT_MS",
      defaultK6CancellationTimeoutMs,
      maxK6CancellationTimeoutMs,
    ),
    controlServiceToken: requireEnv(env, "CONTROL_SERVICE_TOKEN"),
    stateDirectory: env.LOAD_ORCHESTRATOR_STATE_DIR?.trim() || ".checkout-surge/load-orchestrator",
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  if (name === "CONTROL_SERVICE_TOKEN" && unsafeControlServiceTokens.has(value)) {
    throw new Error(`${name} must be replaced with a deployment-specific secret.`);
  }

  return value;
}

function parsePositiveInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = value?.trim();

  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}.`);
  }

  return parsed;
}

function parseUrl(value: string | undefined, name: string, fallback: string): string {
  const raw = value?.trim() || fallback;

  try {
    return new URL(raw).toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}

function parsePath(value: string | undefined, name: string, fallback: string): string {
  const raw = value?.trim() || fallback;

  if (!raw.startsWith("/")) {
    throw new Error(`${name} must start with '/'.`);
  }

  return raw;
}
