# Browser-Use Test Session — Chrome Runtime

Tested against `http://localhost:8080/` on July 5, 2026 using the Chrome plugin. The session covered public demo starts, live watch behavior, run history list/detail, admin sign-in and admin starts, public budget exhaustion, malformed routes, and console errors.

## Findings

| Code | Finding | Severity |
| :-- | :-- | :-- |
| E1 | Fresh dashboard loads emit React hydration error #418 | Medium |
| E2 | Malformed Run History detail IDs expose raw contract validation output | Low |
| E3 | Authenticated admin state is not reflected consistently in admin UI | Low |
| E4 | Out-of-range Run History pages show contradictory empty-state copy | Low |
| E5 | Clearing the admin duplicate slug can still create a preset from stale state | Medium |
| E6 | Admin-created presets have no visible delete path | Medium |

### E1 — Fresh dashboard loads emit React hydration error #418 (Medium)

**What happens:** A clean load of the public dashboard renders usable content, but Chrome records a client-side React runtime error during hydration. The error also appeared repeatedly during navigation and run transitions.

**Reproduction:**

1. Open a fresh Chrome tab.
2. Navigate to `http://localhost:8080/`.
3. Wait for the dashboard to render.
4. Inspect browser console errors for the tab.

**Where:** `http://localhost:8080/`, with the error reported from `/_next/static/chunks/3zp-z98is50wh.js`.

**Evidence:** Chrome console logged `Minified React error #418` on a fresh home-page load at `2026-07-05T07:57:38.542Z`. Earlier run starts and `/watch` navigations produced the same error several times.

**Expected behavior:** Production pages should hydrate without React runtime errors.

**Actual behavior:** The page appears usable, but React reports a hydration/runtime mismatch on initial load.

**Impact:** This affects first impressions for every visitor and can cause React to discard server-rendered markup or re-render unexpectedly. It also makes real frontend regressions harder to spot because the console is noisy during normal demo use.

### E2 — Malformed Run History detail IDs expose raw contract validation output (Low)

**What happens:** A UUID-shaped missing run ID shows a clean not-found state, but a malformed run-history detail URL renders raw Zod/shared-contract validation details to the public page.

**Reproduction:**

1. Navigate to `http://localhost:8080/run-history/not-a-real-run`.
2. Observe the detail page.
3. Compare with `http://localhost:8080/run-history/00000000-0000-4000-8000-000000000000`.

**Where:** `http://localhost:8080/run-history/not-a-real-run`.

**Evidence:** The malformed URL rendered `Detail unavailable` followed by a long validation payload including paths like `summary`, `run`, `orders`, `erpAttempts`, `notifications`, and `eventTimeline`, plus `Unrecognized keys`.

**Expected behavior:** Invalid or missing run IDs should produce a concise public-safe error, such as `Run not found` or `Invalid run ID`, without exposing internal schema validation output.

**Actual behavior:** The public UI displays low-level contract parsing details. A UUID-shaped missing ID does render the cleaner `Run not found` state, so the problem appears specific to malformed route parameters or malformed error response handling.

**Impact:** This does not break valid history/detail navigation, but a mistyped or shared bad URL exposes implementation details and looks broken to public visitors.

### E3 — Authenticated admin state is not reflected consistently in admin UI (Low)

**What happens:** After a successful `/admin` sign-in, protected controls become visible and usable, but the UI still shows unauthenticated wording. The run-history cleanup panel also keeps showing the passphrase form after an admin session is established.

**Reproduction:**

1. Navigate to `http://localhost:8080/admin`.
2. Enter `change-me-admin-passphrase`.
3. Submit `Sign In`.
4. Observe the authenticated admin console.
5. Navigate to `http://localhost:8080/run-history`.
6. In the cleanup panel, enter the same passphrase and submit `Sign In`.

**Where:** `http://localhost:8080/admin` and `http://localhost:8080/run-history`.

**Evidence:** On `/admin`, the page showed protected sections such as `PUBLIC POLICY`, `PRESETS`, `MAINTENANCE`, and `ERP DIAGNOSTICS`, while the top status text still included `access required`. On `/run-history`, the cleanup panel still showed `Admin passphrase` and `Sign In` after authentication; submitting the passphrase added `Admin session established.` but left the sign-in form and button visible.

**Expected behavior:** Once an admin session is established, admin surfaces should display an authenticated state and avoid continuing to prompt for the same passphrase.

**Actual behavior:** The protected controls are available, but the UI continues to present sign-in affordances and unauthenticated status text.

**Impact:** This is mostly a usability and trust issue. Operators can still work, but the mixed state makes it unclear whether the session is valid and invites repeated passphrase entry around destructive history controls.

### E4 — Out-of-range Run History pages show contradictory empty-state copy (Low)

**What happens:** Invalid page query values fall back to page 1 as intended, but an out-of-range positive page shows a total summary count while also saying there is no history.

**Reproduction:**

1. Ensure Run History has fewer summaries than would fill a second page. In this session it had 7 summaries.
2. Navigate to `http://localhost:8080/run-history?page=2`.
3. Observe the list body.

**Where:** `http://localhost:8080/run-history?page=2`.

**Evidence:** The page rendered `7 summaries`, then the completed-runs panel showed `No history yet` and `Terminal summaries appear here after a load run reaches API-owned finalization.`

**Expected behavior:** An out-of-range page should either fall back to the last valid page, disable impossible pagination, or show a page-specific empty state such as no summaries on this page.

**Actual behavior:** The page simultaneously says summaries exist and that no history exists.

**Impact:** This does not affect valid detail navigation, but it is confusing once users or crawlers land on out-of-range pagination URLs.

### E5 — Clearing the admin duplicate slug can still create a preset from stale state (Medium)

**What happens:** The admin duplicate flow is intended to validate an empty duplicate slug before mutation. In the tested interaction, clearing the `Duplicate slug` field and immediately clicking `Duplicate` created a persisted duplicate using the previous slug value.

**Reproduction:**

1. Sign in at `http://localhost:8080/admin`.
2. Select the `Preview 1k` preset.
3. Clear the `Duplicate slug` input.
4. Immediately click `Duplicate`.
5. Observe the preset list.

**Where:** `http://localhost:8080/admin`, preset editor.

**Evidence:** After the interaction, the admin console showed `Preset duplicated.`, `Inspection and starts 9 loaded`, and a new `Preview 1k Copy` preset. The selected slug became `preview-1k-copy`, and the duplicate input changed to `preview-1k-copy-copy`.

**Expected behavior:** Clearing `Duplicate slug` should cause client-side validation to show a duplicate-target error and avoid any mutation.

**Actual behavior:** A duplicate preset was created using the stale pre-clear slug value.

**Impact:** This is protected-admin-only, but it creates unintended persistent preset records and there does not appear to be a browser-visible preset deletion control. It also makes the duplicate validation path unreliable for fast or careless operator interactions.

### E6 — Admin-created presets have no visible delete path (Medium)

**What happens:** Admin operators can create additional editable presets through `Duplicate`, and can overwrite `Custom` through copy-to-custom, but the admin UI does not expose a way to delete duplicated presets afterward.

**Reproduction:**

1. Sign in at `http://localhost:8080/admin`.
2. Duplicate a preset, such as `Preview 1k`.
3. Select the newly created preset in the preset list.
4. Inspect the available preset actions.

**Where:** `http://localhost:8080/admin`, preset editor.

**Evidence:** After the duplicate flow created `Preview 1k Copy` / `preview-1k-copy`, the visible actions were `Start Admin Run`, `Save Preset`, `Copy to Custom`, and `Duplicate`; no delete/remove/archive control appeared. A code scan also found contract/proxy paths for preset list/save/duplicate/copy-to-custom, but no preset delete route or control path.

**Expected behavior:** If admins can create persistent editable presets, they should also have a protected way to remove mistaken or obsolete duplicates, or the UI should clearly state that duplicated presets are permanent and must be cleaned up by reset/maintenance.

**Actual behavior:** Admin-created duplicate presets remain in the preset list with no visible cleanup path.

**Impact:** This is protected-admin-only, but it makes accidental duplicates difficult to recover from and can permanently clutter the operator console during demo preparation. It is especially risky when combined with E5, where a duplicate can be created unintentionally.

## Notes

### N1 — Public budget exhaustion is enforced server-side, but the UI keeps start controls enabled

After two public starts in the same configured 300-second budget window, a third public custom start stayed on `/` and displayed `Public visitor run budget is exhausted.` This confirms server-side enforcement. The public preset and custom start buttons remained enabled afterward, so a visitor can immediately retry the same rejected action. This may be acceptable as a server-first protection model, but a disabled or clearer budget-exhausted state would reduce confusion.

### N2 — `/watch` clears terminal run outcomes immediately after finalization

During active and draining runs, `/watch` showed useful inventory, queue, ERP, consistency-lag, and outcome data. As soon as the run finalized, the page returned to `No active run`, reset the outcome panels to zero/no data, and kept the previous live event count visible. Run History contains the correct terminal data, so this may be intended current-run behavior, but it can be disorienting when a viewer is watching the final seconds of a run.

## Appendix — Session coverage

- Public home route `/`: curated preset list, public custom controls, invalid cap rejection, active/draining start gating, and public-budget exhaustion.
- Public custom starts: small accepted runs, delayed/draining run, server-side sold-out behavior, and terminal history summaries.
- Live watch `/watch`: idle state, active state, draining state, ERP retry/degraded state, queue pressure, consistency lag, live event counts, and final idle transition.
- Run History `/run-history`: summary list, terminal inventory/business metrics, detail links, no-selection delete validation, and cleanup passphrase UI.
- Run History detail `/run-history/[runId]`: valid terminal detail, UUID-shaped missing detail, and malformed-ID detail.
- Admin `/admin`: anonymous sign-in gate, invalid passphrase, valid passphrase, public policy display, preset list, disabled start while draining, enabled start while idle, and an admin-started Preview 1k run.
- Informational route `/about`: navigation and static content.
- Browser console: warnings/errors collected from fresh loads and run transitions.

## Appendix — Code-Scan Follow-Up Candidates

A follow-up code scan identified additional intended browser-visible paths that were not covered in the initial Chrome session. Chrome was initially unavailable after the scan because the native messaging host registry key was missing, but closing and reopening Chrome restored plugin connectivity and allowed partial follow-up testing.

Follow-up tests completed:

- Public custom `steady-arrival-rate` mode on `/`: the form switched to `Requests per second` and `Duration seconds`; over-limit duration produced the configured-cap rejection.
- Public custom client-side validation on `/`: `ERP error rate` above schema bounds produced `Run configuration is outside the shared start contract.` without navigation.
- Run History query parsing: `/run-history?page=abc` and `/run-history?page=0` fell back to page 1; `/run-history?page=2` produced E4.
- Admin read-only refreshes: `Refresh Recovery` and `Refresh Policy` kept panels populated and reported `Public runtime policy refreshed.`
- Admin invalid public-policy draft: unchecking both traffic modes produced `Public runtime policy values are outside the shared contract.`, and `Refresh Policy` restored both checked modes.
- Admin preset editor states: `public-custom` disabled save/copy/duplicate; `Custom` enabled save/copy/duplicate; public `Preview 1k` disabled save and allowed copy/duplicate.
- Admin duplicate-slug validation: attempted empty-slug validation instead created E5.

Recommended safe follow-up still not covered:

- Public visitor identity cookie behavior: verify `checkout_surge_public_visitor` is set/reused and malformed cookies are rotated.

Persistent or destructive flows still intentionally untested:

- Successful `Save Public Policy`, `Save Preset`, and `Copy to Custom`.
- `Apply ERP Controls`, `Reset ERP Controls`, `Reset Demo`, and `Cleanup Runs`.
- Valid Run History `Delete Selected` and `Delete All`.

Persistent mutation note:

- The E5 duplicate-slug test unintentionally created one admin preset, `Preview 1k Copy` / `preview-1k-copy`, while trying to exercise the empty-slug validation path. No cleanup was attempted.
