# 18 — Build runtime progress and the grace-period notice

## Handoff

- Status: Pending.
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

- [ ] Project outstanding orders and oldest outstanding age from durable records, and the observed confirmation rate over a stated window. Report unavailable or stale telemetry explicitly rather than as zero.
- [ ] Project one downstream status derived from the worker's existing protection state: `erp_limiting` while a capacity cooldown is pausing dispatch (revised D06: there is no learned rate), `erp_unavailable` while the availability circuit is open, `nominal` otherwise. Expose the status only, not the underlying numbers.
- [ ] Integrate through the current projection fanout. Preserve bounded public queries, pagination/retention and the existing SSE initial-snapshot, reconnect and missed-update recovery. Add no parallel realtime stream and no per-order public feed.
- [ ] Show these facts in the live dashboard with plain labels, so a slow drain reads as "still processing, the ERP is limiting the rate" or "ERP unavailable, processing resumes automatically".
- [ ] Separate traffic outcome from business settlement. Show confirmed, business-rejected and technically failed totals distinctly; settled processing does not imply every order confirmed. No read-model race may present a run as completed while required work remains.
- [ ] Render the grace-period notice from task 13's reset time: hidden before 600 seconds after acceptance, visible with the remaining time afterwards, and consistent after an SSE reconnect or page reload. The client only displays; the server owns the deadline.
- [ ] Explain the admin reset before action: it stops everything, discards the current run's data, keeps one basic history line and frees the demo immediately.
- [ ] Keep the history presentation of reset runs from tasks 12 and 13 (cancelled label by admin or automatic reset, discarded-data notice) coherent with these views. Keep stale/unavailable views distinct from healthy/empty ones.
- [ ] Coordinate contracts, producers and consumers in the same slice so the repository stays runnable.

## Non-goals

No estimate or estimate-versus-actual display during the run or in history, no over-estimate or over-ceiling warnings, no controller telemetry panel, no per-reason waiting breakdown, no countdown before the grace period, no customer storefront, public order explorer or new public administrative capability.

## Acceptance and validation

- [ ] API/projection tests cover nominal progress, capacity limiting, a finite outage with automatic recovery, uncertainty being reconciled, technical failures, and late settlement, with the downstream status changing accordingly.
- [ ] Final counts agree with durable records; traffic completion cannot masquerade as business completion, and a reset run is never presented as a business result.
- [ ] Component tests prove the grace notice is absent before 600 seconds and present after, under an injected clock, and survives reconnect.
- [ ] Admin tests cover authorized/unauthorized reset, the pre-action explanation, the freed run slot afterwards and the cancelled history entry.
- [ ] Bounded public reads and SSE reconnect/recovery behavior remain intact. Contract tests validate changed payloads.
- [ ] Isolated browser verification demonstrates draining after traffic ends with a meaningful status and coherent final counts. Use small deterministic fixtures; do not make routine tests wait real minutes.
- [ ] Run focused DB/API/projection and web/component tests, `pnpm type-check`, `pnpm test:infra:up`, `pnpm test:api` and affected integration tests. Report browser checks separately from unit evidence.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep projection workflows in services, infrastructure in composition roots and React presentation separate from business policy. All project copy is English; format/check touched supported files with Biome. Use Linux/Dev Container execution and isolated test resources. Do not run composition/characterization suites, reset the reference runtime or rewrite incident history. Report actual/skipped checks and preserve the fixed lifecycle/public scope.

## Completion handoff

Deliver the projections, the dashboard views, the grace notice and their tests with browser evidence. Record field semantics, the rate window, the status derivation, availability behavior and SSE compatibility. Next: [19 — acceptance proof](19_complete_acceptance_matrix_and_runtime_verification.md).
