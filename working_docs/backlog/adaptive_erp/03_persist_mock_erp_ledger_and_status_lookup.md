# 03 — Persist the mock ERP ledger and expose status lookup

## Handoff

- Status: Done (uncommitted at handoff; see Completion notes).
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 03 of 21. Execute after [02](02_add_durable_control_and_attempt_persistence.md); use task 01's ERP contracts.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 2, sections 6.2–6.3, D03 and D05. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: mock ERP application/persistence, shared HTTP contracts, DB schema and test infrastructure.

## Objective and fixed rules

Make external confirmation identity survive process restart and lost responses. The mock owns a durable terminal-outcome ledger, separate from worker success records even on the same PostgreSQL server. The worker may reach this ledger only over HTTP. Local worker records cannot establish exactly-once external effects on their own.

Persist terminal outcomes only: canonical success or an explicitly recognized permanent rejection. Never persist transient capacity/outage/injected-error results or an `in progress` ledger state. No transaction stays open during simulated latency.

## Repository entry points

`apps/mock-erp/src/application/{confirmation-service,chaos-control-service,tps-limiter}.ts`, `apps/mock-erp/src/routes/confirmation-routes.ts`, its server/composition and runtime configuration, `apps/mock-erp/test/unit/{mock-erp,tps-limiter}.test.ts`, `packages/contracts/src/erp.ts`, and `packages/db/src/{schema,testing,demo-run-maintenance}.ts`. Add a narrow mock-owned persistence adapter in the mock ERP workspace. Wire real clients only from its composition root.

## Implementation work

- [x] Persist idempotency key plus immutable order id, public order id, reservation id, sale offer id, run identity and quantity, with canonical terminal result. Enforce uniqueness on the business idempotency key and reject contradictions with `409 erp_idempotency_conflict` rather than returning another order's result.
- [x] Preserve same-process duplicate promise sharing. For cross-process/concurrent first acceptance, let the unique insert determine the winner; the losing request reads and returns the winner's canonical row. Do not hold a transaction or connection over simulated latency.
- [x] Preserve the exact canonical JSON result, including confirmation identity and recorded timing. A replay response indicates reuse through `x-erp-replayed: true`; do not add a replay flag to the JSON body or regenerate canonical timestamps.
- [x] Expose `GET /confirmations/:idempotencyKey`: `succeeded` with canonical result, `rejected` with canonical permanent rejection, or `unknown`. `unknown` means no terminal record and can mean not received, still processing, or lost; it is never proof of no external effect.
- [x] Keep lookup outside the mock TPS quota, chaos latency and injected-error mechanisms. Retain existing service access controls, contract validation and correlation handling. Routes delegate to application services.
- [x] Keep ordinary confirmation capacity/outage behavior intact. The current mock has no permanent business-rejection emitter; do not reinterpret an arbitrary error as one or introduce a public chaos control. Ledger support uses only the shared explicit vocabulary.
- [x] Include ledger tables in isolated setup and exact generated-run cleanup without permitting deletion of unresolved obligations. Preserve catalog records appropriately; never clear the entire ledger during a normal run reset.
- [x] Follow the repository's incremental migration practice (user decision, 2026-09-19; see the [index](index.md) guardrails): add one new generated migration (`0006_*`) with its snapshot and journal entry, update the entry count asserted by `packages/db/test/unit/migration-metadata.test.ts`, and leave `0000`–`0005` untouched. The migration must apply to a populated database. Do not erase historical reference data as an implementation shortcut.

## Non-goals

No distributed worker/ERP transaction, separate orchestration service, durable profile timeline, public lookup feed, payment compensation, or persisted running-promise state. The ledger supplies evidence; worker scheduling and reconciliation remain tasks 04–05.

## Acceptance and validation

- [x] Same-key retries and concurrent duplicates return exactly one canonical confirmation; different immutable identity conflicts deterministically.
- [x] A mock process restart after acceptance returns the same canonical JSON/id through both lookup and replay.
- [x] Lost response after terminal persistence is recoverable; crash before terminal insertion leaves `unknown` without fabricating rejection.
- [x] Lookup works during configured capacity exhaustion/chaos and consumes no TPS; real transport failure remains possible and visible.
- [x] Transient outcomes never occupy the terminal ledger, and cleanup cannot remove evidence referenced by unfinished work.
- [x] Run focused mock/contract tests, `pnpm test:infra:up`, `pnpm test:db:migrate`, relevant PostgreSQL integration tests, `pnpm test:integration`, and `pnpm type-check`. Service-restart verification must use isolated processes/resources, not the user's active runtime.

Read [AGENTS](../../../AGENTS.md), [quality checklists](../../../docs/quality_checklists.md), and relevant local development/schema guidance. Format/check only touched supported files with Biome; execute through the documented Linux/Dev Container path. Do not run composition/characterization suites unless requested. All artifacts are English; report actual and skipped checks. Do not change D05's terminal-only design without explicit user approval.

## Completion handoff

Deliver the durable mock boundary and tests. Record lookup/replay contracts, uniqueness strategy, isolated restart procedure and cleanup ownership. Next: [04 — worker classification and reconciliation](04_implement_erp_classification_and_reconciliation.md).

## Completion notes

### Lookup and replay contracts

`POST /confirmations` still returns the canonical confirmation response body. Reuse is signalled only with `x-erp-replayed: true`; both the initial winner and every replay return the response parsed from the stored row, preserving confirmation identity, latency and timestamp. Concurrent transient responses still share one promise but carry no replay header because no canonical row was reused. UUID identity fields are normalized to lowercase before persistence and comparison, matching PostgreSQL's UUID representation. Identity contradiction emits the shared `409 erp_idempotency_conflict` code.

`GET /confirmations/:idempotencyKey` returns the shared lookup envelope: terminal branches include immutable identity and the complete canonical response as `result`; an absent terminal row returns `unknown` with the queried key. The Fastify router accepts the contract maximum 200-character idempotency key. Lookup calls the application service directly and never enters the chaos decision provider or TPS limiter. The permanent-rejection vocabulary remains intentionally empty, so this task adds storage support without adding a rejection emitter or public chaos control.

### Persistence and uniqueness

`ConfirmationService` depends on the narrow `ConfirmationLedger` port. Unit tests use `InMemoryConfirmationLedger`; the composition root creates `PostgresConfirmationLedger` with the Mock ERP's own bounded PostgreSQL pool. Same-process duplicates share the running promise. Across services, `erp_confirmation_ledger.idempotency_key` is the primary key: both requests complete simulated processing without holding a database transaction or checked-out connection, `INSERT ... ON CONFLICT DO NOTHING` chooses the winner, and both then read the canonical row. The loser returns that row or raises an identity conflict if immutable fields differ. Only successes or codes accepted by `erpPermanentRejectionCodeSchema` are saved; capacity, outage and injected-error responses remain absent.

### Migration and isolated restart evidence

Added `packages/db/drizzle/0006_persist_mock_erp_ledger.sql`, `meta/0006_snapshot.json` and journal entry 6; `0000`–`0005` are unchanged. A one-off isolated `0005 -> 0006` upgrade retained a populated product row (`preservedRows: 1`) and created the ledger table. The Mock ERP integration suite uses the package-isolated `checkout_surge_test_mock_erp` database and real child processes of `apps/mock-erp/src/index.ts` on ephemeral loopback ports. Restart coverage accepts over HTTP, terminates the first process gracefully so its server and pool close, starts a fresh entry-point process over the same database, and verifies byte-identical lookup/replay. Lost-response coverage discards the first HTTP response body and recovers through lookup/replay. Pre-insert crash coverage waits until the request is logged inside configured latency, sends `SIGKILL`, then verifies a fresh process returns `unknown` and PostgreSQL has no terminal row.

### Cleanup ownership

Normal reset changes chaos controls only and never clears the ledger. Exact generated-run teardown deletes only ledger rows matching the run, and only after the existing inspection proves there is no nonterminal order, unresolved dispatch or intervention. Integration coverage verifies an unresolved dispatch keeps its ledger evidence and blocks deletion; settled generated-run evidence is removed while catalog (`run_id IS NULL`) evidence remains.

### Validation

- `pnpm exec biome check --write <24 task implementation files>` — clean; reviewer follow-up reran Biome on its 4 touched TypeScript files with no fixes required. Markdown, SQL, YAML and env files were reviewed directly.
- `pnpm type-check` — passed (11/11 workspace tasks plus test TypeScript).
- `pnpm test:unit` — passed after reviewer fixes: 7 environment-safety, 54 script and 1,378 workspace tests (1,439 total).
- `pnpm test:infra:up` — isolated PostgreSQL and Redis healthy.
- `pnpm test:db:migrate` — passed; isolated database rebuilt through `0006`.
- Populated incremental upgrade (`0005 -> 0006`, isolated DB) — passed with the existing row preserved and ledger table present.
- `pnpm test:api` — passed (50 files, 621 tests) during task implementation; not rerun for the reviewer follow-up because it changed no API or shared-contract files.
- `pnpm test:integration` — passed after reviewer fixes: DB 83, worker 71 and Mock ERP 4 tests (158 total).
- `pnpm test:composition` and `pnpm test:characterization` — not run, as explicitly prohibited for this task.

No locked decision or checklist boundary was changed. No temporary adapter or known implementation gap remains in task 03; worker lookup/reconciliation consumption stays with tasks 04–05.
