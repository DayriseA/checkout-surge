# Task 79: Bound process-local run state (mock-ERP ledger, run semaphores)

## Execution context

- **Execution order:** This is task 79 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P4 (hardening note)
- **Area:** worker / mock-ERP
- **Source:** independent review (note)
- **Locations:** `apps/mock-erp/src/application/confirmation-service.ts:35`, `apps/worker/src/application/run-backpressure.ts:9`

Successful confirmations and run-scoped semaphores accumulate forever across hosted runs. Add eviction consistent with idempotency-retention expectations (coordinate with entry 14, which reworks the same ledger).

## Implementation record

- **Status:** Complete.
- **Completed scope:** The shared terminal generated-run deletion primitive now removes durable Mock ERP confirmation results for the run's actual order IDs inside the same transaction and before deleting those orders. Both protected targeted teardown and broad retention use this primitive, so successful confirmations remain replayable for the entire legal retry lifetime of the order/run and are evicted only with authoritative generated-run deletion. Integration coverage proves targeted and broad removal, preservation of unrelated other-run and catalog results, and transaction rollback of confirmation-result deletion with the rest of the graph.
- **Reconciled scope:** Task 17 already removed the process-local confirmation semaphore. Task 15 already added lazy, lease-aware TTL eviction to the run-scoped circuit-breaker registry. The hosted Mock ERP injects `PostgresConfirmationLedger`, and `ConfirmationService.inFlight` deletes entries in `finally`; therefore no remaining hosted process-local leak justified new runtime behavior. The dependency-free `InMemoryConfirmationLedger` remains intentionally simple for unit/default construction and is not the production ledger.
- **Material decision:** No wall-clock confirmation TTL was added because it could expire a successful result while an order can still legally retry. The independent ledger intentionally has no checkout foreign key, so maintenance correlates its external textual `orderId` to the run's durable UUID order IDs within the deletion transaction.
- **Verification:** `pnpm --filter @checkout-surge/db build` passed. The focused API maintenance integration suite passed 28/28 after rebuilding the changed DB package. DB and API package type checks passed; DB and API package lint passed; scoped Biome check passed; `git diff --check` passed. Repository `pnpm type-check:test` was attempted and remains nonzero only on the existing generic `ExportedPgEnum` incompatibilities in `packages/db/test/unit/vocabulary-parity.test.ts`; it reported no Task 79 test diagnostics. The initial focused test attempt could not connect because isolated test infrastructure was down. After starting it, the next attempt exercised stale pre-build DB output and failed only the two new deletion assertions; rebuilding the DB package made the suite green. Prohibited composition and characterization suites were not run.
- **Remaining blockers/follow-up:** None for Task 79.
