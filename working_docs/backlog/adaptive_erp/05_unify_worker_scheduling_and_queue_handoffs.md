# 05 — Unify worker scheduling and queue handoffs

## Handoff

- Status: Completed.
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

- [x] Before first dispatch, atomically transition/claim the single control record; before every POST, recheck generation, due time, lease, intervention and administrative stop, then persist actual-call intent. Reconcile any earlier unresolved intent before another business attempt.
- [x] Make every initial/delayed/recovery delivery carry the required generation and lineage. Stale generations acknowledge without work or new attempt rows. Duplicate deliveries cannot create concurrent logical processing.
- [x] Persist due time/wait reason and release active ownership before arranging a future wake-up. Denied/local deferrals make no HTTP call and create no ERP attempt. Never sleep in an active job or retain a DB transaction/connection while waiting.
- [x] Extend the existing recovery scanner to own deferred work and publication repair. Claim publication atomically; persist publication failure and next eligibility. Cover crash windows before/after scheduling commit, queue publication and publication acknowledgement. A completed BullMQ job id must not prevent a later legitimate generation from being published.
- [x] Set `attempts: 1` consistently for all order-process producers, including API initial dispatch and recovery. Remove delivery-counter attempt identity and the temporary client adapter from task 04. Remove obsolete finite ERP retry resolution from these producers without deleting unrelated pending-reservation persistence policy.
- [x] Remove recovery publication limits as silent business-abandonment budgets. Bound batches, retry frequency and concurrent work; retain visible escalation/intervention for actual defects. A historical attempt counter may remain diagnostic but cannot erase an obligation.
- [x] Resolve eligibility in SQL before limiting: next eligible time then order creation time, no new-buy priority. Execution rechecks claims; terminal/ineligible rows cannot starve later eligible work.
- [x] Preserve canonical accepted results across local transition failure and enqueue/repair exactly one notification obligation per confirmed order. Missing accepted run snapshot is intervention on that job, never catalog fallback. Scope auth failures block that scope, not the entire worker.
- [x] Persist the scope-level intervention (user decision, 2026-09-20): add an intervention reason and timestamp to the existing `erp_scope_resilience_state` table through this task's incremental migration, reusing task 02's adapter. A `401`/`403` marks the `run:<id>` or `catalog` scope once; the handler and scanner dispatch nothing for a marked scope and open no per-order intervention for the same cause. Task 09 restores the marker at startup; task 11 replaces the marker with a terminal technical failure of each affected order.
- [x] Source deferral delays for capacity, unavailability and timeout from a worker-internal capped exponential backoff with jitter (user decision, 2026-09-20), not from the snapshot's `retryPolicy`. Declare it an explicit temporary adapter in the completion handoff; task 09 replaces it with the engine policy.
- [x] Update tests that currently require temporary retry exhaustion to fail; replace their asserted policy rather than weakening assertions. Keep unknown payload/identity defects attributable and correlation intact.

## Non-goals

Adaptive rate control is not activated here; existing conservative concurrency protection remains until task 09. Do not bypass terminal publication fencing, add another scanner, turn arbitrary permanent errors into endless retries, or remove all retired form/config fields ahead of the coordinated task 14 cleanup.

## Acceptance and validation

- [x] More than the old four attempts and more than the former publication limit retain work and converge after a finite transient problem.
- [x] Real Redis/BullMQ redelivery, duplicated/stale generations and lost wake-ups produce one owner, distinct actual-call ids, no duplicate ERP effect and no busy loop.
- [x] Fault injection around every DB/queue handoff leaves durable recovery intent; lease expiry first reconciles unresolved calls.
- [x] ERP success plus local write failure later produces one confirmed order and one notification; recognized permanent rejection and intervention remain distinct.
- [x] Run focused worker/API publisher tests and `pnpm type-check`; use `pnpm test:infra:up`, `pnpm test:api`, and `pnpm test:integration` for queue/DB boundaries. Ordinary unit checks remain required for touched logic.

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check only touched supported files with Biome; keep routes thin and construction in composition roots. Use Linux/Dev Container tests and isolated infrastructure. Do not run composition/characterization or reset the reference runtime without an explicit request. Report actual/skipped checks and stop for user approval on locked-design deviations.

## Completion handoff

Deliver one runnable end-to-end cutover, not half of a producer/consumer protocol change. Record generation rules, scheduling-owner transitions, repaired crash windows and removed legacy paths. Next: [06 — bounded history](06_bound_attempt_history_and_preserve_aggregates.md).

## Completion notes

Every order-process payload now carries a processing generation. API and queued-order repair publish generation `0`; each recovery publication atomically increments the control generation and publishes that exact value under a new attempt-scoped BullMQ job id. Execution accepts only the control row's current generation and publication owner. Stale or duplicate deliveries acknowledge without dispatch.

The control row is the scheduling owner from the initial `queued -> processing` claim through settlement. Admission moved inside that claimed workflow and surrounds only an actual POST/replay. Capacity, availability, uncertainty, circuit-open and local-admission results persist a waiting reason and due time while releasing the lease. Circuit-open is therefore a local durable deferral: it creates neither an HTTP call nor an ERP attempt row. The recovery scanner filters eligibility before `LIMIT`, atomically claims publication, and retains work beyond the former publication-attempt limit.

The repaired windows are: durable deferral before wake-up publication; publication claim before BullMQ add; persisted publication failure after add rejection; lease-expiry republish after a crash before delivery acknowledgement; generation fencing after a published stale wake-up; and lookup-first reconciliation after a crash with unresolved dispatch intent. Canonical accepted attempts remain reusable after a local transition failure and the confirmed transition remains the exactly-once notification boundary.

Removed paths: BullMQ delivery budgets derived from snapshot retry policy, API/pending-persistence retry-policy resolution for order publication, delivery-counter ERP-call ownership, `HttpErpOrderConfirmation.confirm`, `isTemporaryErpConfirmationError`, `shouldRetainOrderForErpOutcome`, handler thrown-outcome classification, BullMQ circuit-open delay, and recovery-attempt exhaustion escalation. All order-process producers use `attempts: 1`.

Migration `0007_fat_captain_universe` adds the scope intervention reason and opening timestamp. A scope `401`/`403` marker blocks handler claims and scanner selection without opening per-order intervention. Startup restore remains task 09; task 11 replaces the marker with a terminal technical failure of each affected order.

Temporary adapter: `ScheduledErpOrderConfirmation.defer` uses worker-local capped exponential backoff with jitter (1 second base, exponent capped at 6, total delay capped at 60 seconds, and `Retry-After` as a minimum). Task 09 replaces this function with the engine policy. The existing 1-second/60-second Retry-After parsing policy in the worker composition root is unchanged.

Review-cycle repairs consume `publicationOwner` atomically at the publication-to-execution handoff, so the same BullMQ delivery cannot claim twice; unresolved dispatch intent also fences every new business attempt until authoritative reconciliation resolves it or an admitted replay atomically supersedes it. Half-open circuits allow bounded status lookup without learning, and an `unknown` result may reach the single POST probe. Initial dispatch repair filters existing control ownership, scope intervention and administrative stop in SQL before `LIMIT`. Missing or corrupt accepted snapshots open per-order intervention in both handler admission and recovery publication instead of entering an endless publication retry.

An `unknown` lookup preserves unresolved call evidence through replay admission. Only the admitted same-key replay transaction resolves the explicitly superseded call while inserting its replacement intent and updating `unresolvedErpCallId`; denial or a crash before that commit leaves the prior call available for lookup in the next generation. Other unresolved calls still block dispatch.
