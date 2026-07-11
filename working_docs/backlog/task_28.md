# Task 28: Scope dashboard state to the current run (new-run events must not relabel prior-scope projections)

## Execution context

- **Execution order:** This is task 28 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1
- **Area:** web / dashboard state
- **Source:** independent review (medium)
- **Solved elsewhere:** none — cross-run dashboard contamination is a class all three branches share, each with a different mechanism.
- **Locations:** `apps/web/src/app/components/operator-dashboard.tsx:242`, `apps/api/src/services/dashboard-recovery-service.ts:70`

On a run-started event the reducer updates only the current-run pointer and recovery timestamp while retaining inventory, metrics, business outcomes, lag, and completion outcomes from the previous scope; only terminal events trigger recovery. A diagnostic confirmed the new run ID rendered alongside old-scope data. Reset or re-recover all projections on scope change.
