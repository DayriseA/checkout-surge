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
