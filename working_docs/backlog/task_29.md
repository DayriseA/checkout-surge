# Task 29: Add an event watermark so out-of-order live events cannot regress dashboard state

## Execution context

- **Execution order:** This is task 29 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1
- **Area:** web / dashboard state
- **Source:** independent review (medium)
- **Solved elsewhere:** none — stale-data-wins ordering problems exist on all three branches in different forms.
- **Locations:** `apps/web/src/app/components/operator-dashboard.tsx:255`, `packages/db/src/business-outcome-dashboard.ts:223`

The client rejects events older than the HTTP snapshot baseline but never advances a watermark when applying live projections, and asynchronous worker projection reads/publishes can complete out of order. A diagnostic applied T+10 then T+5 and observed state regressing. Advance a per-projection watermark on every applied event.
