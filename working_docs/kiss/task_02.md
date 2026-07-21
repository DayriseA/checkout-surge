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

- [ ] Inventory is reread while the PostgreSQL terminal transaction/advisory fence is held.
- [ ] The operation is bounded and cancellable through an injected dependency.
- [ ] Timeout returns no terminal summary.
- [ ] Timeout releases the transaction and advisory lock, proven by a focused regression.
- [ ] No Redis client is created in the finalization service or route.

## Verification

Run focused API and database/unit tests, for example `pnpm --filter api test:api -- test/demo-run-finalization-service.test.ts` and the relevant `packages/db` inventory test. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record exact results.

## Working record

- Status: pending
- Completed scope: none
- Decisions: none
- Verification: not run
- Follow-up: none
