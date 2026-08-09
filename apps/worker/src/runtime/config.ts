import { orderProcessConcurrencyHardCap } from "@checkout-surge/contracts";

export function loadWorkerConfig(env: NodeJS.ProcessEnv) {
  const config = {
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    healthHost: env.HEALTH_HOST?.trim() || env.HOST?.trim() || "0.0.0.0",
    healthPort: parsePositiveInteger(env.HEALTH_PORT, "HEALTH_PORT", 4300),
    redisUrl: requireEnv(env, "REDIS_URL"),
    orderProcessConcurrency: parsePositiveInteger(
      env.ORDER_PROCESS_CONCURRENCY,
      "ORDER_PROCESS_CONCURRENCY",
      orderProcessConcurrencyHardCap,
    ),
    notificationRecordConcurrency: parsePositiveInteger(
      env.NOTIFICATION_RECORD_CONCURRENCY,
      "NOTIFICATION_RECORD_CONCURRENCY",
      5,
    ),
    notificationRecoveryScanIntervalMs: parsePositiveInteger(
      env.NOTIFICATION_RECOVERY_SCAN_INTERVAL_MS,
      "NOTIFICATION_RECOVERY_SCAN_INTERVAL_MS",
      1000,
    ),
    notificationRecoveryBatchSize: parsePositiveInteger(
      env.NOTIFICATION_RECOVERY_BATCH_SIZE,
      "NOTIFICATION_RECOVERY_BATCH_SIZE",
      100,
    ),
    orderDispatchScanIntervalMs: parsePositiveInteger(
      env.ORDER_DISPATCH_SCAN_INTERVAL_MS,
      "ORDER_DISPATCH_SCAN_INTERVAL_MS",
      1000,
    ),
    orderDispatchBatchSize: parsePositiveInteger(
      env.ORDER_DISPATCH_BATCH_SIZE,
      "ORDER_DISPATCH_BATCH_SIZE",
      100,
    ),
    orderDispatchMinimumQueuedAgeMs: parseNonnegativeInteger(
      env.ORDER_DISPATCH_MINIMUM_QUEUED_AGE_MS,
      "ORDER_DISPATCH_MINIMUM_QUEUED_AGE_MS",
      1000,
    ),
    orderRecoveryScanIntervalMs: parsePositiveInteger(
      env.ORDER_RECOVERY_SCAN_INTERVAL_MS,
      "ORDER_RECOVERY_SCAN_INTERVAL_MS",
      1000,
    ),
    orderRecoveryBatchSize: parsePositiveInteger(
      env.ORDER_RECOVERY_BATCH_SIZE,
      "ORDER_RECOVERY_BATCH_SIZE",
      100,
    ),
    orderRecoveryLeaseMs: parsePositiveInteger(
      env.ORDER_RECOVERY_LEASE_MS,
      "ORDER_RECOVERY_LEASE_MS",
      30_000,
    ),
    orderRecoveryMaxAttempts: parsePositiveInteger(
      env.ORDER_RECOVERY_MAX_ATTEMPTS,
      "ORDER_RECOVERY_MAX_ATTEMPTS",
      100,
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
  if (config.orderProcessConcurrency < orderProcessConcurrencyHardCap) {
    throw new Error(
      `ORDER_PROCESS_CONCURRENCY must be at least the accepted run concurrency cap (${orderProcessConcurrencyHardCap}).`,
    );
  }
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

function parseNonnegativeInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  const raw = value?.trim();

  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a nonnegative integer.`);
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
