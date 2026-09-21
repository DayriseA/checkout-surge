# 19a — Fix recovery starvation when queue waiting outlives the publication lease

## Handoff

- Status: Implemented and verified on 2026-09-21 (see [Completion notes](#completion-notes-2026-09-21)); changes staged, not committed. It no longer blocks [task 19](19_complete_acceptance_matrix_and_runtime_verification.md) and acceptance-dependent work in task 20.
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

## Diagnosis (confirmed by code review)

A code review on 2026-09-21 confirmed every step below against the current sources; the Compose run was not repeated. Still establish the cause with a failing regression before implementing the fix:

1. `createOrderRecoveryScanner` finds eligible durable obligations and calls `claimForPublication` before enqueueing their deliveries.
2. `PostgresOrderRecoveryPersistence.findRecoverable` accepts expired `pending`/`enqueued` rows. `claimForPublication` increments the processing generation and attempts, assigns a fresh `recovery-<orderId>-<attempt>` publication owner/job ID, and starts another 30-second lease.
3. A previously published job may still be legitimately waiting behind the queue's native rate/concurrency limits when that lease expires. Its replacement does not remove the earlier waiting delivery.
4. `claimExecutionOwnership` requires the delivered generation and publication owner to match durable state. The superseded job is therefore acknowledged without ERP work. This fence is necessary, but repeated replacement can prevent every queued generation from reaching execution while current.
5. Re-publication can outpace consumption: 390 replacements per 30 seconds exceed a queue limited to about 10 deliveries/s, including stale deliveries. Initial uncertainty and availability deferral help create the backlog; the five unresolved accepted calls never reach lookup.

The sampled observations match this loop:

- Generations 19–20 at acceptance +600 seconds equal one re-claim per 30-second lease.
- All 210 confirmations stayed at generation 0: in that run, no scanner-published delivery ever executed useful work. The first five calls timed out (3000 ms latency against the 2000 ms initial deadline) and opened the availability circuit; while it was open, roughly 385 initial deliveries were deferred. The learned deadline then rose above the latency, the probe succeeded, and the remaining initial deliveries drained at about 1.67/s (concurrency 5, 3 seconds per call) until about +173 seconds. Only superseded recovery deliveries remained after that.
- `findRecoverable` orders unresolved calls first, but that priority only applies to the claim. BullMQ delivers in arrival order, so their deliveries were superseded like the others: zero lookups.

Root cause: `leaseExpiresAt` covers two different situations, "published and waiting in the queue" and "executing". Since task 17b made the native queue limits the pacing mechanism, waiting longer than a lease is legitimate, while the scanner still treats it as a lost publication. The delivery side already tolerates it: `claimExecutionOwnership` does not check lease expiry (see "renews an expired publication lease for its recovery delivery" in `postgres-processing-control.integration.test.ts`). Only the scanner's re-claim decision is wrong. Do not assume a longer timeout is the fix.

## Selected design

Before re-claiming an `enqueued` row whose lease expired and whose `publicationOwner` is set, the scanner asks the queue for the state of that exact job (`queue.getJobState(jobId)`, available in the installed BullMQ 5.79.1).

| Situation of the expired row | Scanner action |
| --- | --- |
| `publicationOwner` set, job state `waiting`, `active`, `delayed` or `prioritized` | Renew the lease with a conditional update on the same recovery key, generation and publication owner. No generation or attempt increment, no publication. |
| `publicationOwner` set, job state `unknown`, `completed` or `failed` | The publication is lost: claim and publish exactly as today. |
| `publicationOwner` null (executing or deferred) | Unchanged: claim and publish as today, so a dead execution owner is still replaced. |

Placement: a job-state read on the worker queue publisher adapter, a conditional lease renewal on `PostgresOrderRecoveryPersistence`, and the decision in `createOrderRecoveryScanner`. `findRecoverable` must expose the generation and publication owner the decision needs.

Why this satisfies the guardrails below:

- A crash between the durable claim and the queue publication leaves no job, so the row is re-claimed.
- A job delivered between the state read and the renewal has already cleared `publicationOwner`, so the conditional renewal matches nothing and changes nothing.
- An `active` job whose worker died is returned to waiting or failed by BullMQ's stalled-job handling, which leads back to one of the first two rows of the table.
- At most one live delivery exists per order, and the cost is about one Redis read per waiting order per lease period.
- Stale deliveries already queued when the fix is deployed remain harmless acknowledgements and are no longer produced.

Rejected alternatives:

- Removing the superseded job on re-claim: the replacement still joins the tail of the queue and waits longer than its lease, so starvation is unchanged.
- Re-adding the same job ID without reading its state: BullMQ ignores an add whose ID matches a retained `completed` or `failed` job, which would strand the order.
- A BullMQ priority for unresolved calls: not needed. Once starvation is fixed they reach lookup in arrival order, and the acceptance matrix only requires eventual reconciliation.

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
- Do not change job retention on the order-processing queue in this task. Failed jobs are read by `findFailedOrderJobs`, and generated-run cleanup already removes a run's `completed` and `failed` jobs (`apps/api/src/queue/bullmq-demo-queue-maintenance.ts`). The selected design stays safe if retention changes later: a removed job reads as `unknown` and is re-claimed.
- The separate normal-shutdown fix in `apps/mock-erp/src/server.ts` (`return503OnClosing: false`) and its regression should remain; they address an unrelated generic shutdown 503, not this starvation.

## Regression and runtime acceptance

- [x] Add a small real PostgreSQL/Redis/BullMQ regression in the default integration lane: a genuinely published delivery waits past publication-lease expiry under native queue constraints, scanner ticks continue, the waiting order keeps its processing generation and single queue job, and all finite accepted work eventually executes without runaway duplicate publication. Use the existing injected clock/lease seams where suitable; do not add production test knobs or a 15-minute default test.
- [x] Prove the opposite crash case still recovers: a claim without a successful publication cannot strand work. Retain stale-owner rejection, genuine execution-owner expiry/replacement and reset fencing. Reuse existing coverage and extend only missing reachable cases.
- [x] Cover an unresolved externally accepted confirmation joining this backlog: it reaches lookup/reconciliation without a second canonical external effect or duplicate notification.
- [x] Run the original Compose case below with no competing load or tests. Require 600 attempts, 600 reservations, 600 canonical results, 600 confirmed orders, 600 notifications, zero terminal order failures and zero outstanding/unresolved obligations at successful settlement, before automatic reset. Require actual initial uncertainty and eventual lookup, bounded publication pressure, no starvation and respected native limits. A reset, reduced workload or successful single-order test is not a pass.
- [x] Update task 19 with the fix, regression names, exact commands, actual counts/duration and any remaining failure. Distinguish successful settlement from estimator calibration; this task does not approve task 20 constants.

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

## Completion notes (2026-09-21)

**Fix.** The selected design was implemented as written, with no change to fencing, leases, deadlines, queue limits, retention or the estimator:

- `apps/worker/src/queue/bullmq-order-process-job-publisher.ts`: `isDeliveryPending(jobId)` reads `queue.getJobState` (pending = `waiting`, `active`, `delayed`, `prioritized`).
- `apps/worker/src/persistence/postgres-order-recovery-persistence.ts`: `renewPublicationLease` is one conditional update on recovery key, `enqueued` status, generation and publication owner; `findRecoverable` exposes the generation and publication owner.
- `apps/worker/src/application/order-recovery-scanner.ts`: the `OrderDeliveryStateReader` port and the decision at the top of the candidate loop; `apps/worker/src/index.ts` wires the publisher as the reader.
- `docs/architecture.md` and the `ORDER_RECOVERY_LEASE_MS` row of `docs/local_development.md` describe the renewal.

**Regressions.**

- `apps/worker/test/unit/order-recovery-scanner.test.ts`: "renews the lease without re-claiming while the publication still waits in the queue", "re-claims and republishes once the queued delivery is no longer pending", "re-claims an expired row without reading the queue state when no publication owner is set".
- `apps/worker/test/integration/postgres-processing-control.integration.test.ts`: "renews the publication lease only for the unchanged owner and generation".
- `apps/worker/test/integration/order-processing-workflow.test.ts` (real PostgreSQL/Redis/BullMQ): "keeps a recovery delivery waiting past its publication lease instead of republishing it" (three orders, running consumer under native global concurrency 1, scanner ticks while waiting and while draining; fails with `enqueued: 2` instead of `0` when the scanner decision is disabled), "re-claims a durable claim whose delivery never reached the queue", and "reaches lookup reconciliation when an unresolved call's recovery delivery waits past its lease" (real in-process mock ERP and PostgreSQL ledger: one ledger row, one POST, lookup GETs, one confirmation event, one notification publication).

**Default lanes** (turbo limited to `--concurrency=2`, lanes run one at a time to avoid memory exhaustion): Biome on touched files, `turbo run type-check` plus `pnpm type-check:test`, `pnpm test:unit` (worker 134 tests), `pnpm test:api` and `pnpm test:integration` (worker 113 tests) passed after the production change. After the later test-only edits, Biome, type-check, the full workflow test file (44 tests) and `pnpm test:integration` passed again; a final one-line test-clock bound was re-verified with the three new workflow tests only. Composition/characterization were not invoked.

**Compose runtime** (`checkout-surge-gpt-55`, rebuilt with the fix, exclusive use, reports under the ignored `.cache/task19a`). Single-run functional checks, not benchmarks:

| Scenario | Result |
| --- | --- |
| `stable-high-latency` (the failing workload, unchanged) | **passed**, settled in 429.954 s before any grace notice or reset: 600 reservations, 600 ledger results, 600 confirmed, 600 notifications, 0 outstanding, 0 unresolved, 0 terminal failures; 600 POSTs, 5 lookups, maximum 5 in flight, 0 capacity responses; five real 2000 ms timeouts then lookup reconciliation |
| `original-incident` | passed, 98.714 s, 888/888/888 |
| `finite-outage` | passed, 80.248 s, 200/200/200 |
| `original-incident-restart` | second run passed, 149.016 s, 888/888/888 with 3 externally accepted unresolved calls frozen before the kill. The first run met every verification assertion (888/888/888, 0 outstanding) but is recorded failed because exact-run teardown got HTTP 409 `active_job` three times; see follow-ups |
| `pnpm runtime:smoke` | passed, 32 buyers |

Nonterminal diagnostics of the `stable-high-latency` run at about acceptance +250 s (collected before settlement, as required): 306 confirmed and 294 processing, every outstanding control row at generation 1, 289 waiting plus 5 active queue jobs (exactly one per outstanding order), 0 failed jobs, and 0 "another owner holds the lease" acknowledgements in the worker log. The failed run had generations 19–20, 3417 waiting deliveries and 4030 such acknowledgements.

**Follow-ups, not part of this task.**

- Estimator: the admitted estimate was 420.6 s against 429.954 s actual (ratio 0.978), a slight underestimate for task 20 calibration. This task approves no constants.
- Harness cleanup race in `original-incident-restart`, assigned to [task 19b](19b_settle_orphaned_active_jobs_before_exact_run_teardown.md): the jobs that blocked teardown were initial deliveries (job ID = order ID) orphaned as `active` by the worker SIGKILL. BullMQ's stalled-job recovery released them about 100 s after the kill, a few seconds after the verifier's three teardown attempts. Their control rows had no publication owner, so the scanner path for them is unchanged by this fix. The completed run `090eb1a4-c225-4096-b9c3-a46bd0e54bcb` was left in the disposable runtime.
- (Closed within this task.) A rejected job-state read initially aborted the whole scanner pass; it is now logged and counted as a failed candidate, and the row is retried on the next tick.
