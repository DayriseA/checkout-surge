# Task 77: Bind internal traffic ingestion to the accepted run

## Execution context

- **Execution order:** This is task 77 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P4 (hardening note)
- **Area:** API / internal contract
- **Source:** independent review (note)
- **Locations:** `apps/api/src/services/demo-run-service.ts:528`, `packages/contracts/src/load.ts:119`

Metric ingestion accepts any shape-valid service-token payload without checking run existence or traffic-active status, and completion stores supplied counts/identity/timestamps without comparing them to the accepted snapshot. Make stale or misrouted orchestrator output fail closed.
