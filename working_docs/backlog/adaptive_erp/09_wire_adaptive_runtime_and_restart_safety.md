# 09 — Wire adaptive runtime admission and restart safety

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 09 of 21. Execute after [08](08_implement_bounded_adaptive_request_deadlines.md); tasks 05–08 supply durable scheduling, policy and deadlines.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 3, D04–D08 and D14. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: worker application orchestration, persistence of safety state, BullMQ adapters and runtime composition.

## Objective and fixed rules

Activate one downstream admission authority for every capacity-consuming confirmation call, including first attempts, retries and idempotent replay. Local/lookup result adoption requires no POST permit. The only supported deployment has one worker process; per-scope gates do not claim distributed quota safety.

Durably retain dispatched-call intents, next eligibility, interventions, cooldown and circuit-open expiries. Do not persist learned rate, observation windows or latency samples. On restart, reconcile dispatched calls first and relearn from the conservative initial rate; honor unexpired safety state.

## Repository entry points

`apps/worker/src/runtime/worker-runtime.ts`, `apps/worker/src/{index,server}.ts`, application `order-process-job-handler.ts`, `order-process-admission.ts`, `order-recovery-scanner.ts`, `erp-circuit-breaker.ts`, `run-config.ts`, queue `bullmq-order-process-consumer.ts`, and their persistence adapters. Inspect `packages/db/src/redis-erp-resilience.ts` and DB safety-state primitives from task 02 so projections/cache are not confused with durable authority. Relevant tests include `bullmq-order-process-admission.test.ts`, `order-process-admission-boundary.test.ts`, `erp-run-snapshot-precedence.integration.test.ts` and worker runtime tests.

## Implementation work

- [ ] Compose the policy and deadline services once per real quota scope, with a worker-wide in-flight cap. Scope keys are `run:<id>` and `catalog`; a missing accepted run snapshot creates an intervention on that job, never a catalog fallback.
- [ ] Route all confirmation POST paths through claim -> admission -> durable dispatch intent -> HTTP -> classified feedback/settlement. Include replay and accepted-result recovery distinctions. No queue retry shortcut may bypass admission.
- [ ] When denied, persist reason/due time using the single control record and release the worker slot/DB resources. Queue wake-ups and scanner publication remain bounded; duplicate/stale delivery has no side effect or permit consumption.
- [ ] Persist safety changes atomically enough to prevent an acknowledged cooldown/open circuit from disappearing on supported restart. Restore persisted expiries before admitting fresh traffic. Lost cache data cannot falsely mean healthy or erase a PostgreSQL obligation.
- [ ] At startup prioritize resolution of recorded dispatched calls, bounded by their lookup/availability rules; start ordinary learning conservatively. Do not let an unavailable scope block unrelated scopes or turn startup into an unbounded synchronous wait.
- [ ] Feed only eligible real response observations into adaptation. A local/lookup/replayed success cannot close the circuit or undo a recent reduction. HTTP-date/delay-seconds retry guidance remains bounded.
- [ ] Ensure shutdown/cancellation releases resource permits without erasing unresolved intent. No permit leak, double release, or open connection should survive a completed handler.
- [ ] Expose bounded live controller state and progress counters for later API projections. Keep sensor failures explicit; do not invent a zero queue/rate value to mean unavailable.
- [ ] Remove superseded concurrency-only dispatch shortcuts and temporary runtime adapters made obsolete by this cutover, without deleting unrelated reservation-persistence behavior.

## Acceptance and validation

- [ ] Real Redis/BullMQ tests show pacing, concurrency bounds, progress and no sleeping active jobs or rapid defer/requeue loop.
- [ ] Supported concurrency variations preserve identical business totals under the same low-capacity ERP, without bypassing rate protection.
- [ ] Worker restart during capacity cooldown/open circuit honors persisted timing and does not burst. Restart during an uncertain call reconciles before new dispatch and preserves one external effect.
- [ ] Run/catalog isolation, missing snapshot intervention, shutdown races and local success reuse behave as specified.
- [ ] Run focused worker tests and `pnpm type-check`; use `pnpm test:infra:up` followed by `pnpm test:integration` and relevant API/queue tests. Keep real workloads finite; use injected clocks for policy timing.

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check only touched supported files with Biome and construct infrastructure only in composition roots. Use Linux/Dev Container execution and isolated resources. No unsolicited composition/characterization or reference-runtime reset. Report checks and measured observations without claiming final D14 calibration.

## Completion handoff

Deliver the complete adaptive runtime slice. Record every POST entry path checked, persisted safety-state ownership, restart sequence, scope rules and test results. Next: [10 — lifecycle and retention](10_align_finalization_retention_and_long_lived_work.md).
