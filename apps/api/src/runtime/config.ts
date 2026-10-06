import { type DeploymentHardCaps, deploymentHardCapsSchema } from "@checkout-surge/contracts";
import {
  isValidPublicVisitorCredentialSecret,
  publicVisitorCredentialMinimumSecretBytes,
} from "@checkout-surge/contracts/public-visitor-credential";
import {
  conservativeDurationEstimatorConstants,
  type DurationEstimatorConstants,
} from "../services/demo-duration-estimator.js";
import { pendingPersistenceRecoveryDefaults } from "./pending-persistence-recovery-policy.js";

export const composeApiHealthcheckTimeoutMs = 3_000;

export interface ApiConfig {
  host: string;
  port: number;
  listenBacklog: number;
  databaseUrl: string;
  redisUrl: string;
  postgresPoolMax: number;
  reservationHoldMinutes: number;
  idempotencyTtlSeconds: number;
  pendingPersistenceRetryAfterSeconds: number;
  pendingPersistenceRecoveryWindowSeconds: number;
  pendingPersistenceRecoveryMaxAttempts: number;
  pendingPersistenceRecoveryInitialBackoffMs: number;
  pendingPersistenceRecoveryMaxBackoffMs: number;
  pendingPersistenceRecoveryPollIntervalMs: number;
  pendingPersistenceRecoveryDiscoveryTimeoutMs: number;
  pendingPersistenceRecoveryMaxConcurrentDirectAttempts: number;
  webOrigins: string[];
  apiBaseUrl: string;
  loadOrchestratorBaseUrl: string;
  controlServiceToken: string;
  /** This API's commit, for the version handshake with the runner. */
  commitSha: string;
  runnerHost: RunnerHostConfig;
  coreIdleStop: CoreIdleStopConfig;
  publicClientCookieSecret: string;
  deploymentHardCaps: DeploymentHardCaps;
  estimatorConstants: DurationEstimatorConstants;
  demoRunFinalizationPollIntervalSeconds: number;
  dashboardMaxSseClients: number;
  dashboardMaxSseClientsPerSource: number;
  dashboardSseMaxBufferedFrames: number;
  dashboardSseMaxBufferedBytes: number;
  dashboardSseRetryAfterSeconds: number;
  dashboardRecoveryMaxConcurrent: number;
  dashboardRecoveryGlobalMaxRequests: number;
  dashboardRecoveryPerSourceMaxRequests: number;
  dashboardRecoveryWindowSeconds: number;
  dashboardRecoveryRetryAfterSeconds: number;
  dashboardRecoveryTimeoutMs: number;
  readinessTimeoutMs: number;
  trustedProxyCidrs: string[];
}

/** Fly when the runner app is configured; otherwise the local, always-on runner. */
export type RunnerHostConfig =
  | { kind: "local" }
  | {
      kind: "fly";
      appName: string;
      machinesApiToken: string;
      /** The core's current region (`FLY_REGION`, set by Fly), where a recreated runner goes. */
      coreRegion: string;
      /** Where the deploy script writes the runner's deployed config, used to recreate the runner. */
      deployedConfigFile: string;
      cpuKind: string;
      cpus: number;
      memoryMb: number;
    };

/** Off unless configured: only the hosted core stops itself when idle. */
export type CoreIdleStopConfig =
  | { kind: "off" }
  | {
      kind: "fly";
      /** This Machine's app and ID (`FLY_APP_NAME`, `FLY_MACHINE_ID`, set by Fly). */
      appName: string;
      machineId: string;
      machinesApiToken: string;
    };

const unsafeControlServiceTokens = new Set([
  "change-me-shared-control-token",
  "change-me-control-service-token",
]);
const unsafePublicClientCookieSecrets = new Set(["change-me-public-client-cookie-secret"]);

export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const config: ApiConfig = {
    host: env.HOST?.trim() || "0.0.0.0",
    port: parsePositiveInteger(env.PORT, "PORT", 4000),
    listenBacklog: parsePositiveInteger(env.API_LISTEN_BACKLOG, "API_LISTEN_BACKLOG", 8192),
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    redisUrl: requireEnv(env, "REDIS_URL"),
    postgresPoolMax: parsePositiveInteger(env.API_POSTGRES_POOL_MAX, "API_POSTGRES_POOL_MAX", 10),
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
    pendingPersistenceRecoveryWindowSeconds: parsePositiveInteger(
      env.PENDING_PERSISTENCE_RECOVERY_WINDOW_SECONDS,
      "PENDING_PERSISTENCE_RECOVERY_WINDOW_SECONDS",
      pendingPersistenceRecoveryDefaults.recoveryWindowSeconds,
    ),
    pendingPersistenceRecoveryMaxAttempts: parsePositiveInteger(
      env.PENDING_PERSISTENCE_RECOVERY_MAX_ATTEMPTS,
      "PENDING_PERSISTENCE_RECOVERY_MAX_ATTEMPTS",
      pendingPersistenceRecoveryDefaults.maxAttempts,
    ),
    pendingPersistenceRecoveryInitialBackoffMs: parsePositiveInteger(
      env.PENDING_PERSISTENCE_RECOVERY_INITIAL_BACKOFF_MS,
      "PENDING_PERSISTENCE_RECOVERY_INITIAL_BACKOFF_MS",
      pendingPersistenceRecoveryDefaults.initialBackoffMs,
    ),
    pendingPersistenceRecoveryMaxBackoffMs: parsePositiveInteger(
      env.PENDING_PERSISTENCE_RECOVERY_MAX_BACKOFF_MS,
      "PENDING_PERSISTENCE_RECOVERY_MAX_BACKOFF_MS",
      pendingPersistenceRecoveryDefaults.maxBackoffMs,
    ),
    pendingPersistenceRecoveryPollIntervalMs: parsePositiveInteger(
      env.PENDING_PERSISTENCE_RECOVERY_POLL_INTERVAL_MS,
      "PENDING_PERSISTENCE_RECOVERY_POLL_INTERVAL_MS",
      pendingPersistenceRecoveryDefaults.pollIntervalMs,
    ),
    pendingPersistenceRecoveryDiscoveryTimeoutMs: parsePositiveInteger(
      env.PENDING_PERSISTENCE_RECOVERY_DISCOVERY_TIMEOUT_MS,
      "PENDING_PERSISTENCE_RECOVERY_DISCOVERY_TIMEOUT_MS",
      pendingPersistenceRecoveryDefaults.discoveryTimeoutMs,
    ),
    pendingPersistenceRecoveryMaxConcurrentDirectAttempts: parsePositiveInteger(
      env.PENDING_PERSISTENCE_RECOVERY_MAX_CONCURRENT_DIRECT_ATTEMPTS,
      "PENDING_PERSISTENCE_RECOVERY_MAX_CONCURRENT_DIRECT_ATTEMPTS",
      pendingPersistenceRecoveryDefaults.maxConcurrentDirectAttempts,
    ),
    webOrigins: parseCsv(env.WEB_ORIGIN),
    apiBaseUrl: parseApiBaseUrl(env),
    loadOrchestratorBaseUrl: parseUrl(
      env.LOAD_ORCHESTRATOR_BASE_URL,
      "LOAD_ORCHESTRATOR_BASE_URL",
      "http://localhost:4200",
    ),
    controlServiceToken: requireEnv(env, "CONTROL_SERVICE_TOKEN"),
    commitSha: parseOptionalString(env.COMMIT_SHA) ?? "unknown",
    runnerHost: parseRunnerHost(env),
    coreIdleStop: parseCoreIdleStop(env),
    publicClientCookieSecret: requireStrongSecret(env, "PUBLIC_CLIENT_COOKIE_SECRET"),
    deploymentHardCaps: deploymentHardCapsSchema.parse({
      estimatedDemoOccupancyCeilingSeconds: parsePositiveInteger(
        env.DEMO_MAX_ESTIMATED_OCCUPANCY_SECONDS,
        "DEMO_MAX_ESTIMATED_OCCUPANCY_SECONDS",
        600,
      ),
      maxBuyers: parsePositiveInteger(env.DEMO_MAX_BUYERS, "DEMO_MAX_BUYERS", 100_000),
      maxTotalRequests: parsePositiveInteger(
        env.DEMO_MAX_TOTAL_REQUESTS,
        "DEMO_MAX_TOTAL_REQUESTS",
        100_000,
      ),
      maxRequestsPerSecond: parsePositiveInteger(
        env.DEMO_MAX_REQUESTS_PER_SECOND,
        "DEMO_MAX_REQUESTS_PER_SECOND",
        10_000,
      ),
      maxTrafficDurationSeconds: parsePositiveInteger(
        env.DEMO_MAX_TRAFFIC_DURATION_SECONDS,
        "DEMO_MAX_TRAFFIC_DURATION_SECONDS",
        300,
      ),
      maxTrafficStartDelaySeconds: parseNonnegativeInteger(
        env.DEMO_MAX_TRAFFIC_START_DELAY_SECONDS,
        "DEMO_MAX_TRAFFIC_START_DELAY_SECONDS",
        30,
      ),
      maxPreAllocatedVus: parsePositiveInteger(
        env.DEMO_MAX_PRE_ALLOCATED_VUS,
        "DEMO_MAX_PRE_ALLOCATED_VUS",
        10_000,
      ),
      maxVus: parsePositiveInteger(env.DEMO_MAX_VUS, "DEMO_MAX_VUS", 10_000),
    }),
    estimatorConstants: {
      latencyOverheadFloorMs: parsePositiveNumber(
        env.ESTIMATOR_JOB_OVERHEAD_MS,
        "ESTIMATOR_JOB_OVERHEAD_MS",
        conservativeDurationEstimatorConstants.latencyOverheadFloorMs,
      ),
      settlementOverheadSeconds: parsePositiveNumber(
        env.ESTIMATOR_SETTLEMENT_OVERHEAD_SECONDS,
        "ESTIMATOR_SETTLEMENT_OVERHEAD_SECONDS",
        conservativeDurationEstimatorConstants.settlementOverheadSeconds,
      ),
      transientErrorDemandMargin: parseDemandMargin(
        env.ESTIMATOR_TRANSIENT_ERROR_DEMAND_MARGIN,
        "ESTIMATOR_TRANSIENT_ERROR_DEMAND_MARGIN",
        conservativeDurationEstimatorConstants.transientErrorDemandMargin,
      ),
      perExcessAttemptPauseSeconds: parsePositiveNumber(
        env.ESTIMATOR_EXCESS_ATTEMPT_PAUSE_SECONDS,
        "ESTIMATOR_EXCESS_ATTEMPT_PAUSE_SECONDS",
        conservativeDurationEstimatorConstants.perExcessAttemptPauseSeconds,
      ),
    },
    demoRunFinalizationPollIntervalSeconds: parsePositiveInteger(
      env.DEMO_RUN_FINALIZATION_POLL_INTERVAL_SECONDS,
      "DEMO_RUN_FINALIZATION_POLL_INTERVAL_SECONDS",
      5,
    ),
    dashboardMaxSseClients: parsePositiveInteger(
      env.DASHBOARD_MAX_SSE_CLIENTS,
      "DASHBOARD_MAX_SSE_CLIENTS",
      80,
    ),
    dashboardMaxSseClientsPerSource: parsePositiveInteger(
      env.DASHBOARD_MAX_SSE_CLIENTS_PER_SOURCE,
      "DASHBOARD_MAX_SSE_CLIENTS_PER_SOURCE",
      6,
    ),
    dashboardSseMaxBufferedFrames: parsePositiveInteger(
      env.DASHBOARD_SSE_MAX_BUFFERED_FRAMES,
      "DASHBOARD_SSE_MAX_BUFFERED_FRAMES",
      32,
    ),
    dashboardSseMaxBufferedBytes: parsePositiveInteger(
      env.DASHBOARD_SSE_MAX_BUFFERED_BYTES,
      "DASHBOARD_SSE_MAX_BUFFERED_BYTES",
      256 * 1024,
    ),
    dashboardSseRetryAfterSeconds: parsePositiveInteger(
      env.DASHBOARD_SSE_RETRY_AFTER_SECONDS,
      "DASHBOARD_SSE_RETRY_AFTER_SECONDS",
      10,
    ),
    dashboardRecoveryMaxConcurrent: parsePositiveInteger(
      env.DASHBOARD_RECOVERY_MAX_CONCURRENT,
      "DASHBOARD_RECOVERY_MAX_CONCURRENT",
      3,
    ),
    dashboardRecoveryGlobalMaxRequests: parsePositiveInteger(
      env.DASHBOARD_RECOVERY_GLOBAL_MAX_REQUESTS,
      "DASHBOARD_RECOVERY_GLOBAL_MAX_REQUESTS",
      60,
    ),
    dashboardRecoveryPerSourceMaxRequests: parsePositiveInteger(
      env.DASHBOARD_RECOVERY_PER_SOURCE_MAX_REQUESTS,
      "DASHBOARD_RECOVERY_PER_SOURCE_MAX_REQUESTS",
      12,
    ),
    dashboardRecoveryWindowSeconds: parsePositiveInteger(
      env.DASHBOARD_RECOVERY_WINDOW_SECONDS,
      "DASHBOARD_RECOVERY_WINDOW_SECONDS",
      60,
    ),
    dashboardRecoveryRetryAfterSeconds: parsePositiveInteger(
      env.DASHBOARD_RECOVERY_RETRY_AFTER_SECONDS,
      "DASHBOARD_RECOVERY_RETRY_AFTER_SECONDS",
      10,
    ),
    dashboardRecoveryTimeoutMs: parsePositiveInteger(
      env.DASHBOARD_RECOVERY_TIMEOUT_MS,
      "DASHBOARD_RECOVERY_TIMEOUT_MS",
      5_000,
    ),
    readinessTimeoutMs: parsePositiveInteger(
      env.API_READINESS_TIMEOUT_MS,
      "API_READINESS_TIMEOUT_MS",
      2_000,
    ),
    trustedProxyCidrs:
      parseCsv(env.API_TRUSTED_PROXY_CIDRS).length > 0
        ? parseCsv(env.API_TRUSTED_PROXY_CIDRS)
        : ["127.0.0.0/8", "::1/128", "172.30.0.2/32"],
  };

  if (config.dashboardMaxSseClientsPerSource > config.dashboardMaxSseClients) {
    throw new Error(
      "DASHBOARD_MAX_SSE_CLIENTS_PER_SOURCE must not exceed DASHBOARD_MAX_SSE_CLIENTS.",
    );
  }
  if (
    config.pendingPersistenceRecoveryInitialBackoffMs >
    config.pendingPersistenceRecoveryMaxBackoffMs
  ) {
    throw new Error(
      "PENDING_PERSISTENCE_RECOVERY_INITIAL_BACKOFF_MS must not exceed PENDING_PERSISTENCE_RECOVERY_MAX_BACKOFF_MS.",
    );
  }
  if (config.deploymentHardCaps.maxPreAllocatedVus > config.deploymentHardCaps.maxVus) {
    throw new Error("DEMO_MAX_PRE_ALLOCATED_VUS must not exceed DEMO_MAX_VUS.");
  }
  if (config.dashboardRecoveryPerSourceMaxRequests > config.dashboardRecoveryGlobalMaxRequests) {
    throw new Error(
      "DASHBOARD_RECOVERY_PER_SOURCE_MAX_REQUESTS must not exceed DASHBOARD_RECOVERY_GLOBAL_MAX_REQUESTS.",
    );
  }
  if (config.readinessTimeoutMs >= composeApiHealthcheckTimeoutMs) {
    throw new Error(
      `API_READINESS_TIMEOUT_MS must be less than the ${composeApiHealthcheckTimeoutMs}ms Compose API healthcheck timeout.`,
    );
  }
  return config;
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

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function parsePositiveNumber(value: string | undefined, name: string, fallback: number): number {
  const raw = value?.trim();

  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return parsed;
}

/** The retry demand margin multiplies the 1/(1-p) demand, so it may not shrink it. */
function parseDemandMargin(value: string | undefined, name: string, fallback: number): number {
  const parsed = parsePositiveNumber(value, name, fallback);

  if (parsed < 1) {
    throw new Error(`${name} must be a number greater than or equal to 1.`);
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

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a nonnegative integer.`);
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

function parseRunnerHost(env: NodeJS.ProcessEnv): RunnerHostConfig {
  const appName = parseOptionalString(env.RUNNER_FLY_APP);
  if (!appName) return { kind: "local" };
  return {
    kind: "fly",
    appName,
    machinesApiToken: requireEnv(env, "RUNNER_FLY_API_TOKEN"),
    coreRegion: requireEnv(env, "FLY_REGION"),
    deployedConfigFile: requireEnv(env, "RUNNER_MACHINE_CONFIG_FILE"),
    cpuKind: parseOptionalString(env.RUNNER_CPU_KIND) ?? "performance",
    cpus: parsePositiveInteger(env.RUNNER_CPUS, "RUNNER_CPUS", 4),
    memoryMb: parsePositiveInteger(env.RUNNER_MEMORY_MB, "RUNNER_MEMORY_MB", 8192),
  };
}

function parseCoreIdleStop(env: NodeJS.ProcessEnv): CoreIdleStopConfig {
  const enabled = parseOptionalString(env.CORE_IDLE_STOP_ENABLED);
  if (enabled === null || enabled === "false") return { kind: "off" };
  if (enabled !== "true") throw new Error("CORE_IDLE_STOP_ENABLED must be true or false.");
  return {
    kind: "fly",
    appName: requireEnv(env, "FLY_APP_NAME"),
    machineId: requireEnv(env, "FLY_MACHINE_ID"),
    machinesApiToken: requireEnv(env, "CORE_FLY_API_TOKEN"),
  };
}

/**
 * The URL the load generator uses to reach this API. On Fly, the runner is another Machine, so
 * without an explicit API_BASE_URL it is derived from this Machine's 6PN address.
 */
function parseApiBaseUrl(env: NodeJS.ProcessEnv): string {
  const flyPrivateIp = env.FLY_PRIVATE_IP?.trim();
  const fallback = flyPrivateIp
    ? `http://[${flyPrivateIp}]:${parsePositiveInteger(env.PORT, "PORT", 4000)}`
    : "http://localhost:4000";
  return parseUrl(env.API_BASE_URL, "API_BASE_URL", fallback);
}

function parseUrl(value: string | undefined, name: string, fallback: string): string {
  const raw = value?.trim() || fallback;

  try {
    return new URL(raw).toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}
