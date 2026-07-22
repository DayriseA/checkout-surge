import { createAdminLoginHandler, defaultAdminLoginDependencies } from "./admin-login";
import { AdminLoginAttemptLimiter } from "./admin-login-limiter";
import { resetWebServerConfigForTests, webServerConfig } from "./config";
import { readPublicVisitorIdentity } from "./public-visitor";

let limiter: AdminLoginAttemptLimiter | undefined;

export function adminLoginAttemptLimiter(): AdminLoginAttemptLimiter {
  if (limiter) return limiter;
  const config = webServerConfig();
  const policy = {
    clientCapacity: config.adminLoginClientAttempts,
    globalCapacity: config.adminLoginGlobalAttempts,
    refillWindowMs: config.adminLoginWindowSeconds * 1000,
  };
  limiter = new AdminLoginAttemptLimiter(policy);
  return limiter;
}

export const handleAdminLogin = createAdminLoginHandler({
  ...defaultAdminLoginDependencies,
  limiter: adminLoginAttemptLimiter,
  resolveClient(request) {
    const config = webServerConfig();
    return (
      readPublicVisitorIdentity(request, config.publicClientCookieSecret)?.visitorId ?? "unknown"
    );
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
