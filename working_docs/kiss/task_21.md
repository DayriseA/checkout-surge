# Task 21 — Use one local authority for API maintenance cleanup

## Execution context

Task 21 of 45, Phase 4, using task 10's single-API topology. Primary ownership is `DemoMaintenanceService` plus its queue-maintenance dependency; API routes remain thin. Later task 35 may collapse duplicate reset/teardown protocols only after service boundaries split, so this task changes coordination rather than broad service design.

## Why

Redis/cross-replica queue-pause ownership and FIFO coordination preserve a topology that is no longer in scope, while deterministic cleanup still needs one reliable owner.

## Required outcome

Replace replica-aware cleanup ownership with one process-local serialized API maintenance authority. Preserve terminal/generated ownership checks, exact-run attribution, `try/finally` queue resume, and visible/retryable failures. First measure the local workflow under concurrent cleanup and partial-failure cases and prove deterministic serialization, exact-run isolation, and queue resumption; only then remove Redis cleanup metadata and cross-replica queue-pause/FIFO ownership. The authority must deterministically serialize concurrent local cleanup requests.

## Scope and concrete current paths

- `apps/api/src/services/demo-maintenance-service.ts`, `postgres-demo-reset-workflow-fence.ts`, maintenance routes/tests, and composition.
- `apps/api/src/queue/bullmq-demo-queue-maintenance.ts`, queue interfaces/tests, Redis cleanup metadata/helpers, config, schema if metadata is persisted, docs.
- Generated-run cleanup scripts and run lifecycle readers only as needed to preserve exact-run attribution.

## Retained behavior and non-goals

Keep terminal/generated eligibility checks, durable exact-run resource attribution, queue resume in `finally`, and visible failures that can be retried. Do not make cleanup distributed, weaken destructive safety, or merge reset/teardown workflows prematurely; task 35 owns that later consolidation.

## Acceptance

- [ ] A single process-local serialized authority owns API maintenance cleanup.
- [ ] Concurrent local requests cannot interleave queue pause/delete/resume sequences.
- [ ] Queues always resume through `try/finally`; failures remain visible and retryable.
- [ ] Terminal/generated checks and exact-run attribution remain enforced before deletion.
- [ ] Focused measurement proves the local workflow deterministic for concurrent requests and retry-visible partial failures before obsolete cross-replica coordination is removed.
- [ ] Redis/cross-replica FIFO ownership metadata, config, docs, and tests are removed.

## Focused verification

Run `pnpm --filter api test:api`, focused queue-maintenance and maintenance-service tests, DB tests if cleanup metadata/schema changes, and API/DB type-checks. Do not run composition or characterization suites.

## Working record

Pending — describe the local serialization primitive, queue-resume failure behavior, removed distributed metadata, tests run, and task-35 deferred overlap.
