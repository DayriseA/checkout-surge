import {
  isValidPublicVisitorCredentialSecret,
  publicVisitorCredentialMinimumSecretBytes,
} from "@checkout-surge/contracts/public-visitor-credential";
import { parseAdminSecurityConfig } from "./admin-config";

export interface WebServerConfig {
  apiBaseUrl: string;
  controlServiceToken: string;
  adminDashboardPassphrase: string;
  adminSessionSecret: string;
  publicClientCookieSecret: string;
  adminSessionMaxAgeSeconds: number;
  webOrigins: readonly string[];
  adminLoginClientAttempts: number;
  adminLoginGlobalAttempts: number;
  adminLoginWindowSeconds: number;
  secureAdminCookie: boolean;
}

const defaultApiBaseUrl = "http://localhost:4000";
const activeConfigKey = Symbol.for("checkout-surge.web-server-config");

const unsafeSecretValues = new Set([
  "change-me-shared-control-token",
  "change-me-control-service-token",
  "change-me-admin-passphrase",
  "change-me-admin-session-secret",
  "change-me-public-client-cookie-secret",
]);

const requiredSecrets = [
  ["CONTROL_SERVICE_TOKEN", "controlServiceToken"],
  ["ADMIN_DASHBOARD_PASSPHRASE", "adminDashboardPassphrase"],
  ["ADMIN_SESSION_SECRET", "adminSessionSecret"],
  ["PUBLIC_CLIENT_COOKIE_SECRET", "publicClientCookieSecret"],
] as const;

export function loadWebServerConfig(env: Record<string, string | undefined>): WebServerConfig {
  const invalid = requiredSecrets.flatMap(([name]) => {
    const value = env[name]?.trim();

    if (!value) {
      return `${name} is missing or blank`;
    }

    if (unsafeSecretValues.has(value)) {
      return `${name} uses a known placeholder`;
    }
    if (name === "PUBLIC_CLIENT_COOKIE_SECRET" && !isValidPublicVisitorCredentialSecret(value)) {
      return `${name} is shorter than ${publicVisitorCredentialMinimumSecretBytes} UTF-8 bytes`;
    }

    return [];
  });

  const sessionSecret = env.ADMIN_SESSION_SECRET?.trim();
  const publicCookieSecret = env.PUBLIC_CLIENT_COOKIE_SECRET?.trim();

  if (sessionSecret && publicCookieSecret && sessionSecret === publicCookieSecret) {
    invalid.push("ADMIN_SESSION_SECRET and PUBLIC_CLIENT_COOKIE_SECRET must be distinct");
  }

  if (invalid.length > 0) {
    throw new Error(`Unsafe web secrets: ${invalid.join("; ")}.`);
  }
  const apiBaseUrl = parseBackendUrl(env.API_BASE_URL, "API_BASE_URL", defaultApiBaseUrl);
  const adminSecurity = parseAdminSecurityConfig(env);
  if (!adminSecurity) throw new Error("Unsafe web admin security configuration.");

  return {
    apiBaseUrl,
    controlServiceToken: env.CONTROL_SERVICE_TOKEN?.trim() ?? "",
    adminDashboardPassphrase: env.ADMIN_DASHBOARD_PASSPHRASE?.trim() ?? "",
    adminSessionSecret: env.ADMIN_SESSION_SECRET?.trim() ?? "",
    publicClientCookieSecret: env.PUBLIC_CLIENT_COOKIE_SECRET?.trim() ?? "",
    adminSessionMaxAgeSeconds: adminSecurity.sessionMaxAgeSeconds,
    webOrigins: Object.freeze([...adminSecurity.allowedOrigins]),
    adminLoginClientAttempts: adminSecurity.loginClientAttempts,
    adminLoginGlobalAttempts: adminSecurity.loginGlobalAttempts,
    adminLoginWindowSeconds: adminSecurity.loginWindowSeconds,
    secureAdminCookie: adminSecurity.secureCookie,
  };
}

export function initializeWebServerConfig(
  env: Record<string, string | undefined>,
): Readonly<WebServerConfig> {
  if (readActiveConfig()) {
    throw new Error("Web server configuration has already been initialized.");
  }
  const config = Object.freeze(loadWebServerConfig(env));
  activeConfigStore()[activeConfigKey] = config;
  return config;
}

export function webServerConfig(): Readonly<WebServerConfig> {
  const activeConfig = readActiveConfig();
  if (!activeConfig) {
    throw new Error(
      "Web server configuration is not initialized. Next.js instrumentation must run before server request handling.",
    );
  }
  return activeConfig;
}

export function resetWebServerConfigForTests(): void {
  delete activeConfigStore()[activeConfigKey];
}

function activeConfigStore(): Record<symbol, Readonly<WebServerConfig> | undefined> {
  return globalThis as unknown as Record<symbol, Readonly<WebServerConfig> | undefined>;
}

function readActiveConfig(): Readonly<WebServerConfig> | undefined {
  return activeConfigStore()[activeConfigKey];
}

function parseBackendUrl(raw: string | undefined, name: string, fallback: string): string {
  const value = raw?.trim() || fallback;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error();
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`Unsafe web backend configuration: ${name} must be a valid HTTP(S) URL.`);
  }
}
