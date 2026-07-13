import {
  isValidPublicVisitorCredentialSecret,
  publicVisitorCredentialMinimumSecretBytes,
} from "@checkout-surge/contracts/public-visitor-credential";
import { parseAdminSecurityConfig } from "./admin-config";

export interface WebServerConfig {
  controlServiceToken: string;
  adminDashboardPassphrase: string;
  adminSessionSecret: string;
  publicClientCookieSecret: string;
  adminSessionMaxAgeSeconds: number;
  webOrigins: readonly string[];
  adminLoginClientAttempts: number;
  adminLoginGlobalAttempts: number;
  adminLoginWindowSeconds: number;
  redisUrl: string | null;
  adminEdgeAttestationSecret: string | null;
}

const unsafeSecretValues = new Set([
  "change-me-shared-control-token",
  "change-me-control-service-token",
  "change-me-admin-passphrase",
  "change-me-admin-session-secret",
  "change-me-public-client-cookie-secret",
  "change-me-admin-edge-attestation-secret",
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
  const adminSecurity = parseAdminSecurityConfig(env);
  if (!adminSecurity) throw new Error("Unsafe web admin security configuration.");
  if (
    adminSecurity.edgeAttestationSecret &&
    unsafeSecretValues.has(adminSecurity.edgeAttestationSecret)
  ) {
    throw new Error(
      "Unsafe web admin security configuration: ADMIN_EDGE_ATTESTATION_SECRET uses a known placeholder.",
    );
  }
  if (adminSecurity.redisUrl) {
    try {
      const redisUrl = new URL(adminSecurity.redisUrl);
      if (redisUrl.protocol !== "redis:" && redisUrl.protocol !== "rediss:") throw new Error();
    } catch {
      throw new Error("Unsafe web admin security configuration: REDIS_URL must be a redis URL.");
    }
  }

  return {
    controlServiceToken: env.CONTROL_SERVICE_TOKEN?.trim() ?? "",
    adminDashboardPassphrase: env.ADMIN_DASHBOARD_PASSPHRASE?.trim() ?? "",
    adminSessionSecret: env.ADMIN_SESSION_SECRET?.trim() ?? "",
    publicClientCookieSecret: env.PUBLIC_CLIENT_COOKIE_SECRET?.trim() ?? "",
    adminSessionMaxAgeSeconds: adminSecurity.sessionMaxAgeSeconds,
    webOrigins: adminSecurity.allowedOrigins,
    adminLoginClientAttempts: adminSecurity.loginClientAttempts,
    adminLoginGlobalAttempts: adminSecurity.loginGlobalAttempts,
    adminLoginWindowSeconds: adminSecurity.loginWindowSeconds,
    redisUrl: adminSecurity.redisUrl,
    adminEdgeAttestationSecret: adminSecurity.edgeAttestationSecret,
  };
}

export function readWebSecret(
  env: Record<string, string | undefined>,
  name: string,
): string | null {
  const value = env[name]?.trim();
  if (!value || unsafeSecretValues.has(value)) return null;
  if (name === "PUBLIC_CLIENT_COOKIE_SECRET" && !isValidPublicVisitorCredentialSecret(value))
    return null;
  return value;
}
