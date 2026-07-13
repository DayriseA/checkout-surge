import { afterEach, describe, expect, it } from "vitest";
import { loadWebServerConfig } from "../src/app/lib/server/config";
import { register } from "../src/instrumentation";

const validSecrets = {
  CONTROL_SERVICE_TOKEN: "control-token",
  ADMIN_DASHBOARD_PASSPHRASE: "admin-passphrase",
  ADMIN_SESSION_SECRET: "session-secret",
  PUBLIC_CLIENT_COOKIE_SECRET: "visitor-cookie-secret",
  WEB_ORIGIN: "http://dashboard.local",
};
const originalEnv = { ...process.env };

describe("web server secret configuration", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("reports all missing values without exposing secret values", () => {
    expect(() => loadWebServerConfig({})).toThrow(
      "CONTROL_SERVICE_TOKEN is missing or blank; ADMIN_DASHBOARD_PASSPHRASE is missing or blank; ADMIN_SESSION_SECRET is missing or blank; PUBLIC_CLIENT_COOKIE_SECRET is missing or blank",
    );
  });

  it.each([
    ["CONTROL_SERVICE_TOKEN", "change-me-shared-control-token"],
    ["ADMIN_DASHBOARD_PASSPHRASE", "change-me-admin-passphrase"],
    ["ADMIN_SESSION_SECRET", "change-me-admin-session-secret"],
    ["PUBLIC_CLIENT_COOKIE_SECRET", "change-me-public-client-cookie-secret"],
  ])("rejects known placeholder in %s", (name, placeholder) => {
    expect(() => loadWebServerConfig({ ...validSecrets, [name]: placeholder })).toThrow(
      `${name} uses a known placeholder`,
    );
  });

  it("aggregates missing and blank values", () => {
    expect(() =>
      loadWebServerConfig({
        CONTROL_SERVICE_TOKEN: " ",
        ADMIN_DASHBOARD_PASSPHRASE: "admin-passphrase",
      }),
    ).toThrow(
      "CONTROL_SERVICE_TOKEN is missing or blank; ADMIN_SESSION_SECRET is missing or blank; PUBLIC_CLIENT_COOKIE_SECRET is missing or blank",
    );
  });

  it("accepts distinct deployment secrets", () => {
    expect(loadWebServerConfig(validSecrets)).toEqual({
      controlServiceToken: "control-token",
      adminDashboardPassphrase: "admin-passphrase",
      adminSessionSecret: "session-secret",
      publicClientCookieSecret: "visitor-cookie-secret",
      adminSessionMaxAgeSeconds: 28_800,
      webOrigins: ["http://dashboard.local"],
      adminLoginClientAttempts: 5,
      adminLoginGlobalAttempts: 20,
      adminLoginWindowSeconds: 60,
      redisUrl: null,
      adminEdgeAttestationSecret: null,
    });
  });

  it.each([
    ["WEB_ORIGIN", "https://dashboard.local/path"],
    ["WEB_ORIGIN", "https://dashboard.local,http://localhost:3000"],
    ["ADMIN_SESSION_MAX_AGE_SECONDS", "0"],
    ["ADMIN_LOGIN_CLIENT_ATTEMPTS", "2.5"],
    ["ADMIN_LOGIN_GLOBAL_ATTEMPTS", ""],
    ["ADMIN_LOGIN_WINDOW_SECONDS", "nope"],
  ])("rejects invalid admin setting %s=%s", (name, value) => {
    expect(() => loadWebServerConfig({ ...validSecrets, [name]: value })).toThrow(
      /Unsafe web admin security configuration/,
    );
  });

  it("requires shared limiter and attestation configuration in production", () => {
    expect(() => loadWebServerConfig({ ...validSecrets, NODE_ENV: "production" })).toThrow();
    const config = loadWebServerConfig({
      ...validSecrets,
      NODE_ENV: "production",
      REDIS_URL: "redis://redis:6379",
      ADMIN_EDGE_ATTESTATION_SECRET: "edge-attestation",
    });
    expect(config.webOrigins).toEqual(["http://dashboard.local"]);
  });

  it("rejects a public cookie secret shorter than 16 UTF-8 bytes", () => {
    expect(() =>
      loadWebServerConfig({ ...validSecrets, PUBLIC_CLIENT_COOKIE_SECRET: "too-short" }),
    ).toThrow(/shorter than 16 UTF-8 bytes/);
  });

  it("rejects reused HMAC secrets", () => {
    expect(() =>
      loadWebServerConfig({
        ...validSecrets,
        PUBLIC_CLIENT_COOKIE_SECRET: validSecrets.ADMIN_SESSION_SECRET,
      }),
    ).toThrow(/must be distinct/);
  });

  it("does not echo supplied secret values in errors", () => {
    const secret = "actual-secret-that-must-not-appear";
    let thrown: unknown;
    try {
      loadWebServerConfig({
        ...validSecrets,
        ADMIN_DASHBOARD_PASSPHRASE: " ",
        CONTROL_SERVICE_TOKEN: secret,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(secret);
  });

  it("enforces startup validation through instrumentation", () => {
    process.env = { ...process.env, ...validSecrets };
    expect(() => register()).not.toThrow();

    process.env.ADMIN_SESSION_SECRET = "";
    expect(() => register()).toThrow(/ADMIN_SESSION_SECRET is missing or blank/);
  });
});
