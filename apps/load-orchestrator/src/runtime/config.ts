import {
  defaultCompletionDeliveryRetryIntervalMs,
  maxCompletionDeliveryRetryIntervalMs,
} from "../application/completion-delivery-coordinator.js";
import {
  defaultK6CancellationTimeoutMs,
  maxK6CancellationTimeoutMs,
} from "../application/k6-child-process-supervisor.js";

export interface LoadOrchestratorConfig {
  host: string;
  port: number;
  apiBaseUrl: string;
  k6Binary: string;
  k6CancellationTimeoutMs: number;
  completionDeliveryRetryIntervalMs: number;
  controlServiceToken: string;
  stateDirectory: string;
  runnerLifecycleEnabled: boolean;
  commitSha: string;
}

const unsafeControlServiceTokens = new Set([
  "change-me-shared-control-token",
  "change-me-control-service-token",
]);

export function loadLoadOrchestratorConfig(env: NodeJS.ProcessEnv): LoadOrchestratorConfig {
  return {
    runnerLifecycleEnabled: parseBoolean(env.RUNNER_LIFECYCLE_ENABLED),
    commitSha: env.COMMIT_SHA?.trim() || "unknown",
    host: env.HOST?.trim() || "0.0.0.0",
    port: parsePositiveInteger(env.PORT, "PORT", 4200),
    apiBaseUrl: parseUrl(env.API_BASE_URL, "API_BASE_URL", "http://localhost:4000"),
    k6Binary: env.K6_BINARY?.trim() || "k6",
    k6CancellationTimeoutMs: parsePositiveInteger(
      env.K6_CANCELLATION_TIMEOUT_MS,
      "K6_CANCELLATION_TIMEOUT_MS",
      defaultK6CancellationTimeoutMs,
      maxK6CancellationTimeoutMs,
    ),
    completionDeliveryRetryIntervalMs: parsePositiveInteger(
      env.COMPLETION_DELIVERY_RETRY_INTERVAL_MS,
      "COMPLETION_DELIVERY_RETRY_INTERVAL_MS",
      defaultCompletionDeliveryRetryIntervalMs,
      maxCompletionDeliveryRetryIntervalMs,
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

function parseBoolean(value: string | undefined): boolean {
  if (!value?.trim() || value.trim() === "false") return false;
  if (value.trim() === "true") return true;
  throw new Error("RUNNER_LIFECYCLE_ENABLED must be true or false.");
}
