import { describe, expect, it } from "vitest";
import { loadApiConfig } from "../src/runtime/config.js";

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
