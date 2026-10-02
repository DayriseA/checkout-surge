export interface MockErpConfig {
  host: string;
  port: number;
  databaseUrl: string;
  postgresPoolMax: number;
}

export function loadMockErpConfig(env: NodeJS.ProcessEnv): MockErpConfig {
  const config: MockErpConfig = {
    host: env.HOST?.trim() || "0.0.0.0",
    port: parsePositiveInteger(env.PORT, "PORT", 4100),
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    postgresPoolMax: parsePositiveInteger(
      env.MOCK_ERP_POSTGRES_POOL_MAX,
      "MOCK_ERP_POSTGRES_POOL_MAX",
      5,
    ),
  };

  return config;
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
