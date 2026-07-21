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

- **Status:** pending
- **Completed scope:** none
- **Material decisions or deviations:** none
- **Verification performed:** not run
- **Remaining blockers or follow-up:** none
