# Task 24 — Prove worker replay across mock-ERP restart

## Execution context

Task 24 of 45, Phase 4 and a prerequisite for task 25. Primary ownership is the worker's durable `erp_attempts` and confirmation-client workflow; the mock ERP is a replaceable external-service fake. The regression must test the boundary, not private fake internals, and must not introduce production persistence into the mock ERP.

## Why

Removing mock-ERP PostgreSQL is safe only if worker durable idempotency—not the mock's restart-stable ledger—prevents a second durable business outcome after an accepted result/replay window.

## Required outcome

Add a focused worker integration regression with Postgres and a replaceable/fresh in-memory ERP fake/service boundary. Prove that a fresh mock ERP ledger after restart cannot create a second durable business outcome for the same accepted order because worker `erp_attempts` owns replay/idempotency. Also prove accepted-result interruption still converges. Do not pin fake storage internals or require the full composition suite.

## Scope and concrete current paths

- `apps/worker/src/application/erp-confirmation-client.ts`, order handler/workflow, `persistence/postgres-erp-attempt-persistence.ts`, and worker integration test harnesses.
- `apps/worker/test/integration/erp-attempt-recovery.integration.test.ts`, order processing workflow tests, and replaceable ERP fake/service-boundary support.
- Mock ERP confirmation interface only as necessary to enable a fresh instance; task 25 owns removal of its Postgres implementation.

## Retained behavior and non-goals

Keep durable `erp_attempts`, accepted-result recovery, worker backoff/circuit breaker, and in-process mock idempotency behavior. Do not change the mock ERP database implementation yet, invoke composition/characterization, or assert private ledger implementation details.

## Acceptance

- [x] Focused integration starts with a durable accepted order, interrupts after accepted ERP result, and converges to one durable business outcome.
- [x] Replacing/restarting the mock with a fresh in-memory ledger cannot cause a second durable outcome for that accepted order.
- [x] Assertions use observable worker/DB outcomes and service-boundary calls, not fake internals.
- [x] The regression runs with Postgres-backed worker persistence and no full composition requirement.
- [x] Task 25 can remove mock-ERP PostgreSQL without weakening this evidence.

## Focused verification

Run the focused worker integration file through `pnpm --filter worker test:integration` with test infrastructure available, plus worker type-check. Run relevant worker unit tests if interface seams change. Do not run composition or characterization suites.

## Working record

Completed 2026-07-22.

- Consolidated the broad `reuses a successful ERP attempt after confirmed-state persistence fails` case from `order-processing-workflow.test.ts` into `erp-attempt-recovery.integration.test.ts`.
- The focused regression uses real localhost HTTP calls to a test ERP service with a private in-memory idempotency map. After the first service accepts the confirmation and PostgreSQL records the successful `erp_attempt`, the test injects an interruption at `transitionToConfirmed`; the durable order remains `processing`, there is one successful attempt with the original confirmation ID, and there is no confirmed event.
- The first ERP service is closed and a newly constructed service with an empty in-memory map is started. A newly constructed worker confirmation client replays the delivery, consults PostgreSQL first, sends zero requests to the replacement ERP, confirms the order, and leaves exactly one successful attempt and one durable `order.confirmed` event.
- Assertions inspect requests received at the HTTP handler and worker/PostgreSQL outcomes only. The test imports no mock-ERP application code or private ledger implementation.
- Verification passed after rebuilding stale shared package artifacts with `pnpm build:shared`: `pnpm --filter worker test:integration erp-attempt-recovery.integration.test.ts` (1 file, 3 tests), `pnpm --filter worker type-check`, `pnpm --filter worker test:unit erp-confirmation-client.test.ts order-process-job-handler.test.ts` (2 files, 49 tests), `pnpm type-check:test`, `git diff --check`, and focused Biome checks for both changed worker integration files.
- Task 25 has no new production prerequisite from this task: the regression is independent of mock-ERP PostgreSQL and is ready to protect its removal. Task 25 should retain the public confirmation HTTP contract and in-process idempotency behavior while deleting the mock-ERP database boundary.
