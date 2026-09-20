# 05 — Unify worker scheduling and queue handoffs

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 05 of 21. Execute after [04](04_implement_erp_classification_and_reconciliation.md); tasks 02–04 provide durable claims, ledger and reconciliation.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 2, D01, D03–D05 and D07. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: worker handler/recovery, API initial publication, BullMQ adapters and associated persistence.

## Objective and fixed rules

Cut over the entire order-processing path to one durable owner. This task deliberately includes initial publication, delayed/recovery delivery and the handler: switching only one of these would strand work. BullMQ order-process jobs have `attempts: 1`; deliveries are wake-ups, not an ERP-call budget. Transient capacity, recognized unavailability and timeouts must never exhaust into terminal order failure.

Order statuses remain `queued | processing | confirmed | failed`. Only a recognized permanent rejection or explicit administrative disposition can terminally fail an order. Technical/identity defects retain intervention; confirmed results retain notification obligations. No business-abandonment timer is introduced.

## Repository entry points

Worker application files: `order-process-job-handler.ts`, `order-recovery-scanner.ts`, `order-dispatch-scanner.ts`, `order-job-publisher.ts`, `order-process-admission.ts`. Worker persistence: `postgres-order-{recovery,dispatch,transition}-persistence.ts` and `postgres-erp-attempt-persistence.ts`. Queue adapters: `bullmq-order-process-consumer.ts` and `bullmq-order-process-job-publisher.ts`. Also inspect API `services/order-process-job-publisher.ts`, `queue/{bullmq-order-process-job-publisher,postgres-run-retry-policy-resolver}.ts`, `services/run-retry-policy-resolver.ts`, pending-persistence publication, contracts/queue, and worker runtime composition.

## Implementation work

- [ ] Before first dispatch, atomically transition/claim the single control record; before every POST, recheck generation, due time, lease, intervention and administrative stop, then persist actual-call intent. Reconcile any earlier unresolved intent before another business attempt.
- [ ] Make every initial/delayed/recovery delivery carry the required generation and lineage. Stale generations acknowledge without work or new attempt rows. Duplicate deliveries cannot create concurrent logical processing.
- [ ] Persist due time/wait reason and release active ownership before arranging a future wake-up. Denied/local deferrals make no HTTP call and create no ERP attempt. Never sleep in an active job or retain a DB transaction/connection while waiting.
- [ ] Extend the existing recovery scanner to own deferred work and publication repair. Claim publication atomically; persist publication failure and next eligibility. Cover crash windows before/after scheduling commit, queue publication and publication acknowledgement. A completed BullMQ job id must not prevent a later legitimate generation from being published.
- [ ] Set `attempts: 1` consistently for all order-process producers, including API initial dispatch and recovery. Remove delivery-counter attempt identity and the temporary client adapter from task 04. Remove obsolete finite ERP retry resolution from these producers without deleting unrelated pending-reservation persistence policy.
- [ ] Remove recovery publication limits as silent business-abandonment budgets. Bound batches, retry frequency and concurrent work; retain visible escalation/intervention for actual defects. A historical attempt counter may remain diagnostic but cannot erase an obligation.
- [ ] Resolve eligibility in SQL before limiting: next eligible time then order creation time, no new-buy priority. Execution rechecks claims; terminal/ineligible rows cannot starve later eligible work.
- [ ] Preserve canonical accepted results across local transition failure and enqueue/repair exactly one notification obligation per confirmed order. Missing accepted run snapshot is intervention on that job, never catalog fallback. Scope auth failures block that scope, not the entire worker.
- [ ] Persist the scope-level intervention (user decision, 2026-09-20): add an intervention reason and timestamp to the existing `erp_scope_resilience_state` table through this task's incremental migration, reusing task 02's adapter. A `401`/`403` marks the `run:<id>` or `catalog` scope once; the handler and scanner dispatch nothing for a marked scope and open no per-order intervention for the same cause. Task 09 restores the marker at startup and task 11 owns resume.
- [ ] Source deferral delays for capacity, unavailability and timeout from a worker-internal capped exponential backoff with jitter (user decision, 2026-09-20), not from the snapshot's `retryPolicy`. Declare it an explicit temporary adapter in the completion handoff; task 09 replaces it with the engine policy.
- [ ] Update tests that currently require temporary retry exhaustion to fail; replace their asserted policy rather than weakening assertions. Keep unknown payload/identity defects attributable and correlation intact.

## Non-goals

Adaptive rate control is not activated here; existing conservative concurrency protection remains until task 09. Do not bypass terminal publication fencing, add another scanner, turn arbitrary permanent errors into endless retries, or remove all retired form/config fields ahead of the coordinated task 12 cleanup.

## Acceptance and validation

- [ ] More than the old four attempts and more than the former publication limit retain work and converge after a finite transient problem.
- [ ] Real Redis/BullMQ redelivery, duplicated/stale generations and lost wake-ups produce one owner, distinct actual-call ids, no duplicate ERP effect and no busy loop.
- [ ] Fault injection around every DB/queue handoff leaves durable recovery intent; lease expiry first reconciles unresolved calls.
- [ ] ERP success plus local write failure later produces one confirmed order and one notification; recognized permanent rejection and intervention remain distinct.
- [ ] Run focused worker/API publisher tests and `pnpm type-check`; use `pnpm test:infra:up`, `pnpm test:api`, and `pnpm test:integration` for queue/DB boundaries. Ordinary unit checks remain required for touched logic.

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check only touched supported files with Biome; keep routes thin and construction in composition roots. Use Linux/Dev Container tests and isolated infrastructure. Do not run composition/characterization or reset the reference runtime without an explicit request. Report actual/skipped checks and stop for user approval on locked-design deviations.

## Completion handoff

Deliver one runnable end-to-end cutover, not half of a producer/consumer protocol change. Record generation rules, scheduling-owner transitions, repaired crash windows and removed legacy paths. Next: [06 — bounded history](06_bound_attempt_history_and_preserve_aggregates.md).
