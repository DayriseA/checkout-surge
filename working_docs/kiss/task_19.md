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

- [ ] One local admission boundary enforces documented concurrency plus per-source/global request budgets.
- [ ] In-flight recovery honors cancellation/deadline and does not bypass SSE/fan-out limits.
- [ ] Initial public/admin recovery gating remains at the route/workflow boundary.
- [ ] Redis limiter client, keys, scripts, replica-unavailable branch, config, docs, and tests are removed.
- [ ] Focused tests cover allow, local budget exhaustion, cancellation, and authorized recovery.

## Focused verification

Run `pnpm --filter api test:api`, `pnpm --filter web test:unit` for affected recovery UI, and API/web type-checks. Run DB tests only if a shared Redis helper is removed. Do not run composition or characterization suites.

## Working record

Pending — record local limits, retained response semantics, removed Redis resources, auth/gating evidence, and commands run.
