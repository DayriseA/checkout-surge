import {
  isValidPublicVisitorCredentialSecret,
  publicVisitorCredentialMinimumSecretBytes,
} from "@checkout-surge/contracts/public-visitor-credential";

export interface WebServerConfig {
  controlServiceToken: string;
  adminDashboardPassphrase: string;
  adminSessionSecret: string;
  publicClientCookieSecret: string;
}

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

  return {
    controlServiceToken: env.CONTROL_SERVICE_TOKEN?.trim() ?? "",
    adminDashboardPassphrase: env.ADMIN_DASHBOARD_PASSPHRASE?.trim() ?? "",
    adminSessionSecret: env.ADMIN_SESSION_SECRET?.trim() ?? "",
    publicClientCookieSecret: env.PUBLIC_CLIENT_COOKIE_SECRET?.trim() ?? "",
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
