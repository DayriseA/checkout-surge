import { describe, expect, it } from "vitest";
import { loadApiConfig as loadProductionApiConfig } from "../src/runtime/config.js";

const loadApiConfig = (environment: Record<string, string | undefined>) =>
  loadProductionApiConfig({ ...environment, NODE_ENV: "test" });

const baseEnv = {
  DATABASE_URL: "postgresql://localhost/test",
  REDIS_URL: "redis://localhost:6379",
  PUBLIC_CLIENT_COOKIE_SECRET: "test-public-cookie-secret",
};

describe("API runtime configuration", () => {
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
    expect(defaults.dashboardRecoveryMaxConcurrent).toBe(3);
    expect(defaults.dashboardRecoveryWindowSeconds).toBe(60);

    const overridden = loadApiConfig({
      ...baseEnv,
      CONTROL_SERVICE_TOKEN: "deployment-token",
      DASHBOARD_MAX_SSE_CLIENTS: "20",
      DASHBOARD_RECOVERY_GLOBAL_MAX_REQUESTS: "30",
    });
    expect(overridden.dashboardMaxSseClients).toBe(20);
    expect(overridden.dashboardRecoveryGlobalMaxRequests).toBe(30);
  });

  it("loads documented deployment caps and drain defaults and maps every override", () => {
    const defaults = loadApiConfig({ ...baseEnv, CONTROL_SERVICE_TOKEN: "deployment-token" });
    expect(defaults.deploymentHardCaps).toEqual({
      maxBuyers: 100_000,
      maxTotalRequests: 100_000,
      maxRequestsPerSecond: 10_000,
      maxTrafficDurationSeconds: 300,
      maxTrafficStartDelaySeconds: 30,
      maxPreAllocatedVus: 10_000,
      maxVus: 10_000,
    });
    expect(defaults.demoRunDrainTimeoutSeconds).toBe(300);

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
      DEMO_RUN_DRAIN_TIMEOUT_SECONDS: "17",
    });
    expect(overridden.deploymentHardCaps).toEqual({
      maxBuyers: 11,
      maxTotalRequests: 12,
      maxRequestsPerSecond: 13,
      maxTrafficDurationSeconds: 14,
      maxTrafficStartDelaySeconds: 0,
      maxPreAllocatedVus: 15,
      maxVus: 16,
    });
    expect(overridden.demoRunDrainTimeoutSeconds).toBe(17);
  });

  it.each(["12oops", "1.5", "-1", "0"])(
    "rejects malformed or non-positive deployment cap values (%s)",
    (value) => {
      expect(() =>
        loadApiConfig({
          ...baseEnv,
          CONTROL_SERVICE_TOKEN: "deployment-token",
          DEMO_MAX_BUYERS: value,
        }),
      ).toThrow(/DEMO_MAX_BUYERS/);
    },
  );

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

  it.each([
    "0",
    "-1",
    "1.5",
    "invalid",
  ])("rejects non-positive or invalid dashboard limits (%s)", (value) => {
    expect(() =>
      loadApiConfig({
        ...baseEnv,
        CONTROL_SERVICE_TOKEN: "deployment-token",
        DASHBOARD_RECOVERY_MAX_CONCURRENT: value,
      }),
    ).toThrow(/DASHBOARD_RECOVERY_MAX_CONCURRENT/);
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
});
