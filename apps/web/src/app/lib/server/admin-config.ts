import { parseAdminSessionMaxAge } from "./admin-session";

export interface AdminSecurityConfig {
  allowedOrigins: readonly string[];
  secureCookie: boolean;
  sessionMaxAgeSeconds: number;
  loginClientAttempts: number;
  loginGlobalAttempts: number;
  loginWindowSeconds: number;
  redisUrl: string | null;
  edgeAttestationSecret: string | null;
}

export function parseAllowedWebOrigins(raw: string | undefined): readonly string[] | null {
  if (raw === undefined || raw.trim() === "") return null;
  const values = raw.split(",");
  const origins: string[] = [];
  for (const value of values) {
    const candidate = value.trim();
    if (!candidate) return null;
    try {
      const url = new URL(candidate);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.origin !== candidate ||
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== ""
      )
        return null;
      origins.push(url.origin);
    } catch {
      return null;
    }
  }
  if (new Set(origins.map((origin) => new URL(origin).protocol)).size !== 1) return null;
  return [...new Set(origins)];
}

export function parseAdminSecurityConfig(
  env: Record<string, string | undefined>,
): AdminSecurityConfig | null {
  const allowedOrigins = parseAllowedWebOrigins(env.WEB_ORIGIN);
  const sessionMaxAgeSeconds = parseAdminSessionMaxAge(env.ADMIN_SESSION_MAX_AGE_SECONDS);
  const loginClientAttempts = positiveInteger(env.ADMIN_LOGIN_CLIENT_ATTEMPTS, 5);
  const loginGlobalAttempts = positiveInteger(env.ADMIN_LOGIN_GLOBAL_ATTEMPTS, 20);
  const loginWindowSeconds = positiveInteger(env.ADMIN_LOGIN_WINDOW_SECONDS, 60);
  if (
    !allowedOrigins ||
    sessionMaxAgeSeconds === null ||
    loginClientAttempts === null ||
    loginGlobalAttempts === null ||
    loginWindowSeconds === null
  )
    return null;

  const production = env.NODE_ENV === "production";
  const redisUrl = nonBlank(env.REDIS_URL);
  const edgeAttestationSecret = nonBlank(env.ADMIN_EDGE_ATTESTATION_SECRET);
  if (production && (!redisUrl || !edgeAttestationSecret)) return null;
  if (edgeAttestationSecret === "change-me-admin-edge-attestation-secret") return null;
  if (redisUrl) {
    try {
      const parsed = new URL(redisUrl);
      if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") return null;
    } catch {
      return null;
    }
  }

  return {
    allowedOrigins,
    secureCookie: allowedOrigins[0]?.startsWith("https://") === true,
    sessionMaxAgeSeconds,
    loginClientAttempts,
    loginGlobalAttempts,
    loginWindowSeconds,
    redisUrl,
    edgeAttestationSecret,
  };
}

function positiveInteger(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonBlank(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  return raw.trim();
}
