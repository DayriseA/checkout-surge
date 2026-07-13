# Task 26: Decompose the monolithic dashboard and admin-console components

## Execution context

- **Execution order:** This is task 26 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P3 — pulled forward: decompose before the dashboard-behavior entries that follow pile more logic into these files
- **Area:** web / architecture
- **Source:** comparison (worse)
- **Donor context (inlined below):** the useful Opus and GLM boundaries have been translated to the current tree in this document; implementation must not require either donor worktree.
- **Locations:** `apps/web/src/app/components/operator-dashboard.tsx`, admin console component

The operator dashboard owns watch state, realtime, recovery, event reduction, public start actions, and admin utility panels; the admin console owns auth, protected reads, policy/preset editing, starts, reset, cleanup, ERP controls, parsing, and draft conversion in one file. Existing workflow/reducer tests are good and should keep passing through the refactor. Best done **before** the dashboard-touching entries that follow (27–29, 46, and 65) pile more logic into these files.

## Verified donor findings

The recorded donor heads match the delegation context: Opus `6d2585646ea94fc357aab10769ff805314e0d396` and GLM `c07e0de15be815d84419a1c2abd2967f72de0463`. The following is the relevant information from those trees, inlined so the task can be completed without them.

### Opus: glue/presentation splits

- `apps/web/src/components/live-dashboard.tsx` is a thin client orchestrator. It owns `useReducer`, the clock, `EventSource`, recovery polling/co-ordination, and renders already-derived panel props. Event-to-state rules and selectors do **not** live in the component.
- `apps/web/src/lib/live-dashboard-state.ts` owns `initLiveDashboardState`, `liveDashboardReducer`, event parsing/application, run-change overlay resets, and `selectDashboardView`. It has no React, fetch, or `EventSource` dependency and accepts `now` as an argument for deterministic selector tests.
- `apps/web/src/app/admin/page.tsx` performs the session gate on the server and composes feature panels. Anonymous users never mount the protected console. Authenticated content is assembled from `AdminRunControls`, `AdminPresetPanel`, `AdminRuntimePolicyPanel`, `AdminErpChaosPanel`, and `AdminDemoReset`.
- `admin-runtime-policy-panel.tsx` (async server read) -> `admin-runtime-policy-form.tsx` (client state/fetch glue) -> `admin-runtime-policy-view.tsx` (prop-driven rendering) is the clearest three-layer example. `buildPolicyCaps` is a pure exported merge that preserves policy fields not shown by the form.
- `admin-preset-panel.tsx` reads on the server; `admin-preset-actions.tsx` owns mutation status and same-origin fetches; `admin-preset-actions-view.tsx` owns selection/rendering; `admin-preset-editor-view.tsx` owns the field-level editor. Mutations refresh the server-rendered read rather than making one parent synchronize every admin projection.
- `admin-erp-chaos-panel.tsx` is another server-read wrapper around a small client form. `admin-demo-reset.tsx` keeps its destructive-action confirmation, pending state, and result summary local to that action.

Do not copy Opus route names, types, styling, or recovery polling verbatim. Its value here is the responsibility split: server read, narrow client controller, prop-driven view, and pure conversion/state helpers.

### GLM: server reads, pure transitions, small client islands

- `apps/web/app/watch/page.tsx` is a server component. Its `WatchPanels` loads recovery, queue, and ERP in parallel, resolves the watched sale offer from recovery, then loads inventory and passes the initial snapshot into the client island.
- `apps/web/components/watch/live-watch.tsx` is the client orchestrator. It wires `watchReducer`, recovery coalescing, `useDashboardEvents`, terminal-event recovery, and presentational panels. It does not contain the event transition table.
- `apps/web/lib/dashboard-state.ts` owns `initialWatchState` and `watchReducer`. The reducer explicitly models `recovery-start`, `recovery-complete`, events received during an in-flight recovery, and the required follow-up recovery. This makes the discard/follow-up rule testable without React.
- `apps/web/components/realtime/use-dashboard-events.ts` owns the single `EventSource` subscription. It registers named contract events, validates frames, tracks connect/error/reconnect, stores callbacks in refs to avoid resubscribing on render, and supports an injected `EventSource` constructor for tests.
- `apps/web/app/admin/page.tsx` performs the server-side access gate, composes independent panels under `Suspense`, and leaves mutations in small client controls. `lib/admin-reads.ts` contains non-throwing, contract-validated server reads with timeouts and server-only admin headers.
- `components/admin/lifecycle-panel.tsx`, `preset-management-panel.tsx`, and `erp-chaos-panel.tsx` are async server components which convert a read into explicit `ok`/`unavailable`/`unreachable` view props. `demo-tools-panel.tsx` is a focused client island for reset/cleanup only.

Do not import GLM's contracts or copy its `ReadResult` vocabulary. Current checkout-surge already uses `BackendRead<T>`, `DashboardBackendSnapshot`, `readProxyJson`, and different event names. Preserve those current contracts and translate only the boundaries.

## Current checkout-surge ownership map

`apps/web/src/app/components/operator-dashboard.tsx` is 708 lines and currently combines four distinct responsibilities:

1. `OperatorDashboard` owns recovery/ERP state, the EventSource lifecycle, recovery coalescing refs, live-event counts, and public run-start mutation state.
2. `applyDashboardEvent`, `shouldRequestAuthoritativeRecoveryAfterEvent`, and the recovered-run/sale-offer/time-scope helpers implement pure reconciliation rules in the React file.
3. `AdminActionsPanel` owns a second sign-in path plus ERP update/reset, demo reset, and cleanup operations. It is currently dead from production because the only caller, `watch/page.tsx`, does not set `showAdminActions`; the other optional `showControls` and `showHistoryPlaceholder` branches are likewise unused.
4. `parseJson`, `LabeledInput`, `FactLike`, and `RunHistoryPlaceholder` are local transport/presentation utilities.

`apps/web/src/app/components/admin-console.tsx` is 1,574 lines and currently combines:

- session probing/sign-in (`authenticated`, `passphrase`, `refreshProtectedSurface`);
- four protected reads (`presetsRead`, `recovery`, `erpChaos`, `runtimePolicy`) and their refresh coupling;
- selected-preset/draft/duplicate state;
- runtime-policy refresh/save;
- run start, preset save/duplicate/copy-to-custom;
- destructive reset and cleanup;
- ERP update/reset;
- all panel markup and all config/draft parsing/conversion helpers.

The current server pages already provide the right entry points: `watch/page.tsx` calls `getDashboardBackendSnapshot()` before rendering `OperatorDashboard`, while `admin/page.tsx` currently mounts a fully client-owned `AdminConsole`. `apps/web/src/app/lib/api.ts` owns `BackendRead<T>` and server-side public reads; `apps/web/src/app/lib/client/proxy-json.ts` owns browser-side contract-validated proxy reads.

## Required target decomposition

Keep this an extraction/refactor, not a dashboard rewrite. File names may vary slightly, but the ownership boundaries below should be recognizable in the result.

### Watch surface

- `app/lib/dashboard-state.ts`: move `applyDashboardEvent`, `shouldRequestAuthoritativeRecoveryAfterEvent`, and all scope-matching helpers here. Add a small explicit state/action type if needed so recovery, connection status, live count, and in-flight/follow-up flags transition through a pure reducer. No React, fetch, DOM, or `EventSource` imports.
- `app/components/realtime/use-dashboard-events.ts`: own EventSource construction, JSON + `dashboardEventSchema` validation, connection status, teardown, and callback refs. It emits only valid `DashboardEvent` values and a reconnect/open signal; it does not mutate recovery state.
- `app/components/realtime/use-dashboard-recovery.ts` (or an equivalently focused hook): own the single-flight recovery request, discard-during-recovery marker, and exactly-one-follow-up behavior. Keep `readProxyJson(dashboardRecoveryProxyPath, dashboardRecoveryResponseSchema)` here and expose `recovery`, `isRefreshing`, and `refresh`/`applyEvent` commands to the orchestrator.
- `app/components/operator-dashboard.tsx`: retain only composition: consume the hooks/reducer, derive `liveSnapshot`, optionally wire a narrow run-start control, and pass props to existing `dashboard-panels.tsx`. It should not contain event matching, admin authentication, reset/cleanup, or ERP form code.
- Extract public run-start state/fetching to `app/components/public-run-controls.tsx` (or a hook colocated with `LoadRunControlsPanel`) only if the `showControls` capability remains required. Because no current production caller enables it, first verify whether entries 27–29 need it. Remove dead optional branches only when their intended replacement/caller is clear; do not silently remove a promised surface.
- Do not move `AdminActionsPanel` into another watch file. The canonical versions of ERP diagnostics, demo reset, and cleanup belong to the admin feature components below. If compatibility is temporarily needed, make the watch branch a thin composition of those components, not a second implementation.

Target watch data flow:

`watch/page.tsx server read -> initial DashboardBackendSnapshot prop -> OperatorDashboard client orchestrator -> pure dashboard reducer/recovery hook <- validated events from useDashboardEvents -> existing presentational dashboard panels`.

Authoritative recovery remains the baseline. Events are hints: ignore malformed or wrong-run/wrong-offer/stale events; while recovery is in flight, do not apply live events; request one follow-up recovery after the in-flight request settles. Terminal `run.completed`/`run.failed` still trigger authoritative recovery.

### Admin surface

- Keep `admin/page.tsx` as the composition root. Introduce a server-side session helper using the existing admin session cookie/route conventions; render only a small sign-in client component for anonymous users. Do not expose the passphrase or service token in props or browser code.
- Add server-only read helpers (for example `app/lib/server/admin-reads.ts`) for presets, recovery, ERP chaos, and runtime policy. Reuse current schemas and `BackendRead<T>`; reads must be non-throwing and `cache: "no-store"`. If the current session architecture makes direct authenticated upstream reads unsafe, keep reads through same-origin proxy endpoints for the first extraction and document that constraint rather than weakening the boundary.
- Compose focused panels from the page: `admin-current-run-panel`, `admin-runtime-policy-panel`, `admin-preset-panel`, `admin-maintenance-panel`, and `admin-erp-diagnostics-panel`. Each panel owns only its feature's read/mutation status; a failed ERP refresh must not clear presets or de-authenticate the whole console.
- For editable features, use a controller/view pair: the client controller owns draft and fetch state; the view receives values, disabled/error/status props, and callbacks. Keep shared field markup such as `TrafficEditor` and `RunConfigFields` presentational.
- Move `draftFromPreset`, `draftFromRuntimePolicy`, `draftFromConfigSnapshot`, `policyFromDraft`, `configFromDraft`, `parseInteger`, and `parseNumber` into `app/lib/admin-drafts.ts`. Export the minimum types/builders needed by controllers. These functions remain pure and must preserve fields not represented by a particular editor.
- Preset selection, save/duplicate/copy, and run-start config override stay together in the preset feature because they share the selected preset and draft. Reset/cleanup stay in a separate destructive-actions feature with explicit confirmation. ERP draft/update/reset stay isolated from runtime-policy draft/update.
- Replace the global `isSubmitting` and `statusMessage` with per-feature pending/error/notice state. One admin operation must not disable every unrelated panel or overwrite another panel's result.

Target authenticated admin data flow:

`admin/page.tsx session gate -> independent server reads/panel props -> small client controller per mutable feature -> current same-origin /api/admin proxy -> router.refresh or local validated result -> only that feature rerenders`.

## Next.js and state caveats

- A file using hooks, browser `fetch`, `EventSource`, or event handlers must remain behind a `"use client"` boundary. Pure reducer/draft modules must not import a client component, and server-only admin readers must never be imported by client modules.
- Props crossing server-to-client boundaries must be serializable. `BackendRead<T>` data is suitable; schemas, functions, `Response`, errors, cookies, and service clients are not.
- Server-loaded props initialize client state once. A `router.refresh()` can deliver new props without remounting the island, so either key a controller by stable identity or explicitly reconcile changed props. Do not overwrite an in-progress user draft on an unrelated server refresh.
- Maintain one owner for each live value. Do not render a server snapshot directly beside a reducer-owned copy that can drift. On run identity change, reset run-scoped overlays/counters so events from the previous run cannot hydrate the next run's display.
- React hydration occurs before `EventSource` connects. Initialize the reducer from the server snapshot and use a neutral `connecting` state; do not read time, `window`, or browser-only state during server rendering. Time-dependent selectors should accept `now` or update from an effect.
- Keep EventSource subscription stable. Changing callback identities must not tear down/reopen the stream; use callback refs or memoized callbacks. Always remove named listeners and close the source on unmount.
- Access gating in the page is a rendering boundary, not authorization. Existing proxy/API enforcement remains authoritative for every protected mutation.

## Incremental adaptation order

1. Extract the pure dashboard event/recovery transitions first, preserving exports temporarily so `dashboard-phase6.test.ts` can move imports without changing assertions.
2. Extract the EventSource and recovery-coordination hooks, then reduce `OperatorDashboard` to composition. Preserve the browser recovery semantics before touching panel markup.
3. Remove or replace the duplicated watch `AdminActionsPanel`; do not change the actual admin endpoint behavior in the same step.
4. Extract admin draft types/builders and their unit tests without changing rendered output.
5. Split anonymous sign-in from authenticated composition. Then extract one admin feature at a time (current run, runtime policy, presets/start, ERP, maintenance), keeping temporary `AdminConsoleProps` compatibility until existing component/workflow tests have been migrated.
6. Move eligible protected reads to server panels and use refresh after successful mutations. Make this per-panel so a failure does not force a broad rollback.
7. Delete the monolithic compatibility shell only after no page/test imports it and all focused controllers have boundary-level coverage.

## Focused verification

- Move/extend `apps/web/test/dashboard-phase6.test.ts` to import the pure state module. Keep its stale timestamp, wrong run, wrong sale offer, terminal recovery, inventory, queue, metrics, and business-outcome assertions.
- Keep the recovery-window test in `apps/web/test/browser-workflows.test.ts`: an event arriving during the first deferred recovery must cause exactly one serialized follow-up request. Add hook-level coverage for malformed frames, reconnect signaling, listener cleanup, and no resubscribe on callback rerender.
- Split `apps/web/test/dashboard-control-surface.test.ts` expectations across the sign-in gate and focused admin views while preserving the anonymous rule: reset/start/policy controls are absent before authentication, and starts are disabled for active/draining runs.
- Preserve the existing browser workflow that signs in and submits exact ERP chaos values. Add focused tests for each controller's independent pending/error state and for successful refresh/reconciliation.
- Add pure `admin-drafts` tests for round-tripping both traffic modes, numeric fallbacks, unchanged hidden fields, runtime-policy merge, and start/save schema payloads.
- Run the web package's targeted Vitest files first, then its typecheck/lint command, then the full web test suite. No backend, database, queue, ERP, or browser app should be required for this refactor; use injected fetch/EventSource and existing fixtures.

## Scope and non-goals

- Preserve all current contracts, proxy paths, auth enforcement, run-overlap rules, recovery semantics, status/error vocabulary, and panel output.
- Do not redesign the dashboard, add dashboard behavior from tasks 27–29/46/65, change SSE/backend protocols, or introduce a new global state library.
- Do not combine this with API, persistence, queue, worker, ERP, or shared-contract changes.
- Avoid a broad rewrite. Small compatibility wrappers are acceptable while callers/tests move, but the final ownership must not leave duplicate admin or realtime implementations.

## Implementation record

- **Status:** Complete (2026-07-13).
- Extracted pure dashboard event reconciliation and deterministic recovery transition state to `app/lib/dashboard-state.ts`; the module has no React, fetch, DOM, or EventSource dependency.
- Extracted the stable EventSource subscription and authoritative single-flight recovery coordinator into focused hooks. Callback refs prevent callback-render resubscriptions; malformed frames are ignored; named listeners are removed and the source is closed on cleanup; discarded in-flight events coalesce to one serialized follow-up.
- Reduced `OperatorDashboard` to hook and panel composition. Removed the unreferenced optional watch controls, history placeholder, and duplicate watch admin implementation after verifying there were no callers; public starts remain on `/` and privileged operations remain on `/admin`.
- Added a server admin-session rendering gate and server-only, non-throwing protected reads. Anonymous users receive only the sign-in island; authenticated reads attach the existing service credential on the server and cross the client boundary only as `BackendRead<T>` data. Mutations retain the same-origin proxy paths and enforcement.
- Replaced the stateful admin-console shell with focused current-run, runtime-policy, preset/start, maintenance, and ERP controllers plus stateless feature views. Each controller owns independent pending/notice state. Recovery has one shared owner where current-run and start gating require the same live value; reset refreshes that value, while unrelated prop refreshes do not overwrite in-progress drafts.
- Moved all requested draft types, parsers, and builders to `app/lib/admin-drafts.ts`, preserving hidden traffic/backpressure fields and both traffic modes.
- Focused coverage now includes dashboard scope rules, malformed/open/error/cleanup/stable SSE behavior, recovery single-flight plus exactly one follow-up, draft round trips and hidden-field merges, anonymous/authenticated rendering, exact sign-in path/header/refresh behavior with secret-safe errors, independent controller state, ERP exact-value/dirty-draft behavior, reset reconciliation after both available and unavailable reset responses, clean same-slug preset adoption, dirty preset preservation (including reselecting the active preset), and runtime-policy draft preservation plus explicit result adoption.
- Verification: the initial focused dashboard/admin run passed 22 tests and the initial complete non-characterization set passed 12 files/97 tests. Review cycle 1 expanded this to 6 focused files/27 tests and 13 non-characterization files/101 tests. The final review-cycle affected run passed 2 files/13 tests, including all 6 directly executed `browser-workflows.test.ts` cases, and the final complete web run passed 14 files/109 tests. Web typecheck and lint passed; the production web build passed with the existing Edge-runtime `node:crypto` warnings; `git diff --check` passed.
- Verification intentionally excludes the prohibited `test:characterization` and `test:composition` scripts. The migrated browser workflow file was executed directly through Vitest as required.
