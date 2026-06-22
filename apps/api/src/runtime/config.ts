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
}

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
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = parseOptionalString(env[name]);

  if (!value) {
    throw new Error(`${name} is required.`);
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
