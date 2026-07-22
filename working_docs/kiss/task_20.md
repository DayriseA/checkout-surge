# Task 20 — Simplify admin login limiting and remove edge attestation

## Execution context

Task 20 of 45, Phase 4, contingent on the single-web-instance topology in task 10. Primary ownership is the web server admin-login boundary; route handlers use it and runtime config supplies trusted request context. This task follows the checklist's security constraint: do not create infrastructure clients in route modules.

## Why

Redis login coordination and Caddy attestation secret/header handling exist solely to coordinate replicas. They obscure the actual local security controls and can invite unsafe proxy-header trust.

## Required outcome

Use a bounded process-local admin login limiter. Retain HMAC session integrity, HttpOnly/strict cookie settings, constant-time passphrase comparison, exact Origin/CSRF checks, uniform authentication failures, and conservative client identity. Remove Redis login store/client/config and Caddy attestation secret/header/config/docs/tests that only coordinate replicas. Never trust arbitrary forwarded headers.

## Scope and concrete current paths

- `apps/web/src/app/lib/server/admin-login.ts`, `admin-login-limiter.ts`, `admin-login-composition.ts`, auth routes, and web tests.
- Web runtime env/config, Caddy/Compose configuration and examples, trusted-proxy handling in API only where it couples to attestation, and security docs.
- Redis login helper/configuration paths; verify their exact locations before modification.

## Retained behavior and non-goals

Preserve all listed session, cookie, secret-comparison, Origin/CSRF, uniform-failure, and conservative identity protections. Local limiting is not a reason to accept arbitrary `X-Forwarded-*` values or to promise cross-instance rate limiting. Do not alter general admin authorization policy.

## Acceptance

- [x] Login attempts use one bounded local limiter keyed by conservative, trusted client identity.
- [x] HMAC, cookie, constant-time, exact-Origin/CSRF, and uniform-failure tests remain green.
- [x] Redis login coordination and replica-only Caddy attestation mechanism are fully deleted.
- [x] Config/docs make the single-instance limit explicit and do not recommend unsafe forwarded-header trust.
- [x] Focused tests verify limiter bounds and retained security behavior.

## Focused verification

Run `pnpm --filter web test:unit`, relevant API trusted-proxy tests if touched, and web/API type-checks. Do not run composition or characterization suites.

## Working record

- Status: complete
- Local policy: `AdminLoginAttemptLimiter` is the one process-local authority for the accepted single Next.js process. It keeps per-client and global token buckets using the configured `ADMIN_LOGIN_CLIENT_ATTEMPTS`, `ADMIN_LOGIN_GLOBAL_ATTEMPTS`, and `ADMIN_LOGIN_WINDOW_SECONDS`, returns bounded `Retry-After` guidance when either bucket is exhausted, hashes client identities before storing them, prunes client buckets after two refill windows, and caps them at 1,024 with deterministic oldest-entry eviction. The global bucket is retained independently, so rotating otherwise valid client identities cannot remove the aggregate process-wide bound. State intentionally resets when the sole web process restarts and makes no cross-instance claim.
- Trusted identity and fallback: Login reuses the UUID from an existing HMAC-verified `checkout_surge_public_visitor` cookie. It does not mint a visitor credential during login. A missing, malformed, incorrectly signed, or wrongly keyed cookie maps to the shared `unknown` bucket. Caller-supplied identity headers, `Forwarded`, and `X-Forwarded-*` are not read. The existing public visitor secret remains distinct from the admin-session HMAC secret.
- Deleted Redis/attestation paths: Removed the login attempt-store port, memory/Redis store alternatives, Redis Lua script/key namespace, Redis client construction/retry configuration, limiter `unavailable` result mode, web admin Redis/attestation config fields and validation, the web package's direct `ioredis` dependency and lockfile importer, the web service's Redis dependency and inherited `REDIS_URL`, the Caddy client-identity/attestation headers and proxy secret environment, both example secret entries, and current documentation/tests for the replica-only mechanism. Compose now separates common app environment from data-store environment so API, worker, Mock ERP, and setup retain their existing store URLs while web does not receive them.
- Retained security evidence: Admin session tokens remain versioned and HMAC-authenticated; passphrases are still compared through fixed-length digests with `timingSafeEqual`; successful session cookies remain `HttpOnly`, `SameSite=Strict`, path-scoped, and `Secure` for validated HTTPS origins; unsafe admin requests still require an exact configured Origin before limiter or credential work; absent and incorrect passphrases retain the same `401 admin_passphrase_required` response; limited attempts retain `429 admin_login_rate_limited` with `Retry-After`; unexpected limiter failures still fail closed with the existing safe `503` response. General admin authorization and API trusted-proxy behavior were not changed because search confirmed no coupling to the removed web/Caddy attestation.
- Verification: `pnpm install --lockfile-only` updated the lockfile, and `pnpm install --offline` synchronized workspace links. `pnpm --filter web test:unit` passed 26 files / 237 tests. `pnpm --filter web type-check` passed after Next route type generation. `pnpm --filter web lint` passed for 93 files. `node --test scripts/runtime-image-contract.test.mjs` passed 8/8 tests. `docker compose config --quiet` passed. A rendered `docker compose --profile setup config --format json` assertion passed and confirmed web depends only on API, Mock ERP, and load orchestrator, web has no `REDIS_URL`, dashboard-proxy has no environment, and API/worker/runtime-setup retain `REDIS_URL`. `docker compose -f docker-compose.yml -f docker-compose.dev.yml config --quiet` and `docker compose -f docker-compose.yml -f docker-compose.dev.yml -f .devcontainer/docker-compose.yml config --quiet` passed. `pnpm exec biome check --write apps/web/src/app/lib/server/admin-login.ts apps/web/src/app/lib/server/admin-login-limiter.ts apps/web/src/app/lib/server/admin-login-composition.ts apps/web/src/app/lib/server/admin-config.ts apps/web/src/app/lib/server/config.ts apps/web/src/app/lib/server/public-visitor.ts apps/web/test/admin-session.test.ts apps/web/test/config.test.ts apps/web/test/caddy-dashboard-events-config.test.ts apps/web/package.json` completed successfully. Focused stale-reference searches confirmed no current Redis login store/script/client, attestation secret/header, or web `ioredis` import/declaration remains; `pnpm --filter web list --depth 0` confirmed the direct dependency is absent. `git diff --check` passed.
- Skips: API trusted-proxy tests/type-check/lint were not run because API source, configuration, tests, and its Caddy trust boundary were not coupled to this web-only attestation and were not changed. Test infrastructure was not needed. Per repository instruction, `pnpm test:composition` and `pnpm test:characterization` were not run.
