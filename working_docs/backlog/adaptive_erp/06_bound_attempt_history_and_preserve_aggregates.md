# 06 — Bound attempt history without losing business evidence

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 06 of 21. Execute after [05](05_unify_worker_scheduling_and_queue_handoffs.md); durable call identity and scheduling are active.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 2, section 6.2, D04 and D09. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: worker ERP-attempt persistence, DB aggregates/events and their diagnostic readers.

## Objective and fixed rules

Retaining an order through a long transient outage must not require unbounded attempt history. Start with 32 retained ERP attempts per order. Pruning must never delete canonical success, permanent rejection, or an attempt referenced by an unresolved dispatched call. Cumulative counters continue to describe the entire order lifetime, not just the retained tail.

The accounting unit is a durable actual-call identity, not BullMQ delivery or a local admission deferral. Repeated writes/redelivery must not count the same call twice. A history cap is not a retry budget or time-based purge of unresolved obligations.

## Repository entry points

`apps/worker/src/persistence/postgres-erp-attempt-persistence.ts`, `apps/worker/src/application/order-process-job-handler.ts`, `packages/db/src/{schema,business-outcome-dashboard,run-signal-timeline,demo-run-maintenance}.ts`, `apps/api/src/services/{erp-status-service,run-history-service}.ts`, and their current attempt/event readers and tests. Inspect `apps/api/test/erp-attempt-status-reader.test.ts` and worker/DB persistence tests. Reuse task 02's counters/control references rather than inventing a second audit store.

## Implementation work

- [ ] Make attempt insertion/final accounting, cumulative category update and eligible old-row pruning transactionally coherent. When the bound is exceeded, delete the oldest non-canonical, unreferenced attempts for that order only.
- [ ] Apply the same per-order history policy to `erp.attempt.*` order events. Do not prune lifecycle events with the attempt-history rule.
- [ ] Preserve canonical success, permanent rejection and every unresolved-call reference regardless of pruning pressure. Do not corrupt foreign-key/identity evidence to reach the numeric cap; make protected evidence explicit in tests and readers.
- [ ] Apply the protection rule as decided by the user (2026-09-20): "referenced by an unresolved dispatched call" means the single call referenced by the control record's `unresolved_erp_call_id`. Older uncertain calls of the same idempotency key are prunable, because reconciliation works by business key through lookup/replay and their category already lives in the cumulative counters. Prune an attempt together with its `erp_dispatch_calls` row so that table stays bounded too. A delayed write for an already-pruned call finds no call row and is rejected without recounting.
- [ ] Maintain cumulative capacity, unavailable, timeout and permanent counters idempotently per actual-call identity. Prove delayed duplicate writes cannot recount an already-accounted call, including after its diagnostic row has been pruned. Reuse durable generation/finalization guards instead of adding an unbounded duplicate-tracking log.
- [ ] Keep diagnostic readers truthful: retained recent windows and cumulative totals are different concepts. Expose existing truncation/coverage semantics or add explicit ones where necessary; do not silently report a pruned tail as all historical attempts.
- [ ] Preserve stable external identity and correlation lineage needed for accepted-result recovery. Status lookup/local result reuse cannot be counted as a fresh capacity-consuming POST or as a new successful business effect.
- [ ] Integrate new storage into existing exact generated-run deletion only after normal eligibility/fencing checks. No age-based deletion of active, uncertain or intervention-required work.

## Non-goals

No general analytics warehouse, new retention daemon, event-sourcing rewrite or public per-order feed. This task does not pick final adaptive constants or alter the business lifecycle. The 32-attempt value is the plan's initial policy constant; only the calibration process may revise policy constants with reported evidence.

## Acceptance and validation

- [ ] A single order with more than 32 transient calls has bounded ordinary attempt/event history, exact cumulative counts, a retained current obligation and preserved canonical evidence.
- [ ] Duplicate delivery/finalization callbacks do not change counters twice, even across pruning/restart boundaries.
- [ ] Pruning never affects another order/run, lifecycle events or an unresolved intent; final generated-run cleanup removes only eligible scoped data.
- [ ] Recent diagnostic counts remain attributable and explicitly distinguish retained history from cumulative totals.
- [ ] Run focused worker/DB/API reader unit tests, `pnpm type-check`, and `pnpm test:infra:up` followed by relevant DB/worker integration tests and `pnpm test:integration`. If schema changes are necessary, add one incremental generated migration per the [index](index.md) guardrails and run the isolated migration checks.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md), including boundary-local tests and composition-root construction. Format/check only touched supported files with Biome. Use the documented Linux/Dev Container path and isolated resources; do not run composition/characterization suites or mutate the reference incident. Report actual and skipped checks; do not reinterpret a locked decision.

## Completion handoff

Deliver bounded retention with tests proving evidence preservation. Record retention exceptions, aggregate semantics and reader changes. Next: [07 — adaptive admission policy](07_implement_paced_adaptive_admission_policy.md).
