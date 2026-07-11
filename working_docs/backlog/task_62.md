# Task 62: Fix contradictory empty-state copy on out-of-range run-history pages

## Execution context

- **Execution order:** This is task 62 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P3
- **Area:** web / run history
- **Source:** browser testing (low, confirmed)
- **Solved elsewhere:** n/a — branch-specific.
- **Locations:** `/run-history?page=N` handling

With seven summaries, page 2 renders "7 summaries" while simultaneously showing "No history yet". Non-numeric/zero pages already fall back to page 1; clamp out-of-range positive pages the same way or show a proper out-of-range state.
