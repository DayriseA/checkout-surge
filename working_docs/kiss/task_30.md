# Task 30 — Split reset, retention cleanup, and generated-run teardown into focused workflows

## Execution context

- **Execution order:** Task 30 of 45, in Phase 5 (repair ownership boundaries).
- **Dependencies:** The runtime is explicitly single-instance, replica-aware cleanup ownership has already been removed, and run lifecycle/completion owners are separate. The deterministic test reset is a different boundary and must not be folded into this task.
- **Standalone scope:** These requirements remain complete without the audit. Inspect current code because earlier coordination tasks may have simplified names and interfaces.
- **Primary ownership boundary:** API application services for admin reset, old-run retention cleanup, and exact generated-run teardown.
- **Working expectations:** Read working_docs/quality_checklists.md. Keep admin routes thin, preserve transactional database deletion and explicit infrastructure dependencies, and test each workflow independently.

## Why this task exists

apps/api/src/services/demo-maintenance-service.ts currently owns global reset, traffic abort, run fencing, terminal-summary recovery, live projection cleanup, retention selection, generated-run deletion, Redis teardown, and queue quiescence. These workflows share a maintenance label but have different safety rules and failure recovery.

## Required outcome

Create focused workflow owners for:

1. admin reset of the current recoverable run;
2. retention selection and cleanup of old terminal generated runs; and
3. exact teardown of one terminal generated run.

Share only small operations whose semantics are genuinely identical, such as exact-run Redis cleanup or a queue maintenance boundary.

## Scope and implementation guidance

- Split DemoMaintenanceService.reset(), cleanupOldRuns(), and teardownGeneratedRun() into explicit services/interfaces under apps/api/src/services.
- Keep reset responsible for global start exclusion, exact-run traffic termination, admission/metric fencing, final durable capture, immutable failed summary, and scoped live-state clear.
- Keep retention cleanup responsible for age/latest-run selection and invoking exact teardown; it must not silently broaden eligibility.
- Keep targeted teardown responsible for terminal/generated ownership validation, exact queue/Redis attribution, and transactional durable graph deletion.
- Move synthetic reset summary builders and helper types to the workflow that owns them; deduplicate only exact mappings already centralized earlier.
- Update apps/api/src/routes/admin-maintenance-routes.ts so endpoints receive only their workflow dependency.
- Refocus apps/api/test/demo-maintenance-service.test.ts into reset, cleanup-selection, and teardown suites, retaining shared integration fixtures only where they prove a common infrastructure boundary.

## Retained behavior and non-goals

- Preserve fail-closed destructive guards, exact run and generated sale-offer ownership, traffic termination confirmation, immutable terminal history, and retry-visible cleanup failures.
- Preserve the single application maintenance authority and bounded queue pause/resume behavior.
- Do not combine demo maintenance with the test-database reset system.
- Do not build a generic workflow engine, saga framework, or repository lattice.
- Do not delete arbitrary catalog runs, active runs, another run's jobs, or broad Redis namespaces.

## Acceptance criteria

- [ ] No single service owns reset, retention selection, and targeted teardown together.
- [ ] Each route delegates to one focused workflow with explicit dependencies.
- [ ] Destructive ownership checks and exact resource attribution remain fail closed.
- [ ] Reset still produces one coherent terminal outcome before clearing live state.
- [ ] Cleanup/teardown retries are idempotent and infrastructure failures remain visible.
- [ ] Old forwarding service methods and duplicated helpers/tests are removed.

## Verification

- Run focused API reset, maintenance selection, targeted teardown, queue maintenance, and resource-cleanup tests.
- Run relevant PostgreSQL/Redis/BullMQ integration coverage where deletion and queue attribution depend on real infrastructure.
- Run pnpm --filter api type-check and pnpm type-check.
- Do not run the slow composition or characterization suites unless explicitly requested.

## Working record

- **Status:** pending
- **Completed scope:** none
- **Material decisions or deviations:** none
- **Verification performed:** not run
- **Remaining blockers or follow-up:** none
