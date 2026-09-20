# 06 — Bound attempt history without losing business evidence

## Handoff

- Status: Completed.
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

- [x] Make attempt insertion/final accounting, cumulative category update and eligible old-row pruning transactionally coherent. When the bound is exceeded, delete the oldest non-canonical, unreferenced attempts for that order only.
- [x] Apply the same per-order history policy to `erp.attempt.*` order events. Do not prune lifecycle events with the attempt-history rule.
- [x] Preserve canonical success, permanent rejection and every unresolved-call reference regardless of pruning pressure. Do not corrupt foreign-key/identity evidence to reach the numeric cap; make protected evidence explicit in tests and readers.
- [x] Apply the protection rule as decided by the user (2026-09-20): "referenced by an unresolved dispatched call" means the single call referenced by the control record's `unresolved_erp_call_id`. Older uncertain calls of the same idempotency key are prunable, because reconciliation works by business key through lookup/replay and their category already lives in the cumulative counters. Prune an attempt together with its `erp_dispatch_calls` row so that table stays bounded too. A delayed write for an already-pruned call finds no call row and is rejected without recounting.
- [x] Maintain cumulative capacity, unavailable, timeout and permanent counters idempotently per actual-call identity. Prove delayed duplicate writes cannot recount an already-accounted call, including after its diagnostic row has been pruned. Reuse durable generation/finalization guards instead of adding an unbounded duplicate-tracking log.
- [x] Keep diagnostic readers truthful: retained recent windows and cumulative totals are different concepts. Expose existing truncation/coverage semantics or add explicit ones where necessary; do not silently report a pruned tail as all historical attempts.
- [x] Preserve stable external identity and correlation lineage needed for accepted-result recovery. Status lookup/local result reuse cannot be counted as a fresh capacity-consuming POST or as a new successful business effect.
- [x] Integrate new storage into existing exact generated-run deletion only after normal eligibility/fencing checks. No age-based deletion of active, uncertain or intervention-required work.

## Non-goals

No general analytics warehouse, new retention daemon, event-sourcing rewrite or public per-order feed. This task does not pick final adaptive constants or alter the business lifecycle. The 32-attempt value is the plan's initial policy constant; only the calibration process may revise policy constants with reported evidence.

## Acceptance and validation

- [x] A single order with more than 32 transient calls has bounded ordinary attempt/event history, exact cumulative counts, a retained current obligation and preserved canonical evidence.
- [x] Duplicate delivery/finalization callbacks do not change counters twice, even across pruning/restart boundaries.
- [x] Pruning never affects another order/run, lifecycle events or an unresolved intent; final generated-run cleanup removes only eligible scoped data.
- [x] Recent diagnostic counts remain attributable and explicitly distinguish retained history from cumulative totals.
- [x] Run focused worker/DB/API reader unit tests, `pnpm type-check`, and `pnpm test:infra:up` followed by relevant DB/worker integration tests and `pnpm test:integration`. If schema changes are necessary, add one incremental generated migration per the [index](index.md) guardrails and run the isolated migration checks.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md), including boundary-local tests and composition-root construction. Format/check only touched supported files with Biome. Use the documented Linux/Dev Container path and isolated resources; do not run composition/characterization suites or mutate the reference incident. Report actual and skipped checks; do not reinterpret a locked decision.

## Completion handoff

Deliver bounded retention with tests proving evidence preservation. Record retention exceptions, aggregate semantics and reader changes. Next: [07 — adaptive admission policy](07_implement_paced_adaptive_admission_policy.md).

## Completion notes

`erpAttemptHistoryRetentionLimit` is the single named 32-row policy constant. The first-write attempt transaction now persists the normalized disposition, increments the existing control-record counters once per durable call identity, resolves definitive call evidence, writes the paired `erp.attempt.*` event, and prunes the oldest eligible diagnostics for that order. Canonical success, every permanent-rejection disposition, and the attempt/call named by that order's `unresolved_erp_call_id` are protected; only that single current reference protects uncertainty, so superseded same-key calls can age out. Paired pruned attempt/call rows are deleted together, and attempt-less resolved/superseded call intents are pruned under the same per-order bound, both when an attempt is recorded and when a new dispatch intent is recorded (so a crash loop that never persists an outcome stays bounded). A late write whose call row was already pruned returns the existing idempotent no-op result and never reaches accounting.

Attempt events carry the attempt/call identity, normalized disposition, and canonical marker. Only `erp.attempt.failed|succeeded` rows participate in the 32-row rule; lifecycle events are untouched. Lookup/local-reuse diagnostics can remain in the retained tail but have no call identity and therefore never increment actual-call counters or create another external success.

The durable `attempt_counts` JSON remains the lifetime aggregate and no duplicate log was added. `readCumulativeErpOutcomeCounts` sums capacity, temporary-unavailability, uncertainty/timeout, and permanent-rejection categories independently of retained rows. Its coverage starts with orders processed since durable call accounting was introduced in task 02; legacy orders without a control record/counters contribute zero and are intentionally not backfilled. Live ERP status and public/admin run history now emit `retained_history` coverage, the per-order limit, and separate cumulative outcome counts. The admin event timeline marks its attempt-event subset with the same retained-history vocabulary, while existing pagination `truncated` continues to describe response-page omission only.

Migration `0008_overrated_lester` adds the nullable `erp_outcome_disposition` enum column to `erp_attempts`, backfills existing classifications, and links existing attempt events where their durable identity tuple matches; new writes always populate the field and event linkage. Disposition is pruning/accounting metadata rather than attempt identity, so an otherwise identical delayed finalization remains idempotent when a migration-derived classification differs from runtime classification. No new table was introduced, so exact generated-run cleanup continues to remove the column with its already-fenced `erp_attempts` deletion. Existing cleanup integration tests cover the unchanged eligibility and exact-scope boundary.

### Validation

- `pnpm exec biome check --write <18 touched TypeScript/JSON files>`: passed; 18 files checked and 2 formatted. Markdown and generated SQL were reviewed manually.
- `pnpm type-check`: passed; 11/11 workspace tasks plus test TypeScript checking.
- `pnpm test:unit`: passed; 1,472 tests (7 environment-safety, 54 script, and 1,411 workspace tests).
- `pnpm test:infra:up`: passed; isolated PostgreSQL and Redis healthy.
- `pnpm --filter @checkout-surge/db test:db:migrate`: passed; the isolated database rebuilt from all nine reviewed migrations.
- Focused worker persistence integration command: passed; the worker configuration ran 10 files, 81 tests. Focused API readers: passed; 3 files, 35 tests. Focused DB readers/cleanup remained covered by the full integration suite.
- `pnpm test:integration`: passed; 17 files, 169 tests (DB 83, worker 81, Mock ERP 5).
- `pnpm test:api`: passed; 50 files, 621 tests.
- `git diff --check`: passed. Composition and characterization suites were not run, as required.
