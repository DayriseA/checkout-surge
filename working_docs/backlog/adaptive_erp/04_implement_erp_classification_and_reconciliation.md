# 04 — Implement ERP classification and uncertainty reconciliation

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 04 of 21. Execute after [03](03_persist_mock_erp_ledger_and_status_lookup.md); task 02 supplies durable call identities and task 03 supplies lookup/replay.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 2, D03–D05, D06 and D08. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: worker ERP client and a narrow worker application reconciliation boundary.

## Objective and fixed rules

Replace a generic retryable/nonretryable distinction with truthful protocol outcomes. An HTTP deadline bounds resources, not business validity. Every sent confirmation POST has its own durable call identity, while every replay keeps the same business idempotency key and immutable request identity.

A local record or authoritative lookup success settles the external outcome without a confirmation-call permit. An unknown lookup is not proof that a call failed: reconciliation may require an idempotent POST replay through normal admission. Before any terminal conclusion, resolve an earlier uncertain call for that order. Never dispatch parallel catch-up confirmations for one order.

## Repository entry points

`apps/worker/src/application/erp-confirmation-client.ts`, `erp-circuit-breaker.ts`, `order-process-job-handler.ts`, `run-config.ts`, `apps/worker/src/persistence/postgres-erp-attempt-persistence.ts`, `packages/contracts/src/erp.ts`, and worker tests `erp-confirmation-client.test.ts`, `postgres-erp-attempt-persistence.test.ts`, `erp-attempt-recovery.integration.test.ts`. Use task 02's persistence ports rather than reaching into mock tables.

## Implementation work

- [ ] Return explicit capacity, recognized availability, uncertainty, known permanent rejection, intervention and success outcomes. Capacity is `429 erp_capacity_exceeded`; recognized `503` outage/injected-error responses and connection failures are availability; timeouts after dispatch retain uncertainty.
- [ ] Treat `401`/`403` as scope intervention; malformed protocol, `409 erp_idempotency_conflict`, and local `ErpAttemptContradictionError` as affected-order intervention. Unknown response codes require intervention. Unknown `4xx` is not business rejection, and opaque `5xx` after dispatch does not prove absence of effect.
- [ ] Keep recognized permanent-rejection handling restricted to the shared vocabulary. The current mock emits none; do not create a broad permanent-failure fallback. Technical exceptions must preserve dispatched-call evidence.
- [ ] Implement lookup-first reconciliation of unresolved call intent. Adopt canonical `succeeded`/`rejected` results; `unknown` requests a same-key POST replay through the caller's dispatch-admission port. Keep lookup and replay as distinct operations, not an unbounded internal retry loop.
- [ ] Bound lookup concurrency separately. Lookups obey availability circuit protection, but bypass launch-rate pacing and capacity cooldown. This permits useful reconciliation without allowing a dependency outage to trigger unlimited lookups.
- [ ] Parse both `Retry-After` delay-seconds and HTTP-date forms using an injected clock. Invalid values use local backoff; values above the policy maximum produce capped cooldown and a log. Capture `x-erp-replayed` separately from canonical JSON.
- [ ] Make the mock ERP emit `Retry-After` in delay-seconds form on its `429` capacity and recognized `503` responses (user decision, 2026-09-20: D06 assumes it, the current mock sends none). Deliver it in this slice with the worker parser and cover it through the real HTTP boundary. Lookup responses are unaffected.
- [ ] Exclude local/lookup/replayed success from learning ERP health or latency. Preserve enough call-generation/timing metadata that later feedback cannot reverse a newer controller reduction. Distinguish dispatched actual calls, status lookups and non-call deferrals in diagnostics.
- [ ] Preserve late canonical success after a local timeout, and accepted-result recovery after local persistence fails. A cancelled local request/expired lease is not proof of cancellation at the ERP.

## Runnable boundary and non-goals

Introduce the explicit client/reconciliation port with focused tests before task 05 switches all live scheduling paths. Keep the existing entry point runnable through a narrow, explicitly temporary adapter where required; record it for removal in task 05. Do not activate a second retry owner or make the client sleep/retry indefinitely. Adaptive pacing is tasks 07–09 and the bounded deadline calculator is task 08; use injected policy/deadline inputs here rather than new dashboard settings.

## Acceptance and validation

- [ ] Table-driven tests cover recognized protocol outcomes, malformed bodies, identity contradictions, unknown codes, valid/invalid/oversized retry guidance, and replay headers.
- [ ] Lost response -> lookup success converges without a new confirmation call; unknown -> admitted same-key replay converges without duplicate external effects.
- [ ] Lookups are not starved by capacity cooldown, obey their own in-flight bound and availability circuit, and cannot become evidence that closes the circuit or raises the rate.
- [ ] Late success and local persistence failure preserve recovery ownership; no branch turns a timeout into permanent business rejection.
- [ ] Run focused worker unit tests, `pnpm test:unit`, `pnpm type-check`, and, for the real HTTP/DB boundary, `pnpm test:infra:up` followed by the affected integration lane.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep application policy out of route/persistence adapters and clients out of module globals. Format/check touched supported files with Biome. Use Linux/Dev Container execution and isolated resources; no unsolicited composition/characterization runs or reference-runtime reset. Report check results and deviations, obtaining explicit approval for changes to locked decisions.

## Completion handoff

Deliver the client/reconciliation boundary and protocol tests. Record outcome-to-disposition mapping, unresolved-call semantics, temporary adapter removal points and lookup/replay ports. Next: [05 — scheduling cutover](05_unify_worker_scheduling_and_queue_handoffs.md).
