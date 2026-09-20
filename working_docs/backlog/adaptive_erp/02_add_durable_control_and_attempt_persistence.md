# 02 — Add durable control and ERP-attempt persistence

## Handoff

- Status: Done (uncommitted at handoff; see Completion notes).
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 02 of 21. Execute after [01](01_define_contracts_and_acceptance_fixtures.md); its contracts and fixtures must be available.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 2, D01, D02, D04, D07, D09 and section 12. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: DB schema and worker persistence adapters. Runtime scheduling cutover belongs to task 05.

## Objective and fixed rules

Provide durable primitives for exactly one logical processing owner per order, independent of BullMQ deliveries. Extend the existing recovery row; do not add a competing scanner or a second downstream state machine. Before a first ERP dispatch, creation/claim of that row and `queued -> processing` occur in one transaction. An expired lease allows reclaim, but never proves an earlier HTTP call had no effect.

Order/run lifecycle statuses stay unchanged. Technical failures retain nonterminal work. PostgreSQL is authoritative for obligations, intent, next eligibility, and ownership; the queue is not a business retry budget. No processing deadline or expiry is introduced.

## Repository entry points

`packages/db/src/{schema,migrations,testing,demo-run-maintenance}.ts`, `packages/db/drizzle/`, `apps/worker/src/persistence/{postgres-order-recovery-persistence,postgres-order-transition-persistence,postgres-order-dispatch-persistence,postgres-erp-attempt-persistence}.ts`, and `apps/worker/src/application/order-process-job-handler.ts` define the existing boundaries. Inspect `packages/db/test/{unit,integration,types}/` and the worker persistence/integration tests before modifying SQL.

## Implementation work

- [x] Extend the order recovery/control record with one-row-per-order identity, processing generation, lease expiry, next eligible time, waiting reason, publication ownership, intervention reason, and unresolved dispatched-call identity. Keep initial dispatch/outbox evidence distinct from processing ownership without creating two independent retry owners.
- [x] Introduce a durable identity for each actual confirmation POST, independent of queue job id or `attemptsMade`. Record dispatch intent before sending HTTP, and retain immutable order/reservation/sale/run/quantity/idempotency identity and correlation lineage.
- [x] Implement atomic claim and conditional generation/lease updates, with eligibility in the selection query and again at dispatch. Use the repository's transaction/locking conventions. Select by next eligible time then order creation time; filter ineligible rows before applying the batch limit. Pending rows must respect next eligibility too.
- [x] Provide atomic APIs for durable deferral, publication claim/ack/failure, uncertainty, accepted-result recovery, intervention, and resolution. Reject stale generations without overwriting a newer owner. A recoverable database error must not be converted into a terminal business outcome.
- [x] Add persistence support for per-scope cooldown/circuit-open expiry, administrative stop, terminal failure category/code, and per-order cumulative attempt categories where needed by later tasks. Keep unimplemented behavior inactive; do not fabricate live projection values from new empty fields.
- [x] Preserve canonical ERP-success/permanent-rejection evidence and references from unresolved calls. Prepare idempotent per-call accounting; task 06 implements and verifies bounded pruning rather than deleting evidence to satisfy a limit.
- [x] Update generated-run cleanup ownership for the added tables/columns, but never make active, uncertain, or intervention work eligible for deletion. The mock ledger is ERP-owned and will be added in task 03; the worker must not access it directly.
- [x] Follow the repository's actual incremental migration practice (user decision, 2026-09-19): `packages/db/drizzle/` holds `0000_baseline` plus incremental migrations, so add one new generated migration (`0005_*`) with its snapshot and journal entry, and update the entry count asserted by `packages/db/test/unit/migration-metadata.test.ts`. Do not amend or recondense `0000`–`0004`, keep the required custom SQL of the baseline untouched, and validate isolated migrations. The migration must apply to a database holding existing rows without rewriting or wiping the user's historical incident records. The single-baseline wording in `docs/local_development.md` is outdated relative to the repository; report it rather than fixing it in this task.

## Runnable boundary and non-goals

Keep current consumers runnable while these primitives are introduced; coordinate changed persistence interfaces with their callers in this task. Do not enable a partial new scheduler or set queue attempts to one before task 05 updates all producers and recovery. Do not persist learned rates or latency samples; D07 retains only restart safety state. Do not introduce distributed limiting, payment expiry, or automatic stock release.

## Acceptance and validation

- [x] Concurrent claims yield one owner; stale generation/delivery cannot dispatch or mutate current ownership.
- [x] Crash/rollback between transition and claim leaves neither an ownerless processing order nor a committed dispatch without intent.
- [x] Future-due pending work, leased work, interventions and terminal rows cannot occupy the front of a limited recoverable batch; older eligible retries are not starved by new orders.
- [x] Lease expiry retains uncertainty, canonical results survive duplicate writes, and cumulative accounting is idempotent by actual call identity.
- [x] Test schema/metadata parity and isolated migration: `pnpm test:infra:up`, `pnpm test:db:migrate`, relevant worker/DB integration tests, `pnpm test:integration`, and `pnpm type-check`; run focused unit tests too. Do not use the reference runtime as a migration fixture.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep infrastructure in composition roots and persisted-boundary validation explicit. Format/check only touched supported files with Biome. Use Linux/Dev Container execution; no composition/characterization suites without an explicit request. Report executed/skipped checks and stop for approval rather than changing a locked decision.

## Completion handoff

Deliver the runnable schema/adapter slice. Record the concrete control-record fields, transaction boundaries, claim ordering, dispatch-intent API, SQL artifacts, and tests. Next: [03 — mock ERP ledger](03_persist_mock_erp_ledger_and_status_lookup.md).

## Completion notes

### Control record (`order_recovery_jobs`, one row per order)

Existing scheduling fields are kept; `next_attempt_at` is the durable next eligible time and is now respected for `pending` rows too. Added: `processing_generation`, `lease_expires_at` (distinct from next eligibility), `waiting_reason` (`order_waiting_reason` enum, contracts vocabulary), `publication_owner` (the owning delivery/job id), `intervention_reason`, `unresolved_erp_call_id` (FK to `erp_dispatch_calls`, `ON DELETE SET NULL`), and `attempt_counts` (jsonb, keyed by the shared `ErpOutcomeDisposition` vocabulary; a timeout counts as `uncertain_result`).

Inactive persistence support for later tasks: `orders.failure_category`, `demo_runs.administrative_stop`, and `erp_scope_resilience_state` (`catalog` / `run:<id>` cooldown and circuit-open expiries, adapter `PostgresErpScopeResiliencePersistence`, not wired into the runtime). No projection reads the new fields.

### Per-call identity and dispatch intent

`erp_dispatch_calls` holds one row per actual confirmation POST with immutable order/public-order/reservation/sale/run/quantity/idempotency identity, correlation id, processing generation, `dispatched_at` and `resolved_at`. `ErpAttemptPersistence.recordDispatchIntent({ job, idempotencyKey, dispatchedAt, expectedProcessingGeneration })` returns an `ErpCallReference`; the confirmation client calls it before `fetch`, and every recorded attempt carries `call`. `erp_attempts.erp_call_id` is unique; the legacy `(order, delivery, attempt number)` uniqueness is now partial (rows without `erp_call_id`), so several real calls from one delivery coexist.

The reconciliation set is `erp_dispatch_calls` with `resolved_at IS NULL`. A call resolves only on a contract-valid success, a contract-declared permanent rejection, or a recognized capacity/unavailability disposition. Timeouts, transport errors, malformed bodies, unknown codes and opaque `5xx` stay unresolved. A canonical success or permanent rejection also resolves every earlier unresolved call of the same order and idempotency key; capacity/unavailability resolve only their own call.

### Transaction boundaries and lock order

- `transitionToProcessing`: lock order, create the control row if missing (also for pre-0005 in-flight `processing` orders), execution claim, `queued -> processing`, `order.processing` event — one transaction. Terminal transitions close the control record in the same transaction.
- Execution claim (delivery-keyed, one conditional `UPDATE`): same `publication_owner` renews the lease and keeps the generation; a free or expired lease takes ownership and increments the generation; a live competing owner makes the handler acknowledge the delivery without dispatch and without a business failure. Eligibility (status, no intervention, next eligible time, lease) is in the `WHERE` clause.
- Dispatch intent: validate the claimed generation and eligibility under lock, insert the call, stamp the control — one transaction, before HTTP; failure is a recoverable error, never a terminal outcome.
- Attempt result: evidence, per-call accounting (first insert only) and call resolution — one transaction.
- Lock order everywhere: order, then control, then call.

### Claim ordering

`findRecoverable` filters before `LIMIT`: control `pending|enqueued`, no intervention, next eligible time reached, lease free or expired, order `queued|processing`; ordered by `next_attempt_at ASC NULLS FIRST`, then `orders.created_at`. `claimForPublication` is one conditional `UPDATE` that increments attempts and generation, derives `publication_owner` = `recovery-<orderId>-<attempt>` and returns that exact job id for the scanner to publish. `markPublicationFailed`, `defer` and `openIntervention` require the generation and never reopen a resolved control.

### Cleanup

Generated-run teardown reports `outstanding_work` at inspection (before queue/Redis cleanup, HTTP `409 run_cleanup_conflict`) while the run holds a nonterminal order, an unresolved dispatched call or an open intervention. Durable deletion removes `erp_dispatch_calls` and the run's `run:<id>` resilience scope. Accepted consequence: a run with a genuinely uncertain call stays until a later task reconciles it.

### SQL artifacts

`packages/db/drizzle/0005_durable_control_and_attempt_persistence.sql`, `meta/0005_snapshot.json`, journal entry 5. `0000`–`0004` untouched. New `NOT NULL` columns have defaults. A one-off populated `0004 -> 0005` upgrade on the isolated test database preserved historical values, applied defaults and kept legacy delivery uniqueness (`23505`).

### Tests

`apps/worker/test/integration/postgres-processing-control.integration.test.ts` (one-transaction creation and rollback through the production transition, concurrent claims, stale generation, batch eligibility/ordering, dispatch-intent ownership, lease expiry retaining uncertainty, canonical results and idempotent accounting, malformed/opaque responses unresolved, concurrent canonical success on two connections, lock-order overlap, old delivery after reclaim / retry after lease expiry / late recovery delivery / pre-0005 processing order through the real handler, timeout-then-success and timeout-then-capacity resolution), `postgres-erp-scope-resilience.integration.test.ts`, `packages/db/test/integration/demo-run-maintenance.integration.test.ts`, the API teardown service test for `outstanding_work`, plus updated scanner, client, vocabulary-parity and migration-metadata tests.

Last reported validation: Biome on touched files clean, `pnpm type-check` 11/11, `pnpm test:unit` 1,433 passed, `pnpm test:db:migrate` passed, `pnpm test:integration` 154 passed (DB 83, worker 71). Composition and characterization suites not run.

### Follow-ups

- `docs/local_development.md` still describes a single amended baseline; the repository uses incremental migrations. Not fixed here by decision.
- A call recorded as uncertain after the canonical success of the same key already exists (possible only when a second owner dispatches after a lease expiry while the first owner's success is being persisted), or a duplicate success write arriving after such a call, leaves that call unresolved. It is safe (it blocks teardown, it never deletes evidence) and belongs to the lookup-first reconciliation of tasks 03/05.
- The 30 s control lease reuses `orderRecoveryLeaseMs`; task 05 should align it with the maximum ERP deadline (D08) so a slow in-flight call is not reclaimed.
- Deliveries still carry no generation in their payload; ownership is bound to the delivery id until task 05.

