export interface WorkerConfig {
  databaseUrl: string;
  healthHost: string;
  healthPort: number;
  redisUrl: string;
  orderProcessConcurrency: number;
  postgresPoolMax: number;
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
