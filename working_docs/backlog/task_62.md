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

## Implementation record (2026-07-15)

### Status

Completed.

### Completed scope and decisions

- The web list now distinguishes globally empty history (`totalCount === 0`) from an empty out-of-range page slice (`summaries.length === 0` with `totalCount > 0`).
- Out-of-range pages state which requested page has no summaries, preserve the truthful total count, and link back to the latest summaries at `/run-history`.
- The genuine first-run empty state remains unchanged.
- The API pagination contract and service behavior remain unchanged. This keeps the fix in the frontend component that owns the misleading copy and avoids a broader pagination redesign.
- Existing `docs/` descriptions only document Run History ownership, access, and refresh behavior; none specify out-of-range pagination copy or API clamping, so no product documentation change was needed.

### Verification

- `pnpm --filter web exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.config.ts test/run-history.test.ts`: 1 file, 4 tests passed, including the reported seven-summaries/page-2 response and the genuine zero-summary empty state.
- `pnpm --filter web type-check`: passed; Next.js route types generated and TypeScript reported no errors.
- `pnpm --filter web exec biome lint src/app/components/run-history-list.tsx test/run-history.test.ts`: passed; 2 changed source/test files checked with no findings.
- `git diff --check`: passed.
- `pnpm test:composition` and `pnpm test:characterization` were not run per repository instructions.
