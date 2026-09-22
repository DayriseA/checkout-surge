# 24 — Align reset presentation and admin ERP fields

## Handoff

- Status: Implemented and validated on 2026-09-22 in the current working tree. Contract/producer, Watch/history presentation and admin field grouping are aligned; check and browser evidence is recorded below.
- Origin: Chrome acceptance checks on the local reference runtime on 2026-09-22, comparing the complete `cleaning` state (`a1ddd151`) with `dev` (`c4a81472`), including the inherited adaptive-ERP work.
- Branch: Implement on the assigned current branch or its dedicated worktree. The index's original `feat/adaptive-erp-and-admission` target does not apply to this post-delivery follow-up.
- Prerequisites: Tasks 12–14 and 18 are implemented. Read the current code, repository instructions and [quality checklists](../../../docs/quality_checklists.md) before editing.
- Ownership: Web presentation, page composition, admin field grouping and their tests, plus one additive discard marker on the run snapshot contract and its API projection producer (see anomaly 1). Existing API summaries remain authoritative.
- Relevant decisions: D01 (unchanged lifecycle), D02 (destructive reset with a minimal retained history entry), D10 (automatic reset), D13 (retired scenario-engine controls).

## Objective and fixed rules

Correct all three observed UI anomalies so a developer or agent can complete this task without further product decisions. A reset that discarded a run's data must consistently appear as **Cancelled**, with the reset origin and data-discard explanation, rather than as a business failure or an unfinished experiment. Admin ERP fields must be grouped by their actual meaning.

Cancellation is decided only from an explicit `dataDiscarded` marker, never inferred from a `failed` status or from a `failureCategory` alone. Two boundaries carry that marker:

- The saved public report already exposes `summary.dataDiscarded` (produced by `isDestructiveResetReason` in `run-history-service.ts`).
- The live dashboard projection does not. `DashboardProjection.currentRun` is a `DemoRunSnapshot` whose failed variant carries only `failureCategory`, and Watch retains terminal projections across idle reads (`terminalRunFrom` / `retainTerminalAcrossIdleRead` in `dashboard-projection-state.ts`), so a reset run can reach Watch through the live path with no authorized marker. Owner decision (2026-09-22): add `dataDiscarded` to the failed run snapshot variant of the contract and produce it in `toDemoRunSnapshot` from `isDestructiveResetReason(run.failureReason)`, mirroring the history summaries. This is an additive, optional contract field; it is the only backend change this task allows.

For discarded runs, `failureCategory === "automatic_reset"` selects automatic-reset copy; the admin-reset case uses admin copy. Do not add a persisted `cancelled` lifecycle status, alter canonical business outcome calculations, erase evidence from API responses, or manufacture zero pending counts to hide this presentation problem.

The `operator` failure category is produced only for `admin_reset` (`toPublicRunFailureCategory` is exhaustive), so every consumer branch keyed on it describes a discarded run. Once cancellation rendering takes precedence, those branches become unreachable. Owner decision (2026-09-22): remove them in this task rather than leaving dead copy. That covers the "Operator stop decision", "Acceptance-to-stop duration" and "Operator-stopped run" copy and the `operatorReset` prop on Watch (currently keyed on `acceptedResult === undefined`, a different criterion for the same state), and the `automatic_reset` special case in `failedSentence` of `run-result-presentation.ts`, which would otherwise duplicate the cancellation copy. Remove their tests with them. This is the full extent of the vocabulary cleanup; leave unrelated copy alone.

## Observed evidence and reproduction

The reference runtime was accessed through `http://localhost:8080`. Run IDs below are diagnostic references, not permanent fixtures: a local wipe may remove them. Reproduce with newly generated data when needed. Never commit credentials or local environment files.

The browser session completed five runs: a 100-order run at 2 TPS; a 100-order run with 20% transient errors; a 200-request duplicate run yielding 100 unique orders; an interrupted 100-order run; and a successful 10-order run after reset. Completed 100-order runs each recorded 100 confirmations and 100 notifications, with no final order failure or overselling. These observations support the narrow UI scope; they do not prove all backend failure modes.

### 1. Watch describes an intentionally reset run as a failure with pending work

- Reproduction: In admin, start a one-off buyer-spike run with 100 buyers, stock 100, quantity 1, ERP latency 100 ms, capacity 2 TPS, error rate 0 and outage off. Open the accepted run's `/watch?acceptedRunId=<id>`. Reset the demo while confirmations remain outstanding, then inspect Watch and reload it.
- Observed run: `380c94c2-b088-46a5-b3a2-c3acfa7af51a` (accepted at 13:53:05 UTC, reset at 13:53:50 UTC).
- Actual: Watch displayed `Failed`, `The run failed due to a operator failure. 14 orders remain pending.`, and `Reconciliation warning: some final evidence populations disagree and need investigation.` The same messages persisted after reload. The runtime was already free and the history detail correctly said its data was discarded.
- Expected: A neutral `Cancelled` result, identity and report link, plus `This run was cancelled by an admin reset. Its experiment data was discarded.` Automatic reset uses the corresponding automatic-reset wording. Do not show pending-work claims, normal business-result counters, success/failure verdicts or reconciliation warnings for a discarded experiment.

Two Watch paths can present a reset run and both must be covered:

- Saved report path: `acceptedRunResultFromRead` builds `reportEvidence` from the public detail without carrying `summary.dataDiscarded`, so `AcceptedResultNarrative` runs `derivePublicRunSummary` on discarded evidence. This is the path that survives a reload and produced the observed messages.
- Live projection path: `WatchNarrative` / `terminalSummary` derive from `composition.result` (`deriveRunResult(evidenceFromDashboard(projection))`) when the retained terminal projection is a failed `admin_reset` / `auto_reset` snapshot.

Recommended correction:

1. Contract and producer: add `dataDiscarded: z.boolean().optional()` to `failedDemoRunSnapshotSchema` in `packages/contracts/src/demo.ts`, following the existing `failureCategory` pattern (`z.never().optional()` on the nonterminal and completed variants). Produce it in `toDemoRunSnapshot` (`apps/api/src/services/demo-run-projections.ts`) with `isDestructiveResetReason(run.failureReason)`, exactly as the history summaries do. Cover it in `packages/contracts/test/contracts.test.ts` and `apps/api/test/demo-run-projections.test.ts`. No other API behavior changes.
2. Trace the public history read through `acceptedRunResultFromRead`, the accepted-result hook, Watch composition and `AcceptedResultNarrative`.
3. Preserve the discard marker and reset origin in the web's accepted-result presentation model. A small explicit cancellation variant or discriminated presentation state is preferable if it prevents normal report evidence from being used for discarded runs; do not introduce a generic result framework. This variant replaces the `operatorReset` prop and its "Operator-stopped run" copy.
4. Select cancellation rendering **before** `deriveRunResult` / `derivePublicRunSummary` and normal result/caveat rendering on both paths: from `run.dataDiscarded` in `deriveWatchComposition` (a dedicated cancelled phase or an equivalent explicit state, so `terminalSummary` never sees a discarded run) and from the saved report marker in the accepted-result model. The same run must not regain a failure narrative after a projection change or a reload.
5. Keep accepted-run identity tracking intact when the current run disappears or a successor starts. A previous cancellation must not replace the successor's live status or acquire the successor's counts. Preserve loading, unavailable, retry and genuine failure behavior.

### 2. Public history detail says both Failed and Cancelled

- Reproduction: Open `/run-history/<reset-run-id>` while signed out of admin. Compare it with the same detail while signed in and with the history list.
- Actual: The public page's outer header showed `Failed`; its child rendered `Cancelled` and the correct discard explanation. The page had duplicate run titles (`h1`) and duplicate return links. The authenticated detail correctly used the cancellation block. The history list labelled the row `Cancelled` but still exposed snapshot counts (86 confirmed, 100 reservations for this run).
- Expected: One coherent cancellation page, one primary heading and one primary return link, no contradictory failure badge or normal experiment report. The retained list row should be a minimal cancellation entry with identity/time and the report link, not a business scorecard for discarded data. Preserve existing authorized history actions.

Recommended correction:

1. In `run-history/[runId]/page.tsx`, handle the discarded public response before the generic report header. Prefer composing the existing discarded-run detail as the whole cancelled page rather than patching only the badge text.
2. Give the page or its cancellation component clear ownership of heading and navigation so they are rendered once. Reuse the existing discard explanation; share a small presentation helper only where the same decision/copy is actually used by Watch and history.
3. In `run-history-list.tsx`, make the existing `dataDiscarded` branch govern the summary content as well as the badge: retain identification, cancellation and navigation/actions, but suppress normal business counts and convergence claims. Do not change the retained backend summary or ordinary rows.
4. Cover both admin and automatic reset, signed-out and authenticated detail, and direct navigation/reload. Ordinary completed and genuinely failed reports retain their current evidence and warnings.

### 3. Retired controls left positional field groups misaligned

- Reproduction: Open the admin preset editor and inspect the per-run ERP and worker sections, then expand the effective preview and public runtime policy defaults.
- Actual: `Circuit protection` contains `ERP max TPS` and `ERP error rate`; `ERP latency ms` appears under `Worker and backpressure`. The retired circuit fields themselves are absent.
- Code evidence: `AdminPresetView` still distributes `runConfigFields` with slices `(0, 3)`, `(8)`, `(3, 6)` and `(6, 8)` although the list now contains only eight fields. The shared defaults form also uses positional slices `(0, 8)` and `(8)`.
- Expected grouping:

| Group | Fields |
| --- | --- |
| Inventory | Starting stock, quantity per checkout, hold minutes |
| Per-run ERP | ERP latency, max TPS, error rate and forced outage where supported |
| Worker and backpressure | Worker concurrency, persistence retry seconds |

Recommended correction: Replace the fragile numeric slices with small explicitly named field lists for the groups above, reusing the existing input renderer and field metadata. Update the shared defaults form's consumers so no empty obsolete group or misplaced ERP field remains. Remove the obsolete `Circuit protection` group. Preserve existing field names, IDs, labels, validation bounds, help text, units, dirty-state handling and submitted payloads. In particular, do not expose forced outage in public custom defaults where it is currently disabled. Do not restore retired timeouts, retry policies or circuit settings.

## Repository entry points

- Contract and producer: `packages/contracts/src/demo.ts` (`failedDemoRunSnapshotSchema`), `packages/contracts/src/run-result.ts` (`isDestructiveResetReason`, `toPublicRunFailureCategory`); `apps/api/src/services/demo-run-projections.ts` (`toDemoRunSnapshot`). `apps/api/src/services/run-history-service.ts` is the reference for the existing marker and stays unchanged.
- Watch: `apps/web/src/app/lib/presentation/accepted-run-result.ts`, `watch-composition.ts`, `public-run-summary.ts`, `run-result-presentation.ts`; `apps/web/src/app/lib/dashboard-projection-state.ts` (terminal retention); `apps/web/src/app/components/operator-dashboard.tsx`; `apps/web/src/app/components/realtime/use-accepted-run-result.ts`.
- History: `apps/web/src/app/run-history/[runId]/page.tsx`; `apps/web/src/app/components/run-history-detail.tsx` (`DiscardedRunDetail` and the `operator` copy branches), `run-history-list.tsx`.
- Admin: `apps/web/src/app/components/admin/admin-feature-views.tsx` (`AdminPresetView`, shared config inputs and `runConfigFields`); `admin-authenticated-surface.tsx`; `apps/web/src/app/lib/admin-drafts.ts`.
- Existing test homes: `packages/contracts/test/contracts.test.ts`; `apps/api/test/demo-run-projections.test.ts`; `apps/web/test/watch-narrative.test.tsx`, `watch-composition.test.ts`, `dashboard-projection-state.test.ts`, `run-history.test.ts` (already covers `dataDiscarded` on list and both details), `admin-controller-state.test.tsx`, `admin-drafts.test.ts`, `run-result-presentation.test.ts`, `public-run-summary.test.tsx` and `browser-workflows.test.ts`.
- Do not introduce a new endpoint or backend workflow; the reset services are out of scope.

## Acceptance criteria

- [x] A discarded run renders `Cancelled` consistently on Watch, the history list and both public/admin detail; admin and automatic reset origins are stated correctly.
- [x] Watch remains correct after reset, reload/recovery and the start of a successor; no discarded-result pending counts, reconciliation caveats or business-failure narrative appear.
- [x] Public cancellation detail has one primary heading and return link, with no generic failed-result header. Cancelled history rows contain only the retained entry presentation, not a normal experiment scorecard.
- [x] Genuine non-discarded failures, successful results and unavailable reads retain their appropriate statuses, counts and warnings. Cancellation does not hide a real failure on an unrelated run.
- [x] Admin field placement matches the table, with each supported field shown exactly once in its relevant form. The obsolete circuit group and positional field slicing are removed; editing and submission still preserve the correct values.
- [x] The failed run snapshot contract carries `dataDiscarded`, `toDemoRunSnapshot` produces it for `admin_reset` and `auto_reset` and omits it otherwise, and the Watch live/retained projection path selects cancellation from that marker before any result derivation.
- [x] The unreachable `operator` copy branches, the `operatorReset` prop and the `automatic_reset` special case of `failedSentence` are removed with their tests; no other vocabulary is touched.
- [x] Focused regression tests cover these behaviors at their actual rendering/model boundaries, including the full public history page composition rather than only its child cancellation component.
- [x] A browser rerun demonstrates reset with outstanding orders, consistent signed-out/authenticated reports, a correct cancelled history row and a successful successor run. Record actual run IDs and observations.
- [x] Apart from the additive snapshot marker, no backend lifecycle/reset policy, admission behavior, persistent schema, public access boundary or unrelated UI is changed.

## Validation and implementation sequence

1. Reproduce against the current build and add focused regression coverage for the reachable states above. Use existing test fixtures/helpers. Test both reset origins with schema-valid discarded summaries; do not invent impossible lifecycle combinations or wait 15 real minutes in unit tests.
2. Implement the contract marker and its producer first, then the narrow presentation and field-grouping changes. Keep normal evidence derivation intact and place cancellation handling at the boundaries that have the authoritative discard marker.
3. Run `pnpm exec biome check --write <touched-supported-files>`, then `pnpm exec biome check <touched-supported-files>`, `pnpm --filter @checkout-surge/contracts test:unit`, `pnpm --filter api test:unit`, `pnpm --filter web test:unit` and `pnpm type-check`. Run project tests in Linux/Dev Container as documented in [local development](../../../docs/local_development.md). Check Markdown and local links directly when unsupported by Biome.
4. Rebuild/restart the affected reference-runtime web service as required so the browser actually tests the new build. Follow [local development](../../../docs/local_development.md). Do not wipe existing runtime volumes or delete unrelated historical runs. Use a newly created test run for the destructive reset check and restore any global ERP settings changed for verification.
5. Browser check: inspect the admin groups, launch the slow 100-order run, reset before settlement, compare Watch and history before/after reload and signed in/out, then launch a 10-order zero-error successor and verify its successful result. Also inspect a genuine non-discarded failure through component coverage so failure warnings cannot be accidentally suppressed.
6. Automatic-reset **presentation** must pass deterministic tests with the existing automatic-reset summary shape. The earlier browser session did not test the 600-second grace notice or 900-second reset trigger. This task does not require inducing an infrastructure outage or changing clocks/deadlines to test those mechanisms; report that runtime coverage separately and do not claim it passed.

Do not run `pnpm test:composition` or `pnpm test:characterization` unless explicitly requested. The snapshot marker is covered by the contract and API unit suites above; backend integration suites are unnecessary because the reset workflow itself does not change.

## Non-goals and completion handoff

No ERP algorithm changes, estimator recalibration, new telemetry, dashboard redesign, automatic-reset timing changes, migration work or wholesale vocabulary cleanup. Fix the three anomalies and their directly affected consumers only.

Before marking complete, apply the final self-review checklist and replace the pending status with actual implementation/check evidence. Report changed boundaries, test results, browser run IDs, remaining limitations and any skipped checks with reasons. Update the index's task 24 row. Documentation alone or a badge-only fix that leaves misleading reset counts/warnings is not completion.


## Implementation and validation evidence — 2026-09-22

- Added optional `dataDiscarded` to failed snapshots only. The projection producer emits `true` for `admin_reset` and `auto_reset` and omits the field otherwise. No reset workflow, lifecycle, persistence or admission behavior changed.
- Watch selects its cancellation phase from the live marker or the same run's saved cancellation model before normal result derivation. Cancelled saved models exclude report evidence. The cancellation card retains preset/run identity and its report link; discarded projections do not render the normal technical business panels. An unrelated current run retains its own result and counters.
- Public cancellation detail now owns its complete page before the generic report header; public/admin pages each retain one heading and primary return link. Cancelled list rows keep preset identity, timestamp, cancellation, link and authorized actions, without business counters or convergence. Removed the specified unreachable operator-stop copy/prop and automatic-reset `failedSentence` branch.
- Admin inputs now use explicit inventory, ERP and worker field lists in the preset and shared defaults forms. Input metadata, IDs, draft updates and submitted configuration remain unchanged; public custom defaults still exclude forced outage.
- Updated the architecture description and this task/index. Final self-review confirmed requested ownership boundaries, thin routes, unchanged infrastructure composition and consistent contracts/implementation/tests.

### Checks

- `pnpm exec biome check --write <17 touched TypeScript/TSX files>` and the subsequent read-only check passed. Markdown and relative local links were checked separately; `git diff --check` passed.
- `pnpm --filter @checkout-surge/contracts test:unit`: **198 passed**, 9 files.
- `pnpm --filter api test:unit`: **9 passed**, 1 file.
- `pnpm --filter api exec vitest run --config vitest.api.config.ts test/demo-run-projections.test.ts`: **3 passed**, 1 file. This additional focused run is necessary because the API unit glob only includes `test/unit/**`; the projection test lives outside that glob. It needs no infrastructure.
- `pnpm --filter web test:unit`: **809 passed**, 48 files. Coverage includes both reset origins, live/retained and saved Watch paths, same-run stale projections, unrelated failures/successors, full public/admin page composition, minimal rows and field placement. Existing editing/submission, unavailable-read and ordinary result checks passed.
- `pnpm type-check`: passed, including workspace source and test type checks.
- Earlier checks caught stale operator-copy assertions, a duration whitespace regression and an invalid test fixture field; these were corrected. One intermediate web run under concurrent image-build load failed two existing transport timing tests; subsequent complete runs passed. JSDOM emitted its existing navigation-not-implemented diagnostics.
- Composition, characterization and backend integration suites were not run: they were not requested and the reset workflow itself did not change.

### Browser rerun

The reference runtime was initially down. Ran `pnpm runtime:setup`, `pnpm runtime:up` and a final affected web rebuild/restart through Compose. No volumes were wiped and no history was deleted. Browser checks used Playwright Chromium against `http://localhost:8080` with real service responses.

- **Reset run `245bf51b-0223-4604-88a8-bd220bf7d6a6`**: launched a one-off 100-buyer/100-stock/quantity-1 run with ERP 100 ms, 2 TPS, zero errors and outage off. Immediately before reset, the browser recovery read showed 100 reservations, **3 confirmations and 97 queued orders**. Confirmed the admin reset while work was outstanding. Watch displayed `Cancelled`, the admin-reset discard explanation and exact run/report identity before and after reload, without pending-work claims or business/reconciliation warnings.
- Authenticated and signed-out direct detail navigation and reload each showed one primary heading and one `Back to run history` link, cancellation and the discard explanation, without a generic failed header or normal report. Both history lists showed a minimal cancelled row with timestamp and report link, without scorecard counts or convergence duration. Admin actions remained available.
- Verified the preset's inventory/ERP/worker groups and exactly one supported input per group, expanded effective preview and public runtime policy defaults, and confirmed no public-default forced-outage input. Submitted edited ERP values were exercised by both real runs.
- **Successful successor `4b144bb3-a0ce-46ca-9edd-7b4895387e97`**: 10 buyers, stock 10, quantity 1, ERP 100 ms/100 TPS, zero errors and outage off. Saved result was `completed-successfully`, with **10 confirmed orders, 10 notifications, zero failed and zero pending orders**. The previous accepted Watch URL retained its cancellation and exact report link while showing the successor's separate completed live result.
- An initial harness attempt created `8a7779f2-e86d-4b86-b3f7-4d13a6c5656a`; its reset confirmation selector incorrectly targeted `dialog` instead of `alertdialog`. Corrected the harness and used the fresh reset run above for acceptance. The extra history entry was retained.
- Global ERP settings were not changed. All eight Compose services were healthy at handoff.

Automatic-reset presentation passed deterministic tests. The 600-second grace notice and 900-second automatic trigger were not exercised in the browser; no clock/deadline changes or infrastructure outage were used.
