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

- [ ] Focused integration starts with a durable accepted order, interrupts after accepted ERP result, and converges to one durable business outcome.
- [ ] Replacing/restarting the mock with a fresh in-memory ledger cannot cause a second durable outcome for that accepted order.
- [ ] Assertions use observable worker/DB outcomes and service-boundary calls, not fake internals.
- [ ] The regression runs with Postgres-backed worker persistence and no full composition requirement.
- [ ] Task 25 can remove mock-ERP PostgreSQL without weakening this evidence.

## Focused verification

Run the focused worker integration file through `pnpm --filter worker test:integration` with test infrastructure available, plus worker type-check. Run relevant worker unit tests if interface seams change. Do not run composition or characterization suites.

## Working record

Pending — record interruption point, fresh-ERP setup, observed durable assertions, test command/result, and any task-25 prerequisites discovered.
