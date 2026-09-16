# Task 06 — Public run history

Status: Done · Depends on: [Task 05](05-demo-and-custom-builder.md) · Next: [Task 07](07-about-and-recovery.md)

## Outcome

Public history rows answer which simulation ran, when, and what happened. Advanced retains the detailed comparisons. Authenticated history keeps its current dense rows, selection and cleanup behavior.

## Read first

- [Design contract](design-contract.md), route scope and list DTO limits; [H01–H02 and V02–V03](state-coverage.md).
- `apps/web/src/app/run-history/page.tsx`, `components/run-history-list.tsx`, `relative-time.tsx`.
- `components/run-history-admin-controls.tsx`, `run-history-row-controls.tsx`, `run-history-delete-all-button.tsx` as regression boundaries.
- `lib/presentation/public-vocabulary.ts`, `run-history-count.ts`, `format.ts` and `packages/contracts/src/demo.ts` (`RunHistoryListItem`).

## Work

1. Give the public list an explicit mode-aware composition while preserving the authenticated variant selected by the route. The existing list is reused inside the admin controls provider; the authenticated variant renders no view control and ignores the page's view cookie.
2. Basic rows show scenario with a mandatory “10,000 attempts · 1,000 units” subtitle from `plannedAttempts` and `startingStock`, readable absolute date/time with timezone and relative recency, canonical `resultOutcome` label, confirmed/failed counts, explicitly labeled overall duration and one accessible View report link. Use separate labels rather than unexplained numeric pairs. Without the subtitle, “1,000 confirmed” alone would not tell the reader how many buyers competed.
3. The list has planned attempts and cannot infer unique buyers, duplicate settings, pending count, oversold quantity or speed-target result, so the subtitle says attempts. Keep available warning/indeterminate outcome labels; send readers to the exact report for detail. Do not add per-row fetches or enrich the list contract. Rewrite the page subtitle under the h1 in plain vocabulary.
4. Advanced retains current demand/stock, reservations/rejections, confirmed/failed and convergence comparisons, with a brief definition distinguishing convergence from overall duration. Avoid repeating the same fact in competing panels.
5. Preserve exact IDs in report hrefs, pagination query semantics, relative-time behavior and accessible per-row link names. The page's cookie-backed mode survives pagination without losing the selected page.
6. Add Start a simulation to a genuinely empty public history. Preserve View page 1 for out-of-range pages, and safe recovery for unavailable reads. These states do not need artificial Advanced detail.

## Acceptance criteria

- Basic rows can be scanned without deciphering multiple `x / y` relationships. Long scenario names and warning labels wrap at narrow widths.
- Result labels and counts agree with existing list DTOs in both views; terminal does not automatically become green success.
- Advanced retains all current public list facts. No extra network request is made per row or on a view switch.
- Empty, out-of-range, unavailable and multi-page history remain actionable; exact report and pagination links are unchanged.
- Authenticated selection, one/selected/all deletion, confirmation and refresh flows still operate with their existing detailed rows and render no view control.

## Validation

Update/run `run-history.test.ts`, `run-history-admin-controls.test.tsx`, `auth-rendering.test.tsx`, `relative-time.test.tsx`, and the history cleanup/page cases in `browser-workflows.test.ts`. Add focused Basic/Advanced row and pagination assertions with mixed outcomes. Retain the current admin deletion checks; do not perform destructive browser deletion as UX validation.

Run common formatting/type checks. Inspect several real history rows at desktop and narrow widths; use valid fixtures for empty, indeterminate or out-of-range states if the runtime lacks them.

## Handoff

Record how the public/admin list variant is selected and which unavailable quantities are intentionally left to the report. Suggested commit subject: `feat(web): simplify public run history rows`.

## Completion notes

- Variant selection: `apps/web/src/app/run-history/page.tsx` keeps using the server's `hasValidAdminPageSession()` result. Anonymous renders are wrapped in `PageView page="history"` (cookie `checkout-surge.view.history`, read server-side, so the mode survives pagination without touching the query string); authenticated renders skip `PageView` entirely, so no view control exists and the cookie is ignored. `RunHistoryList` is shared: its `AdvancedOnly` sections are hidden in public Basic, revealed in public Advanced, and always visible without a `PageView` context, which is how the admin list keeps every fact plus its selection/deletion controls.
- Rows (`components/run-history-list.tsx`): always-visible scenario, "N attempts · M units" subtitle, absolute UTC time with relative recency, canonical outcome pill, separately labeled confirmed/failed orders, "Overall duration", one "View report" link with the exact run ID. Advanced-only: unique reservations secured, sold-out rejections, convergence duration, plus one list-level definition distinguishing convergence from overall duration. Empty history links "Start a simulation" to `/`; out-of-range and unavailable states are unchanged.
- Intentionally left to the linked report because the list DTO does not carry them: unique buyers, duplicate settings, pending count, oversold quantity, speed-target verdict.
- Validation: `pnpm exec biome check` on touched files; focused vitest (`run-history`, `run-history-admin-controls`, `auth-rendering`, `relative-time`, `page-view`, `browser-workflows`: 6 files, 150 tests passed); `pnpm --filter web type-check` and `pnpm type-check:test` passed. Coverage: H01/H02/V02/V03 via `run-history.test.ts` (Basic/Advanced rows with mixed outcomes, empty/out-of-range/pagination, admin render without view control) and `auth-rendering.test.tsx`. Narrow-width behavior relies on wrapping (`min-w-0`, `break-words`, flex wrap); no browser viewport inspection was performed in this handoff, left to Task 08.
- Follow-up: the admin list now uses the same stacked row layout as the public Advanced view instead of the former single-line desktop grid; all facts and controls are retained.
