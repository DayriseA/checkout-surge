export interface LoadOrchestratorConfig {
  host: string;
  port: number;
  apiBaseUrl: string;
  buyEndpointPath: string;
  k6Binary: string;
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

function parsePositiveInteger(value: string | undefined, name: string, fallback: number): number {
  const raw = value?.trim();

  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
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
