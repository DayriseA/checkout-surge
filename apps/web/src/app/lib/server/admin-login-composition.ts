import Redis from "ioredis";
import { createAdminLoginHandler, defaultAdminLoginDependencies } from "./admin-login";
import {
  AdminLoginAttemptLimiter,
  MemoryAdminLoginAttemptStore,
  RedisAdminLoginAttemptStore,
  resolveTrustedAdminClient,
} from "./admin-login-limiter";
import { resetWebServerConfigForTests, webServerConfig } from "./config";

let limiter: AdminLoginAttemptLimiter | undefined;

export function adminLoginAttemptLimiter(): AdminLoginAttemptLimiter {
  if (limiter) return limiter;
  const config = webServerConfig();
  const policy = {
    clientCapacity: config.adminLoginClientAttempts,
    globalCapacity: config.adminLoginGlobalAttempts,
    refillWindowMs: config.adminLoginWindowSeconds * 1000,
  };
  const store =
    config.isProduction && config.redisUrl
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
    return resolveTrustedAdminClient(request, webServerConfig().adminEdgeAttestationSecret ?? undefined);
  },
  config() {
    const config = webServerConfig();
    return {
      passphrase: config.adminDashboardPassphrase,
      sessionSecret: config.adminSessionSecret,
      sessionMaxAgeSeconds: config.adminSessionMaxAgeSeconds,
      secureCookie: config.secureAdminCookie,
    };
  },
  now: () => new Date(),
});

export function resetAdminLoginAttemptLimiterForTests(): void {
  limiter = undefined;
  resetWebServerConfigForTests();
}
