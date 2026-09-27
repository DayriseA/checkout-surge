import { correlationIdHeaderName } from "@checkout-surge/logger";
import type { AdminLoginLimiter } from "./admin-login-limiter";
import { requireAdminOrigin } from "./admin-origin";
import { createAdminSessionToken, verifyAdminPassphrase } from "./admin-session";
import {
  adminSessionCookieName,
  createProxyRequestContext,
  jsonError,
  type ProxyRequestContext,
} from "./backend-proxy";

export interface AdminLoginConfig {
  passphrase: string;
  sessionSecret: string;
  sessionMaxAgeSeconds: number;
  secureCookie: boolean;
}

export interface AdminLoginDependencies {
  limiter(): AdminLoginLimiter;
  resolveClient(request: Request): string;
  config(): AdminLoginConfig;
  now(): Date;
  requireOrigin(ctx: ProxyRequestContext): Response | null;
}

export function createAdminLoginHandler(dependencies: AdminLoginDependencies) {
  return async function handleAdminLogin(request: Request): Promise<Response> {
    const ctx = createProxyRequestContext(request);
    const originFailure = dependencies.requireOrigin(ctx);
    if (originFailure) return originFailure;

    const candidate = await readPassphraseFromJsonBody(request);
    if (candidate === null) return invalidCredential(ctx);

    const now = dependencies.now();
    const admission = dependencies
      .limiter()
      .admit(dependencies.resolveClient(request), now.getTime());
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
    if (!verifyAdminPassphrase(candidate, config.passphrase)) return invalidCredential(ctx);

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

async function readPassphraseFromJsonBody(request: Request): Promise<string | null> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null) return null;
    const passphrase = (body as Record<string, unknown>).passphrase;
    return typeof passphrase === "string" ? passphrase : null;
  } catch {
    return null;
  }
}
