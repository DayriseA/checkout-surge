import {
  isValidPublicVisitorCredentialSecret,
  publicVisitorCredentialMinimumSecretBytes,
} from "@checkout-surge/contracts/public-visitor-credential";

export interface ApiConfig {
  host: string;
  port: number;
  listenBacklog: number;
  databaseUrl: string;
  redisUrl: string;
  postgresPoolMax: number;
  orderProcessMaxAttempts: number;
  orderProcessBackoffBaseMs: number;
  reservationHoldMinutes: number;
  idempotencyTtlSeconds: number;
  pendingPersistenceRetryAfterSeconds: number;
  webOrigins: string[];
  apiBaseUrl: string;
  loadOrchestratorBaseUrl: string;
  controlServiceToken: string;
  publicClientCookieSecret: string;
  demoRunFinalizationPollIntervalSeconds: number;
}

const unsafeControlServiceTokens = new Set([
  "change-me-shared-control-token",
  "change-me-control-service-token",
]);
const unsafePublicClientCookieSecrets = new Set(["change-me-public-client-cookie-secret"]);

export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port: parsePositiveInteger(env.PORT, "PORT", 4000),
    listenBacklog: parsePositiveInteger(env.API_LISTEN_BACKLOG, "API_LISTEN_BACKLOG", 8192),
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    redisUrl: requireEnv(env, "REDIS_URL"),
    postgresPoolMax: parsePositiveInteger(env.API_POSTGRES_POOL_MAX, "API_POSTGRES_POOL_MAX", 10),
    orderProcessMaxAttempts: parsePositiveInteger(
      env.ORDER_PROCESS_MAX_ATTEMPTS,
      "ORDER_PROCESS_MAX_ATTEMPTS",
      4,
    ),
    orderProcessBackoffBaseMs: parsePositiveInteger(
      env.ORDER_PROCESS_BACKOFF_BASE_MS,
      "ORDER_PROCESS_BACKOFF_BASE_MS",
      500,
    ),
    reservationHoldMinutes: parsePositiveInteger(
      env.RESERVATION_HOLD_MINUTES,
      "RESERVATION_HOLD_MINUTES",
      15,
    ),
    idempotencyTtlSeconds: parsePositiveInteger(
      env.IDEMPOTENCY_TTL_SECONDS,
      "IDEMPOTENCY_TTL_SECONDS",
      1800,
    ),
    pendingPersistenceRetryAfterSeconds: parsePositiveInteger(
      env.PENDING_PERSISTENCE_RETRY_AFTER_SECONDS,
      "PENDING_PERSISTENCE_RETRY_AFTER_SECONDS",
      30,
    ),
    webOrigins: parseCsv(env.WEB_ORIGIN),
    apiBaseUrl: parseUrl(env.API_BASE_URL, "API_BASE_URL", "http://localhost:4000"),
    loadOrchestratorBaseUrl: parseUrl(
      env.LOAD_ORCHESTRATOR_BASE_URL,
      "LOAD_ORCHESTRATOR_BASE_URL",
      "http://localhost:4200",
    ),
    controlServiceToken: requireEnv(env, "CONTROL_SERVICE_TOKEN"),
    publicClientCookieSecret: requireStrongSecret(env, "PUBLIC_CLIENT_COOKIE_SECRET"),
    demoRunFinalizationPollIntervalSeconds: parsePositiveInteger(
      env.DEMO_RUN_FINALIZATION_POLL_INTERVAL_SECONDS,
      "DEMO_RUN_FINALIZATION_POLL_INTERVAL_SECONDS",
      5,
    ),
  };
}

function requireStrongSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = requireEnv(env, name);
  if (name === "PUBLIC_CLIENT_COOKIE_SECRET" && unsafePublicClientCookieSecrets.has(value))
    throw new Error(`${name} must be replaced with a deployment-specific secret.`);
  if (!isValidPublicVisitorCredentialSecret(value))
    throw new Error(
      `${name} must be at least ${publicVisitorCredentialMinimumSecretBytes} UTF-8 bytes.`,
    );
  return value;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = parseOptionalString(env[name]);

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  if (name === "CONTROL_SERVICE_TOKEN" && unsafeControlServiceTokens.has(value)) {
    throw new Error(`${name} must be replaced with a deployment-specific secret.`);
  }

  return value;
}

function parseOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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

function parseCsv(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0) ?? []
  );
}

function parseUrl(value: string | undefined, name: string, fallback: string): string {
  const raw = value?.trim() || fallback;

  try {
    return new URL(raw).toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}
