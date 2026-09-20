# 12 — Implement the destructive admin reset

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 12 of 21. Execute after [11](11_fail_orders_on_non_transient_erp_errors.md); settlement-based finalization and guarded teardown are available and the intervention concept is gone.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 4, D01 and D02. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: API administrative reset service, generated-run deletion helpers in `@checkout-surge/db`, shared reset contract, and the history presentation label.

## Objective and fixed rules

Admin reset is simple and brutal. It stops everything, discards the interrupted run's internal data, keeps one basic history line, and returns the demo to a ready state as fast as possible. This is a demonstration against a mock ERP: whatever the run had in flight is lost on purpose, and a reset never waits on the ERP.

Lifecycle vocabularies do not change. The reset run stays `failed` / `admin_reset`; "cancelled" is a presentation label only. Reset does not terminalize individual orders, it deletes them.

The outstanding-work guard from task 10 keeps protecting retention cleanup and exact teardown. Only admin reset bypasses it.

## Repository entry points

Inspect `apps/api/src/services/admin-demo-reset-service.ts` (current stop sequence and summary writing), `incomplete-admin-reset.ts`, `generated-run-teardown-service.ts`, `demo-queue-maintenance.ts`, `run-history-service.ts`, `apps/api/src/routes/admin-maintenance-routes.ts`, `packages/db/src/demo-run-maintenance.ts` (`deleteGeneratedRunRows`, `hasOutstandingGeneratedRunWork`), the generated-run Redis deletion helper in `packages/db/`, `adminDemoResetResponseSchema` in `packages/contracts/src/demo.ts`, the reset clients in `scripts/runtime-reset*.mjs`, and the run-result presentation in `apps/web/src/app/lib/presentation/`. Reuse the existing admin authentication, CSRF, maintenance authority and reset fence; do not create a parallel administrative framework.

## Implementation work

- [ ] Keep the current stop sequence: claim the nonterminal run as terminal `failed` / `admin_reset` with traffic status `failed`, close sale eligibility, abort traffic, fence dashboard ingestion, and clean the run's queue jobs within the existing bounded wait. The terminal claim is the stop; worker dispatch, recovery and publication already exclude terminal runs.
- [ ] Write the run's history summary as today, from a plain count of the durable rows as they stand. No reconciliation, no disposition of individual orders, no in-progress state.
- [ ] After the summary is written, delete the run's internal data regardless of outstanding work: orders, reservations, pending persistence, order events, control records, dispatched-call intents, ERP attempts, mock ERP ledger rows, notifications, sold-out counts, finalization evidence, run-scoped resilience state and the run's Redis state. Add a purge helper next to `deleteGeneratedRunRows` that shares its deletions and keeps the run row, its summary row and its closed generated sale offer. Do not weaken `hasOutstandingGeneratedRunWork` for retention or exact teardown.
- [ ] Handle a run reset before it owns a generated sale offer: the same reset succeeds with nothing to purge for the missing parts.
- [ ] Expose the workflow so a caller supplies the reset reason; the admin route passes `admin_reset`. Task 13 reuses the same workflow with `auto_reset`. Do not add the automatic trigger here.
- [ ] Keep the request bounded and idempotent. A reset interrupted by an infrastructure failure is finished by calling reset again through the existing incomplete-reset pattern; a repeated reset neither duplicates the history line nor fails on already-deleted data. A successor run can start as soon as reset returns.
- [ ] Make the history views honest about the purge: the list shows the run as cancelled by admin reset, and the detail view states that the run's data was discarded instead of rendering empty sections as a real result. Keep manual history deletion working for these entries.
- [ ] Remove the scaffolding earlier slices prepared for a reconciling reset, together with its tests, since nothing produces or consumes it:
  - the `demo_runs.administrative_stop` column (incremental migration), `administrativeStopEvidenceSchema`, and the worker stop checks in `postgres-erp-attempt-persistence.ts`, `postgres-order-dispatch-persistence.ts` and `postgres-order-transition-persistence.ts`;
  - the `administrative` order failure category, `administrativeOrderFailureCodeValues`, and the `administrativelyDisposedOrders` count across contracts, the DB enum, projections, history and web presentation. Confirm each removal with a repository search before deleting; keep persisted summaries readable.
- [ ] Update the reset response contract, the `scripts/` reset clients and their tests in the same slice only where the response actually changes.

## Non-goals

No reconciliation of dispatched calls during reset, no reset-in-progress state or counts, no automatic trigger (task 13), no stock release or compensation, no new lifecycle status, no dashboard bypass, and no change to how retention or exact teardown protect unfinished work.

## Acceptance and validation

- [ ] Reset of a run with queued and processing orders and an unresolved dispatched call completes in one bounded request without any ERP call, and a successor run starts immediately afterwards.
- [ ] After reset, none of the run's internal rows or Redis keys remain; the run row, its summary and its closed sale offer do. History lists exactly one `failed` / `admin_reset` entry for it, presented as cancelled.
- [ ] A worker call in flight during reset fails cleanly afterwards: no row is recreated, no notification is recorded, and the terminal fence holds.
- [ ] Reset with an unreachable ERP behaves exactly the same.
- [ ] Repeated reset, and reset retried after an injected mid-sequence failure, converge to the same final state with one history line.
- [ ] Retention cleanup and exact teardown still refuse a run with outstanding work.
- [ ] Run focused reset/teardown/history/worker tests, `pnpm type-check`, `pnpm test:infra:up`, `pnpm test:api`, the relevant worker and DB integration tests, and the web presentation tests, using isolated resources.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep routes thin, infrastructure in composition roots and artifacts in English. Format/check touched supported files with Biome; use the documented Linux/Dev Container path. Do not run composition/characterization suites or reset the user's reference runtime. Report checks and obtain explicit approval before deviating from D02.

## Completion handoff

Deliver the destructive reset, the purge helper, the honest history presentation and the scaffolding removal with their tests. Record what reset deletes and keeps, the in-flight worker behavior, the reusable workflow entry point, and any scaffolding that had to stay with the reason. Next: [13 — automatic run reset](13_add_automatic_run_reset.md).
