# Task 22 — Replace pending-persistence mesh with one run-scoped owner

## Execution context

Task 22 of 45, Phase 4, implementing D1 after task 05 removed incident remediation. Primary ownership is one dedicated application recovery component that discovers, schedules, and resolves interrupted Redis-to-Postgres reservation persistence. Redis/DB adapters provide operations; finalization observes its state. No startup service, worker, route, or maintenance service may become a second scheduler.

## Why

Global indexes, classifications, reconcilers, schedulers, mirrored state, and one-time remediation overlap around one real handoff failure, creating multiple authorities and duplicate-repair risk.

## Required outcome

Provide one bounded, observable, idempotent, run-scoped owner for interrupted Redis holds whose Postgres persistence was interrupted. It must discover cases, schedule retries, and resolve holds to durable records without duplicate inventory/business effects. Define one named/configured recovery-window bound plus a bounded retry/backoff policy; exhaustion must produce a durable or otherwise queryable operator-visible unresolved state for the affected run. Retain durable queue dispatch recovery and terminal finalization; finalization cannot silently succeed while this failure remains pending. Remove global mesh components not required by the chosen path. Reset remains only an explicit operator escape hatch.

Before deletion, inventory and explicitly disposition every part of the current failure path: pending-persistence indexes and Lua scripts, mirrored PostgreSQL state, completion-enrichment repair hooks, finalization polling, worker scanners, failed-set ingestion, and terminal recovery sweeps. For each, record whether it is deleted, retained as the sole owner's minimal discovery/state adapter, or retained for a separate named guarantee. A retained adapter may expose data or an idempotent operation but must not independently discover work, schedule retries, or drive resolution.

## Scope and concrete current paths

- `packages/db/src/redis-stock-reservation.ts`, `redis-inventory*.ts`, Redis resilience/helpers, schema and Postgres buy-persistence support.
- `apps/api/src/services/postgres-buy-persistence.ts`, `pending-persistence-reconciler.ts`, startup reconciliation, finalizer/maintenance/run services, and associated routes/index composition.
- Global indexes/classifications/schedulers, mirrored state, tests, docs, and removed remediation references. Verify exact names before editing.
- Trace the complete call graph for completion enrichment, finalization polling, worker scanning, failed-set ingestion, and terminal recovery sweeps; similarly named entry points do not count as separate dispositions.

## Retained behavior and non-goals

Keep atomic reservation/no oversell, durable PostgreSQL-to-BullMQ dispatch recovery, terminal finalization, and operator visibility. Redis Lua or indexing used to make the original reservation atomic is a reservation primitive, not repair scheduling, and must not be deleted merely because it shares storage or helpers with pending-persistence recovery. Ordinary synchronous completion enrichment is likewise distinct from repair discovery or retry scheduling. Do not treat reset as normal recovery, duplicate or reapply the inventory decision, or add a second background repair authority. This task does not remove durable queue/finalization recovery.

## Acceptance

- [x] Exactly one component owns discovery, retry scheduling, and resolution for interrupted reservation persistence.
- [x] Repair is bounded, idempotent, run-scoped, and cannot duplicate durable business records or inventory effects.
- [x] Each case reaches a durable record or an operator-visible unresolved failure within a bounded window. Every attempt owns abortable PostgreSQL, deadline-limited Redis, and disconnectable BullMQ resources; deadline expiry and owner shutdown cancel subordinate work instead of only racing its promise.
- [x] The recovery-window/retry bounds have named defaults, observable attempts/exhaustion, and deterministic fake-clock tests.
- [x] Finalization reports/blocks unresolved pending persistence rather than silently succeeding.
- [x] The working record explicitly dispositions pending-persistence indexes/Lua scripts, mirrored PostgreSQL state, completion-enrichment repair, finalization polling, worker scanners, failed-set ingestion, and terminal recovery sweeps without deleting primitives required for atomic no-oversell.
- [x] Unneeded global indexes, reconcilers, schedulers, classifications, mirrored state, docs, and tests are deleted in the same cutover; every retained recovery mechanism is subordinate to the single owner or protects a separately named guarantee.

## Focused verification

Run API persistence/recovery/finalization tests, DB unit/integration tests for Redis-to-Postgres handoff, and API/DB type-checks. Use the focused test-infrastructure-backed suites when available. Do not run composition or characterization suites.

## Working record

The sole owner is `PendingPersistenceRecoveryService` in `apps/api`. It discovers work by listing nonterminal run/sale scopes and active catalog offers from PostgreSQL and then reading only due records from each sale's Redis pending-persistence index. Catalog holds therefore retain autonomous recovery without restoring a global Redis index. Its single self-scheduled loop and exact request-replay entry point call the same due-time/idempotent resolution path: write the attempt audit, materialize or verify the reservation/order, reassert the deterministic BullMQ job, durably resolve the audit, and only then atomically promote the existing Redis hold to accepted. It never reapplies the inventory decrement.

The named defaults are a 300-second recovery window, six attempts, exponential backoff from 1 second capped at 30 seconds, a 1-second polling interval, a 2-second whole-discovery deadline, a process-local cap of three distinct direct replay attempts, and a per-sale batch of 100. The first failed/audit-deferred attempt persists a deadline derived from the original secured time; restarts honor it even after configuration changes. Marker ensure preserves future/exhausted scheduling state, exact replay respects the same due time, and due pages exclude future/exhausted records. Invalid companion metadata is logged and its cursor quarantined outside due work so it remains visible without starving later cases.

Each record attempt receives an owned PostgreSQL pool whose statements honor the attempt `AbortSignal`, a Redis client with the remaining persisted deadline as its command timeout, and a BullMQ publisher that disconnects on abort. Discovery uses separately owned abortable PostgreSQL and Redis resources under one whole-operation deadline. The scheduler processes records sequentially; exact request replay coalesces the same reservation and admits no more than three distinct direct attempts by default. `close()` synchronously closes admission, aborts those resources, and all-settled drains scheduler passes and exact request-replay operations. Close-triggered PostgreSQL/Redis cancellation is normalized, while unexpected cleanup failures remain aggregated and the API continues closing later resources.

The subordinate PostgreSQL audit stores only reservation/sale/optional-run/correlation coordinates plus status, attempt count, last error, exhaustion time, and row timestamps. It never discovers, schedules, or resolves work. At exhaustion Redis is marked authoritative and moved outside due work first while retaining the hold/pending record, so finalization continues to block even when the bounded audit write is unavailable; generated-run reset is the explicit escape hatch. If promotion removed the Redis cursor before its response was observed, or a concurrent resolver removed it first, the authoritative `removed` disposition prevents retry/exhaustion audit rewrites; an already resolved audit and durable result remain resolved. Catalog exhaustion remains visible for explicit operational cleanup. Business-outcome projection may display the audit, but finalization blockers and accepted-response accounting replace its pending count with the authoritative Redis observation.

| Failure-path category | Disposition | Guarantee / boundary |
| --- | --- | --- |
| Per-sale indexes and Lua scripts | Retained only as the sole owner's state adapter and atomic reservation primitive. The global pending-persistence index and all of its writes/rescoring were deleted. | Per-sale pending ZSET/hash records support bounded due discovery for run and catalog offer scopes. Marker ensure preserves scheduling state; invalid metadata is quarantined without hiding later work. Reservation, acceptance promotion, reversal, and idempotency Lua operations preserve no-oversell. |
| Mirrored PostgreSQL state | Reduced to a minimal subordinate audit; request-path mirror writes, hold/idempotency/quantity/token/window copies, redundant indexes, and use as discovery/scheduling state were deleted. | Operator-visible attempt, resolution, and exhaustion history. Audit resolution precedes Redis removal. It cannot discover, schedule, resolve, or independently block finalization. |
| Completion-enrichment repair hooks | Deleted. Ordinary synchronous completion enrichment remains. | Completion enrichment may add ordinary terminal metadata but cannot repair pending persistence or invoke its owner. |
| Finalization polling | Retained as lifecycle finalization, with pending repair calls deleted. | It observes Redis pending counts and the terminal writer refuses completion while any remain; it neither discovers nor schedules persistence recovery. |
| Worker scanners | Retained unchanged for separate guarantees. | PostgreSQL-to-BullMQ queued-order dispatch, durable ERP-result recovery, and notification recovery cover failures after durable order creation, not Redis-to-PostgreSQL persistence. |
| Failed-set ingestion | Retained unchanged for the separate poison order-job recovery guarantee. | It recovers/escalates failed durable order-processing jobs and cannot resolve pending reservations. |
| Terminal recovery sweeps | Pending-persistence sweep behavior was deleted; terminal writing/finalization remains. | There is no terminal pending-persistence scheduler. A run cannot finalize while pending records remain, and reset remains the operator escape hatch. |
| Request replay | Retained as a delegate to the sole owner. | A repeated idempotency request may prompt the same bounded resolution path but cannot form a second authority. Same-reservation work coalesces, distinct direct attempts are permit-bounded, and overload preserves the pending response. |
| Atomic reservation primitives | Retained. | The original Redis stock decrement and idempotent hold/accept/reversal transitions remain atomic and are never duplicated by recovery. |

Deleted mesh pieces include `PendingPersistenceReconciler`, its global discovery/index path, startup-wide reconciliation, finalizer and completion-enrichment re-drive hooks, request-path PostgreSQL mirror coordination, and their mesh-specific tests and documentation. The API starts and stops exactly one recovery service instance.

Verification performed after the reviewer-blocker corrections:

- Full API suite: 40 files / 506 tests passed, including real PostgreSQL discovery cancellation, real Redis command interruption, shutdown cleanup aggregation, promotion-response-loss audit truth, direct replay admission, persistence, replay, and finalization coverage.
- DB integration: 5 files / 77 tests passed, including authoritative concurrent cursor-removal behavior; DB unit: 7 files / 49 tests passed.
- Contracts: 3 files / 109 tests passed.
- The isolated baseline migration verification passed.
- Root production/boundary and test TypeScript checks passed across all packages.
- Repository lint and format checks passed across 397 files; `git diff --check` and the live retired/stale-identifier search passed.
- The isolated test PostgreSQL/Redis containers and volumes were removed after verification.

The composition and characterization suites were intentionally skipped per repository instructions.
