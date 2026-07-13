import { adminPassphraseHeaderName } from "../control-paths";
import type { AdminLoginAttemptLimiter } from "./admin-login-limiter";
import { requireAdminOrigin } from "./admin-origin";
import { createAdminSessionToken, verifyAdminPassphrase } from "./admin-session";
import { adminSessionCookieName, jsonError } from "./backend-proxy";

export interface AdminLoginConfig {
  passphrase: string | null;
  sessionSecret: string | null;
  sessionMaxAgeSeconds: number;
  secureCookie: boolean;
}

export interface AdminLoginDependencies {
  limiter(): AdminLoginAttemptLimiter;
  resolveClient(request: Request): string;
  config(): AdminLoginConfig | null;
  now(): Date;
  requireOrigin(request: Request): Response | null;
}

export function createAdminLoginHandler(dependencies: AdminLoginDependencies) {
  return async function handleAdminLogin(request: Request): Promise<Response> {
    const originFailure = dependencies.requireOrigin(request);
    if (originFailure) return originFailure;

    const candidate = request.headers.get(adminPassphraseHeaderName);
    if (candidate === null) return invalidCredential();

    let limiter: AdminLoginAttemptLimiter;
    try {
      limiter = dependencies.limiter();
    } catch {
      return limiterUnavailable();
    }
    const now = dependencies.now();
    const admission = await limiter.admit(dependencies.resolveClient(request), now.getTime());
    if (admission.outcome === "unavailable") return limiterUnavailable();
    if (admission.outcome === "limited") {
      return jsonError(429, "admin_login_rate_limited", "Admin login is temporarily unavailable.", {
        "retry-after": String(admission.retryAfterSeconds),
      });
    }

    const config = dependencies.config();
    if (!config)
      return jsonError(503, "admin_session_config_invalid", "Admin sessions are not configured.");
    if (!config.passphrase)
      return jsonError(
        503,
        "admin_passphrase_not_configured",
        "Admin controls are not configured.",
      );
    if (!verifyAdminPassphrase(candidate, config.passphrase)) return invalidCredential();
    if (!config.sessionSecret)
      return jsonError(
        503,
        "admin_session_secret_not_configured",
        "Admin sessions are not configured.",
      );

    const nowSeconds = Math.floor(now.getTime() / 1000);
    const token = createAdminSessionToken({
      secret: config.sessionSecret,
      nowSeconds,
      maxAgeSeconds: config.sessionMaxAgeSeconds,
    });
    const cookie = serializeSessionCookie(token, config.sessionMaxAgeSeconds, config.secureCookie);
    return Response.json(
      { authenticated: true },
      { status: 200, headers: { "set-cookie": cookie } },
    );
  };
}

export function serializeSessionCookie(
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return `${adminSessionCookieName}=${encodeURIComponent(token)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export const defaultAdminLoginDependencies = { requireOrigin: requireAdminOrigin } as const;

function invalidCredential(): Response {
  return jsonError(401, "admin_passphrase_required", "A valid admin passphrase is required.");
}

function limiterUnavailable(): Response {
  return jsonError(
    503,
    "admin_login_limiter_unavailable",
    "Admin login is temporarily unavailable.",
  );
}
