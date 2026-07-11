# Task 22: Enforce run–sale-offer ownership after guarded insertion

## Execution context

- **Execution order:** This is task 22 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1
- **Area:** database / schema integrity
- **Source:** independent review (medium)
- **Solved elsewhere:** none — shared class; GLM's own maintenance test demonstrated the same weakness at the storage boundary. Needs a DB-level constraint or update-guard trigger.
- **Locations:** `packages/db/src/schema.ts:198`, `packages/db/drizzle/0000_initial_schema.sql:455`, `apps/api/src/services/generated-run-sale-gate.ts:10`

Run and sale-context rows store sale-offer ownership independently with no constraint tying them together, and the guard trigger fires only on context insertion. A later contradictory write can make the durable admission gate approve Redis holds whose PostgreSQL rows are rejected, stranding secured stock in pending persistence.
