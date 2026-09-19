# 10 — Align finalization, retention and long-lived work

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 10 of 21. Execute after [09](09_wire_adaptive_runtime_and_restart_safety.md); adaptive processing and durable recovery are active.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 4, section 6.4, D01 and D13. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: API finalization/retention, worker publication/recovery, DB/Redis lifecycle helpers.

## Objective and fixed rules

Traffic completion closes new experiment traffic and begins draining; it does not settle accepted business work. Remove automatic failure after the old 300-second drain deadline. An accepted-estimate or occupancy overrun is a warning only, never a terminal transition.

Normal completion requires no `queued`/`processing` orders, no unresolved uncertain call, no open intervention, and one notification record per confirmed order. Orders keep `queued | processing | confirmed | failed`; runs keep `starting | active | draining | completed | failed`. Final reports are produced from actual settled evidence. Do not solve premature finalization by bypassing the terminal publication fence.

## Repository entry points

API services `demo-run-finalization-service.ts`, `demo-run-startup-reconciliation-service.ts`, `terminal-demo-run-{transition,writer}.ts`, `demo-run-snapshot-operations.ts`, `traffic-completion-service.ts`, `generated-run-{retention,teardown}-service.ts`, `run-history-service.ts`; worker `generated-run-publication-fence.ts`, `notification-{record-job-handler,recovery-scanner}.ts`, order recovery, and their persistence adapters. Inspect `packages/db/src/{demo-run-locks,demo-run-maintenance,redis-inventory-policy,redis-inventory,redis-stock-reservation}.ts` and finalization/publication tests.

## Implementation work

- [ ] Replace elapsed-drain terminalization with separate operational observations. Stop emitting `business_drain_timeout` for new runtime results. Until task 15 supplies accepted estimates, treat absent historical/newly transitional estimate metadata as unavailable, not an invented zero or a hidden 300-second default.
- [ ] Make finalization inspect durable obligations under the existing serialization/locking boundary, including uncertain calls, interventions, accepted-result recovery and required notification records. Preserve traffic outcome evidence separately from business settlement.
- [ ] Keep order/notification recovery and publication enabled throughout nonterminal draining. Serialize finalization with publication so a required notification cannot be fenced out between a stale count read and terminal write.
- [ ] Produce immutable final reports only at genuine settlement or the explicit administrative workflow implemented in task 11. Separate confirmed, business-rejected and administratively disposed totals; processing finished does not imply all confirmed.
- [ ] Exclude permanently ineligible terminal work before recovery batch limits, while retaining active/intervention obligations. Retention/teardown must not delete unresolved work or canonical evidence referenced by it.
- [ ] Audit request deadlines, recovery/publication leases, reservation visibility expiry, run-sale eligibility TTL, idempotency retention and cleanup together. Remove long-lived processing's dependency on the current seven-day admission-marker assumption.
- [ ] Missing/expired sale eligibility stays fail-closed for new buys. Recovering accepted work must never restore buying permission, reopen a sale, release stock or lose reservation attribution. Preserve retained expired holds; payment expiry and stock-release workflows remain out of scope.
- [ ] Preserve one-nonterminal-run admission even when a run is prolonged or intervention-required. No timer, cleanup policy or retry limit silently frees the slot.

## Runnable boundary and non-goals

Implement ordinary lifecycle and retention here; task 11 completes reset/intervention controls before the final public guarantee. Do not make historical reports mutable or rewrite the incident. Leave final removal of retired snapshot/form fields to task 12, but remove their lifecycle authority now. Do not add extra lifecycle statuses.

## Acceptance and validation

- [ ] Advancing an injected clock beyond 300 seconds, the accepted estimate, and the occupancy ceiling leaves unresolved work nonterminal and recoverable.
- [ ] Late confirmations receive all required notifications before finalization; immutable final counts match durable settled records.
- [ ] Finalization/publication races preserve the terminal fence and cannot suppress a required notification.
- [ ] Expired eligibility/hold timing never reopens buying or releases reserved stock; accepted processing survives the boundary.
- [ ] Cleanup rejects active/uncertain/intervention work, and recovery eligibility filtering prevents batch starvation.
- [ ] Run focused lifecycle/maintenance tests, `pnpm type-check`, `pnpm test:infra:up`, `pnpm test:api` and relevant `pnpm test:integration` cases. Use injected clocks instead of five-minute waits.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep orchestration in services and clients in composition roots; format/check touched supported files with Biome. Use Linux/Dev Container and isolated test resources. No composition/characterization or reference-runtime reset without explicit request. Preserve historic incident evidence and report actual/skipped checks.

## Completion handoff

Deliver truthful normal settlement and retention. Record settlement predicates, lock boundaries, expiry behavior and remaining reset integration points. Next: [11 — reset and intervention resume](11_implement_truthful_reset_and_intervention_resume.md).
