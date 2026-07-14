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

---

## Implementation record (Task 36)

- **Status:** ✅ Complete and verified.
- **Completed scope:**
  - Fixed the stale-state handoff at the frontend boundary so the duplicate submission consumes the value currently displayed in the DOM rather than a possibly stale React render closure.
  - `apps/web/src/app/components/admin/admin-feature-views.tsx`:
    - `AdminPresetView.onDuplicate` callback contract changed from `() => void` to `(targetSlug: string) => void`.
    - Wrapped the `Duplicate slug` input and `Duplicate` button in a semantic `<form>` whose `onSubmit` calls `event.preventDefault()`, reads the current value via `new FormData(event.currentTarget).get("duplicate-target-slug")`, and forwards it to `onDuplicate(targetSlug)`.
    - The input gained a stable `name="duplicate-target-slug"`; the button changed from `type="button"` + `onClick` to `type="submit"`. The same `disabled` conditions are preserved.
    - Extended the shared `LabeledTextInput` with a small optional `name` prop (passed straight through to the `<input>`).
  - `apps/web/src/app/components/admin/admin-authenticated-surface.tsx`:
    - `AdminPresetController.duplicate` now accepts `targetSlug: string` and validates that argument with the existing `duplicateDemoPresetRequestSchema`. The controlled `duplicateTargetSlug` state, its `onChange` handler, and the preset-switch default reset are retained purely for rendering/default behavior, so the submission value no longer depends on a completed rerender.
    - The `onDuplicate` wiring passes the form-supplied slug through: `onDuplicate={(targetSlug) => void duplicate(targetSlug)}`.
  - Focused regression coverage added to `apps/web/test/admin-controller-state.test.tsx`:
    - "rejects a duplicate when the visible slug is cleared ahead of React's state commit" reproduces the stale-render window by forcing the DOM input value to empty without flushing React state, installs a fetch mock that makes any network call observable, then activates `Duplicate` and asserts `fetch` was never called and that `Duplicate target slug is outside the shared contract.` is shown.
    - "submits the current duplicate slug exactly through the shared contract" types a distinct valid slug and asserts the request path (`adminPresetDuplicateProxyPath`) and parsed JSON body (`sourceSlug: "custom"`, exact `targetSlug`, and expected `displayName`), with the mutation and preset-list refresh stubbed.
- **Material decisions and rationale:**
  - Form/`FormData` submission over reading React state so the validated value is the value currently in the DOM even when a state commit has not happened. This is the smallest change that guarantees correctness without `flushSync`, timers, forced rerenders, duplicated ad hoc slug validation, or disabling the button off the same possibly-stale state.
  - The existing validation layers were left intact and are still the single source of truth: `duplicateDemoPresetRequestSchema` (`.trim().min(1)` on `targetSlug`) is used unchanged in the controller, and the web proxy route and API route continue to validate with the same schema. Because the submitted value is the raw DOM string passed through that schema, whitespace-only input still fails the trimmed `.min(1)` constraint.
  - Kept the controlled input/value pair for rendering and default updates; only the submission value source changed.
  - No preset deletion/archive behavior was added (Task 37). No database, API service, API route, shared contract, authentication, or unrelated admin control was modified.
- **Verification performed:**
  - `pnpm --filter web exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.config.ts test/admin-controller-state.test.tsx` → 9 passed (7 pre-existing + 2 new).
  - Confirmed the regression test genuinely guards the defect: with the two production source files reverted to HEAD (old closure-based `duplicate()` reading `duplicateTargetSlug` state), the regression test fails for the intended reason — `fetch` is called once with the stale body `{"sourceSlug":"custom","targetSlug":"custom-copy","displayName":"Custom Copy"}` against `adminPresetDuplicateProxyPath`; restoring the fix makes it pass.
  - `pnpm --filter web test:unit` → 16 files / 132 tests passed.
  - `pnpm --filter web type-check` → passed.
  - `pnpm --filter web lint` (biome) → passed, no fixes applied.
  - `pnpm --filter web build` → passed.
  - `git diff --check` → clean.
- **Skipped checks:** `pnpm test:composition` and `pnpm test:characterization` were intentionally not run (repository AGENTS.md prohibits them unless explicitly requested; they require Docker and are out of scope for this focused web fix).
- **Remaining blockers / follow-up:** None for this task. The shared schema, web proxy route, and API route are unchanged and continue to validate `targetSlug`. Preset deletion/remediation of already-created stale duplicates is Task 37 and was intentionally left out of scope.
