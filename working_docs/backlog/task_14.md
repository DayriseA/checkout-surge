# Task 14: Close the concurrent-duplicate window in mock-ERP confirmation idempotency

## Execution context

- **Execution order:** This is task 14 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1
- **Area:** mock-ERP
- **Source:** independent review (medium)
- **Solved elsewhere:** none — shared class; Opus's ledger is additionally lost across process restart, and GLM has no idempotency barrier at all. A durable-ledger design is the strongest direction.
- **Locations:** `apps/mock-erp/src/application/confirmation-service.ts:46`, `apps/mock-erp/src/application/confirmation-service.ts:70`

The confirmation service checks its completed-response map before awaiting the chaos decision and stores the result only afterward, so overlapping same-key requests both miss; a barrier probe reproduced two decisions and two confirmation IDs for one key. This breaks the retry invariant the worker depends on when it times out while the ERP continues processing.

## Implementation record

- **Status:** Completed on the current branch; the production change was implemented earlier as part of Task 04 and audited here against this task's narrower acceptance boundary.
- **Completed scope:** `ConfirmationService` now coalesces in-process same-key requests before producing a decision. Production injects `PostgresConfirmationLedger`, which persists successful responses under a unique idempotency key and uses a transaction-scoped advisory lock so separate service instances converge before either invokes the decision provider. Replays survive service reconstruction, immutable request contradictions raise an idempotency conflict, and failed decisions are not cached.
- **Material decisions:** Retained the in-memory ledger as the dependency-free default for unit/server construction while production owns PostgreSQL connection construction in the composition root. The in-process map is a fast single-flight path; PostgreSQL is the authoritative cross-process and restart boundary. Successful results are committed before returning, while transient failures remain eligible for a later attempt.
- **Audit adjustment:** Corrected the PostgreSQL restart-replay fixture to expect the zero latency produced by its fixed clock and scoped cleanup to every key created by that suite. No production behavior changed during this task-specific audit.
- **Verification:** `pnpm --filter mock-erp test:integration` (4 passed); `pnpm --filter mock-erp test:unit` (31 passed); `pnpm --filter mock-erp type-check` (passed); `pnpm --filter mock-erp lint` (passed). The first integration attempt could not connect because the isolated `checkout_surge_test_mock_erp` database did not exist; it was created and migrated with the repository helper. The next run exposed the fixture-only latency mismatch, and the unchanged production implementation passed after that expectation and cleanup were corrected. The prohibited composition and characterization suites were not run.
- **Remaining blockers/follow-up:** None for Task 14. The PostgreSQL implementation deliberately holds one transaction/connection while producing a first result so another process cannot cross the same-key decision boundary; revisiting that throughput tradeoff would be a separate architecture/performance task, not an idempotency correctness gap.
