import { describe, expect, it } from "vitest";
import { loadApiConfig as loadProductionApiConfig } from "../../src/runtime/config.js";
import { pendingPersistenceRecoveryDefaults } from "../../src/runtime/pending-persistence-recovery-policy.js";

const loadApiConfig = (environment: Record<string, string | undefined>) =>
  loadProductionApiConfig({ ...environment, NODE_ENV: "test" });

const baseEnv = {
  DATABASE_URL: "postgresql://localhost/test",
  REDIS_URL: "redis://localhost:6379",
  PUBLIC_CLIENT_COOKIE_SECRET: "test-public-cookie-secret",
};

describe("API runtime configuration", () => {
  it("requires Redis configuration for production composition", () => {
    expect(() =>
      loadApiConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/test" }),
    ).toThrow("REDIS_URL is required.");
  });

  it.each([
    undefined,
    "  ",
    "change-me-shared-control-token",
  ])("rejects unsafe control tokens (%s)", (token) => {
    expect(() => loadApiConfig({ ...baseEnv, CONTROL_SERVICE_TOKEN: token })).toThrow(
      /CONTROL_SERVICE_TOKEN/,
    );
  });

  it("accepts a deployment-specific control token", () => {
    expect(
      loadApiConfig({ ...baseEnv, CONTROL_SERVICE_TOKEN: "deployment-token" }).controlServiceToken,
    ).toBe("deployment-token");
  });

  it.each([
    undefined,
    "weak",
    "change-me-public-client-cookie-secret",
  ])("rejects missing, weak, or placeholder public cookie secrets (%s)", (secret) => {
    expect(() =>
      loadApiConfig({
        ...baseEnv,
        CONTROL_SERVICE_TOKEN: "deployment-token",
        PUBLIC_CLIENT_COOKIE_SECRET: secret,
      }),
    ).toThrow(/PUBLIC_CLIENT_COOKIE_SECRET/);
  });

  it("loads documented dashboard availability defaults and overrides", () => {
    const defaults = loadApiConfig({ ...baseEnv, CONTROL_SERVICE_TOKEN: "deployment-token" });
    expect(defaults.dashboardMaxSseClients).toBe(80);
    expect(defaults.dashboardMaxSseClientsPerSource).toBe(6);
    expect(defaults.dashboardSseMaxBufferedFrames).toBe(32);
    expect(defaults.dashboardSseMaxBufferedBytes).toBe(256 * 1024);
    expect(defaults.dashboardRecoveryMaxConcurrent).toBe(3);
    expect(defaults.dashboardRecoveryWindowSeconds).toBe(60);
    expect(defaults.dashboardRecoveryTimeoutMs).toBe(5_000);
    expect(defaults.readinessTimeoutMs).toBe(2_000);

    const overridden = loadApiConfig({
      ...baseEnv,
      CONTROL_SERVICE_TOKEN: "deployment-token",
      DASHBOARD_MAX_SSE_CLIENTS: "20",
      DASHBOARD_SSE_MAX_BUFFERED_FRAMES: "7",
      DASHBOARD_SSE_MAX_BUFFERED_BYTES: "4096",
      DASHBOARD_RECOVERY_GLOBAL_MAX_REQUESTS: "30",
      DASHBOARD_RECOVERY_TIMEOUT_MS: "4500",
      API_READINESS_TIMEOUT_MS: "1500",
    });
    expect(overridden.dashboardMaxSseClients).toBe(20);
    expect(overridden.dashboardSseMaxBufferedFrames).toBe(7);
    expect(overridden.dashboardSseMaxBufferedBytes).toBe(4096);
    expect(overridden.dashboardRecoveryGlobalMaxRequests).toBe(30);
    expect(overridden.dashboardRecoveryTimeoutMs).toBe(4_500);
    expect(overridden.readinessTimeoutMs).toBe(1_500);
  });

  it("loads documented deployment caps and maps every override", () => {
    const defaults = loadApiConfig({ ...baseEnv, CONTROL_SERVICE_TOKEN: "deployment-token" });
    expect(defaults.deploymentHardCaps).toEqual({
      estimatedDemoOccupancyCeilingSeconds: 600,
      maxBuyers: 100_000,
      maxTotalRequests: 100_000,
      maxRequestsPerSecond: 10_000,
      maxTrafficDurationSeconds: 300,
      maxTrafficStartDelaySeconds: 30,
      maxPreAllocatedVus: 10_000,
      maxVus: 10_000,
    });

    const overridden = loadApiConfig({
      ...baseEnv,
      CONTROL_SERVICE_TOKEN: "deployment-token",
      DEMO_MAX_BUYERS: "11",
      DEMO_MAX_TOTAL_REQUESTS: "12",
      DEMO_MAX_REQUESTS_PER_SECOND: "13",
      DEMO_MAX_TRAFFIC_DURATION_SECONDS: "14",
      DEMO_MAX_TRAFFIC_START_DELAY_SECONDS: "0",
      DEMO_MAX_PRE_ALLOCATED_VUS: "15",
      DEMO_MAX_VUS: "16",
      DEMO_MAX_ESTIMATED_OCCUPANCY_SECONDS: "450",
    });
    expect(overridden.deploymentHardCaps).toEqual({
      estimatedDemoOccupancyCeilingSeconds: 450,
      maxBuyers: 11,
      maxTotalRequests: 12,
      maxRequestsPerSecond: 13,
      maxTrafficDurationSeconds: 14,
      maxTrafficStartDelaySeconds: 0,
      maxPreAllocatedVus: 15,
      maxVus: 16,
    });
  });

  it("rejects an occupancy deployment ceiling above 600 seconds", () => {
    expect(() =>
      loadApiConfig({
        ...baseEnv,
        CONTROL_SERVICE_TOKEN: "deployment-token",
        DEMO_MAX_ESTIMATED_OCCUPANCY_SECONDS: "601",
      }),
    ).toThrow();
  });

  it("loads every pending-persistence recovery default and override", () => {
    const defaults = loadApiConfig({ ...baseEnv, CONTROL_SERVICE_TOKEN: "deployment-token" });
    expect(defaults).toMatchObject({
      pendingPersistenceRecoveryWindowSeconds:
        pendingPersistenceRecoveryDefaults.recoveryWindowSeconds,
      pendingPersistenceRecoveryMaxAttempts: pendingPersistenceRecoveryDefaults.maxAttempts,
      pendingPersistenceRecoveryInitialBackoffMs:
        pendingPersistenceRecoveryDefaults.initialBackoffMs,
      pendingPersistenceRecoveryMaxBackoffMs: pendingPersistenceRecoveryDefaults.maxBackoffMs,
      pendingPersistenceRecoveryPollIntervalMs: pendingPersistenceRecoveryDefaults.pollIntervalMs,
      pendingPersistenceRecoveryDiscoveryTimeoutMs:
        pendingPersistenceRecoveryDefaults.discoveryTimeoutMs,
      pendingPersistenceRecoveryMaxConcurrentDirectAttempts:
        pendingPersistenceRecoveryDefaults.maxConcurrentDirectAttempts,
    });

    const overrides = loadApiConfig({
      ...baseEnv,
      CONTROL_SERVICE_TOKEN: "deployment-token",
      PENDING_PERSISTENCE_RECOVERY_WINDOW_SECONDS: "41",
      PENDING_PERSISTENCE_RECOVERY_MAX_ATTEMPTS: "7",
      PENDING_PERSISTENCE_RECOVERY_INITIAL_BACKOFF_MS: "250",
      PENDING_PERSISTENCE_RECOVERY_MAX_BACKOFF_MS: "5000",
      PENDING_PERSISTENCE_RECOVERY_POLL_INTERVAL_MS: "750",
      PENDING_PERSISTENCE_RECOVERY_DISCOVERY_TIMEOUT_MS: "1250",
      PENDING_PERSISTENCE_RECOVERY_MAX_CONCURRENT_DIRECT_ATTEMPTS: "4",
    });
    expect(overrides).toMatchObject({
      pendingPersistenceRecoveryWindowSeconds: 41,
      pendingPersistenceRecoveryMaxAttempts: 7,
      pendingPersistenceRecoveryInitialBackoffMs: 250,
      pendingPersistenceRecoveryMaxBackoffMs: 5_000,
      pendingPersistenceRecoveryPollIntervalMs: 750,
      pendingPersistenceRecoveryDiscoveryTimeoutMs: 1_250,
      pendingPersistenceRecoveryMaxConcurrentDirectAttempts: 4,
    });
  });

  it.each([
    "PENDING_PERSISTENCE_RECOVERY_WINDOW_SECONDS",
    "PENDING_PERSISTENCE_RECOVERY_MAX_ATTEMPTS",
    "PENDING_PERSISTENCE_RECOVERY_INITIAL_BACKOFF_MS",
    "PENDING_PERSISTENCE_RECOVERY_MAX_BACKOFF_MS",
    "PENDING_PERSISTENCE_RECOVERY_POLL_INTERVAL_MS",
    "PENDING_PERSISTENCE_RECOVERY_DISCOVERY_TIMEOUT_MS",
    "PENDING_PERSISTENCE_RECOVERY_MAX_CONCURRENT_DIRECT_ATTEMPTS",
  ])("rejects invalid %s values", (name) => {
    expect(() =>
      loadApiConfig({
        ...baseEnv,
        CONTROL_SERVICE_TOKEN: "deployment-token",
        [name]: "0",
      }),
    ).toThrow(new RegExp(name));
  });

  it("rejects pending-persistence initial backoff above its maximum", () => {
    expect(() =>
      loadApiConfig({
        ...baseEnv,
        CONTROL_SERVICE_TOKEN: "deployment-token",
        PENDING_PERSISTENCE_RECOVERY_INITIAL_BACKOFF_MS: "1001",
        PENDING_PERSISTENCE_RECOVERY_MAX_BACKOFF_MS: "1000",
      }),
    ).toThrow(/INITIAL_BACKOFF_MS must not exceed PENDING_PERSISTENCE_RECOVERY_MAX_BACKOFF_MS/);
  });

  it.each([
    "12oops",
    "1.5",
    "-1",
    "0",
    "invalid",
    String(Number.MAX_SAFE_INTEGER + 1),
  ])("rejects malformed or non-positive deployment cap values (%s)", (value) => {
    expect(() =>
      loadApiConfig({
        ...baseEnv,
        CONTROL_SERVICE_TOKEN: "deployment-token",
        DEMO_MAX_BUYERS: value,
      }),
    ).toThrow(/DEMO_MAX_BUYERS/);
  });

  it("rejects deployment preallocated VUs above max VUs", () => {
    expect(() =>
      loadApiConfig({
        ...baseEnv,
        CONTROL_SERVICE_TOKEN: "deployment-token",
        DEMO_MAX_PRE_ALLOCATED_VUS: "11",
        DEMO_MAX_VUS: "10",
      }),
    ).toThrow(/DEMO_MAX_PRE_ALLOCATED_VUS.*must not exceed.*DEMO_MAX_VUS/);
  });

  it("does not bound processing lifetime by the sale-eligibility marker TTL", () => {
    expect(() =>
      loadApiConfig({
        ...baseEnv,
        CONTROL_SERVICE_TOKEN: "deployment-token",
        DEMO_MAX_TRAFFIC_START_DELAY_SECONDS: "0",
        DEMO_MAX_TRAFFIC_DURATION_SECONDS: "604800",
        PENDING_PERSISTENCE_RECOVERY_WINDOW_SECONDS: "604800",
      }),
    ).not.toThrow();
  });

  it("rejects lifecycle values outside safe integer arithmetic", () => {
    expect(() =>
      loadApiConfig({
        ...baseEnv,
        CONTROL_SERVICE_TOKEN: "deployment-token",
        DEMO_MAX_TRAFFIC_DURATION_SECONDS: String(Number.MAX_SAFE_INTEGER + 1),
      }),
    ).toThrow(/DEMO_MAX_TRAFFIC_DURATION_SECONDS must be a positive integer/);
  });

  it("rejects an invalid dashboard recovery limit", () => {
    expect(() =>
      loadApiConfig({
        ...baseEnv,
        CONTROL_SERVICE_TOKEN: "deployment-token",
        DASHBOARD_RECOVERY_MAX_CONCURRENT: "0",
      }),
    ).toThrow(/DASHBOARD_RECOVERY_MAX_CONCURRENT/);
  });

  it.each([
    "DASHBOARD_SSE_MAX_BUFFERED_FRAMES",
    "DASHBOARD_SSE_MAX_BUFFERED_BYTES",
  ])("rejects an invalid %s limit", (name) => {
    expect(() =>
      loadApiConfig({
        ...baseEnv,
        CONTROL_SERVICE_TOKEN: "deployment-token",
        [name]: "0",
      }),
    ).toThrow(new RegExp(name));
  });

  it("rejects per-source limits larger than their total or global limit", () => {
    expect(() =>
      loadApiConfig({
        ...baseEnv,
        CONTROL_SERVICE_TOKEN: "deployment-token",
        DASHBOARD_MAX_SSE_CLIENTS: "2",
        DASHBOARD_MAX_SSE_CLIENTS_PER_SOURCE: "3",
      }),
    ).toThrow(/PER_SOURCE.*must not exceed.*MAX_SSE_CLIENTS/);
    expect(() =>
      loadApiConfig({
        ...baseEnv,
        CONTROL_SERVICE_TOKEN: "deployment-token",
        DASHBOARD_RECOVERY_GLOBAL_MAX_REQUESTS: "2",
        DASHBOARD_RECOVERY_PER_SOURCE_MAX_REQUESTS: "3",
      }),
    ).toThrow(/PER_SOURCE.*must not exceed.*GLOBAL/);
  });

  it("drives a local runner unless a Fly runner app is configured", () => {
    const env = { ...baseEnv, CONTROL_SERVICE_TOKEN: "deployment-token" };
    expect(loadApiConfig(env)).toMatchObject({
      commitSha: "unknown",
      runnerHost: { kind: "local" },
    });
    expect(() => loadApiConfig({ ...env, RUNNER_FLY_APP: "runner-app" })).toThrow(
      "RUNNER_FLY_API_TOKEN is required.",
    );
    expect(
      loadApiConfig({
        ...env,
        COMMIT_SHA: "abc123",
        RUNNER_FLY_APP: "runner-app",
        RUNNER_FLY_API_TOKEN: "runner-token",
        RUNNER_CPUS: "8",
        FLY_REGION: "cdg",
        RUNNER_MACHINE_CONFIG_FILE: "/fly/runner-machine.json",
      }),
    ).toMatchObject({
      commitSha: "abc123",
      runnerHost: {
        kind: "fly",
        appName: "runner-app",
        machinesApiToken: "runner-token",
        coreRegion: "cdg",
        deployedConfigFile: "/fly/runner-machine.json",
        cpuKind: "performance",
        cpus: 8,
        memoryMb: 8192,
      },
    });
  });

  it("keeps the core idle stop off unless it is enabled with its Fly identity and token", () => {
    const env = { ...baseEnv, CONTROL_SERVICE_TOKEN: "deployment-token" };
    expect(loadApiConfig(env).coreIdleStop).toEqual({ kind: "off" });
    expect(() => loadApiConfig({ ...env, CORE_IDLE_STOP_ENABLED: "yes" })).toThrow(
      "CORE_IDLE_STOP_ENABLED must be true or false.",
    );
    const flyEnv = {
      ...env,
      CORE_IDLE_STOP_ENABLED: "true",
      FLY_APP_NAME: "core-app",
      FLY_MACHINE_ID: "core-machine",
    };
    expect(() => loadApiConfig(flyEnv)).toThrow("CORE_FLY_API_TOKEN is required.");
    expect(loadApiConfig({ ...flyEnv, CORE_FLY_API_TOKEN: "core-token" }).coreIdleStop).toEqual({
      kind: "fly",
      appName: "core-app",
      machineId: "core-machine",
      machinesApiToken: "core-token",
    });
  });

  it("loads estimator allowance defaults and decimal overrides", () => {
    expect(
      loadApiConfig({ ...baseEnv, CONTROL_SERVICE_TOKEN: "deployment-token" }).estimatorConstants,
    ).toEqual({
      latencyOverheadFloorMs: 130,
      settlementOverheadSeconds: 15,
      transientErrorDemandMargin: 1.25,
      perExcessAttemptPauseSeconds: 1,
    });
    expect(
      loadApiConfig({
        ...baseEnv,
        CONTROL_SERVICE_TOKEN: "deployment-token",
        ESTIMATOR_JOB_OVERHEAD_MS: "210.5",
        ESTIMATOR_SETTLEMENT_OVERHEAD_SECONDS: "20",
        ESTIMATOR_TRANSIENT_ERROR_DEMAND_MARGIN: "1.5",
        ESTIMATOR_EXCESS_ATTEMPT_PAUSE_SECONDS: "2.5",
      }).estimatorConstants,
    ).toEqual({
      latencyOverheadFloorMs: 210.5,
      settlementOverheadSeconds: 20,
      transientErrorDemandMargin: 1.5,
      perExcessAttemptPauseSeconds: 2.5,
    });
  });

  it.each([
    ["ESTIMATOR_JOB_OVERHEAD_MS", "0"],
    ["ESTIMATOR_SETTLEMENT_OVERHEAD_SECONDS", "-1"],
    ["ESTIMATOR_EXCESS_ATTEMPT_PAUSE_SECONDS", "invalid"],
    ["ESTIMATOR_TRANSIENT_ERROR_DEMAND_MARGIN", "0.9"],
  ])("rejects an unusable %s value (%s)", (name, value) => {
    expect(() =>
      loadApiConfig({
        ...baseEnv,
        CONTROL_SERVICE_TOKEN: "deployment-token",
        [name]: value,
      }),
    ).toThrow(new RegExp(name));
  });

  it.each([
    [{ CAPACITY_VU_LATENCY_BUDGET_SECONDS: "0" }, /CAPACITY_VU_LATENCY_BUDGET_SECONDS/],
    [{ CAPACITY_CONSTANT_ARRIVAL_ACCEPTED_ORDER_COST: "0.5" }, /constantArrivalAcceptedOrderCost/],
    [{ CAPACITY_BUYER_SPIKE_ACCEPTED_PER_SECOND: "2000" }, /must not exceed sold-out answers/],
  ])("rejects an unusable deployment capacity (%o)", (override, message) => {
    expect(() =>
      loadApiConfig({ ...baseEnv, CONTROL_SERVICE_TOKEN: "deployment-token", ...override }),
    ).toThrow(message);
  });

  it("rejects a readiness deadline outside the Compose healthcheck budget", () => {
    expect(() =>
      loadApiConfig({
        ...baseEnv,
        CONTROL_SERVICE_TOKEN: "deployment-token",
        API_READINESS_TIMEOUT_MS: "3000",
      }),
    ).toThrow(/API_READINESS_TIMEOUT_MS.*less than.*Compose API healthcheck timeout/);
  });

  it("derives the generator-facing API base URL from the Fly private address", () => {
    const env = { ...baseEnv, CONTROL_SERVICE_TOKEN: "deployment-token", PORT: "4000" };

    expect(loadApiConfig({ ...env, FLY_PRIVATE_IP: "fdaa:0:1:a7b:1::2" }).apiBaseUrl).toBe(
      "http://[fdaa:0:1:a7b:1::2]:4000",
    );
    expect(
      loadApiConfig({
        ...env,
        FLY_PRIVATE_IP: "fdaa:0:1:a7b:1::2",
        API_BASE_URL: "http://api:4000",
      }).apiBaseUrl,
    ).toBe("http://api:4000");
    expect(loadApiConfig(env).apiBaseUrl).toBe("http://localhost:4000");
  });
});
