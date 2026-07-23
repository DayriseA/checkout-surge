# Task 31 — Extract per-operation infrastructure lifecycles from API composition

## Execution context

- **Execution order:** Task 31 of 45, in Phase 5 (repair ownership boundaries).
- **Dependencies:** The major application workflows must already have focused interfaces, and all production-required dependencies must be explicit. This task follows the maintenance split so resource ownership can match real operation boundaries.
- **Standalone scope:** This task is complete without the audit. Verify current locations because earlier tasks may have changed apps/api/src/index.ts substantially.
- **Primary ownership boundary:** API runtime infrastructure factories for bounded, request-scoped PostgreSQL, Redis, and BullMQ operations.
- **Working expectations:** Follow working_docs/quality_checklists.md. Infrastructure construction belongs in composition/runtime modules, never in routes or application services; cancellation and cleanup must be explicit and tested.

## Why this task exists

apps/api/src/index.ts currently contains substantial per-request resource construction and lifecycle behavior, particularly for dashboard recovery and other bounded operations. Startup composition becomes hard to review when it also implements deadlines, client cancellation, operation-owned pools/connections, and cleanup order.

## Required outcome

Move per-operation infrastructure creation and disposal into small named runtime factories. apps/api/src/index.ts should choose concrete implementations and wire them together, while routes and services receive an operation factory or already-created application dependency with a clear AbortSignal and close contract.

## Scope and implementation guidance

- Inventory every operation-owned PostgreSQL pool/client, Redis connection, BullMQ queue/client, AbortController, and disconnect/close callback currently constructed inline in apps/api/src/index.ts.
- Extend or use apps/api/src/runtime/operation-lifecycle.ts and apps/api/src/runtime/api-resource-cleanup.ts for shared cancellation and cleanup semantics only where they are genuinely identical.
- Create focused factories such as a dashboard-recovery operation factory rather than one universal resource bag. Each factory should expose the smallest typed application-facing dependency set.
- Preserve one end-to-end deadline, caller-disconnect cancellation, cancellation of queued/active PostgreSQL work, Redis/BullMQ disconnect, and exactly-once cleanup.
- Keep configuration values and top-level construction decisions in apps/api/src/index.ts; move implementation mechanics out.
- Do not let route modules call createRedisClient, Drizzle/PostgreSQL constructors, or BullMQ constructors.
- Update apps/api/test/operation-lifecycle.test.ts, api-resource-cleanup.test.ts, dashboard recovery workflow/service tests, and startup composition tests as appropriate.

## Retained behavior and non-goals

- Retain bounded dashboard recovery, readiness, correlation-aware errors, per-projection degradation where still part of the current contract, and clean shutdown.
- Do not create module-level infrastructure clients or a service locator.
- Do not make one generic factory that returns every client to every workflow.
- Do not redesign readiness in this task; its concrete checks move in Task 32.
- Do not change public HTTP error/status vocabulary.

## Acceptance criteria

- [ ] apps/api/src/index.ts no longer implements request-operation cancellation or cleanup mechanics inline.
- [ ] Each operation factory owns only the resources its workflow needs and exposes an explicit AbortSignal/cleanup contract.
- [ ] Routes and application services remain free of infrastructure construction.
- [ ] Timeout, caller disconnect, partial construction failure, and repeated cleanup release every acquired resource exactly once.
- [ ] Startup composition remains readable and is limited to configuration and dependency wiring.

## Verification

- Run operation-lifecycle, API-resource-cleanup, dashboard recovery workflow/service, and affected API route tests.
- Run pnpm --filter api type-check and pnpm type-check.
- Run focused lint checks on runtime/composition files.
- Do not run composition or characterization unless expressly authorized.

## Working record

- **Status:** completed
- **Completed scope:** Added focused runtime factories for dashboard recovery, pending-persistence discovery/attempt operations, and the terminal inventory read. The factories construct only their workflow's PostgreSQL, Redis, and BullMQ dependencies; bind them to the existing operation `AbortSignal`; roll back partial construction; and expose idempotent cleanup that attempts every acquired resource and aggregates failures. `apps/api/src/index.ts` now selects configuration and concrete factories and wires their existing application-facing interfaces without implementing request-operation abort listeners or disconnect choreography. Dashboard recovery still uses the route-owned end-to-end deadline and caller-disconnect signal through admission, projection reads, abortable PostgreSQL, Redis, and BullMQ cleanup. Pending-persistence remains the sole scheduling/repair authority and retains its shutdown drain behavior. Terminal inventory remains a bounded Redis read inside the PostgreSQL finalization fence. Updated focused ownership documentation and added operation-factory coverage without reproducing third-party client behavior.
- **Material decisions or deviations:** Kept three workflow-aligned modules instead of a universal resource bag or service locator. Reused one small cleanup primitive only for the identical exactly-once/all-settled semantics and retained combined operation/cleanup errors. Kept readiness construction in `apps/api/src/index.ts` because Task 32 explicitly owns concrete readiness extraction. Did not make the pending-persistence service's reusable test fallbacks required or otherwise redesign its scheduling interface; production composition continues to provide every operation factory explicitly.
- **Verification performed:** `pnpm --filter api exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.api.config.ts test/operation-lifecycle.test.ts test/api-resource-cleanup.test.ts test/operation-factories.test.ts test/dashboard-recovery-workflow.test.ts test/dashboard-routes.test.ts test/readiness.test.ts` passed 6 files / 25 tests. `dashboard-recovery-service.test.ts` passed 1 file / 16 tests. `pending-persistence-recovery-service.test.ts` passed 1 file / 27 tests, and `pending-persistence-recovery-integration.test.ts` passed 1 file / 2 tests. `demo-run-finalization-service.test.ts` passed 1 file / 29 tests. The selected `api.test.ts` recovery/composition checks passed 2 tests with 88 skipped. `pnpm --filter api type-check` passed. `pnpm type-check` passed all 11 production/boundary tasks plus the repository test-source TypeScript check. Focused Biome format and lint passed for the changed API runtime/composition/service/test files. `git diff --check` passed. Dedicated PostgreSQL/Redis test infrastructure was started for the focused integration-backed checks and removed afterward. Per repository instruction, `pnpm test:composition` and `pnpm test:characterization` were not run.
- **Remaining blockers or follow-up:** None for Task 31. Task 32 remains the explicit owner of moving the concrete readiness implementations out of API composition.
