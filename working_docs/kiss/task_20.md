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

- [ ] Login attempts use one bounded local limiter keyed by conservative, trusted client identity.
- [ ] HMAC, cookie, constant-time, exact-Origin/CSRF, and uniform-failure tests remain green.
- [ ] Redis login coordination and replica-only Caddy attestation mechanism are fully deleted.
- [ ] Config/docs make the single-instance limit explicit and do not recommend unsafe forwarded-header trust.
- [ ] Focused tests verify limiter bounds and retained security behavior.

## Focused verification

Run `pnpm --filter web test:unit`, relevant API trusted-proxy tests if touched, and web/API type-checks. Do not run composition or characterization suites.

## Working record

Pending — record local limiter policy, trusted identity source, deleted attestation/configuration paths, retained security checks, and verification results.
