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

- [x] A single process-local serialized authority owns API maintenance cleanup.
- [x] Concurrent local requests cannot interleave queue pause/delete/resume sequences.
- [x] Queues always resume through `try/finally`; failures remain visible and retryable.
- [x] Terminal/generated checks and exact-run attribution remain enforced before deletion.
- [x] Focused measurement proves the local workflow deterministic for concurrent requests and retry-visible partial failures before obsolete cross-replica coordination is removed.
- [x] Redis/cross-replica FIFO ownership metadata, config, docs, and tests are removed.

## Focused verification

Run `pnpm --filter api test:api`, focused queue-maintenance and maintenance-service tests, DB tests if cleanup metadata/schema changes, and API/DB type-checks. Do not run composition or characterization suites.

## Working record

- **Status:** complete
- **Completed scope:** `DemoMaintenanceService` now owns one instance-local promise tail for reset, retention cleanup, and exact generated-run teardown. A request enters only after the previous maintenance request has completed its full workflow, including targeted queue restoration and teardown-receipt completion, so concurrent local pause/preflight/delete/resume sequences cannot interleave. The BullMQ adapter remains a narrow queue boundary: it pauses only queues that were not already paused, removes only jobs whose validated payload has the requested run ID, and attempts every locally introduced resume after acquisition or workflow failure. The teardown service calls release from `finally`, combines a primary and resume failure when both occur, and logs queue, Redis, and receipt failures with run/correlation context. A process-local set makes a transient resume failure retryable while this sole API process remains alive. Adapter shutdown atomically refuses later acquisitions, waits for the one active acquisition/lease to complete its release path, retries locally pending resumes, and only then closes every queue while aggregating remaining resume/close failures. The durable PostgreSQL teardown receipt remains the exact run/sale-offer retry coordinate after durable deletion.
- **Removed coordination:** Deleted the queue adapter's FIFO promise chain, Redis maintenance pause-owner keys, Lua claim/compare/clear commands, retained-pause release disposition, foreign-owner conflict vocabulary, restart adoption behavior, and tests/docs that required those mechanics. No replacement lock, coordinator framework, environment setting, Redis metadata, or schema state was added.
- **Preserved safeguards:** Terminal status and matching generated-run sale ownership are still locked and checked transactionally before deletion. Active or malformed target jobs fail closed; exact payload attribution preserves other runs and catalog jobs. Queue restoration is attempted for preflight, durable, BullMQ, Redis, and receipt-stage failures, while pre-existing operator pauses remain untouched. Post-commit failure stays visible and the exact bodyless DELETE remains idempotently retryable through the existing receipt.
- **Focused measurement:** Before deletion, `pnpm --filter api exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.api.config.ts test/bullmq-demo-queue-maintenance.test.ts test/demo-maintenance-service.test.ts` passed 2 files / 43 tests, characterizing FIFO serialization, exact-run isolation, retained partial failures, and resume behavior. After replacement, the same command passed 2 files / 40 tests; the outcome-level suite now proves that a complete first pause/preflight/clean/resume sequence precedes a concurrent second sequence, exact-run jobs are isolated across all supported states, post-commit queue failure resumes before returning, resume failure remains visible with durable retry coordinates, and every locally changed queue is attempted during rollback/restoration.
- **Verification:** `pnpm --filter api test:api` passed 39 files / 487 tests before the final focused shutdown-drain correction. After that correction, the focused queue-maintenance and maintenance-service command passed again at 2 files / 40 tests, including the deterministic active-lease shutdown regression; the API type-check and focused two-file Biome check also passed again. `pnpm --filter @checkout-surge/db type-check` passed, including its package-boundary check. `pnpm exec biome check --write apps/api/src/services/demo-maintenance-service.ts apps/api/src/queue/bullmq-demo-queue-maintenance.ts apps/api/test/demo-maintenance-service.test.ts apps/api/test/bullmq-demo-queue-maintenance.test.ts` passed after formatting one file; the broader focused `pnpm exec biome check` command included the impacted docs and passed with no fixes across the four supported TypeScript files. `git diff --check` passed. `pnpm test:infra:down` stopped the dedicated test services and removed the test-only volumes/network created for verification. Dedicated database tests were not run because no database schema, migration, export, or helper changed. `pnpm test:composition` and `pnpm test:characterization` were not run by instruction.
- **Task 35 boundary:** Reset, retention cleanup, targeted teardown, their durable receipt, convergence rescans, and the existing reset workflow fence remain distinct. Task 21 changed only the shared local maintenance admission and generated-run pause ownership protocol; Task 35 still owns any later collapse of queue/reset/teardown operations, rescans, receipts, or convergence semantics after the maintenance service split.
