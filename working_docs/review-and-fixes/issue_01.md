# Issue 01 — Generated purchase bursts can deadlock the API database pool

## Classification

- Priority: P0
- Status: Fix implemented and regression-tested; reference-runtime revalidation pending
- Affected path: Public curated runs, accepted `/buy` requests, order publication, API readiness
- Audit run: `598023fd-b68b-46c2-bf24-d13d0096a39f` (Preview 1k)

## Resolution status (2026-07-18)

The circular-wait dependency graph has been removed in code:

- Generated buys now resolve the immutable PostgreSQL-backed run retry policy before acquiring run admission and carry that validated policy into BullMQ publication.
- The API BullMQ publisher no longer performs a PostgreSQL lookup. A run-attributed job must receive its frozen retry policy explicitly.
- Ordinary generated buys use a shared session advisory lock. Terminal and reset transitions retain the corresponding exclusive advisory lock, so accepted persistence and deterministic enqueue can proceed concurrently without weakening the maintenance fence.
- Durable reservation/order/event writes and deterministic BullMQ enqueue remain inside admission. They use the already reserved PostgreSQL session; code inside admission must not check out another connection from the bounded base pool.
- Inventory-projection Redis promotion, reversal, and pending-marker repair now occur after admission is released. The Redis-backed BullMQ enqueue intentionally remains inside admission so reset cannot cross an admitted job handoff.
- A missing durable run discovered during pre-admission policy resolution is still treated as a definitive rejection and reverses the Redis hold. Database or snapshot-parsing failures remain retryable and do not incorrectly restore stock.
- `PendingPersistenceReconciler` follows the same policy-resolution, admission, enqueue, and post-admission Redis ordering as the request path.

Coverage added or updated:

- `apps/api/test/generated-buy-pool-admission.test.ts` composes one PostgreSQL pool of size four, the PostgreSQL retry-policy resolver, real shared admission, Redis inventory, and BullMQ. Four simultaneous accepted buys must reach enqueue together and finish within a hard deadline.
- The regression verifies the frozen retry options, durable reservations/orders/events, zero pending-persistence state, zero remaining advisory locks, and a bounded same-pool readiness query while all four admission sessions occupy the pool.
- Service tests cover policy resolution before admission, missing-run reversal, retryable resolver failures, post-admission inventory Redis work, replay, and reconciliation.
- `runtime:smoke:load` retains the existing steady scenario and adds a second bounded `public-custom` buyer spike with 32 buyers and stock 32. It requires exactly 32 durable accepted reservations and performs exact-run cleanup after each scenario.
- The affected architecture, inventory hot-path, runtime-topology, and local-development documentation now describes shared admission, exclusive maintenance, the no-nested-checkout invariant, and both smoke scenarios.

Verification completed:

- Full API suite: 34 files, 432 tests passed before the review corrections; the corrected service and bounded-pool tests passed again afterward.
- Focused corrected service/reconciler/regression suites: 48 tests passed; the final bounded-pool regression passed independently.
- Script suite: 57 tests passed, including 14 runtime-load-smoke tests.
- API type-check, all 11 production Turbo type-check tasks, repository lint, targeted Biome checks, and `git diff --check` passed.

Verification still pending:

- `pnpm runtime:smoke:load` and a live default Preview 1k run have not been executed against the rebuilt reference runtime. Two `pnpm runtime:up` attempts failed before service creation because Docker BuildKit timed out connecting to `/var/run/docker/containerd/containerd.sock`. Lightweight PostgreSQL and Redis test containers remained available, so the production-shaped integration regression did run.
- Consequently, live HTTP readiness and dashboard-recovery latency during the burst, and coherent terminal completion of Preview 1k without a restart, still require reference-runtime confirmation.
- Root `pnpm type-check` completed all production package checks but its final repository test-source phase remains blocked by pre-existing Drizzle `PgEnum` generic incompatibilities in `packages/db/test/unit/vocabulary-parity.test.ts`; no Issue 01 file was implicated.

This fix deliberately does not increase the pool size, tune curated preset timing, introduce a new queue architecture, or address unrelated request-cancellation/timeout work. Preset timing should be reconsidered only after the pending live Preview revalidation.

## Original incident

Starting the default Preview 1k demo sent all 1,000 generated purchase attempts to the API, but the run stopped making progress:

- 750 requests returned `409 sold_out`.
- 250 requests entered the accepted-inventory path and never returned.
- Redis contained 250 accepted holds/pending-persistence records.
- The API stopped answering readiness and dashboard recovery requests.
- The orchestrator could not report completion while the API was wedged.

The run only progressed after the API process was restarted, which released its PostgreSQL sessions and advisory locks. Recovery then processed part of the backlog, but the run ultimately failed with `business_drain_timeout` and only 201 reservations/orders had been persisted and confirmed.

This makes a default, prominently exposed happy path unusable and can take the whole API out of service, so it is a release-blocking defect.

## Original reproduction

1. Start the reference runtime with its normal Compose configuration and PostgreSQL pool size.
2. Open the public home page.
3. Start the default Preview 1k curated run.
4. Observe that the sold-out responses complete while accepted requests stop completing.
5. Inspect `pg_stat_activity` and `pg_locks` while the run is stuck.

In the audited run, one API session held the run admission advisory lock while nine other API sessions waited for that same lock. These ten sessions occupied the full API pool.

## Original cause

At the audited revision, the accepted-buy path created a circular wait across a session advisory lock and the shared PostgreSQL pool:

1. `PostgresBuyPersistence.withRunAdmissionLock` checks out a pool connection and acquires an exclusive session advisory lock for the run.
2. The connection is deliberately retained through durable persistence and job publication (`apps/api/src/services/postgres-buy-persistence.ts`).
3. Other accepted requests each check out another connection before waiting for the same advisory lock.
4. With the configured pool maximum of 10, the lock holder plus nine lock waiters consume every base-pool connection (`docker-compose.yml`, `apps/api/src/index.ts`).
5. After committing the reservation/order, the lock holder invokes the BullMQ publisher from inside the locked callback (`apps/api/src/services/reserve-order-service.ts`).
6. The publisher resolves the run retry policy before adding the job (`apps/api/src/queue/bullmq-order-process-job-publisher.ts`).
7. `PostgresRunRetryPolicyResolver` attempts to check out another connection from the same exhausted pool (`apps/api/src/queue/postgres-run-retry-policy-resolver.ts`).

The lock holder cannot finish until it obtains a pool connection, no waiter can release a connection until the holder releases the advisory lock, and the pool has no free connection. Increasing the pool size merely moves the concurrency threshold and does not remove the cycle.

The production composition combines two individually reasonable behaviors:

- the admission lock was extended through enqueue to protect the reset/admission boundary; and
- job publication gained a PostgreSQL-backed retry-policy lookup.

The relevant tests isolate those components: the admission-lock test publisher uses a separate database connection, while the publisher integration test uses an in-memory retry-policy resolver. Neither test exercises the combined production dependency graph with one bounded shared pool.

## Why the previous smoke coverage did not catch it

At audit time, `runtime:smoke:load` used a steady custom run at roughly two requests per second, stock 32, and at most four virtual users. A small live custom run with stock 5 also completed successfully during this audit.

The public curated presets create an immediate accepted-request burst larger than the pool: Preview accepts up to 250, Surge 5k up to 750, Surge 10k up to 1,000, and the idempotency scenario up to 200. The smoke path therefore validates low-concurrency behavior but not the default public narrative.

## Original remediation plan

1. Establish and enforce this invariant: code holding a run admission session lock must never perform a nested checkout from the same bounded base pool.
2. Resolve and validate the immutable run retry policy before acquiring the admission lock, carry it into publication, or make the lookup use an already reserved session. Choose the smallest design that preserves the frozen-policy guarantee.
3. Audit every operation inside `withRunAdmissionLock` for hidden database, Redis, or queue dependencies that can block while waiters retain base-pool connections.
4. Reconsider whether ordinary accepted requests require mutually exclusive serialization for the entire persistence-and-publication sequence. Preserve the exclusive reset/terminal fence and commit-before-enqueue guarantee, but allow the concurrency the demo is intended to demonstrate if shared-admission/exclusive-maintenance locking can do so safely.
5. Add an integration test wired like production: one bounded PostgreSQL pool, the PostgreSQL retry-policy resolver, real admission locking, and at least as many simultaneous accepted requests as pool connections.
6. Add a bounded burst check to the reference-runtime smoke suite using a curated-like accepted load. Do not replace the existing steady smoke; it covers a different behavior.
7. Re-evaluate the curated preset timing only after this deadlock is fixed. The current run's duration shortfall is explained by the deadlock and is not evidence for a separate preset-tuning issue.

## Acceptance criteria

- [x] With a pool of `N` connections, at least `N` simultaneous accepted generated buys all terminate without a circular wait. Verified with `N = 4` and hard admission/burst deadlines.
- [x] Reservations and orders are durably committed before their BullMQ jobs become observable. Preserved by the admission-scoped persistence/enqueue workflow and its reset-boundary coverage.
- [x] The configured, frozen run retry policy is still used for every job. Verified in publisher/service tests and against the jobs stored by the bounded-pool integration test.
- [x] Redis holds progress to durable reservations/orders and then to final inventory outcomes; no advisory lock or pending-persistence record remains after a successful run. Verified by the bounded-pool integration test.
- [ ] API readiness and dashboard recovery return within their bounded service-level time during the burst. A same-pool readiness query is bounded in the regression, and the updated smoke polls dashboard recovery, but live HTTP/runtime confirmation is still pending.
- [ ] The default Preview 1k run reaches a coherent terminal state without restarting a service. The rebuilt reference runtime could not be started because of the Docker BuildKit/containerd timeout described above.
- [x] A regression test fails under the audited lock/pool dependency graph and passes with the corrected graph. The test's shared-admission barrier and hard deadlines encode the former exclusive-lock/nested-checkout failure modes; the corrected production-shaped graph passes.

## Scope guard

This issue is about restoring the core concurrent checkout demonstration. It does not call for a new queueing architecture or additional product features.
