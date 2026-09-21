# 19a — Fix recovery starvation when queue waiting outlives the publication lease

## Handoff

- Status: Pending implementation; blocks completion of [task 19](19_complete_acceptance_matrix_and_runtime_verification.md) and acceptance-dependent work in task 20.
- Ownership: worker recovery scheduling, durable publication/execution ownership and BullMQ delivery. Keep application policy in the worker application layer and database/queue operations in their adapters.
- Objective: accepted finite work must keep making progress when a delivery waits longer than its publication lease, without weakening generation fencing, durable recovery or external idempotency.
- This task describes an observed application failure, not the intentionally unreachable Compose capacity-change experiment. No `/chaos` change or production injection mechanism is needed.

## Reproducible failure

Task 19 ran a stable accepted ERP snapshot in the disposable Compose runtime on 2026-09-21. The request was admitted with a conservative estimate of 420.6 seconds, below the 600-second ceiling.

| Input | Value |
| --- | --- |
| Traffic | `constant-arrival-rate`, 20 requests/s for 30 seconds, no start delay: 600 attempts |
| Inventory | 600 units, quantity 1 per checkout, reservation hold 15 minutes |
| ERP | Stable latency 3000 ms, declared capacity 10/s, error rate 0, forced outage false |
| Worker | Accepted order-processing concurrency 5; native declared-capacity queue limits |
| Initial ERP request deadline | Existing policy: 2000 ms |
| Recovery publication lease | Existing default: 30000 ms |

Observed before the automatic reset:

| Observation | Value |
| --- | ---: |
| Accepted reservations | 600 |
| Confirmed orders / notifications | 210 / 210 |
| Outstanding orders | 390 |
| Terminal order failures | 0 |
| Canonical ERP ledger results | 215 |
| Unresolved externally accepted calls | 5 |
| Actual confirmation POSTs / lookup GETs | 215 / 0 |
| Waiting BullMQ processing deliveries at one sample | 3417 |
| Logged acknowledgements saying another owner holds the lease at one sample | 4030 |

At acceptance +600 seconds, all 390 outstanding control rows were still `enqueued`, at processing generations 19–20, while the 210 resolved rows remained at generation 0. No useful ERP progress had occurred since approximately acceptance +173 seconds. These are sampled observations, not exact thresholds a regression test should hard-code.

The UI remained nonterminal beyond the former drain target and displayed its real grace notice after 600 seconds. The application automatically reset the run at 902.230 seconds, as designed. That purge is not a successful recovery. Five external results had remained unreconciled. The generated run was `02f5d3e3-dc6d-4f20-b76f-446ab4a6de37`; it has been cleaned up and is not a prerequisite for reproduction. Raw session logs/screenshots were intentionally removed at the user's request; the actionable facts are retained here.

## Working diagnosis to verify

Trace the following path and establish the cause with a failing regression before implementing the fix:

1. `createOrderRecoveryScanner` finds eligible durable obligations and calls `claimForPublication` before enqueueing their deliveries.
2. `PostgresOrderRecoveryPersistence.findRecoverable` accepts expired `pending`/`enqueued` rows. `claimForPublication` increments the processing generation and attempts, assigns a fresh `recovery-<orderId>-<attempt>` publication owner/job ID, and starts another 30-second lease.
3. A previously published job may still be legitimately waiting behind the queue's native rate/concurrency limits when that lease expires. Its replacement does not remove the earlier waiting delivery.
4. `claimExecutionOwnership` requires the delivered generation and publication owner to match durable state. The superseded job is therefore acknowledged without ERP work. This fence is necessary, but repeated replacement can prevent every queued generation from reaching execution while current.
5. Re-publication can outpace consumption: 390 replacements per 30 seconds exceed a queue limited to about 10 deliveries/s, including stale deliveries. Initial uncertainty and availability deferral help create the backlog; the five unresolved accepted calls never reach lookup.

The queue/control/log observations strongly implicate this feedback loop. Verify the full path, including unresolved-call priority and publication races; do not assume a longer timeout is the fix.

## Entry points

- `apps/worker/src/application/order-recovery-scanner.ts`: scanner, claim/enqueue handoff and publication failure handling.
- `apps/worker/src/persistence/postgres-order-recovery-persistence.ts`: eligibility, publication claim, lease/generation changes and durable deferral.
- `apps/worker/src/persistence/postgres-order-transition-persistence.ts`: `ensureProcessingOwnership` and `claimExecutionOwnership`.
- `apps/worker/src/application/order-process-job-handler.ts`: acknowledgement when execution ownership is not claimed.
- `apps/worker/src/queue/bullmq-order-process-consumer.ts` and `apps/worker/src/queue/`: delivery metadata, native limits and publisher adapters.
- `apps/worker/src/persistence/postgres-erp-attempt-persistence.ts`: unresolved intent and actual-call ownership.
- Existing tests: `apps/worker/test/integration/{postgres-processing-control.integration,order-recovery-boundary.integration,erp-attempt-recovery.integration,erp-run-snapshot-precedence.integration}.test.ts`, `order-processing-workflow.test.ts`, and `apps/worker/test/unit/order-recovery-scanner.test.ts`.
- Runtime reproducer: `scripts/runtime-acceptance.mjs`, scenario `stable-high-latency`, derived from the unchanged `latencyIncreaseFixture` in `packages/contracts/src/acceptance-fixtures.ts`.

## Implementation requirements and guardrails

- Distinguish legitimate queue waiting from lost publication/execution ownership using the existing durable control model and queue capabilities. Keep the solution at the owning boundary; do not add an orchestration service or a second schedule owner.
- Prevent repeated lease expiry from producing unbounded stale deliveries or perpetually superseding work before it executes. Preserve recovery when a process dies after a durable claim but before queue publication, when publication fails, and when an executing owner disappears.
- Preserve stale-generation fencing, one canonical ERP effect per intent, lookup reconciliation of uncertainty, one notification per confirmed order, and reset/terminal publication fences. Do not simply let stale jobs execute or indefinitely trust an `enqueued` row whose publication may never have happened.
- Preserve native declared-capacity rate/concurrency limits and Retry-After pauses. Do not raise queue capacity/concurrency, add learned-rate control, skip uncertainty, or disable the scanner to make this case pass.
- Do not increase leases/deadlines as a substitute for handling queue waits longer than a lease. Do not lower the 600-order reproduction or the existing 10,000-buyer target, extend automatic reset, or retune the estimator around this failure.
- Accepted snapshots still override global chaos controls. Leave `erp-run-snapshot-precedence.integration.test.ts` unchanged. No production injection flag/endpoint/mode or dynamic ERP profile.
- The separate normal-shutdown fix in `apps/mock-erp/src/server.ts` (`return503OnClosing: false`) and its regression should remain; they address an unrelated generic shutdown 503, not this starvation.

## Regression and runtime acceptance

- [ ] Add a small real PostgreSQL/Redis/BullMQ regression in the default integration lane: a genuinely published delivery waits past publication-lease expiry under native queue constraints, scanner ticks continue, and all finite accepted work eventually executes without runaway duplicate publication. Use the existing injected clock/lease seams where suitable; do not add production test knobs or a 15-minute default test.
- [ ] Prove the opposite crash case still recovers: a claim without a successful publication cannot strand work. Retain stale-owner rejection, genuine execution-owner expiry/replacement and reset fencing. Reuse existing coverage and extend only missing reachable cases.
- [ ] Cover an unresolved externally accepted confirmation joining this backlog: it reaches lookup/reconciliation without a second canonical external effect or duplicate notification.
- [ ] Run the original Compose case below with no competing load or tests. Require 600 attempts, 600 reservations, 600 canonical results, 600 confirmed orders, 600 notifications, zero terminal order failures and zero outstanding/unresolved obligations at successful settlement, before automatic reset. Require actual initial uncertainty and eventual lookup, bounded publication pressure, no starvation and respected native limits. A reset, reduced workload or successful single-order test is not a pass.
- [ ] Update task 19 with the fix, regression names, exact commands, actual counts/duration and any remaining failure. Distinguish successful settlement from estimator calibration; this task does not approve task 20 constants.

From the repository root, use an exclusively owned disposable runtime with its root environment loaded by the existing scripts. The host-side verifier requires Linux access to the Docker Compose bridge, Docker/Compose and built contracts. Deploy the changed worker before measuring:

```bash
pnpm build:shared
pnpm runtime:up
pnpm runtime:acceptance stable-high-latency .cache/task19a
```

Wait for the rebuilt services to become healthy before starting the verifier. The verifier starts a fresh admin-scoped run, retains exact targets and writes its report under the ignored `.cache` directory. It performs protected cleanup after recording the verdict. **Collect durable/queue/worker diagnostics while the run is still nonterminal, before 900 seconds:** the application's automatic reset destroys run rows, so post-reset zero counts cannot describe outstanding work. Record that distinction in the handoff. Do not reset foreign work or rely on the historical UUID.

Validation after implementation:

```bash
# First run the new focused regression and relevant existing ownership/recovery tests.
pnpm exec biome check --write <touched-supported-files>
pnpm type-check
pnpm test:infra:up
pnpm test
# Run these separately from test/build load, after deploying the fix:
pnpm runtime:acceptance stable-high-latency .cache/task19a
pnpm runtime:acceptance original-incident .cache/task19a
pnpm runtime:acceptance finite-outage .cache/task19a
pnpm runtime:acceptance original-incident-restart .cache/task19a
pnpm runtime:smoke
```

Do not invoke composition/characterization without an explicit request. Apply `AGENTS.md` and `docs/quality_checklists.md`; include a final boundary/self-review. Keep generated output out of the repository and retain a concise textual handoff, not a new screenshot/log archive.
