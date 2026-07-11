# Task 06: Make admin reset a fenced terminal transition (no admission or job cleanup after the summary is written)

## Execution context

- **Execution order:** This is task 6 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P0
- **Area:** API / maintenance / lifecycle
- **Source:** independent review (high)
- **Solved elsewhere:** none — shared defect; Opus has the same reset-vs-normal-finalization race.
- **Locations:** `apps/api/src/services/demo-maintenance-service.ts:65`, `apps/api/src/services/demo-maintenance-service.ts:112`, `apps/api/src/services/reserve-order-service.ts:159`

Reset commits the immutable failed summary **before** closing Redis eligibility and cleaning queues, so a `/buy` that passed the durable gate can reserve, persist, and enqueue after the outcome was captured — and queue cleanup may then delete the new job. Reset reports success while secured business state is absent from the immutable summary. Sequence reset as: fence the terminal transition first (see entry 5), close admission, drain/clean, then write the summary. Reset **workflow completeness** (traffic aborter, ERP chaos reset, dashboard clear) is entry 34.
