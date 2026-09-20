# 09 — Wire adaptive runtime admission and restart safety

## Handoff

- Status: Complete (2026-09-20).
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

- [x] Compose the policy and deadline services once per real quota scope, with a worker-wide in-flight cap. Scope keys are `run:<id>` and `catalog`; a missing accepted run snapshot creates an intervention on that job, never a catalog fallback.
- [x] Route all confirmation POST paths through claim -> admission -> durable dispatch intent -> HTTP -> classified feedback/settlement. Include replay and accepted-result recovery distinctions. No queue retry shortcut may bypass admission.
- [x] When denied, persist reason/due time using the single control record and release the worker slot/DB resources. Queue wake-ups and scanner publication remain bounded; duplicate/stale delivery has no side effect or permit consumption.
- [x] Persist safety changes atomically enough to prevent an acknowledged cooldown/open circuit from disappearing on supported restart. Restore persisted expiries and the scope-level intervention marker (`erp_scope_resilience_state`, added in task 05) before admitting fresh traffic. Lost cache data cannot falsely mean healthy or erase a PostgreSQL obligation.
- [x] At startup prioritize resolution of recorded dispatched calls, bounded by their lookup/availability rules; start ordinary learning conservatively. Do not let an unavailable scope block unrelated scopes or turn startup into an unbounded synchronous wait.
- [x] Feed only eligible real response observations into adaptation. A local/lookup/replayed success cannot close the circuit or undo a recent reduction. HTTP-date/delay-seconds retry guidance remains bounded.
- [x] Ensure shutdown/cancellation releases resource permits without erasing unresolved intent. No permit leak, double release, or open connection should survive a completed handler.
- [x] Expose bounded live controller state and progress counters for later API projections. Keep sensor failures explicit; do not invent a zero queue/rate value to mean unavailable.
- [x] Remove superseded concurrency-only dispatch shortcuts and temporary runtime adapters made obsolete by this cutover, including task 05's worker-internal deferral backoff (replaced by the engine policy), without deleting unrelated reservation-persistence behavior.

## Acceptance and validation

- [x] Real Redis/BullMQ tests show pacing, concurrency bounds, progress and no sleeping active jobs or rapid defer/requeue loop.
- [x] Supported concurrency variations preserve identical business totals under the same low-capacity ERP, without bypassing rate protection.
- [x] Worker restart during capacity cooldown/open circuit honors persisted timing and does not burst. Restart during an uncertain call reconciles before new dispatch and preserves one external effect.
- [x] Run/catalog isolation, missing snapshot intervention, shutdown races and local success reuse behave as specified.
- [x] Run focused worker tests and `pnpm type-check`; use `pnpm test:infra:up` followed by `pnpm test:integration` and relevant API/queue tests. Keep real workloads finite; use injected clocks for policy timing.

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check only touched supported files with Biome and construct infrastructure only in composition roots. Use Linux/Dev Container execution and isolated resources. No unsolicited composition/characterization or reference-runtime reset. Report checks and measured observations without claiming final D14 calibration.

## Completion handoff

Deliver the complete adaptive runtime slice. Record every POST entry path checked, persisted safety-state ownership, restart sequence, scope rules and test results. Next: [10 — lifecycle and retention](10_align_finalization_retention_and_long_lived_work.md).

## Completion notes

The production confirmation surface has one POST implementation, `HttpErpOrderConfirmation.dispatch`. Both callers were checked and are now owned by `ScheduledErpOrderConfirmation` / `ErpUnresolvedCallReconciler`: a first or later business attempt acquires adaptive confirmation admission before `dispatch`, and an `unknown` lookup acquires the same authority before its same-key replay. `dispatch` still records the actual-call intent before issuing HTTP. Local accepted-attempt reuse and canonical lookup adoption do not acquire a confirmation permit. A lookup uses the separate bounded lookup operation; if its outage probe returns `unknown`, that probe opportunity can continue directly to exactly one confirmation probe. Only a fresh non-replayed confirmation success teaches recovery.

`AdaptiveErpRuntimeAdmission` is composed once in the worker root and owns one bounded controller/deadline state map for the real `catalog` and `run:<id>` quota scopes plus the process-wide in-flight count. It resolves generated-run concurrency only from the accepted snapshot; missing/corrupt snapshots open the existing per-order intervention. Denials persist the controller's exact reason-derived waiting class and absolute due time on `order_recovery_jobs` and return without sleeping or consuming an ERP attempt. Its bounded live state reports controller/deadline snapshots and admitted/deferred/settled/released counters; a PostgreSQL safety-write failure returns an explicit unavailable sensor result rather than fabricated zero state.

PostgreSQL remains the safety authority. Migration `0009_high_franklin_richards` extends `erp_scope_resilience_state` with availability retry, circuit-open marker, and next-probe time while retaining cooldown, circuit expiry, and task-05 intervention fields; the migration conservatively upgrades earlier circuit rows. Every probe admission and classified response safety transition is persisted before the job can durably acknowledge its deferral. The per-order control row continues to own dispatch intent, next eligibility, and order intervention. Redis circuit snapshots were removed from worker authority; losing Redis cannot clear either PostgreSQL obligation. Learned rate/generation/window state and latency samples are not persisted.

Startup restores only PostgreSQL rows with an unexpired cooldown, availability retry, circuit/probe deadline, or intervention; historical healthy rows cannot consume or truncate the bounded restore set, and a first-seen scope is hydrated from PostgreSQL before admission. More active obligations than the controller can safely retain fail startup explicitly. The same restore seeds a per-scope gate from runnable dispatched-but-unresolved control records; per-order interventions retain their evidence but do not gate fresh scope traffic. `createWorkerRuntime.start()` then publishes one bounded recovery batch before starting consumers, but queue priority is not treated as a correctness mechanism: fresh confirmation POSTs remain blocked in each startup-seeded scope until reconciliation clears or parks its durable intents, while lookups/replays and unrelated scopes progress. Gated denials refresh from PostgreSQL at most once per short recheck interval, local-result adoption and intervention parking force a refresh, and generation ordering prevents an older overlapping read from restoring stale state. Gate deferrals carry the earliest durable reconciliation eligibility plus later controller safety deadlines; refresh failures retain a short recovery recheck, and scope interventions use a bounded 60-second recheck rather than a 100 ms loop. Gate refreshes can only retain or clear startup-seeded gates; ordinary live dispatch intents never reopen a scope gate. Newly uncertain calls retain per-order recovery and controller safety handling. Reconciliation-read failures remain explicit unavailable sensor errors until a successful refresh of that scope, independently of safety-write failures, and throttled denials retain the short recheck even after an earlier long eligibility read. Safety writes are serialized per scope and snapshot controller state at write time, so a delayed older save cannot erase a newer restriction or a later legitimate close. Controllers restart at the provisional initial rate/deadline and honor unexpired PostgreSQL timing. Shutdown drains BullMQ handlers, then idempotently releases any remaining adaptive permits without resolving dispatch intent.

Removed live shortcuts: `ProcessLocalOrderProcessAdmission`, consumer `admission` / `admissionDelayMs`, `RunScopedBackpressureOrderConfirmation`, the inert `ErpCircuitBreaker` wrappers, worker-local generation backoff, and hardcoded composition-root Retry-After constants. The client now receives Retry-After bounds from `adaptive-erp-admission-v1-provisional`. The legacy request-timeout fallback and legacy circuit environment fields remain intentionally for task 12 compatibility; task 09 passes the adaptive deadline on every production confirmation dispatch.

Measured finite production-boundary observation: the PostgreSQL/BullMQ fixture at worker concurrency 1 and 10 runs four competing catalog orders against an ERP that rejects starts closer than 650 ms or overlapping calls. Both variants confirm all four orders, observe at least one real classified 429, keep peak ERP in-flight at one, preserve at least 400 ms observed start spacing, and remain within 12 recovery publications and six scanner cycles. A delayed unresolved call gives gated fresh traffic its durable 60-second due time and produces zero early scanner publications. A fresh catalog job queued ahead of recovery makes no POST until the catalog's unresolved call is adopted by lookup; the observed external order is `GET` reconciliation then one fresh `POST`. A parked per-order intervention no longer gates its scope. A restarted persisted cooldown/open circuit makes zero POSTs before its deadline and one probe afterward. These are task-09 functional checks, not final D14 calibration. The earlier task-07 idle-window first-success additive step remains unchanged and is deferred to task 20 calibration rather than adding activity state here.

Validation completed:

- `pnpm exec biome check --write <touched supported files>`: passed; 22 existing supported files checked with no fixes required, followed by a clean focused pass after the last test edit.
- `pnpm type-check`: passed all workspace and test TypeScript checks.
- `pnpm test:unit`: passed environment safety (7), scripts (54), and all 10 package tasks; worker 15 files / 129 tests, DB 8 / 59, mock ERP 3 / 64, contracts 9 / 198, logger 2 / 8, load orchestrator 7 / 177, web 46 / 788. The pre-existing non-failing React `act(...)` warning remains in `web/test/browser-workflows.test.ts`.
- `pnpm test:infra:up`: isolated PostgreSQL and Redis healthy.
- `pnpm --filter @checkout-surge/db test:db:migrate`: passed; the isolated database rebuilt from all ten reviewed migrations.
- `pnpm test:integration`: passed all six workspace tasks; worker 10 files / 89 tests, including the production PostgreSQL/BullMQ capacity, restart-gate, delayed-publication, parked-intervention and persisted-timing regressions.
- `pnpm test:api`: passed 50 files / 621 tests.
- `pnpm test:composition` and `pnpm test:characterization` were not run, as prohibited.

The "original request still running at the ERP" recovery variant remains unreachable under the supported startup lease invariant; the existing real HTTP fixture covers timeout, late canonical completion, lease expiry, lookup-first recovery, and exactly one POST. No parallel catch-up request was added. Task 10 still owns finalization/retention, task 11 owns resume, task 12 owns legacy timeout/control removal, and task 16 owns public API projections.

### Surviving review findings follow-up (2026-09-20)

- Fixed healthy overlapping calls reopening the restart gate in the shared admission authority: only restore seeds scopes, and all settlement/denial refreshes can retain or clear those gates. This preserves startup query semantics without tracking live lease owners or changing persistence queries. Newly uncertain calls continue through existing per-order recovery and controller safety handling.
- Added a PostgreSQL workflow regression with injected time and controlled HTTP responses: calls A/B start 500 ms apart and each takes 1,500 ms; after A succeeds, B still has its durable intent and 30-second lease, but fresh C dispatches and confirms with zero admission deferrals.
- Retained reconciliation-read errors per scope independently of safety-write errors. Successful refreshes clear only that scope's read error; failed and throttled refreshes keep the gate closed with a short recheck, including after a previously observed long eligibility. Unit coverage checks denial and settlement refresh failures and both directions of independent read/write error recovery.
- Follow-up validation: Biome checked all three touched TypeScript files cleanly (Markdown paths supplied but unsupported by the configured formatter); type-check passed all 11 workspace tasks and test TypeScript checks. Unit suite passed 7 environment checks, 54 script tests, and 10 package tasks (9 cached): worker 130, DB 59, mock ERP 64, contracts 198, logger 8, load orchestrator 177, web 788. The cached web output retains the existing non-failing React act warning. Isolated PostgreSQL/Redis are healthy. Integration passed all six tasks (three cached): worker 10 files / 90 tests, DB 6 / 83, mock ERP 1 / 6. API passed 50 files / 621 tests (four tasks successful, three cached).
- No commits, staging, branch changes, or reverts. Tasks 10, 11, 12, and 16 remain out of scope; composition and characterization suites were not run.
