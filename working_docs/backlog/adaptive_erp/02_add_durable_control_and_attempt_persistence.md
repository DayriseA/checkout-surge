# 02 — Add durable control and ERP-attempt persistence

## Handoff

- Status: Pending.
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

- [ ] Extend the order recovery/control record with one-row-per-order identity, processing generation, lease expiry, next eligible time, waiting reason, publication ownership, intervention reason, and unresolved dispatched-call identity. Keep initial dispatch/outbox evidence distinct from processing ownership without creating two independent retry owners.
- [ ] Introduce a durable identity for each actual confirmation POST, independent of queue job id or `attemptsMade`. Record dispatch intent before sending HTTP, and retain immutable order/reservation/sale/run/quantity/idempotency identity and correlation lineage.
- [ ] Implement atomic claim and conditional generation/lease updates, with eligibility in the selection query and again at dispatch. Use the repository's transaction/locking conventions. Select by next eligible time then order creation time; filter ineligible rows before applying the batch limit. Pending rows must respect next eligibility too.
- [ ] Provide atomic APIs for durable deferral, publication claim/ack/failure, uncertainty, accepted-result recovery, intervention, and resolution. Reject stale generations without overwriting a newer owner. A recoverable database error must not be converted into a terminal business outcome.
- [ ] Add persistence support for per-scope cooldown/circuit-open expiry, administrative stop, terminal failure category/code, and per-order cumulative attempt categories where needed by later tasks. Keep unimplemented behavior inactive; do not fabricate live projection values from new empty fields.
- [ ] Preserve canonical ERP-success/permanent-rejection evidence and references from unresolved calls. Prepare idempotent per-call accounting; task 06 implements and verifies bounded pruning rather than deleting evidence to satisfy a limit.
- [ ] Update generated-run cleanup ownership for the added tables/columns, but never make active, uncertain, or intervention work eligible for deletion. The mock ledger is ERP-owned and will be added in task 03; the worker must not access it directly.
- [ ] Follow the pre-release baseline policy in `docs/local_development.md`: regenerate/review the baseline SQL and metadata together, preserve required custom SQL, and validate isolated migrations. Do not add a compatibility migration or rewrite/wipe the user's historical incident records.

## Runnable boundary and non-goals

Keep current consumers runnable while these primitives are introduced; coordinate changed persistence interfaces with their callers in this task. Do not enable a partial new scheduler or set queue attempts to one before task 05 updates all producers and recovery. Do not persist learned rates or latency samples; D07 retains only restart safety state. Do not introduce distributed limiting, payment expiry, or automatic stock release.

## Acceptance and validation

- [ ] Concurrent claims yield one owner; stale generation/delivery cannot dispatch or mutate current ownership.
- [ ] Crash/rollback between transition and claim leaves neither an ownerless processing order nor a committed dispatch without intent.
- [ ] Future-due pending work, leased work, interventions and terminal rows cannot occupy the front of a limited recoverable batch; older eligible retries are not starved by new orders.
- [ ] Lease expiry retains uncertainty, canonical results survive duplicate writes, and cumulative accounting is idempotent by actual call identity.
- [ ] Test schema/metadata parity and isolated migration: `pnpm test:infra:up`, `pnpm test:db:migrate`, relevant worker/DB integration tests, `pnpm test:integration`, and `pnpm type-check`; run focused unit tests too. Do not use the reference runtime as a migration fixture.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep infrastructure in composition roots and persisted-boundary validation explicit. Format/check only touched supported files with Biome. Use Linux/Dev Container execution; no composition/characterization suites without an explicit request. Report executed/skipped checks and stop for approval rather than changing a locked decision.

## Completion handoff

Deliver the runnable schema/adapter slice. Record the concrete control-record fields, transaction boundaries, claim ordering, dispatch-intent API, SQL artifacts, and tests. Next: [03 — mock ERP ledger](03_persist_mock_erp_ledger_and_status_lookup.md).
