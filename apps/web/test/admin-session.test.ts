import { createHmac } from "node:crypto";
import {
  publicVisitorCookieName,
  signPublicVisitorCredential,
} from "@checkout-surge/contracts/public-visitor-credential";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseAdminSecurityConfig,
  parseAllowedWebOrigins,
} from "../src/app/lib/server/admin-config";
import { createAdminLoginHandler, serializeSessionCookie } from "../src/app/lib/server/admin-login";
import { AdminLoginAttemptLimiter } from "../src/app/lib/server/admin-login-limiter";
import { handleAdminLogout } from "../src/app/lib/server/admin-logout";
import { requireAdminOrigin } from "../src/app/lib/server/admin-origin";
import {
  createAdminSessionToken,
  isValidAdminSessionToken,
  parseAdminSessionMaxAge,
  verifyAdminPassphrase,
} from "../src/app/lib/server/admin-session";
import {
  initializeWebServerConfig,
  resetWebServerConfigForTests,
} from "../src/app/lib/server/config";
import { readPublicVisitorIdentity } from "../src/app/lib/server/public-visitor";

describe("admin session core", () => {
  it("compares credentials through fixed-length digests", () => {
    expect(verifyAdminPassphrase("secret", "secret")).toBe(true);
    expect(verifyAdminPassphrase("short", "a much longer candidate")).toBe(false);
    expect(verifyAdminPassphrase("secret", "different")).toBe(false);
    expect(verifyAdminPassphrase(" secret ", "secret")).toBe(false);
  });

  it("authenticates the signature before accepting bounded timestamps", () => {
    const token = createAdminSessionToken({ secret: "one", nowSeconds: 100, maxAgeSeconds: 60 });
    const valid = (nowSeconds: number, secret = "one", value = token) =>
      isValidAdminSessionToken({ token: value, secret, nowSeconds, maxAgeSeconds: 60 });
    expect(valid(100)).toBe(true);
    expect(valid(159)).toBe(true);
    expect(valid(160)).toBe(false);
    expect(valid(99)).toBe(false);
    expect(valid(100, "two")).toBe(false);
    expect(valid(100, "one", `${token}.extra`)).toBe(false);
    expect(valid(100, "one", "bm90LWpzb24.invalid")).toBe(false);
    expect(valid(100, "one", signedPayload("not-json", "one"))).toBe(false);
    const validPayload = token.split(".")[0];
    expect(valid(100, "one", signEncodedPayload(`${validPayload}%`, "one"))).toBe(false);
    expect(valid(100, "one", signedJson({ v: 2, iat: 100, exp: 160 }, "one"))).toBe(false);
    expect(valid(100, "one", signedJson({ v: 1, iat: 101, exp: 161 }, "one"))).toBe(false);
    expect(valid(100, "one", signedJson({ v: 1, iat: 100, exp: 999 }, "one"))).toBe(false);
    expect(valid(100, "one", "%..bad")).toBe(false);
  });

  it("distinguishes absent max age from invalid configured values", () => {
    expect(parseAdminSessionMaxAge(undefined)).toBe(28_800);
    expect(parseAdminSessionMaxAge("0")).toBeNull();
    expect(parseAdminSessionMaxAge("oops")).toBeNull();
  });

  it("strictly parses canonical same-scheme origins", () => {
    expect(parseAllowedWebOrigins("https://one.example,https://two.example:8443")).toEqual([
      "https://one.example",
      "https://two.example:8443",
    ]);
    for (const value of [
      undefined,
      "",
      "https://one.example/route",
      "https://user@one.example",
      "https://one.example,http://two.example",
      "https://one.example,",
    ]) {
      expect(parseAllowedWebOrigins(value)).toBeNull();
    }
  });
});

describe("admin sign-out", () => {
  afterEach(() => resetWebServerConfigForTests());

  it("requires the trusted origin and clears the existing HttpOnly cookie", async () => {
    initializeWebServerConfig({
      CONTROL_SERVICE_TOKEN: "control-token",
      ADMIN_DASHBOARD_PASSPHRASE: "secret",
      ADMIN_SESSION_SECRET: "signing-secret",
      PUBLIC_CLIENT_COOKIE_SECRET: "visitor-cookie-secret",
      WEB_ORIGIN: "https://dashboard.local",
    });
    const denied = await handleAdminLogout(
      new Request("https://dashboard.local/api/admin/session", { method: "DELETE" }),
    );
    expect(denied.status).toBe(403);

    const response = await handleAdminLogout(
      new Request("https://dashboard.local/api/admin/session", {
        method: "DELETE",
        headers: { origin: "https://dashboard.local" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBe(
      "checkout_surge_admin_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict; Secure",
    );
  });
});

describe("admin login limiter", () => {
  it("reports Retry-After and refills client and global buckets", async () => {
    const clientLimiter = new AdminLoginAttemptLimiter({
      clientCapacity: 1,
      globalCapacity: 10,
      refillWindowMs: 1_000,
    });
    expect(await clientLimiter.admit("a", 0)).toEqual({ outcome: "admitted" });
    expect(await clientLimiter.admit("a", 100)).toEqual({
      outcome: "limited",
      retryAfterSeconds: 1,
    });
    expect(await clientLimiter.admit("a", 1_000)).toEqual({ outcome: "admitted" });

    const globalLimiter = new AdminLoginAttemptLimiter({
      clientCapacity: 10,
      globalCapacity: 1,
      refillWindowMs: 1_000,
    });
    expect(await globalLimiter.admit("a", 0)).toEqual({ outcome: "admitted" });
    expect(await globalLimiter.admit("b", 100)).toEqual({
      outcome: "limited",
      retryAfterSeconds: 1,
    });
    expect(await globalLimiter.admit("b", 1_000)).toEqual({ outcome: "admitted" });
  });

  it("prunes stale client buckets and enforces a deterministic hard cap", async () => {
    const policy = { clientCapacity: 10, globalCapacity: 100, refillWindowMs: 1_000 };
    const limiter = new AdminLoginAttemptLimiter(policy, Date.now, 2);
    await limiter.admit("a", 0);
    await limiter.admit("b", 1);
    expect(limiter.clientBucketCount).toBe(2);
    await limiter.admit("c", 2);
    expect(limiter.clientBucketCount).toBe(2);
    await limiter.admit("d", 2_002);
    expect(limiter.clientBucketCount).toBe(1);
  });

  it("uses only a server-verifiable visitor cookie and ignores identity headers", () => {
    const secret = "visitor-cookie-secret";
    const visitorId = "123e4567-e89b-12d3-a456-426614174000";
    const credential = signPublicVisitorCredential(secret, visitorId, 100);
    expect(credential).not.toBeNull();
    const request = new Request("http://dashboard.local", {
      headers: {
        cookie: `${publicVisitorCookieName}=${credential}`,
        "x-client-id": "caller-supplied",
        forwarded: "for=evil",
        "x-forwarded-for": "evil",
      },
    });
    expect(readPublicVisitorIdentity(request, secret)).toEqual({ credential, visitorId });
    expect(readPublicVisitorIdentity(request, "wrong-secret")).toBeNull();
    expect(
      readPublicVisitorIdentity(
        new Request("http://dashboard.local", {
          headers: { forwarded: "for=evil", "x-forwarded-for": "evil", "x-client-id": visitorId },
        }),
        secret,
      ),
    ).toBeNull();
  });
});

describe("admin login workflow", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    resetWebServerConfigForTests();
    process.env = { ...originalEnv };
  });

  it("serializes every strict cookie attribute from validated origin policy", () => {
    expect(serializeSessionCookie("token", 60, false)).toBe(
      "checkout_surge_admin_session=token; Max-Age=60; Path=/; HttpOnly; SameSite=Strict",
    );
    expect(serializeSessionCookie("token", 60, true)).toBe(
      "checkout_surge_admin_session=token; Max-Age=60; Path=/; HttpOnly; SameSite=Strict; Secure",
    );
  });

  it("denies every untrusted unsafe Origin before limiter admission", async () => {
    const limiter = { admit: vi.fn().mockResolvedValue({ outcome: "admitted" as const }) };
    const handler = createAdminLoginHandler({
      limiter: () => limiter,
      resolveClient: () => "unknown",
      config: () => ({
        passphrase: "secret",
        sessionSecret: "signing",
        sessionMaxAgeSeconds: 60,
        secureCookie: true,
      }),
      now: () => new Date(100_000),
      requireOrigin: requireAdminOrigin,
    });
    process.env.WEB_ORIGIN = "https://dashboard.local";
    initializeWebServerConfig({
      CONTROL_SERVICE_TOKEN: "control-token",
      ADMIN_DASHBOARD_PASSPHRASE: "secret",
      ADMIN_SESSION_SECRET: "signing-secret",
      PUBLIC_CLIENT_COOKIE_SECRET: "visitor-cookie-secret",
      WEB_ORIGIN: "https://dashboard.local",
    });
    for (const origin of [undefined, "null", "not an origin", "https://evil.local"]) {
      const denied = await handler(
        new Request("https://dashboard.local/api/admin/session", {
          method: "POST",
          headers: origin === undefined ? {} : { origin },
          body: JSON.stringify({ passphrase: "secret" }),
        }),
      );
      expect(denied.status).toBe(403);
    }
    expect(limiter.admit).not.toHaveBeenCalled();
    const accepted = await handler(
      new Request("https://dashboard.local/api/admin/session", {
        method: "POST",
        headers: { origin: "https://dashboard.local" },
        body: JSON.stringify({ passphrase: "secret" }),
      }),
    );
    expect(accepted.status).toBe(200);
    expect(limiter.admit).toHaveBeenCalledOnce();
    expect(accepted.headers.get("set-cookie")).toMatch(
      /Max-Age=60; Path=\/; HttpOnly; SameSite=Strict; Secure/,
    );
  });

  it("returns a uniform limiting response before consulting credentials", async () => {
    const config = vi.fn(() => ({
      passphrase: "expected-secret",
      sessionSecret: "signing-secret",
      sessionMaxAgeSeconds: 60,
      secureCookie: false,
    }));
    const request = () =>
      new Request("http://dashboard.local", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: "candidate-secret" }),
      });
    const limited = createAdminLoginHandler({
      limiter: () => ({
        admit: vi.fn().mockResolvedValue({ outcome: "limited", retryAfterSeconds: 7 }),
      }),
      resolveClient: () => "unknown",
      config,
      now: () => new Date(0),
      requireOrigin: () => null,
    });
    const limitedResponse = await limited(request());
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get("retry-after")).toBe("7");
    const limitedPayload = await limitedResponse.json();
    expect(limitedPayload).toMatchObject({ code: "admin_login_rate_limited" });
    expect(JSON.stringify(limitedPayload)).not.toMatch(/candidate-secret|expected-secret/);
    expect(config).not.toHaveBeenCalled();
  });

  it("does not expose passphrases in admitted credential failures", async () => {
    const admit = vi.fn().mockResolvedValue({ outcome: "admitted" as const });
    const handler = createAdminLoginHandler({
      limiter: () => ({ admit }),
      resolveClient: () => "raw-client-identity",
      config: () => ({
        passphrase: "expected-secret",
        sessionSecret: "signing-secret",
        sessionMaxAgeSeconds: 60,
        secureCookie: false,
      }),
      now: () => new Date(0),
      requireOrigin: () => null,
    });
    const absentResponse = await handler(new Request("http://dashboard.local"));
    const response = await handler(
      new Request("http://dashboard.local", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: "candidate-secret" }),
      }),
    );
    expect(absentResponse.status).toBe(401);
    expect(response.status).toBe(401);
    await expect(absentResponse.json()).resolves.toMatchObject({
      code: "admin_passphrase_required",
      message: "A valid admin passphrase is required.",
    });
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toMatch(/candidate-secret|expected-secret|signing-secret/);
    expect(admit).toHaveBeenCalledWith("raw-client-identity", 0);
  });

  it.each([
    ["http://dashboard.local", false],
    ["https://dashboard.local", true],
  ])("derives production cookie security from %s", async (origin, secure) => {
    const security = parseAdminSecurityConfig({
      NODE_ENV: "production",
      WEB_ORIGIN: origin,
    });
    expect(security).not.toBeNull();
    if (!security) throw new Error("Expected valid security configuration");
    const handler = createAdminLoginHandler({
      limiter: () => ({ admit: vi.fn().mockResolvedValue({ outcome: "admitted" }) }),
      resolveClient: () => "unknown",
      config: () => ({
        passphrase: "candidate",
        sessionSecret: "signing",
        sessionMaxAgeSeconds: security.sessionMaxAgeSeconds,
        secureCookie: security.secureCookie,
      }),
      now: () => new Date(0),
      requireOrigin: () => null,
    });
    const response = await handler(
      new Request(origin, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: "candidate" }),
      }),
    );
    expect(response.headers.get("set-cookie")?.includes("; Secure")).toBe(secure);
  });

  it("rejects non-JSON and non-string credential bodies before limiter admission", async () => {
    const admit = vi.fn().mockResolvedValue({ outcome: "admitted" as const });
    const handler = createAdminLoginHandler({
      limiter: () => ({ admit }),
      resolveClient: () => "unknown",
      config: () => ({
        passphrase: "expected-secret",
        sessionSecret: "signing-secret",
        sessionMaxAgeSeconds: 60,
        secureCookie: false,
      }),
      now: () => new Date(0),
      requireOrigin: () => null,
    });
    const notJson = await handler(
      new Request("http://dashboard.local", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
    );
    const nonString = await handler(
      new Request("http://dashboard.local", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: 123 }),
      }),
    );
    expect(notJson.status).toBe(401);
    expect(nonString.status).toBe(401);
    await expect(notJson.json()).resolves.toMatchObject({ code: "admin_passphrase_required" });
    await expect(nonString.json()).resolves.toMatchObject({ code: "admin_passphrase_required" });
    expect(admit).not.toHaveBeenCalled();
  });

  it("signs in with a non-ASCII configured passphrase sent as a JSON body", async () => {
    const handler = createAdminLoginHandler({
      limiter: () => ({ admit: vi.fn().mockResolvedValue({ outcome: "admitted" as const }) }),
      resolveClient: () => "unknown",
      config: () => ({
        passphrase: "密码🔒",
        sessionSecret: "signing-secret",
        sessionMaxAgeSeconds: 60,
        secureCookie: false,
      }),
      now: () => new Date(0),
      requireOrigin: () => null,
    });
    const response = await handler(
      new Request("http://dashboard.local/api/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: "密码🔒" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("checkout_surge_admin_session=");
  });
});

function signedJson(value: unknown, secret: string): string {
  return signedPayload(JSON.stringify(value), secret);
}

function signedPayload(value: string, secret: string): string {
  const payload = Buffer.from(value).toString("base64url");
  return signEncodedPayload(payload, secret);
}

function signEncodedPayload(payload: string, secret: string): string {
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
