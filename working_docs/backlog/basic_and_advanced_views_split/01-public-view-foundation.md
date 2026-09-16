# Task 01 — Per-page public view control

Status: Done (2026-09-16) · Depends on: none · Next: [Task 02](02-result-summary-and-warnings.md)

## Outcome

Each public page owns one accessible Basic/Advanced control at the top of its content. A new visitor starts in Basic. The choice is stored per page in a cookie, so the server renders the saved mode directly on reload without a flash of the other mode. Switching never reloads, refreshes or remounts the page. Admin and authenticated surfaces do not render the control.

## Read first

- [Design contract](design-contract.md), especially route scope and view interaction; [V01–V04](state-coverage.md).
- `apps/web/src/app/layout.tsx` (read only; it does not change), `globals.css`, `components/status-pill.tsx`, `components/control-styles.ts`.
- `app/run-history/page.tsx` and `app/run-history/[runId]/page.tsx` under `apps/web/src`, and `lib/server/admin-page-session.ts`, to see how the authenticated variant is already selected.
- Existing `dashboard-hydration.test.tsx`, `auth-rendering.test.tsx`, `public-mental-model.test.tsx` in `apps/web/test`.

## Work

1. Add one small client component that owns the view state for a page: it receives the initial mode from the server, renders the labeled **View: Basic / Advanced** control, and exposes the mode to its children through a narrow context. Pages render their Basic and Advanced content as children of this component; Advanced-only sections are wrapped in a small client helper that hides them with the `hidden` attribute while Basic is selected, keeping them mounted. Server-rendered content participates by being passed as children; do not import server readers into client modules.
2. Persist the choice per page in a cookie named after the page, for example `checkout-surge.view.watch`, with the values `basic` or `advanced` only. The client writes it with `document.cookie` (`Path=/`, `SameSite=Lax`, long `Max-Age`) when the user switches; no server action, route handler or request is needed. Each public page reads its cookie with `cookies()` from `next/headers` and passes the resolved mode to the client component. Missing, malformed or unreadable cookies mean Basic. The server and the first client render therefore agree, so there is no hydration mismatch and no flash of the other mode.
3. Provide a helper for contextual links such as “View technical measurements”: it switches the page to Advanced, reveals the target section and moves focus there. Returning to Basic while focus is inside a disappearing section moves focus to the view control.
4. Do not render the control on `/admin`, on the admin sign-in surface, or on authenticated history/report variants selected by the existing server session check. Those surfaces keep their current detailed presentation and ignore any public cookie. The cookie is never read as authorization.
5. Do not add a global preference, a layout-level provider, a store dependency, route groups or a mode-based `key` anywhere. Modes are independent between pages; opening a report from Watch uses the report page's own saved mode.

This task establishes the control and its helpers; tasks 02–07 wire each page's content into it. The complete branch is the deliverable.

## Acceptance criteria

- With no cookie, or with an invalid value, the page renders Basic on the server and on the client with no hydration warning. With a saved `advanced` cookie, the page renders Advanced on the server; the other mode never flashes.
- One keyboard-operable control per public page, using a native radio group or correctly implemented toggle buttons, with a visible selected state and focus styling. Hidden Advanced content is absent from the tab order.
- Switching updates the cookie and the visible sections only. It performs no navigation, router refresh, backend request, subscription reconnect or remount of page children.
- Admin and authenticated surfaces show no control and keep their existing rendering.

## Validation

Add focused DOM tests for: initial mode from a valid, missing and malformed cookie value; switching and cookie write; contextual reveal-and-focus; mounted-child preservation with one meaningful stateful child. Run the three existing suites listed above, the new tests, and the formatting/type checks from the design contract.

Check keyboard focus and the control's placement at desktop and narrow widths in the running application when available; record incomplete browser checks for task 08.

## Handoff

Record the cookie naming rule, the client component and helper names, and the tests. Tasks 02–07 must use these rather than introduce their own state. Suggested commit subject: `feat(web): add per-page Basic and Advanced view control`.

## Completion notes

- Cookie rule: `viewModeCookieName(page)` in `apps/web/src/app/lib/presentation/view-mode.ts` yields `checkout-surge.view.<page>` for `ViewPage` = `demo | watch | about | history | report`; `parseViewMode` accepts exactly `advanced`, everything else is `basic`. The client writes it with `Path=/; SameSite=Lax; Max-Age=31536000` only on a user switch.
- Server reader: `readPageViewMode(page)` in `apps/web/src/app/lib/server/page-view-mode.ts` (server-only, `cookies()`; unreadable store means Basic).
- Client component and helpers in `apps/web/src/app/components/page-view.tsx`: `PageView({ page, initialMode, children })` owns the native radio control (fieldset "View", radios "Basic"/"Advanced") and the mode context; `useViewMode()` returns `{ mode, setMode }`; `AdvancedOnly({ id, className, children })` hides with the `hidden` attribute and keeps children mounted (`tabIndex={-1}` reveal target); `RevealAdvancedLink({ targetId, children, className })` switches to Advanced and focuses the target. Returning to Basic with focus inside an `AdvancedOnly` section moves focus to the checked radio.
- Wired on `/`, `/watch`, `/about` (now `force-dynamic`), public `/run-history` and public `/run-history/[runId]` (available and unavailable branches); authenticated variants and `/admin` never read the cookie or render the control. Existing page content is passed unchanged as children; tasks 02–07 wrap Advanced-only sections with `AdvancedOnly` and must not introduce their own view state.
- Tests: `apps/web/test/page-view.test.tsx` (SSR mode, hydration in both modes without warnings or cookie writes, switch and cookie write, reveal-and-focus, focus return, mounted-child preservation) and `apps/web/test/page-view-mode.test.ts` (valid, missing, malformed and throwing cookie reads). Existing page-rendering suites mock `lib/server/page-view-mode.js`.
- Not done here, recorded for task 08: in-browser keyboard focus and control placement checks at desktop and narrow widths. The control currently renders above each page `<header>`; later page tasks may move it below the title when they restructure content.
