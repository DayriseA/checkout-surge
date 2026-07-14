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

---

## Implementation record (Task 35)

- **Status:** ✅ Complete and verified.
- **Completed scope:**
  - Added a single shared, deterministic dashboard timestamp formatter at `apps/web/src/app/lib/dashboard-time.ts` (`formatDashboardTime`). It builds the clock text from UTC date fields (`getUTCHours/Minutes/Seconds`) plus a literal `UTC` suffix, so output never depends on the host process timezone or locale ICU data. Chosen format: `HH:MM:SS AM/PM UTC` (e.g. `12:00:10 AM UTC` for `2026-06-20T00:00:10.000Z`).
  - Routed all client-rendered dashboard timestamp text through the shared formatter:
    - `public-demo-entry.tsx` (`/`): removed the local unsafe `formatTime`; the "Recovered" fact uses `formatDashboardTime`.
    - `dashboard-panels.tsx` (`/watch`): the local `formatTime` wrapper now delegates to `formatDashboardTime`, preserving the existing `Not started` behavior for missing values.
    - Admin surface: removed the duplicated unsafe `formatTime` export from `admin-feature-views.tsx`; `admin-authenticated-surface.tsx` imports and uses `formatDashboardTime` for the current-run "Recovered" fact.
  - Added focused regression coverage at the changed boundary:
    - `apps/web/test/dashboard-time.test.ts`: verifies `formatDashboardTime` returns the exact same UTC string for `process.env.TZ` set to `UTC` and then `America/New_York` (plus a fixed-output assertion), restoring the original timezone in cleanup.
    - `apps/web/test/public-demo-hydration.test.tsx`: a jsdom test that server-renders `PublicDemoEntry` with `renderToString` under `TZ=UTC`, injects the markup into a container, switches to `TZ=America/New_York`, and `hydrateRoot`s the same element while collecting `onRecoverableError`; asserts zero recoverable errors and the deterministic `12:00:10 AM UTC` text. The root is unmounted and the timezone restored in cleanup.
- **Material decisions:**
  - UTC-from-date-fields over `Intl`/`toLocaleString` to avoid host-default timezone and ICU-dependent timezone labels entirely.
  - Kept the 12-hour `AM/PM UTC` presentation to stay closest to the prior on-screen format; the UTC case now matches the old UTC output exactly.
  - The Run History list/detail components are server components and were intentionally left unchanged (out of scope); no client formatter duplication remains on the public/watch/admin dashboard surfaces.
  - No `suppressHydrationWarning`, no `mounted`/`isClient` gating, no `ssr: false`, no `console.error` suppression, and no `Date.now()`/random values in first render.
- **Verification performed:**
  - `pnpm --filter web exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.config.ts test/dashboard-time.test.ts test/public-demo-hydration.test.tsx` → 4 passed.
  - Confirmed the hydration regression test genuinely guards the defect: temporarily reverting the formatter to the unsafe `Intl` version makes the hydration test fail with exactly one captured recoverable error; restoring the fix makes it pass.
  - `pnpm --filter web test:unit` → 16 files / 130 tests passed.
  - `pnpm --filter web type-check` → passed.
  - `pnpm --filter web lint` (biome) → passed, no fixes.
  - `pnpm --filter web build` → passed.
  - `git diff --check` → clean.
- **Skipped checks:** `pnpm test:composition` and `pnpm test:characterization` were intentionally not run (repository AGENTS.md prohibits them unless explicitly requested; they require Docker and are out of scope for this focused web fix).
- **Remaining blockers / follow-up:** None for this task. A separate task may choose to standardize the server-rendered Run History date presentation if a future hydration boundary is added there.
