import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Redis from "ioredis";
import {
  parseAdminSecurityConfig,
  parseAllowedWebOrigins,
} from "../src/app/lib/server/admin-config";
import { createAdminLoginHandler, serializeSessionCookie } from "../src/app/lib/server/admin-login";
import { requireAdminOrigin } from "../src/app/lib/server/admin-origin";
import {
  initializeWebServerConfig,
  resetWebServerConfigForTests,
} from "../src/app/lib/server/config";
import {
  createAdminSessionToken,
  isValidAdminSessionToken,
  parseAdminSessionMaxAge,
  verifyAdminPassphrase,
} from "../src/app/lib/server/admin-session";
import {
  AdminLoginAttemptLimiter,
  MemoryAdminLoginAttemptStore,
  RedisAdminLoginAttemptStore,
  resolveTrustedAdminClient,
} from "../src/app/lib/server/admin-login-limiter";

describe("admin session core", () => {
  it("compares credentials through fixed-length digests", () => {
    expect(verifyAdminPassphrase("secret", "secret")).toBe(true);
    expect(verifyAdminPassphrase("", "")).toBe(true);
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
    expect(() => valid(100, "one", "%..bad")).not.toThrow();
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

describe("admin login limiter", () => {
  it("reports Retry-After and refills client and global buckets", async () => {
    const clientLimiter = new AdminLoginAttemptLimiter(new MemoryAdminLoginAttemptStore(), {
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

    const globalLimiter = new AdminLoginAttemptLimiter(new MemoryAdminLoginAttemptStore(), {
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
    const store = new MemoryAdminLoginAttemptStore(2);
    await store.admit("a".repeat(64), 0, policy);
    await store.admit("b".repeat(64), 1, policy);
    expect(store.clientBucketCount).toBe(2);
    await store.admit("c".repeat(64), 2, policy);
    expect(store.clientBucketCount).toBe(2);
    await store.admit("d".repeat(64), 2_002, policy);
    expect(store.clientBucketCount).toBe(1);
  });

  it("hashes identities before storage and maps store outages to unavailable", async () => {
    const admit = vi.fn().mockResolvedValue({ outcome: "admitted" as const });
    const limiter = new AdminLoginAttemptLimiter(
      { admit },
      { clientCapacity: 1, globalCapacity: 1, refillWindowMs: 1_000 },
    );
    await limiter.admit("raw-client-identity", 0);
    expect(admit.mock.calls[0]?.[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(admit.mock.calls[0]?.[0]).not.toContain("raw-client-identity");

    const unavailable = new AdminLoginAttemptLimiter(
      { admit: vi.fn().mockRejectedValue(new Error("store down")) },
      { clientCapacity: 1, globalCapacity: 1, refillWindowMs: 1_000 },
    );
    await expect(unavailable.admit("identity", 0)).resolves.toEqual({ outcome: "unavailable" });
  });

  it("retains global admission history", async () => {
    const limiter = new AdminLoginAttemptLimiter(new MemoryAdminLoginAttemptStore(), {
      clientCapacity: 5,
      globalCapacity: 2,
      refillWindowMs: 1000,
    });
    await limiter.admit("a", 0);
    expect((await limiter.admit("b", 1)).outcome).toBe("admitted");
    expect((await limiter.admit("c", 2)).outcome).toBe("limited");
  });

  it("is atomic across concurrent limiter instances sharing a store", async () => {
    const store = new MemoryAdminLoginAttemptStore();
    const policy = { clientCapacity: 10, globalCapacity: 2, refillWindowMs: 10_000 };
    const first = new AdminLoginAttemptLimiter(store, policy);
    const second = new AdminLoginAttemptLimiter(store, policy);
    const results = await Promise.all([
      first.admit("a", 0),
      second.admit("b", 0),
      first.admit("c", 0),
    ]);
    expect(results.filter((result) => result.outcome === "admitted")).toHaveLength(2);
    expect(results.filter((result) => result.outcome === "limited")).toHaveLength(1);
  });

  it("uses one Redis eval with same-slot bounded keys and validates its response", async () => {
    const evalMock = vi.fn().mockResolvedValue([0, 1500]);
    const store = new RedisAdminLoginAttemptStore({ eval: evalMock } as unknown as Redis);
    const admission = await store.admit("a".repeat(64), 100, {
      clientCapacity: 2,
      globalCapacity: 3,
      refillWindowMs: 1000,
    });
    expect(admission).toEqual({ outcome: "limited", retryAfterSeconds: 2 });
    expect(evalMock).toHaveBeenCalledOnce();
    const args = evalMock.mock.calls[0];
    expect(args).toBeDefined();
    if (!args) throw new Error("Expected Redis eval call");
    expect(args[1]).toBe(2);
    expect(args[2]).toMatch(/\{admin-login\}.*client:[0-9a-f]{64}$/);
    expect(args[3]).toMatch(/\{admin-login\}.*global$/);
    expect(String(args[0])).toContain("PEXPIRE");

    for (const invalid of [
      [0.5, 0],
      [0, "1000"],
      [0, Number.NaN],
    ]) {
      evalMock.mockResolvedValueOnce(invalid);
      await expect(
        store.admit("b".repeat(64), 100, {
          clientCapacity: 2,
          globalCapacity: 3,
          refillWindowMs: 1000,
        }),
      ).rejects.toThrow("Invalid Redis limiter result");
    }
  });

  it("trusts only bounded identity with a valid server attestation", () => {
    const trusted = new Request("http://dashboard.local", {
      headers: {
        "x-checkout-surge-client-id": "203.0.113.4",
        "x-checkout-surge-client-attestation": "edge",
        forwarded: "for=evil",
        "x-forwarded-for": "evil",
      },
    });
    expect(resolveTrustedAdminClient(trusted, "edge")).toBe("203.0.113.4");
    expect(resolveTrustedAdminClient(trusted, "wrong")).toBe("unknown");
    expect(
      resolveTrustedAdminClient(
        new Request("http://dashboard.local", { headers: { "x-forwarded-for": "203.0.113.4" } }),
        "edge",
      ),
    ).toBe("unknown");
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
    const store = { admit: vi.fn().mockResolvedValue({ outcome: "admitted" as const }) };
    const handler = createAdminLoginHandler({
      limiter: () =>
        new AdminLoginAttemptLimiter(store, {
          clientCapacity: 1,
          globalCapacity: 1,
          refillWindowMs: 1000,
        }),
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
          headers: {
            ...(origin === undefined ? {} : { origin }),
            "x-admin-passphrase": "secret",
          },
        }),
      );
      expect(denied.status).toBe(403);
    }
    expect(store.admit).not.toHaveBeenCalled();
    const accepted = await handler(
      new Request("https://dashboard.local/api/admin/session", {
        method: "POST",
        headers: { origin: "https://dashboard.local", "x-admin-passphrase": "secret" },
      }),
    );
    expect(accepted.status).toBe(200);
    expect(store.admit).toHaveBeenCalledOnce();
    expect(accepted.headers.get("set-cookie")).toMatch(
      /Max-Age=60; Path=\/; HttpOnly; SameSite=Strict; Secure/,
    );
  });

  it("returns uniform limiting and unavailable responses before consulting credentials", async () => {
    const config = vi.fn(() => ({
      passphrase: "expected-secret",
      sessionSecret: "signing-secret",
      sessionMaxAgeSeconds: 60,
      secureCookie: false,
    }));
    const request = new Request("http://dashboard.local", {
      headers: { "x-admin-passphrase": "candidate-secret" },
    });
    const limited = createAdminLoginHandler({
      limiter: () =>
        new AdminLoginAttemptLimiter(
          { admit: vi.fn().mockResolvedValue({ outcome: "limited", retryAfterSeconds: 7 }) },
          { clientCapacity: 1, globalCapacity: 1, refillWindowMs: 1_000 },
        ),
      resolveClient: () => "unknown",
      config,
      now: () => new Date(0),
      requireOrigin: () => null,
    });
    const limitedResponse = await limited(request);
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get("retry-after")).toBe("7");
    const limitedPayload = await limitedResponse.json();
    expect(limitedPayload).toMatchObject({ code: "admin_login_rate_limited" });
    expect(JSON.stringify(limitedPayload)).not.toMatch(/candidate-secret|expected-secret/);
    expect(config).not.toHaveBeenCalled();

    const unavailable = createAdminLoginHandler({
      limiter: () =>
        new AdminLoginAttemptLimiter(
          { admit: vi.fn().mockRejectedValue(new Error("down")) },
          { clientCapacity: 1, globalCapacity: 1, refillWindowMs: 1_000 },
        ),
      resolveClient: () => "unknown",
      config,
      now: () => new Date(0),
      requireOrigin: () => null,
    });
    const unavailableResponse = await unavailable(request);
    expect(unavailableResponse.status).toBe(503);
    await expect(unavailableResponse.json()).resolves.toMatchObject({
      code: "admin_login_limiter_unavailable",
    });
    expect(config).not.toHaveBeenCalled();
  });

  it("does not expose passphrases in admitted credential failures", async () => {
    const admit = vi.fn().mockResolvedValue({ outcome: "admitted" as const });
    const handler = createAdminLoginHandler({
      limiter: () =>
        new AdminLoginAttemptLimiter(
          { admit },
          { clientCapacity: 1, globalCapacity: 1, refillWindowMs: 1_000 },
        ),
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
    const response = await handler(
      new Request("http://dashboard.local", {
        headers: { "x-admin-passphrase": "candidate-secret" },
      }),
    );
    expect(response.status).toBe(401);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toMatch(/candidate-secret|expected-secret|signing-secret/);
    expect(admit.mock.calls[0]?.[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(admit.mock.calls[0]?.[0]).not.toMatch(/candidate-secret|raw-client-identity/);
  });

  it.each([
    [
      "absent passphrase",
      { passphrase: null, sessionSecret: "signing", sessionMaxAgeSeconds: 60, secureCookie: false },
      "admin_passphrase_not_configured",
    ],
    [
      "absent session secret",
      {
        passphrase: "candidate",
        sessionSecret: null,
        sessionMaxAgeSeconds: 60,
        secureCookie: false,
      },
      "admin_session_secret_not_configured",
    ],
    ["invalid present max age", null, "admin_session_config_invalid"],
  ])("counts admitted attempts before %s configuration failures", async (_case, configured, code) => {
    const admit = vi.fn().mockResolvedValue({ outcome: "admitted" as const });
    const config = vi.fn(() => configured);
    const handler = createAdminLoginHandler({
      limiter: () =>
        new AdminLoginAttemptLimiter(
          { admit },
          { clientCapacity: 1, globalCapacity: 1, refillWindowMs: 1_000 },
        ),
      resolveClient: () => "raw-identity",
      config,
      now: () => new Date(0),
      requireOrigin: () => null,
    });
    const response = await handler(
      new Request("http://dashboard.local", {
        headers: { "x-admin-passphrase": "candidate" },
      }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code });
    expect(admit).toHaveBeenCalledOnce();
    expect(config).toHaveBeenCalledOnce();
  });

  it.each([
    ["http://dashboard.local", false],
    ["https://dashboard.local", true],
  ])("derives production cookie security from %s", async (origin, secure) => {
    const security = parseAdminSecurityConfig({
      NODE_ENV: "production",
      WEB_ORIGIN: origin,
      REDIS_URL: "redis://redis:6379",
      ADMIN_EDGE_ATTESTATION_SECRET: "edge-secret",
    });
    expect(security).not.toBeNull();
    if (!security) throw new Error("Expected valid security configuration");
    const handler = createAdminLoginHandler({
      limiter: () =>
        new AdminLoginAttemptLimiter(
          { admit: vi.fn().mockResolvedValue({ outcome: "admitted" }) },
          { clientCapacity: 1, globalCapacity: 1, refillWindowMs: 1_000 },
        ),
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
        headers: { "x-admin-passphrase": "candidate" },
      }),
    );
    expect(response.headers.get("set-cookie")?.includes("; Secure")).toBe(secure);
  });

  it("maps request-time invalid configuration to a stable unavailable response", async () => {
    const handler = createAdminLoginHandler({
      limiter: () =>
        new AdminLoginAttemptLimiter(new MemoryAdminLoginAttemptStore(), {
          clientCapacity: 1,
          globalCapacity: 1,
          refillWindowMs: 1000,
        }),
      resolveClient: () => "unknown",
      config: () => null,
      now: () => new Date(0),
      requireOrigin: () => null,
    });
    const response = await handler(
      new Request("http://dashboard.local", { headers: { "x-admin-passphrase": "candidate" } }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "admin_session_config_invalid" });
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
