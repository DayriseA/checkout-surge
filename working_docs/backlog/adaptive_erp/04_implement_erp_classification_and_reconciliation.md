# 04 — Implement ERP classification and uncertainty reconciliation

## Handoff

- Status: Done (see Completion notes).
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

- [x] Return explicit capacity, recognized availability, uncertainty, known permanent rejection, intervention and success outcomes. Capacity is `429 erp_capacity_exceeded`; recognized `503` outage/injected-error responses and connection failures are availability; timeouts after dispatch retain uncertainty.
- [x] Treat `401`/`403` as scope intervention; malformed protocol, `409 erp_idempotency_conflict`, and local `ErpAttemptContradictionError` as affected-order intervention. Unknown response codes require intervention. Unknown `4xx` is not business rejection, and opaque `5xx` after dispatch does not prove absence of effect.
- [x] Keep recognized permanent-rejection handling restricted to the shared vocabulary. The current mock emits none; do not create a broad permanent-failure fallback. Technical exceptions must preserve dispatched-call evidence.
- [x] Implement lookup-first reconciliation of unresolved call intent. Adopt canonical `succeeded`/`rejected` results; `unknown` requests a same-key POST replay through the caller's dispatch-admission port. Keep lookup and replay as distinct operations, not an unbounded internal retry loop.
- [x] Bound lookup concurrency separately. Lookups obey availability circuit protection, but bypass launch-rate pacing and capacity cooldown. This permits useful reconciliation without allowing a dependency outage to trigger unlimited lookups.
- [x] Parse both `Retry-After` delay-seconds and HTTP-date forms using an injected clock. Invalid values use local backoff; values above the policy maximum produce capped cooldown and a log. Capture `x-erp-replayed` separately from canonical JSON.
- [x] Make the mock ERP emit `Retry-After` in delay-seconds form on its `429` capacity and recognized `503` responses (user decision, 2026-09-20: D06 assumes it, the current mock sends none). Deliver it in this slice with the worker parser and cover it through the real HTTP boundary. Lookup responses are unaffected.
- [x] Exclude local/lookup/replayed success from learning ERP health or latency. Preserve enough call-generation/timing metadata that later feedback cannot reverse a newer controller reduction. Distinguish dispatched actual calls, status lookups and non-call deferrals in diagnostics.
- [x] Preserve late canonical success after a local timeout, and accepted-result recovery after local persistence fails. A cancelled local request/expired lease is not proof of cancellation at the ERP.

## Runnable boundary and non-goals

Introduce the explicit client/reconciliation port with focused tests before task 05 switches all live scheduling paths. Keep the existing entry point runnable through a narrow, explicitly temporary adapter where required; record it for removal in task 05. Do not activate a second retry owner or make the client sleep/retry indefinitely. Adaptive pacing is tasks 07–09 and the bounded deadline calculator is task 08; use injected policy/deadline inputs here rather than new dashboard settings.

## Acceptance and validation

- [x] Table-driven tests cover recognized protocol outcomes, malformed bodies, identity contradictions, unknown codes, valid/invalid/oversized retry guidance, and replay headers.
- [x] Lost response -> lookup success converges without a new confirmation call; unknown -> admitted same-key replay converges without duplicate external effects.
- [x] Lookups are not starved by capacity cooldown, obey their own in-flight bound and availability circuit, and cannot become evidence that closes the circuit or raises the rate.
- [x] Late success and local persistence failure preserve recovery ownership; no branch turns a timeout into permanent business rejection.
- [x] Run focused worker unit tests, `pnpm test:unit`, `pnpm type-check`, and, for the real HTTP/DB boundary, `pnpm test:infra:up` followed by the affected integration lane.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep application policy out of route/persistence adapters and clients out of module globals. Format/check touched supported files with Biome. Use Linux/Dev Container execution and isolated resources; no unsolicited composition/characterization runs or reference-runtime reset. Report check results and deviations, obtaining explicit approval for changes to locked decisions.

## Completion handoff

Deliver the client/reconciliation boundary and protocol tests. Record outcome-to-disposition mapping, unresolved-call semantics, temporary adapter removal points and lookup/replay ports. Next: [05 — scheduling cutover](05_unify_worker_scheduling_and_queue_handoffs.md).

## Completion notes

### Outcome mapping

The HTTP client returns the shared dispositions directly: contract-valid `200` is `succeeded`; `429 erp_capacity_exceeded` is `capacity_rejected`; recognized `503 erp_forced_outage` / `erp_injected_error` and connection failure are `temporarily_unavailable`; an aborted dispatched POST is `uncertain_result`; only codes accepted by `erpPermanentRejectionCodeSchema` are `permanent_rejection`; `401`/`403` are scope intervention, while malformed/mismatched protocol, `409 erp_idempotency_conflict`, local attempt contradiction, unknown `4xx`, and opaque/unknown `5xx` are affected-order intervention. The temporary handler adapter retains every non-permanent outcome instead of converting delivery exhaustion into business failure.

Attempt persistence carries this validated disposition rather than re-deriving it from a raw error code. Canonical terminal results and validated capacity/availability responses resolve dispatched-call evidence; intervention and uncertainty retain `unresolvedErpCallId`, including a malformed response that happens to contain a recognized code. Connection loss and response-body transport failures retain the availability disposition for circuit/accounting purposes, but without a validated ERP response they leave `resolvedAt` null and preserve `unresolvedErpCallId` for lookup-first reconciliation. A timeout while reading a dispatched response body remains business uncertainty and also counts as an availability-circuit failure. Lookup recovery accepts only contract-valid recognized availability responses; malformed or unknown `5xx` lookup responses require affected-order intervention.

### Unresolved-call reconciliation and ports

`ErpUnresolvedCallReconciler` first adopts a worker-local success, then performs one bounded status lookup through the availability-circuit gate. Canonical lookup success/rejection is persisted as a lookup diagnostic and resolves the original task-02 call through `resolveDispatchedCall`. `unknown` invokes exactly one callback through the caller-owned `ErpReplayDispatchAdmission`; that callback dispatches the same business key and creates a fresh durable call identity. A per-order in-process guard prevents parallel catch-up, while task 02's durable generation remains the cross-process owner. Lookup admission is separate from replay admission, so lookup bypasses capacity cooldown and launch pacing without bypassing outage protection.

### Diagnostics, retry guidance, and recovery

Explicit results carry the durable call generation and dispatch timestamp plus operation timing. Attempt events identify `dispatched_confirmation` versus `status_lookup` and store the replay header separately from canonical response JSON; reconciler denials are `non_call_deferral`. Non-negative integer delay-seconds and strict IMF-fixdate `Retry-After` values use the injected clock and policy bounds; invalid values use injected fallback and oversized values are capped and logged. Mock `429` and recognized `503` responses emit `Retry-After: 1`. Local, lookup, and replayed success return `erpHealthLearningEligible: false`, so they cannot close the circuit; the same metadata is available to the later pacing/deadline controllers.

Late ledger success after timeout is adopted without a second POST. If the ledger is unknown, admitted same-key replay converges through ERP idempotency. Accepted-result persistence errors still carry the complete successful attempt record for durable recovery.

### Temporary adapter removal in task 05

`HttpErpOrderConfirmation.confirm`, `isTemporaryErpConfirmationError`, `shouldRetainOrderForErpOutcome`, and the existing handler's thrown-error wiring are explicitly temporary. Task 05 replaces them with direct disposition-driven durable defer/intervention scheduling, wires the reconciler before every new business attempt, persists scope interventions, and supplies the real dispatch-admission owner. The fixed fallback/max Retry-After policy values in the composition root are also replaced by the task 09 engine policy; no dashboard setting was added here.

### Validation

- `pnpm exec biome check --write <15 touched TypeScript files>`: passed; 15 files checked, no fixes applied.
- `pnpm type-check`: passed; 11/11 workspace tasks plus test TypeScript checking.
- Focused review unit command for the ERP client and circuit breaker: passed; 2 files, 34 tests.
- Focused worker integration command including the durable ownership regression: passed; 10 files, 74 tests.
- `pnpm test:unit`: passed; 1,461 tests.
- `pnpm test:infra:up`: passed; isolated PostgreSQL and Redis healthy.
- `pnpm test:integration`: passed; 17 files, 162 tests (DB 83, worker 74, mock ERP 5).
- `pnpm test:api`: passed; 50 files, 621 tests.
- `pnpm test:composition` and `pnpm test:characterization` were not run, as required.

### Transport-failure review follow-up

Availability resolves a dispatched call only when the client supplied its validated ERP response alongside the disposition. Transport errors keep availability accounting but retain reconciliation ownership. The existing intervention guard still prevents recognized raw codes in malformed/status-mismatched responses from resolving calls. No new client field, schema change, retry owner, or locked-decision deviation was needed.

Validation rerun for this surgical follow-up (all passed, zero failures):

- `pnpm exec biome check --write apps/worker/src/persistence/postgres-erp-attempt-persistence.ts apps/worker/test/integration/postgres-processing-control.integration.test.ts apps/worker/test/unit/erp-confirmation-client.test.ts working_docs/backlog/adaptive_erp/04_implement_erp_classification_and_reconciliation.md`: 3 TypeScript files checked; Markdown reviewed manually.
- `pnpm type-check`: 11/11 workspace tasks (10 cached), plus test TypeScript checking.
- `pnpm --filter worker test:unit erp-confirmation-client.test.ts postgres-erp-attempt-persistence.test.ts erp-reconciliation.test.ts erp-circuit-breaker.test.ts`: 4 files, 44 tests.
- `pnpm --filter worker test:integration postgres-processing-control.integration.test.ts`: 1 file, 25 tests, including connection loss, body-read failure, validated availability, and the earlier malformed-response regression.
- `pnpm test:unit`: 1,462 tests (7 environment-safety, 54 script, 1,401 workspace); 10/10 tasks, 9 cached.
- `pnpm test:integration`: 17 files, 165 tests (DB 83, worker 77, mock ERP 5); 6/6 tasks, 3 cached. Used the already-running isolated infrastructure.
- `git diff --check`: clean. No API changes in this follow-up, so the API lane was not rerun. No composition/characterization runs or reference-runtime reset.
