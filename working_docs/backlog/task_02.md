# Task 02: Build a durable PostgreSQL-to-BullMQ order-dispatch handoff (transactional outbox or autonomous scanner)

## Execution context

- **Execution order:** This is task 2 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P0
- **Area:** API / buy pipeline durability
- **Source:** independent review (high)
- **Solved elsewhere:** none — shared defect; Opus and GLM also commit durable rows before enqueue with no outbox or re-drive. Design fresh.
- **Locations:** `apps/api/src/services/reserve-order-service.ts:246`, `apps/api/src/services/reserve-order-service.ts:263`

The reservation, queued order, and initial events commit before the BullMQ enqueue, with no transactional outbox and no background scan for undispatched queued orders. If enqueue fails or the process dies in that window, the only repair is a later request with the same idempotency key; a buyer who never retries leaves a permanently queued order and the run drains to timeout. Fix with a transactional outbox or an autonomous scanner that re-drives queued orders without a job. Design together with entry 3 — they are one ownership problem.
