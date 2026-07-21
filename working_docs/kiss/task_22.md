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

- [ ] Exactly one component owns discovery, retry scheduling, and resolution for interrupted reservation persistence.
- [ ] Repair is bounded, idempotent, run-scoped, and cannot duplicate durable business records or inventory effects.
- [ ] Each case reaches durable record or an operator-visible unresolved failure within a bounded window.
- [ ] The recovery-window/retry bounds have named defaults, observable attempts/exhaustion, and deterministic fake-clock tests.
- [ ] Finalization reports/blocks unresolved pending persistence rather than silently succeeding.
- [ ] The working record explicitly dispositions pending-persistence indexes/Lua scripts, mirrored PostgreSQL state, completion-enrichment repair, finalization polling, worker scanners, failed-set ingestion, and terminal recovery sweeps without deleting primitives required for atomic no-oversell.
- [ ] Unneeded global indexes, reconcilers, schedulers, classifications, mirrored state, docs, and tests are deleted in the same cutover; every retained recovery mechanism is subordinate to the single owner or protects a separately named guarantee.

## Focused verification

Run API persistence/recovery/finalization tests, DB unit/integration tests for Redis-to-Postgres handoff, and API/DB type-checks. Use the focused test-infrastructure-backed suites when available. Do not run composition or characterization suites.

## Working record

Pending — identify the sole owner, discovery source, retry bound, visible failure surface, explicit disposition of every listed mesh category, atomic reservation primitives retained, deleted mesh pieces, commands run, and skipped checks.
