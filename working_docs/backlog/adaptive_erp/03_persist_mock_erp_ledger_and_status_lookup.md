# 03 — Persist the mock ERP ledger and expose status lookup

## Handoff

- Status: Pending.
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

- [ ] Persist idempotency key plus immutable order id, public order id, reservation id, sale offer id, run identity and quantity, with canonical terminal result. Enforce uniqueness on the business idempotency key and reject contradictions with `409 erp_idempotency_conflict` rather than returning another order's result.
- [ ] Preserve same-process duplicate promise sharing. For cross-process/concurrent first acceptance, let the unique insert determine the winner; the losing request reads and returns the winner's canonical row. Do not hold a transaction or connection over simulated latency.
- [ ] Preserve the exact canonical JSON result, including confirmation identity and recorded timing. A replay response indicates reuse through `x-erp-replayed: true`; do not add a replay flag to the JSON body or regenerate canonical timestamps.
- [ ] Expose `GET /confirmations/:idempotencyKey`: `succeeded` with canonical result, `rejected` with canonical permanent rejection, or `unknown`. `unknown` means no terminal record and can mean not received, still processing, or lost; it is never proof of no external effect.
- [ ] Keep lookup outside the mock TPS quota, chaos latency and injected-error mechanisms. Retain existing service access controls, contract validation and correlation handling. Routes delegate to application services.
- [ ] Keep ordinary confirmation capacity/outage behavior intact. The current mock has no permanent business-rejection emitter; do not reinterpret an arbitrary error as one or introduce a public chaos control. Ledger support uses only the shared explicit vocabulary.
- [ ] Include ledger tables in isolated setup and exact generated-run cleanup without permitting deletion of unresolved obligations. Preserve catalog records appropriately; never clear the entire ledger during a normal run reset.
- [ ] Update baseline SQL/metadata under the repository's pre-release policy and test setup. Do not migrate or erase historical reference data as an implementation shortcut.

## Non-goals

No distributed worker/ERP transaction, separate orchestration service, durable profile timeline, public lookup feed, payment compensation, or persisted running-promise state. Profiles are task 13. The ledger supplies evidence; worker scheduling and reconciliation remain tasks 04–05.

## Acceptance and validation

- [ ] Same-key retries and concurrent duplicates return exactly one canonical confirmation; different immutable identity conflicts deterministically.
- [ ] A mock process restart after acceptance returns the same canonical JSON/id through both lookup and replay.
- [ ] Lost response after terminal persistence is recoverable; crash before terminal insertion leaves `unknown` without fabricating rejection.
- [ ] Lookup works during configured capacity exhaustion/chaos and consumes no TPS; real transport failure remains possible and visible.
- [ ] Transient outcomes never occupy the terminal ledger, and cleanup cannot remove evidence referenced by unfinished work.
- [ ] Run focused mock/contract tests, `pnpm test:infra:up`, `pnpm test:db:migrate`, relevant PostgreSQL integration tests, `pnpm test:integration`, and `pnpm type-check`. Service-restart verification must use isolated processes/resources, not the user's active runtime.

Read [AGENTS](../../../AGENTS.md), [quality checklists](../../../docs/quality_checklists.md), and relevant local development/schema guidance. Format/check only touched supported files with Biome; execute through the documented Linux/Dev Container path. Do not run composition/characterization suites unless requested. All artifacts are English; report actual and skipped checks. Do not change D05's terminal-only design without explicit user approval.

## Completion handoff

Deliver the durable mock boundary and tests. Record lookup/replay contracts, uniqueness strategy, isolated restart procedure and cleanup ownership. Next: [04 — worker classification and reconciliation](04_implement_erp_classification_and_reconciliation.md).
