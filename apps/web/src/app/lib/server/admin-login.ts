import { correlationIdHeaderName } from "@checkout-surge/logger";
import { adminPassphraseHeaderName } from "../control-paths";
import type { AdminLoginAttemptLimiter } from "./admin-login-limiter";
import { requireAdminOrigin } from "./admin-origin";
import { createAdminSessionToken, verifyAdminPassphrase } from "./admin-session";
import {
  adminSessionCookieName,
  createProxyRequestContext,
  jsonError,
  type ProxyRequestContext,
} from "./backend-proxy";

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
  requireOrigin(ctx: ProxyRequestContext): Response | null;
}

export function createAdminLoginHandler(dependencies: AdminLoginDependencies) {
  return async function handleAdminLogin(request: Request): Promise<Response> {
    const ctx = createProxyRequestContext(request);
    const originFailure = dependencies.requireOrigin(ctx);
    if (originFailure) return originFailure;

    const candidate = request.headers.get(adminPassphraseHeaderName);
    if (candidate === null) return invalidCredential(ctx);

    let limiter: AdminLoginAttemptLimiter;
    try {
      limiter = dependencies.limiter();
    } catch {
      return limiterUnavailable(ctx);
    }
    const now = dependencies.now();
    const admission = await limiter.admit(dependencies.resolveClient(request), now.getTime());
    if (admission.outcome === "unavailable") return limiterUnavailable(ctx);
    if (admission.outcome === "limited") {
      return jsonError(
        ctx,
        429,
        "admin_login_rate_limited",
        "Admin login is temporarily unavailable.",
        {
          "retry-after": String(admission.retryAfterSeconds),
        },
      );
    }

    const config = dependencies.config();
    if (!config)
      return jsonError(ctx, 503, "service_misconfigured", "Admin sessions are not configured.");
    if (!config.passphrase)
      return jsonError(ctx, 503, "service_misconfigured", "Admin controls are not configured.");
    if (!verifyAdminPassphrase(candidate, config.passphrase)) return invalidCredential(ctx);
    if (!config.sessionSecret)
      return jsonError(ctx, 503, "service_misconfigured", "Admin sessions are not configured.");

    const nowSeconds = Math.floor(now.getTime() / 1000);
    const token = createAdminSessionToken({
      secret: config.sessionSecret,
      nowSeconds,
      maxAgeSeconds: config.sessionMaxAgeSeconds,
    });
    const cookie = serializeSessionCookie(token, config.sessionMaxAgeSeconds, config.secureCookie);
    const headers = new Headers();
    headers.set("set-cookie", cookie);
    headers.set(correlationIdHeaderName, ctx.correlationId);
    return Response.json({ authenticated: true }, { status: 200, headers });
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

function invalidCredential(ctx: ProxyRequestContext): Response {
  return jsonError(ctx, 401, "admin_passphrase_required", "A valid admin passphrase is required.");
}

function limiterUnavailable(ctx: ProxyRequestContext): Response {
  return jsonError(ctx, 503, "service_unavailable", "Admin login is temporarily unavailable.");
}
