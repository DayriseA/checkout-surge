# Task 35: Eliminate the React hydration error (#418) on fresh dashboard loads

## Execution context

- **Execution order:** This is task 35 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1
- **Area:** web / frontend
- **Source:** browser testing (medium, confirmed)
- **Solved elsewhere:** n/a — branch-specific frontend defect.
- **Locations:** public dashboard at `/` (Next.js static chunk during hydration)

A clean load of the public dashboard renders usable content but Chrome records `Minified React error #418` during hydration, recurring on navigation and run transitions. It affects every visitor's first load, can force React to discard server markup, and buries real regressions under baseline console noise. Diagnose the server/client markup mismatch and fix at the source.
