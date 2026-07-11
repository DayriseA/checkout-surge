# Task 37: Add a delete/archive path for admin-created presets

## Execution context

- **Execution order:** This is task 37 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1
- **Area:** web + API / admin console
- **Source:** browser testing (medium, confirmed)
- **Solved elsewhere:** n/a — capability gap; a tester code-scan found list/save/duplicate/copy-to-custom paths but no preset delete route at all.
- **Locations:** `/admin` preset panel; API preset routes

Duplicated presets remain selectable forever; the only actions are `Start Admin Run`, `Save Preset`, `Copy to Custom`, and `Duplicate`. Accidental duplicates (see entry 36) permanently clutter the operator console. Requires an API delete route (protected), a UI control with confirmation, and probably guardrails for seeded/public presets.
