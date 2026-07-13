import Redis from "ioredis";
import { parseAdminSecurityConfig } from "./admin-config";
import { createAdminLoginHandler, defaultAdminLoginDependencies } from "./admin-login";
import {
  AdminLoginAttemptLimiter,
  MemoryAdminLoginAttemptStore,
  RedisAdminLoginAttemptStore,
  resolveTrustedAdminClient,
} from "./admin-login-limiter";
import { readWebSecret } from "./config";

let limiter: AdminLoginAttemptLimiter | undefined;

export function adminLoginAttemptLimiter(): AdminLoginAttemptLimiter {
  if (limiter) return limiter;
  const config = parseAdminSecurityConfig(process.env);
  if (!config) throw new Error("Invalid admin security configuration");
  const policy = {
    clientCapacity: config.loginClientAttempts,
    globalCapacity: config.loginGlobalAttempts,
    refillWindowMs: config.loginWindowSeconds * 1000,
  };
  const store =
    process.env.NODE_ENV === "production" && config.redisUrl
      ? new RedisAdminLoginAttemptStore(
          new Redis(config.redisUrl, {
            lazyConnect: true,
            connectTimeout: 2_000,
            commandTimeout: 2_000,
            maxRetriesPerRequest: 1,
            enableOfflineQueue: true,
            retryStrategy: () => null,
          }),
        )
      : new MemoryAdminLoginAttemptStore();
  limiter = new AdminLoginAttemptLimiter(store, policy);
  return limiter;
}

export const handleAdminLogin = createAdminLoginHandler({
  ...defaultAdminLoginDependencies,
  limiter: adminLoginAttemptLimiter,
  resolveClient(request) {
    return resolveTrustedAdminClient(request, process.env.ADMIN_EDGE_ATTESTATION_SECRET);
  },
  config() {
    const security = parseAdminSecurityConfig(process.env);
    if (!security) return null;
    return {
      passphrase: readWebSecret(process.env, "ADMIN_DASHBOARD_PASSPHRASE"),
      sessionSecret: readWebSecret(process.env, "ADMIN_SESSION_SECRET"),
      sessionMaxAgeSeconds: security.sessionMaxAgeSeconds,
      secureCookie: security.secureCookie,
    };
  },
  now: () => new Date(),
});

export function resetAdminLoginAttemptLimiterForTests(): void {
  limiter = undefined;
}
