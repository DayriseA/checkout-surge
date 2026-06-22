export interface WorkerConfig {
  databaseUrl: string;
  healthHost: string;
  healthPort: number;
  redisUrl: string;
  orderProcessConcurrency: number;
  postgresPoolMax: number;
  mockErpBaseUrl: string;
  erpRequestTimeoutMs: number;
  erpCircuitFailureThreshold: number;
  erpCircuitResetTimeoutMs: number;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  return {
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    healthHost: env.HEALTH_HOST?.trim() || env.HOST?.trim() || "0.0.0.0",
    healthPort: parsePositiveInteger(env.HEALTH_PORT, "HEALTH_PORT", 4300),
    redisUrl: requireEnv(env, "REDIS_URL"),
    orderProcessConcurrency: parsePositiveInteger(
      env.ORDER_PROCESS_CONCURRENCY,
      "ORDER_PROCESS_CONCURRENCY",
      5,
    ),
    postgresPoolMax: parsePositiveInteger(
      env.WORKER_POSTGRES_POOL_MAX,
      "WORKER_POSTGRES_POOL_MAX",
      10,
    ),
    mockErpBaseUrl: parseUrl(
      env.MOCK_ERP_BASE_URL?.trim() || "http://localhost:4100",
      "MOCK_ERP_BASE_URL",
    ),
    erpRequestTimeoutMs: parsePositiveInteger(
      env.ERP_REQUEST_TIMEOUT_MS,
      "ERP_REQUEST_TIMEOUT_MS",
      2000,
    ),
    erpCircuitFailureThreshold: parsePositiveInteger(
      env.ERP_CIRCUIT_FAILURE_THRESHOLD,
      "ERP_CIRCUIT_FAILURE_THRESHOLD",
      5,
    ),
    erpCircuitResetTimeoutMs: parsePositiveInteger(
      env.ERP_CIRCUIT_RESET_TIMEOUT_MS,
      "ERP_CIRCUIT_RESET_TIMEOUT_MS",
      10_000,
    ),
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required.`);
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

function parseUrl(value: string, name: string): string {
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}
