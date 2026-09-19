# 18 — Build runtime progress, history and administrative UX

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 18 of 21. Execute after [17](17_build_dashboard_estimate_and_admission_flow.md); tasks 11 and 16 supply truthful admin controls and operational projections.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 7, D01–D03, D06, D09 and D13. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: web live dashboard, run-history presentation and authorized reset/resume controls.

## Objective and fixed rules

Make waiting and eventual completion legible. Traffic finished, business processing ongoing, intervention required, administrative stop and settled result are different conditions even though lifecycle enums stay unchanged. More elapsed time does not itself mean failure.

Use server projections as truth. Show observed progress separately from controller target and avoid interpreting unavailable telemetry as zero outstanding work. Do not add a customer storefront, public order feed or new public administrative capability.

## Repository entry points

Existing dashboard/runtime panels, run history, admin controls, API clients and SSE recovery state in `apps/web/src/` and their tests in `apps/web/test/`; `packages/contracts/src/{demo,erp,run-result,run-signals}.ts`; task 16's projection semantics and task 11's reset/resume responses. Reuse existing bounded snapshot/SSE workflow and styling/components.

## Implementation work

- [ ] Show outstanding work, oldest outstanding age, last progress, waiting reasons, unresolved calls and intervention counts. Present actual confirmation rate, target pacing, bounded in-flight work, cooldown and probe/circuit state with appropriate labels.
- [ ] Display over-accepted-estimate and over-occupancy-ceiling warnings as continuing/recoverable processing, not a terminal error or a client-side countdown that cancels work. Keep the occupied run slot visible.
- [ ] Separate traffic outcome from business settlement. Show confirmed, business-rejected and administratively disposed totals distinctly; settled processing does not imply every order confirmed.
- [ ] Explain reset before action: it stops the experiment, does not undo ERP confirmations and does not release reserved stock. Display in-progress reset with disposed/confirmed/still-uncertain counts, preserve successor blocking, and let repeated authorized action resume the existing workflow.
- [ ] Offer explicit authenticated admin resume for the order/scope intervention surfaces supplied by the API. Do not expose identity editing, overwrite snapshots, silently retry intervention, or let resume undo administrative stop. Scope the UI to the existing admin workflow rather than adding a public order explorer.
- [ ] Show accepted estimate versus actual completion timing and policy/estimator evidence in history. Handle legacy history without estimates and pruned/recent diagnostics explicitly. Final order/notification totals must remain coherent.
- [ ] Preserve SSE initial snapshot, reconnect and missed-event recovery. Keep stale/unavailable views distinct from healthy/empty ones, and avoid losing overrun/admin state when reconnecting or switching between live/history views.

## Acceptance and validation

- [ ] Component tests cover slow progress, capacity cooldown, finite outage/probes, uncertainty, order/scope intervention, late completion, legacy history and both overrun indications.
- [ ] Admin tests cover authorized/unauthorized resume, reset in progress and repeated reset without falsely claiming rollback or a free run slot.
- [ ] Reconnect/stale-data tests preserve existing bounded SSE recovery and never present a completed run with unresolved obligations.
- [ ] Isolated browser verification demonstrates draining after traffic ends, meaningful waiting state, coherent final counts and authorized administrative progression. Use small deterministic fixtures; do not make routine tests wait beyond real five/ten-minute boundaries.
- [ ] Run focused web/client/component tests, `pnpm type-check` and affected API/contract tests. Report browser checks separately from unit evidence; do not run composition/characterization unless explicitly requested.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). All project copy is English; format/check touched supported files with Biome. Keep React presentation separate from business policy and use Linux/Dev Container with isolated resources. Do not reset the reference runtime or rewrite incident history. Report actual/skipped checks and preserve the fixed lifecycle/public scope.

## Completion handoff

Deliver runtime/history/admin presentation with tests and browser evidence. Record view-state semantics, retained public restrictions and recovery behavior. Next: [19 — acceptance proof](19_complete_acceptance_matrix_and_runtime_verification.md).
