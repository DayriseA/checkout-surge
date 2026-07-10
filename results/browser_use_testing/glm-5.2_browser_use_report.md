# Browser-Use Testing Report

Date: 2026-07-04  
Target: `http://localhost:8080/` reference runtime  
Tester: Codex browser-use session

## Findings Index

| Code | Finding | Severity |
| --- | --- | --- |
| E1 | Mobile layout has horizontal overflow in the top navigation and run history table | Low |
| E2 | Public home mixes stale future-phase copy with a missing public custom/guardrail surface | Medium |
| E3 | Admin run start accepts the run but does not move the operator to `/watch` | Low |
| E4 | Live Watch can get stuck with partial run counters and a contradictory "No active run" completion panel | Medium |
| E5 | Admin start control is enabled with no preset selected and fails silently | Low |
| E6 | Repeated action buttons have indistinguishable accessible names | Low |
| E7 | Failed runs do not expose an actionable explanation or detail view | Medium |

## Findings

### E1 — Mobile layout has horizontal overflow in the top navigation and run history table (Low)

At a narrow mobile viewport, the page becomes wider than the viewport instead of fitting, wrapping, collapsing, or containing overflow in an intentional scroller. This was downgraded to Low because mobile compatibility was not part of the evaluated implementation scope.

Reproduction:

1. Set the viewport to a narrow mobile size, e.g. 390px wide.
2. Open `http://localhost:8080/`.
3. Open `http://localhost:8080/admin`.
4. Open `http://localhost:8080/run-history`.
5. Inspect the top navigation and run table.

Where/evidence:

- Pages involved: `/`, `/admin`, `/run-history`.
- At 390px viewport width, `document.documentElement.scrollWidth` was `600` while `clientWidth` was `375`.
- The `Admin`, `Run History`, and `About` nav links were positioned beyond the right edge of the viewport.
- On `/run-history`, the table measured roughly 474px wide while the client width was 375px, and the `Confirmed` / `Failed` columns were beyond the right edge.

Impact:

- Mobile or narrow-window users need horizontal scrolling to reach navigation and table content.
- Since mobile was not requested in the model task scope, this is mostly a polish/responsiveness gap rather than a core product failure.

### E2 — Public home mixes stale future-phase copy with a missing public custom/guardrail surface (Medium)

The public home page still presents delivered functionality as future work, and the `Surge Guardrails` panel remains a placeholder where the documented public custom/guardrail surface should exist. The first part is copy drift; the second part appears to be an incomplete public-home UI surface for functionality expected in the first 10 phases.

Reproduction:

1. Open `http://localhost:8080/`.
2. Read the public home panels.
3. Look for the documented bounded public custom / guardrail controls on the public route.

Where/evidence:

- Page involved: `/`.
- Stale future-phase copy on implemented surfaces:
  - `Queue pressure, realtime events, ERP health, and the load orchestrator surface in later phases.`
  - `Admin controls, ERP tuning, and reset land in later phases.`
- Those surfaces do exist on `/watch` and `/admin`, so those strings are UI-copy drift.
- More substantial placeholder:
  - `Static placeholder surface — wired up in a later phase.`
- This appears on the `Surge Guardrails` home panel.
- Follow-up source/roadmap review found `docs/admin_access_protection.md` says `/` should include bounded public custom controls, while the current public picker excludes the read-only `public-custom` base.

Impact:

- Public visitors see stale/future-tense messaging that makes implemented features look missing.
- More importantly, the public route appears to lack the promised bounded public custom/guardrail control surface, even though backend policy and caps exist.

### E3 — Admin run start accepts the run but does not move the operator to `/watch` (Low)

Starting an admin run succeeds, but the browser remains on `/admin` instead of moving the operator to the live watch surface. Public starts from the `Load-Run Controls` panel do navigate to `/watch`, so the admin flow is inconsistent with both public behavior and the documented runtime flow.

Reproduction:

1. Open `http://localhost:8080/admin`.
2. Sign in with `change-me-admin-passphrase`.
3. In `Current Run`, select `Admin Custom (admin)`.
4. Click `Start run`.
5. Observe the page URL and current-run panel.

Where/evidence:

- Page involved: `/admin`.
- After clicking `Start run`, the `Current Run` panel shows `Run active` for `Admin Custom · admin`.
- The `Start run` button becomes disabled with `A run (Admin Custom) is already in progress.`
- The browser remains at `http://localhost:8080/admin`; it does not navigate to `/watch`.

Impact:

- Operators can start a run and miss the intended live observation page unless they manually navigate to `/watch`.
- This weakens the main admin demo workflow and makes admin starts feel less complete than public starts.

### E4 — Live Watch can get stuck with partial run counters and a contradictory "No active run" completion panel (Medium)

After a public start navigates to `/watch`, the watch page can display live counters from a run while the completion panel simultaneously says there is no active run. The page then remained in that contradictory state for at least 30 seconds.

Reproduction:

1. Open `http://localhost:8080/`.
2. Click the `Start load run` button in the `Load-Run Controls` panel.
3. Let the automatic navigation to `/watch` occur.
4. Keep the page open while the run progresses/finalizes.

Where/evidence:

- Pages involved: `/`, `/watch`, `/run-history`.
- `/watch` showed live counters from the new run: `secured 62`, `queued 62`, `confirmed 62`, and inventory `938 of 1,000 remaining`.
- At the same time, the `Completion Outcomes` panel said `No active run - completion outcomes appear once a run is in progress.`
- The state stayed unchanged for at least 30 seconds.
- Reloading `/watch` reset the request/inventory panels back to idle baseline.
- `/run-history` showed the same `Preview 1k` run as terminal `Failed` with `62 (6%)` delivered and `62` confirmed.

Impact:

- Spectators cannot tell whether they are watching an active, completed, failed, or stale run.
- This directly affects the product's core demonstration surface: observing lifecycle/finalization behavior during a surge.

### E5 — Admin start control is enabled with no preset selected and fails silently (Low)

The admin `Start run` button is enabled while the preset select is still on the placeholder option. Clicking it does nothing visible.

Reproduction:

1. Open `http://localhost:8080/admin`.
2. Sign in with `change-me-admin-passphrase`.
3. Leave the `Start a preset` select on `Select a preset...`.
4. Click `Start run`.

Where/evidence:

- Page involved: `/admin`.
- `Start run` is enabled with the placeholder `Select a preset...` selected.
- Clicking it produces no inline validation, no toast, no status change, and no field focus feedback.

Impact:

- Admin users can perform an apparently valid action that silently fails.
- This is low severity because it does not mutate state or block a knowledgeable user from selecting a preset and starting a run.

### E6 — Repeated action buttons have indistinguishable accessible names (Low)

Several repeated controls share identical button names without target-specific accessible labels. This makes the UI harder to operate with assistive technology and less clear for keyboard/search-driven interaction.

Reproduction:

1. Open `http://localhost:8080/`.
2. Inspect the public preset buttons in `Available demo runs` and the separate `Load-Run Controls` button.
3. Open signed-in `http://localhost:8080/admin`.
4. Inspect preset-management actions.

Where/evidence:

- Pages involved: `/`, `/admin`.
- Public preset cards and the load-run panel expose five buttons all named `Start load run`.
- Admin preset management exposes repeated `Duplicate` and `Copy to Custom` actions without target-specific accessible names.
- Expected examples would be target-specific labels like `Start Idempotency Check 200` or `Duplicate Preview 1k`.

Impact:

- Keyboard and assistive-technology users cannot distinguish which preset each action affects from the button name alone.
- This is a usability/accessibility issue rather than a data correctness issue.

### E7 — Failed runs do not expose an actionable explanation or detail view (Medium)

Every non-Idempotency Check run observed in Run History finalized as `Failed`, but the UI does not make the reason clear. Run History shows high-level status, delivered count, and business outcome counts, but there is no run details view or visible failure explanation that helps distinguish expected under-delivery, load-orchestrator failure, lifecycle finalization rules, or backend/runtime problems.

Reproduction:

1. Start one or more non-idempotency presets, e.g. `Preview 1k` from `/` or `Admin Custom` from `/admin`.
2. Wait for the run to finalize.
3. Open `http://localhost:8080/run-history`.
4. Inspect the failed run row and the outcome card below the table.

Where/evidence:

- Page involved: `/run-history`.
- Observed finalized rows included:
  - `Admin Custom` with status `Failed`, duration `22.6s`, delivered `125 (13%)`, confirmed `125`, failed `0`.
  - `Preview 1k` with status `Failed`, duration `8.5s`, delivered `138 (14%)`, confirmed `138`, failed `0`.
  - `Preview 1k` with status `Failed`, duration `7.4s`, delivered `135 (14%)`, confirmed `135`, failed `0`.
  - `Surge 5k` with status `Failed`, duration `22.5s`, delivered `653 (13%)`, confirmed `200`, failed `0`.
  - `Preview 1k` with status `Failed`, duration `11.9s`, delivered `62 (6%)`, confirmed `62`, failed `0`.
  - `Admin Custom` with status `Failed`, duration `12.3s`, delivered `175 (18%)`, confirmed `175`, failed `0`.
  - `Idempotency Check 200` with status `Completed`, delivered `100 (50%)`, confirmed `100`, failed `0`.
  - Additional `Idempotency Check 200` rows also completed, e.g. delivered `175 (88%)` with `100` confirmed and delivered `115 (57%)` with `100` confirmed.
- The outcome cards show aggregate counts such as `CONFIRMED`, `FAILED`, `PROCESSING`, `QUEUED`, `ERP SUCCEEDED`, `ERP FAILED`, `ERP TIMED OUT`, and `NOTIFICATIONS`, but not a visible explanation for why the run itself failed while all delivered orders confirmed.
- Source review of `apps/web/app/run-history/page.tsx` found the page renders summary rows and the first three aggregate outcome cards only. The `Failed` label has a `title` attribute for `failureReason`, but there is no visible detail route, expandable panel, or linked run detail page.

Impact:

- Demo viewers and evaluators see failed runs but cannot tell whether the failure is a product bug, expected delivery-quality threshold behavior, local runtime capacity, or a specific load-orchestrator/finalization reason.
- This makes the main benchmark/demo output hard to interpret, especially because the visible business outcome counts can look successful (`confirmed` equals delivered and `failed` is `0`) while the run status is still `Failed`.

## Appendix — Session coverage

Surfaces and flows exercised:

- Public home/demo picker route `/`.
- Public start button from the home page.
- Live watch route `/watch`.
- Public run history route `/run-history`.
- Static about route `/about`.
- Admin gate `/admin`.
- Admin login with `change-me-admin-passphrase`.
- Admin sign-out and invalid-login feedback.
- Admin ERP behavior profile update with the default values.
- Public default start from the `Load-Run Controls` panel and follow-up `/watch` observation.
- Run History after terminal public and admin runs.
- Signed-in admin current-run start for `Admin Custom`.
- Verified admin run start remains on `/admin` instead of moving to `/watch`; see E3.
- Admin empty-preset start submission; see E5.
- Narrow mobile viewport pass at 390px width for `/`, `/admin`, `/run-history`, `/watch`, and signed-in `/admin`; see E1.
- Follow-up roadmap/source review for the public-home future-phase placeholder copy; see E2.

Working flows observed:

- `/about` rendered normally.
- Admin login with `change-me-admin-passphrase` succeeded.
- Empty admin passphrase kept `Sign in` disabled.
- Invalid admin passphrase showed `Invalid passphrase`.
- Admin sign-out returned to the protected login gate.
- Admin ERP behavior profile update with the default values showed `Updated the retained ERP chaos profile.`
- The `Load-Run Controls` public start did navigate to `/watch`.
- Admin `Admin Custom` start succeeded, showed `Run active`, and disabled the admin start control while active.
- Terminal public/admin runs appeared in `/run-history` with durable outcome summaries, though failed-run explanation/detail is covered in E7.

Not exercised:

- Destructive admin reset.
- Preset duplicate/copy-to-custom mutations.
- Maintenance cleanup actions.
