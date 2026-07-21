# Task 02 — Bound terminal inventory read inside the finalization fence

## Execution context

Task 2 of 45. Phase 0: establish a trusted baseline. Primary ownership boundary: terminal finalization application service and its injected inventory operation. Dependencies: task 01 is not a code dependency, but this Phase 0 repair must complete before structural cleanup. This record is standalone. Apply the quality checklist: the service receives explicit dependencies; composition owns clients; tests prove the transaction/infrastructure boundary.

## Why this task exists

The final Redis inventory reread is correctly placed inside the PostgreSQL terminal transaction/advisory fence to avoid a pre-fence race. Its Redis command is currently unbounded, so a stalled read can retain the transaction and advisory lock indefinitely.

## Required outcome

Keep the inventory reread inside the terminal fence, but inject a bounded, cancellable inventory-read operation from composition. On timeout, finalization returns no terminal summary and releases both transaction and advisory lock.

## Scope and implementation guidance

Verify paths before editing because the checkout may drift: `apps/api/src/services/demo-run-finalization-service.ts`, `apps/api/src/services/terminal-demo-run-writer.ts`, `packages/db/src/redis-inventory.ts`, `apps/api/src/index.ts`, and `apps/api/test/demo-run-finalization-service.test.ts`. Define the cancellation/deadline at the explicit service-operation boundary; do not create Redis clients in a service or route. Ensure transaction cleanup is reliable for timeout, abort, and normal completion. Tests should use a controllable injected operation and demonstrate that a timeout yields no summary and frees the fence for a subsequent finalization attempt.

## Retained behavior and non-goals

Retain the coherent in-fence Redis read, PostgreSQL terminal transaction/advisory fence, and normal terminal summary behavior. Do not move the read outside the fence, add a generic DI framework, or weaken terminal correctness merely to avoid waiting.

## Acceptance criteria

- [x] Inventory is reread while the PostgreSQL terminal transaction/advisory fence is held.
- [x] The operation is bounded and cancellable through an injected dependency.
- [x] Timeout returns no terminal summary.
- [x] Timeout releases the transaction and advisory lock, proven by a focused regression.
- [x] No Redis client is created in the finalization service or route.

## Verification

Run focused API and database/unit tests, for example `pnpm --filter api test:api -- test/demo-run-finalization-service.test.ts` and the relevant `packages/db` inventory test. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record exact results.

## Working record

- Status: completed
- Completed scope: Replaced the finalizer's direct in-fence Redis inventory call with a required `TerminalInventoryReadOperation` that receives an `AbortSignal`. The finalization service enforces a positive finite whole-operation deadline and settles on abort even if an adapter stalls. API composition supplies a fixed two-second policy, creates a short-lived no-retry Redis client for each terminal read, and disconnects it on abort and normal completion. The preflight read remains unchanged, and the coherent terminal reread remains inside `writePrepared()`'s PostgreSQL transaction and advisory xact fence. Timeout returns no prepared summary, leaves the run `draining`, publishes no terminal event, and releases the fence for retry. Updated all test construction sites plus the architecture and Redis hot-path documentation.
- Decisions: Kept deadline authority at the narrow service-operation boundary and client lifecycle in API composition; did not add an environment setting, generic DI framework, Redis client to the service/route, or cancellation behavior to the shared database inventory helper. Reused `OperationDeadlineExceededError` and `settleWithAbort`. The focused regression uses a controllable injected read, observes the PostgreSQL advisory fence through a second connection, awaits signal cancellation without a sleep-based timing assertion, flushes Redis Pub/Sub observation with a barrier, and proves a second attempt completes.
- Verification: The first focused run, `pnpm --filter api exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.api.config.ts test/demo-run-finalization-service.test.ts`, could not reach the dedicated test PostgreSQL service (`ECONNREFUSED 127.0.0.1:56432`; 31 fixture-setup failures). `pnpm test:infra:up` started healthy PostgreSQL and Redis test services. The same focused finalization command then passed 1 file / 31 tests, and its final rerun after formatting also passed 1 file / 31 tests. `pnpm --filter @checkout-surge/db exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.integration.config.ts test/integration/db.integration.test.ts -t "derives pending and expired status fields from Redis source collections"` passed 1 test with 74 skipped. `pnpm --filter api type-check` passed. `pnpm type-check:test` remained at the documented Task 03 baseline of 20 TypeScript errors and reported no new terminal-inventory dependency error. `pnpm exec biome lint apps/api/src/index.ts apps/api/src/services/demo-run-finalization-service.ts apps/api/test/demo-run-finalization-service.test.ts apps/api/test/demo-run-service.test.ts apps/worker/test/integration/order-processing-workflow.test.ts` passed for all 5 supported changed files. Targeted Biome formatting passed for the same 5 files; Markdown is not processed by the configured Biome command. `git diff --check` passed.
- Follow-up: Task 03 remains responsible for the pre-existing 20 test-source type errors; none is introduced or expanded by this task.
