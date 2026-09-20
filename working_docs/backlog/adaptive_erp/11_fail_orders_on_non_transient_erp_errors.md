# 11 — Fail orders on non-transient ERP errors

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 11 of 21. Execute after [10](10_align_finalization_retention_and_long_lived_work.md); classification, durable claims and settlement-based finalization are available.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phases 2 and 4, D01, D03, D04 and D07. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: worker classification/handler/admission/recovery, worker persistence adapters, shared lifecycle and ERP-outcome contracts, DB schema, finalization and teardown predicates.

## Objective and fixed rules

Only transient ERP conditions are retried: capacity, recognized unavailability, connection errors, timeouts and an opaque `5xx` after dispatch. Any other error terminally fails the affected order at once, as a real integration would, and the run carries on to normal completion. No order is parked for an operator.

The code built by tasks 04, 05, 09 and 10 instead opens an "intervention" on the order or on the whole downstream scope, never retries it, and refuses to complete the run while one is open. This task replaces that behavior and removes the intervention concept entirely.

Technical failure classes: `401`/`403`, a response body that fails the contract, `409 erp_idempotency_conflict`, a local `ErpAttemptContradictionError`, a missing accepted run snapshot, and any `4xx` outside the recognized vocabulary. The order becomes `failed` with category `technical` and a code naming the cause. An unknown `4xx` is still not a business rejection.

Before any terminal conclusion the worker still resolves an earlier uncertain call for the same order through lookup (D05); a canonical success found there wins.

## Repository entry points

`packages/contracts/src/{lifecycle,erp-outcomes,processing-control}.ts` and their tests; `packages/db/src/schema.ts` (`order_failure_category`, `order_waiting_reason`, `order_recovery_jobs.intervention_reason`, `erp_scope_resilience_state.intervention_*`) and `packages/db/test/unit/vocabulary-parity.test.ts`; `apps/worker/src/application/{erp-confirmation-client,erp-reconciliation,order-process-job-handler,order-process-admission,order-recovery-scanner,run-config}.ts`; `apps/worker/src/persistence/postgres-{order-recovery,order-transition,order-dispatch,erp-attempt,erp-scope-resilience}-persistence.ts`; `apps/api/src/services/{demo-run-finalization-service,demo-run-projections}.ts`; `packages/db/src/demo-run-maintenance.ts`; `packages/db/src/business-outcome-dashboard.ts`; the web run-result presentation in `apps/web/src/app/lib/presentation/`.

## Implementation work

- [ ] Add the `technical` order failure category with a closed code vocabulary covering the classes above, in contracts and the DB enum, through one incremental migration following the [index](index.md) guardrails.
- [ ] Map every former intervention disposition in the client/handler boundary to a terminal technical failure: persist the attempt, fail the order with its category and code in the existing terminal transition, resolve the control record, and emit the usual lifecycle event with correlation lineage. Do not retry and do not feed pacing or the availability circuit.
- [ ] Remove scope-level blocking: the `interventions` set and `scope_intervention` deferral in `order-process-admission.ts`, the scope marker persistence and restore, and the scope filters in dispatch and recovery selection. A `401` fails each order that meets it; it never stops a scope.
- [ ] Remove order-level intervention: the `intervention_required` waiting reason, `interventionReason` on the control record, `resumeFromIntervention`, the selection filters that skip intervention rows, and the `intervention_required` handler disposition.
- [ ] Drop the now-unused columns and enum value in the same migration: `order_recovery_jobs.intervention_reason`, `erp_scope_resilience_state.intervention_reason` and `intervention_opened_at`, and `intervention_required` from `order_waiting_reason`. Confirm no remaining reader with a repository search first.
- [ ] Remove the intervention conditions from the settlement predicate in the finalizer and from `hasOutstandingGeneratedRunWork`. A failed order of any category never blocks completion, retention or teardown.
- [ ] Report technically failed orders as their own total next to confirmed and business-rejected ones, in the business outcome summary, projections, history and the web run-result presentation. Keep persisted summaries readable.
- [ ] Update or delete the tests that encode the intervention behavior, at the boundary that owned it.

## Non-goals

No change to the transient classes, pacing, circuit, deadlines, lookup/replay or the mock ERP ledger. No operator queue, alerting or resume control. The destructive reset is task 12.

## Acceptance and validation

- [ ] A `401`, a malformed body, a `409 erp_idempotency_conflict`, an unknown `4xx` and a missing run snapshot each fail only the affected order, with category `technical` and the right code, after exactly one ERP call and no retry.
- [ ] Other orders of the same run and scope keep processing, and the run reaches normal completion with separate confirmed, business-rejected and technically failed totals.
- [ ] An order with an earlier uncertain call that the lookup reports as succeeded ends `confirmed` with one notification, not failed.
- [ ] Capacity, recognized `503`, connection errors, timeouts and opaque `5xx` still retain the order and recover automatically.
- [ ] No symbol, column, enum value or test named after intervention remains outside historical documentation; list any deliberate exception in the handoff.
- [ ] The migration upgrades an isolated populated database. Run focused contracts/worker/API/DB tests, `pnpm type-check`, `pnpm test:unit`, `pnpm test:infra:up`, `pnpm test:api` and the worker integration tests, using isolated resources.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep application policy out of route/persistence adapters and infrastructure in composition roots. Format/check touched supported files with Biome; use the documented Linux/Dev Container path. Do not run composition/characterization suites or reset the user's reference runtime. Report checks and obtain explicit approval before deviating from D01/D03.

## Completion handoff

Deliver the terminal technical-failure path, the removal of the intervention concept and the migration, with their tests. Record the final code vocabulary, the mapping from each response class to its disposition, and the removed symbols. Next: [12 — destructive admin reset](12_implement_destructive_admin_reset.md).
