# 18 — Build runtime progress and the grace-period notice

## Handoff

- Status: Implemented, validated and browser-verified on the nominal path (2026-09-21); full API scenario matrix and non-nominal browser states remain for task 19.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 18 of 21. Execute after [17c](17c_refit_estimator_to_declared_capacity.md); settlement-based finalization, terminal technical failures, both resets and the admission flow are available.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 6, D01, D02, D09, D10 and D13. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: API dashboard projection services and contracts, web live dashboard and run-history presentation.

## Objective and fixed rules

A run that drains slowly because the ERP is slow must look alive, not frozen. Show a small, honest set of facts: outstanding orders, the age of the oldest one, the observed confirmation rate, and one downstream status (`nominal`, `erp_limiting`, `erp_unavailable`). More elapsed time does not itself mean failure.

Do not project controller internals (target rate, in-flight ceiling, cooldown, probe or circuit detail), per-reason waiting counts, or anything about the admission estimate. Lifecycle statuses stay unchanged. Do not derive business success from traffic completion, queue emptiness or elapsed time; durable order and notification records own the truth.

The automatic reset deadline is invisible until 600 seconds after acceptance. From then on, and only then, the dashboard warns that the run is in its grace period and will be reset at the deadline to free the demo, with the time left.

## Repository entry points

`apps/api/src/services/{erp-status-service,demo-run-projections,run-history-service}.ts`, the existing dashboard snapshot/projection services, `apps/api/src/realtime/dashboard-projection-fanout.ts`, `apps/api/src/routes/{dashboard-routes,erp-routes}.ts`, `packages/db/src/{business-outcome-dashboard,redis-erp-resilience}.ts`, `packages/contracts/src/{erp,run-result,run-signals,demo}.ts`, task 09's worker status boundary, task 13's snapshot field carrying the automatic reset time, and the existing dashboard/runtime panels, run history, admin controls and SSE recovery state in `apps/web/src/` with their tests in `apps/web/test/`. Reuse the existing bounded snapshot/SSE workflow and styling/components.

## Implementation work

- [x] Project outstanding orders and oldest outstanding age from durable records, and the observed confirmation rate over a stated window. Report unavailable or stale telemetry explicitly rather than as zero.
- [x] Project one downstream status derived from the worker's existing protection state: `erp_limiting` while a capacity cooldown is pausing dispatch (revised D06: there is no learned rate), `erp_unavailable` while the availability circuit is open, `nominal` otherwise. Expose the status only, not the underlying numbers.
- [x] Integrate through the current projection fanout. Preserve bounded public queries, pagination/retention and the existing SSE initial-snapshot, reconnect and missed-update recovery. Add no parallel realtime stream and no per-order public feed.
- [x] Show these facts in the live dashboard with plain labels, so a slow drain reads as "still processing, the ERP is limiting the rate" or "ERP unavailable, processing resumes automatically".
- [x] Separate traffic outcome from business settlement. Show confirmed, business-rejected and technically failed totals distinctly; settled processing does not imply every order confirmed. No read-model race may present a run as completed while required work remains.
- [x] Render the grace-period notice from task 13's reset time: hidden before 600 seconds after acceptance, visible with the remaining time afterwards, and consistent after an SSE reconnect or page reload. The client only displays; the server owns the deadline.
- [x] Explain the admin reset before action: it stops everything, discards the current run's data, keeps one basic history line and frees the demo immediately.
- [x] Keep the history presentation of reset runs from tasks 12 and 13 (cancelled label by admin or automatic reset, discarded-data notice) coherent with these views. Keep stale/unavailable views distinct from healthy/empty ones.
- [x] Coordinate contracts, producers and consumers in the same slice so the repository stays runnable.

## Non-goals

No estimate or estimate-versus-actual display during the run or in history, no over-estimate or over-ceiling warnings, no controller telemetry panel, no per-reason waiting breakdown, no countdown before the grace period, no customer storefront, public order explorer or new public administrative capability.

## Acceptance and validation

- [ ] API/projection tests cover nominal progress, capacity limiting, a finite outage with automatic recovery, uncertainty being reconciled, technical failures, and late settlement, with the downstream status changing accordingly.
- [x] Final counts agree with durable records; traffic completion cannot masquerade as business completion, and a reset run is never presented as a business result.
- [x] Component tests prove the grace notice is absent before 600 seconds and present after, under an injected clock, and survives reconnect.
- [x] Admin tests cover authorized/unauthorized reset, the pre-action explanation, the freed run slot afterwards and the cancelled history entry.
- [x] Bounded public reads and SSE reconnect/recovery behavior remain intact. Contract tests validate changed payloads.
- [x] Isolated browser verification demonstrates draining after traffic ends with a meaningful status and coherent final counts. Use small deterministic fixtures; do not make routine tests wait real minutes.
- [x] Run focused DB/API/projection and web/component tests, `pnpm type-check`, `pnpm test:infra:up`, `pnpm test:api` and affected integration tests. Report browser checks separately from unit evidence.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep projection workflows in services, infrastructure in composition roots and React presentation separate from business policy. All project copy is English; format/check touched supported files with Biome. Use Linux/Dev Container execution and isolated test resources. Do not run composition/characterization suites, reset the reference runtime or rewrite incident history. Report actual/skipped checks and preserve the fixed lifecycle/public scope.

## Completion handoff

Deliver the projections, the dashboard views, the grace notice and their tests with browser evidence. Record field semantics, the rate window, the status derivation, availability behavior and SSE compatibility. Next: [19 — acceptance proof](19_complete_acceptance_matrix_and_runtime_verification.md).

## Completion notes

- Projection version 5 carries nullable `runtimeProgress` through the existing snapshot/recovery and projection fanout. Durable queued/processing orders own `outstandingOrders`; the oldest outstanding reservation's secured time owns `oldestOutstandingAgeSeconds` (null when none remain). `observedAt` is the measurement timestamp. Lifecycle and finalization authority remain unchanged; live confirmed, business-rejected and technically failed totals are displayed separately.
- The confirmation rate uses durable confirmed orders in the inclusive interval from `observedAt - 10 seconds` through `observedAt`, divided by `min(10, elapsed seconds since the earliest processingAt)`. `confirmationRateWindowSeconds` exposes that effective denominator. Before processing starts the window is zero and the rate is null; a positive window with no confirmations gives a genuine zero.
- PostgreSQL `erp_scope_resilience_state`, scope `run:<id>`, remains the worker-owned safety authority. The read-only status mirrors worker restoration: `availabilityCircuitOpen && max(availabilityRetryAt, circuitOpenExpiresAt, nextProbeAt) > now` means `erp_unavailable`; otherwise a future capacity cooldown means `erp_limiting`, otherwise `nominal`. Expiry permits a probe and cannot prematurely imply recovery while another availability deadline remains future. Only the status enum is exposed, never the safety deadlines.
- Failed status reads yield null and `downstreamErpStatusReadStatus: unavailable`; failed progress reads yield a null section and degraded projection. Existing freshness/recovery presentation labels stale last-known-good data. Neither failed read becomes healthy or zero telemetry.
- Grace display uses the existing server-owned `autoResetAt`, appears from 600 seconds after acceptance, and reconstructs under an injectable clock after snapshot replacement/reconnect. The admin confirmation explains the destructive reset before action, including the retained basic history line and immediately freed demo; reset history remains cancelled with discarded-data copy.
- Existing bounded aggregate queries, complete snapshots, scoped revisions, initial SSE recovery, reconnect and missed-terminal recovery remain the only public realtime workflow. No worker changes, per-order feed, new admin capability, estimate display or controller telemetry were added.
- Review corrections cover a future next-probe/retry deadline after circuit expiry, expired deadlines falling through to capacity/nominal, closed-circuit recovery, confirmation timestamps beyond the advertised measurement instant, and distinct live totals (2 business rejections / 1 technical failure).
- `scripts/runtime-smoke.test.mjs` changes are required fixture compatibility for version 5 and its nullable field. `packages/contracts/src/estimate.ts` names the grace threshold `automaticRunResetGraceNoticeSeconds`, defined as `estimatedDemoOccupancyCeilingSeconds` so the 600-second value keeps a single source.
- Known limit of the status derivation: a probe may stay in flight up to the 6-second maximum request deadline while `nextProbeAt` only covers the 5-second cadence, so the status can read `nominal`/`erp_limiting` for at most about one second during a continuing outage. Trusting the `availabilityCircuitOpen` flag alone was rejected: a row left open by a crashed worker is treated as closed on restart and could pin the dashboard to `erp_unavailable`.
- Composition/characterization and reference-runtime reset are prohibited and were not run.

### Browser evidence (2026-09-21, separate from unit evidence)

Headless Chromium through `playwright-cli` against the running Compose reference runtime (`http://localhost:8080`), two small public preset runs, no reset, cleanup or ERP fault injection.

- Preview 1k (run `ba57e3bd-5273-4643-b470-6bc1d0e3b2a3`, 1,000 attempts, 250 units) drained after traffic ended while staying visibly alive: pending 137 → 22 → 0, oldest pending 4 s → 7 s → none, confirmation rate 27.2 → 31.6 → 30.0 confirmations/s over an effective window growing 4.11 → 7.19 → 8.33 s, downstream status "Processing normally". "Completed" appeared only after pending reached 0.
- Final counts were coherent and matched durable records, the run-history list and the per-run report: 250 reservations, 250 confirmed, 0 business-rejected, 0 technically failed, 0 pending, 750 sold-out rejections, oversold 0. The duplicate-click storm run (`88493495-a6bf-4c02-a46e-0e37fc89334d`) was equally coherent at 200 / 200 / 0 / 0.
- The grace-period notice was absent in every sample (runs far younger than 600 s), including after a reload. A reload after settlement restored the same final result from the snapshot with updates connected.
- The admin reset dialog showed the pre-action explanation (stops all demo work, discards the current run's data, frees the demo, keeps one cancelled history line) and was cancelled.
- Not demonstrated in the browser: non-zero business-rejected/technically failed live figures (both rendered distinctly, at 0), the `erp_limiting`/`erp_unavailable`/unavailable status labels (would need ERP fault injection), a mid-run reload (runs finished in under 12 s) and the notice appearing after 600 s. These stay covered by component/DB tests only and are candidates for task 19.
- Observed, outside task 18's surfaces: a transient `404` on `GET /api/demo/runs/history/<runId>` in the console right at finalization of the first run; the same URL returned `200` shortly after.

Validation scope: the review follow-up adds boundary regressions for the three findings. Existing service tests cover rate/availability semantics, projection degradation and finalization; DB tests cover capacity/outage/recovery status transitions. The complete API/projection scenario matrix above is left unchecked because the existing runtime-progress tests do not demonstrate every listed scenario together with its status transitions. No broader scenario implementation was added in this three-finding follow-up.

### Validation (review follow-up, 2026-09-21)

Commands were launched strictly sequentially; none ran alongside another validation command.

- `pnpm exec biome check --write <all touched supported files>`: 38 supported files clean. The first pass reported a new test non-null assertion; it was removed, and subsequent passes were clean. Markdown is unsupported by this formatter and was reviewed manually.
- `pnpm type-check`: passed 11/11 workspace tasks and test TypeScript. Two earlier runs caught and then resolved the new optional-prop/draining-fixture typing errors; neither was killed or out of memory.
- `pnpm test:unit`: passed 1,469 package tests (contracts 198, logger 8, load orchestrator 178, API 8, mock ERP 64, DB 60, worker 131, web 822), plus 7 environment safety and 54 script tests; 11/11 Turbo tasks successful, 6 cached. Existing non-failing React `act` warning in `apps/web/test/browser-workflows.test.ts` remains untouched.
- `pnpm test:infra:up`: passed; isolated PostgreSQL and Redis healthy.
- `pnpm test:api`: passed 51 files / 661 tests, 4/4 Turbo tasks successful (3 dependency builds cached).
- Shared contracts and DB `dist` outputs were rebuilt by the normal validation build dependencies; the DB output includes the corrected predicate.
- `git diff --check`: passed.

- `pnpm test:integration`: passed 17 files / 198 tests (DB 84, worker 108, mock ERP 6), 6/6 Turbo tasks successful, 3 dependency builds cached. No validation command was killed or ran out of memory.
- Final self-review: scope and phase boundaries preserved; no route workflow or infrastructure ownership changes; contracts/producers/consumers remain compatible; public wording and unavailable states remain distinct; regression checks passed. No commits, staging, branch changes, or reference-runtime mutations were made.
