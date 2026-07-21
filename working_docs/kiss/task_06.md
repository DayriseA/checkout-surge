# Task 06 — Remove confirmed dead routes, predicates, fetches, and placeholders

## Execution context

Task 6 of 45. Phase 1: remove unambiguous residue. Primary ownership boundary: each proven-unreachable route/client/script and its direct tests/docs. Dependencies: Phase 0 must provide a reliable baseline; this task must not delete behavior simply because it is uncommon. This record is standalone. Follow the quality checklist: keep routes thin, preserve application-service ownership, and delete tests only with the dead surface they pin.

## Why this task exists

The project carries dashboard/admin proxy and read-code candidates, placeholder scripts such as `scripts/not-implemented.mjs` and `scripts/no-tests-yet.mjs`, and related commands/docs/tests. Dead surface increases maintenance cost and makes the public demo boundary unclear.

## Required outcome

Delete only surfaces proven unreachable or unused, together with their direct tests, commands, and documentation. Preserve useful low-frequency behavior.

## Scope and implementation guidance

Verify paths before editing because the checkout may drift. Start with reachability/usage proof using repository references, route registration, imports, package scripts, docs, and tests. Inspect candidate areas under `apps/web/src/app`, admin/dashboard proxy and backend-read code, `apps/api/src`, `scripts/not-implemented.mjs`, `scripts/no-tests-yet.mjs`, `package.json`, `docs/`, and their tests. Record evidence for every deletion (for example no route registration, no production import, and no documented supported workflow). Remove associated tests/docs only when they describe the deleted surface; retain a test if it protects a still-supported contract.

## Retained behavior and non-goals

Retain all documented gold signals, public/admin operations, focused diagnostic reads, and low-frequency but reachable workflows. Do not use file size, lack of recent edits, or lack of a direct test alone as proof of deadness.

## Acceptance criteria

- [x] Every deleted surface has recorded reachability/usage proof.
- [x] Confirmed dead routes, predicates, fetches, placeholders, commands, docs, and direct tests are removed together.
- [x] No useful supported behavior is deleted solely for low frequency.
- [x] Remaining route and composition boundaries retain their existing responsibilities.

## Verification

Run focused tests for affected remaining routes/components and repository searches for deleted identifiers. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record proof and commands per deletion group.

## Working record

- Status: complete
- Completed scope:
  - Deleted the unused Next admin run-history detail proxy and its route-only test. Repository search found the browser-facing `/api/admin/demo/runs/history/:runId` detail path only in that route and test. The authenticated detail page instead calls `getAdminRunHistoryDetail()` during server rendering; that reader calls the protected API detail path directly with the server-owned control token, and `apps/web/test/run-history.test.ts` retains coverage of that selection. The live access-protection document now describes this server-only read. The run-history collection DELETE proxy remains because authenticated cleanup controls call it.
  - Removed `DashboardBackendSnapshot.erpChaos` and the Watch bootstrap's Mock ERP `/chaos` fetch, together with fallback assertions and the browser snapshot fixture field. Search found no `erpChaos` read in `OperatorDashboard`, Watch, or dashboard panels. The admin-only `readAdminErpChaos()` path, authenticated ERP controls, Mock ERP chaos implementation, and public read-only `GET /api/admin/erp-chaos` remain supported and tested.
  - Deleted `shouldRequestAuthoritativeRecoveryAfterEvent` and its direct test. Its only references were its declaration/import/test assertions. The scope-aware `shouldRequestAuthoritativeRecoveryAfterScopedEvent` remains the production reducer/hook path and retains focused coverage.
  - Deleted `RESERVATION_TRANSITIONS`, `ORDER_TRANSITIONS`, `canTransitionReservation`, and `canTransitionOrder` plus their mechanism-only assertions. Repository search found no consumer outside their declaration and direct contract test. The private contracts package retains canonical lifecycle values/schemas and both event-name helpers. `docs/cross_service_conventions.md` continues to document actual domain semantics without claiming that the removed shared maps/predicates implement them.
  - Deleted orphaned `scripts/not-implemented.mjs` and `scripts/no-tests-yet.mjs`. Searches across manifests, Turbo configuration, apps, packages, scripts, live docs, README, and GitHub configuration found no references; only this task's candidate list named them.
  - Removed nonexistent `readAdminRecovery` members from `auth-rendering.test.tsx` and `browser-workflows.test.ts`. `apps/web/src/app/lib/server/admin-reads.ts` exports only ERP chaos, preset, and runtime-policy readers; the stale name had no production definition or call.
  - Corrected `docs/local_development.md` to advertise the implemented `pnpm --filter load-orchestrator test:focused:service` and `pnpm --filter web test:focused:proxy` scripts instead of nonexistent package-level `test:api` scripts.
- Decisions:
  - Made no production edit under `apps/api/src`. `buildApiServer()` registers inventory, order-status, queue, ERP-status, admin-maintenance/generated-run teardown, run-history, demo-run, dashboard, buy, and health route modules. These reads and operations are documented and/or runtime-consumed, so low frequency is not deletion proof.
  - Retained public read-only `GET /api/admin/erp-chaos`, the Mock ERP `/chaos` contract, admin ERP reads/controls, and their tests. The endpoint policy explicitly supports public chaos-status visibility while protecting PUT/reset mutations.
  - Retained the admin run-history API detail route and direct server reader. Only the redundant same-origin browser proxy was unreachable.
- Verification:
  - `pnpm --filter @checkout-surge/contracts test:unit` — passed: 3 files, 111 tests.
  - `pnpm --filter web exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.config.ts test/api-read-fallback.test.ts test/dashboard-phase6.test.ts test/auth-rendering.test.tsx test/browser-workflows.test.ts test/run-history.test.ts` — passed: 5 files, 69 tests.
  - `pnpm --filter web exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.config.ts test/admin-route-architecture.test.ts test/admin-control-proxy.test.ts` — passed: 2 files, 22 tests; re-proved the remaining admin route architecture, public ERP-chaos GET, and protected admin proxies after deleting the unused history-detail proxy.
  - `node --test scripts/test-command-graph.test.mjs` — passed: 6 tests, including genuine package command ownership.
  - `pnpm type-check` — passed: all 11 Turbo tasks and the root `tsc -p tsconfig.test.json --noEmit` gate.
  - `pnpm exec biome check --formatter-enabled=false apps/web/src/app/lib/api.ts apps/web/src/app/lib/dashboard-state.ts apps/web/test/api-read-fallback.test.ts apps/web/test/auth-rendering.test.tsx apps/web/test/browser-workflows.test.ts apps/web/test/dashboard-phase6.test.ts packages/contracts/src/lifecycle.ts packages/contracts/test/vocabulary.test.ts` — passed: 8 files, no fixes.
  - `pnpm exec biome lint apps/web/src/app/lib/api.ts apps/web/src/app/lib/dashboard-state.ts apps/web/test/api-read-fallback.test.ts apps/web/test/auth-rendering.test.tsx apps/web/test/browser-workflows.test.ts apps/web/test/dashboard-phase6.test.ts packages/contracts/src/lifecycle.ts packages/contracts/test/vocabulary.test.ts` — passed: 8 files, no fixes.
  - The same affected-file `biome check` with formatting enabled reported two existing formatter-only differences in untouched blocks of `auth-rendering.test.tsx` and `dashboard-phase6.test.ts`; it made no edits. The formatter-disabled check and lint above are green, and the task did not broaden into unrelated formatting cleanup.
  - `git diff --check` — passed.
  - Compound deleted-surface verification checked all four deleted paths, found no deleted predicates/maps/mock member in apps/packages/scripts/live docs, found no Watch ERP-chaos bootstrap references, found no stale package-level `test:api` docs, and found no placeholder-script references — passed.
- Follow-up: none
