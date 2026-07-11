# Task 63: Render public-safe error states for malformed run-history routes

## Execution context

- **Execution order:** This is task 63 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P3
- **Area:** web / error handling
- **Source:** browser testing (low, confirmed); a related symptom of the error-envelope weakness in entry 38
- **Solved elsewhere:** n/a — the UUID-shaped missing-ID path already renders a clean `Run not found`; extend that handling.
- **Locations:** `/run-history/[id]` detail page (malformed-parameter path)

`/run-history/not-a-real-run` renders `Detail unavailable` followed by raw Zod/shared-contract validation output including internal field paths. A mistyped or shared bad URL exposes implementation details on a public page. Fix the malformed-parameter branch to reuse the not-found presentation.
