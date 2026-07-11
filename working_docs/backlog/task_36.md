# Task 36: Fix stale-state preset duplication in the admin console (empty slug duplicates from previous value)

## Execution context

- **Execution order:** This is task 36 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1
- **Area:** web / admin console
- **Source:** browser testing (medium, confirmed)
- **Solved elsewhere:** n/a — branch-specific UI state bug.
- **Locations:** `/admin` preset editor (duplicate-slug flow)

Clearing the `Duplicate slug` field and immediately clicking `Duplicate` creates a persisted duplicate using the **previous** slug value instead of failing empty-slug validation — the UI reports success and advances the input to `preview-1k-copy-copy`. Creates unintended persistent records; compounded by entry 37 (no delete path).
