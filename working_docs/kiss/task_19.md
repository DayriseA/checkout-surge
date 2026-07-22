# Task 19 — Make dashboard recovery admission local and bounded

## Execution context

Task 19 of 45, Phase 4, after task 10's single-API-instance decision. Primary ownership is the API dashboard recovery workflow/admission service; routes authenticate/authorize and call it, while runtime composition provides dependencies. Keep web recovery UI as a consumer, not an authority.

## Why

The Redis recovery limiter, scripts, keys, and special unavailable mode exist to coordinate replicas that this topology intentionally excludes.

## Required outcome

Replace deployment-wide Redis dashboard-recovery budgets with small local admission. Preserve SSE connection caps, cancellation/deadline behavior, bounded fan-out, local concurrency, and bounded per-source/global request budget. Delete the Redis limiter client/scripts/keys and unavailable mode that only exists because of it. Preserve initial public/admin authoritative gating.

## Scope and concrete current paths

- `apps/api/src/services/dashboard-recovery-admission.ts`, `dashboard-recovery-workflow.ts`, `dashboard-recovery-service.ts`, routes, runtime/index/config, and recovery tests.
- Dashboard event fanout and web recovery hook/retry consumers where response semantics are exposed.
- Redis dashboard/recovery helpers in `packages/db/src/`, environment examples, docs, and any Lua/script assets. Verify paths before editing.

## Retained behavior and non-goals

Keep trusted source identity, public/admin gating, cancellation/deadlines, fan-out bounds, connection caps, and a clear local overloaded response where one is genuinely needed. Do not weaken authoritative snapshot authorization or redesign the revisioned dashboard protocol reserved for Phase 6.

## Acceptance

- [x] One local admission boundary enforces documented concurrency plus per-source/global request budgets.
- [x] In-flight recovery honors cancellation/deadline and does not bypass SSE/fan-out limits.
- [x] Initial public/admin recovery gating remains at the route/workflow boundary.
- [x] Redis limiter client, keys, scripts, replica-unavailable branch, config, docs, and tests are removed.
- [x] Focused tests cover allow, local budget exhaustion, cancellation, and authorized recovery.

## Focused verification

Run `pnpm --filter api test:api`, `pnpm --filter web test:unit` for affected recovery UI, and API/web type-checks. Run DB tests only if a shared Redis helper is removed. Do not run composition or characterization suites.

## Working record

- Status: complete. Fresh review #2 approved the change after one documentation-only correction; no push was made.
- Local admission design: `DashboardRecoveryAdmissionService` is the one process-local authority. Defaults remain three concurrent recovery builds, 60 admitted requests globally per 60-second fixed window, and 12 admitted requests per signed visitor or normalized network source per window. The source map records only admitted sources, so it can contain at most the configured global request count, and advancing to a later epoch window clears both counters and the map. An earlier wall-clock window cannot reopen a spent budget. No generic limiter framework or second fallback mode was introduced.
- Retained response and lifecycle semantics: fixed-window exhaustion remains HTTP 429 `dashboard_recovery_rate_limited`; local concurrent-capacity exhaustion remains HTTP 503 `dashboard_recovery_unavailable` with `details.reason = at_capacity`; deadline expiry remains the same 503 code with `details.reason = timed_out`; and a disconnected caller receives no attempted response. The workflow still releases an acquired permit exactly once on success, failure, deadline, or disconnect. Recovery operations still own and close their short-lived PostgreSQL, Redis projection, and BullMQ resources. The separate SSE fan-out remains bounded by total/per-source connection caps and per-client frame/byte queues.
- Removed Redis resources and state: deleted the inline recovery-admission Lua script, the `DashboardRecoveryBudgetStore` port, `RedisDashboardRecoveryBudgetStore`, hashed `dashboard:recovery:{window}:global` and per-source keys, per-admission Redis client construction, Redis-operation abort/disconnect handling, shared-store failure tests, the admission `unavailable` outcome, workflow `limiter_unavailable` outcome, and route/docs claims for that mode. Search confirmed there was no dedicated `packages/db` helper or separate Lua asset to remove. Local concurrency, global/per-source/window/retry/timeout configuration remains because the local policy and route still consume it; none of those settings is Redis-specific.
- Identity, authorization, and gating evidence: `createDashboardSourceResolver` remains unchanged and accepts only an HMAC-verified public visitor credential before falling back to the proxy-derived normalized network source. The recovery route still resolves that source before invoking the workflow. Public, Watch, and authenticated admin server renders still start with unavailable/pending authoritative recovery; public and admin start controls remain blocked until the mounted browser receives an available current snapshot. The Next BFF still ignores caller-supplied visitor identity and forwards only its server-verified credential. The web recovery consumer still honors `Retry-After`, coalesces requests, bounds automatic retries, and keeps the existing Phase 6 mixed projection protocol unchanged.
- Verification passed: `pnpm --filter api exec vitest run --config vitest.api.config.ts test/dashboard-recovery-admission.test.ts test/dashboard-recovery-workflow.test.ts test/dashboard-routes.test.ts` (15/15); `pnpm --filter api type-check`; `pnpm --filter api lint`; `pnpm --filter web test:unit` (26 files, 239/239); `node --test scripts/runtime-recovery-soak.test.mjs` (4/4); `node --test scripts/runtime-image-contract.test.mjs scripts/runtime-recovery-soak.test.mjs` (12/12); focused `dashboard-source-identity` and `dashboard-event-fanout` files passed within the attempted three-file command; `pnpm exec biome check apps/api/src/index.ts apps/api/src/routes/dashboard-routes.ts apps/api/src/services/dashboard-recovery-admission.ts apps/api/src/services/dashboard-recovery-workflow.ts apps/api/test/dashboard-recovery-admission.test.ts apps/api/test/dashboard-recovery-workflow.test.ts apps/api/test/dashboard-routes.test.ts scripts/runtime-recovery-soak.mjs scripts/runtime-recovery-soak.test.mjs`; and `git diff --check`.
- Required API-suite caveat: the first `pnpm --filter api test:api` run failed because the isolated test services were not running. After `pnpm test:infra:up`, the exact command ran with test infrastructure but remained red only in three untouched `test/postgres-buy-persistence.test.ts` uniqueness-race cases (`reservations_pkey`, `reservations_reservation_token_unique`, and wrapped-cause recovery), where current PostgreSQL error recognition rejects instead of returning the durable winner. Task 19 does not touch that persistence code or test. `pnpm test:infra:down` removed both containers, volumes, and the test network afterward.
- Formatting caveat and skipped checks: root `pnpm format:check` remains red with 26 existing diagnostics in untouched files; the targeted Biome check above passes every changed code/script file. DB package tests were not run because no shared DB helper was removed. Web type-check/lint were not run because no web source or test file changed; the full web unit lane covered the exposed retry/gating behavior. Per repository instructions, `pnpm test:composition` and `pnpm test:characterization` were not run.
- Review #1 correction: updated Task 16's retained-vocabulary matrix so it no longer describes recovery capacity as shared or lists the removed Redis limiter-failure mode. It now records process-local recovery concurrency/deadline `503` semantics separately from fixed-window `429` exhaustion without changing contracts or the Phase 6 protocol. Proportionate documentation-only verification reran the stale-reference searches and `git diff --check`; both passed apart from Task 19's intentional historical rationale/removal record.
