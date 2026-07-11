# Task 61: Reflect authenticated admin state consistently across admin surfaces

## Execution context

- **Execution order:** This is task 61 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P3
- **Area:** web / admin UX
- **Source:** browser testing (low, confirmed)
- **Solved elsewhere:** n/a — branch-specific UI state bug; overlaps entry 60's surface work.
- **Locations:** `/admin` page shell; `/run-history` cleanup panel

After signing in, protected sections become usable but the page still shows "access required" wording, and `/run-history` keeps showing the passphrase field and Sign In button. Operators cannot tell whether their session is valid and are invited to re-enter the passphrase around destructive controls.
