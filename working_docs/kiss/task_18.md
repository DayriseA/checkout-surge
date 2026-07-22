# Task 18 — Use local worker admission for the single-runtime topology

## Execution context

Task 18 of 45, Phase 4, after the single-instance topology decision (task 10). Primary ownership is the worker admission application boundary; BullMQ remains the queue/concurrency infrastructure boundary and runtime composition supplies dependencies. Do not create Redis clients in handlers or move queue behavior into API routes.

## Why

Redis leases, renewal, and global coordination support replicas the accepted local reference runtime does not run. They introduce lease failure modes without improving the worker's required per-run backpressure.

## Required outcome

Replace Redis worker admission leases with bounded process-local per-run admission plus the BullMQ concurrency ceiling. Retain queue buffering, per-run backpressure, worker retry/backoff/circuit breaker, and shutdown release. Remove lease renewal/global coordination, Redis admission configuration, documentation, and tests. The result must explicitly make no multi-replica claim.

## Scope and concrete current paths

- `apps/worker/src/queue/redis-order-process-admission.ts`, consumer/runtime/index/config, and `application/order-process-admission.ts`.
- Worker admission/consumer unit and integration tests, especially Redis/BullMQ admission tests.
- `apps/worker/.env.example`, root/runtime docs, Compose/config references, and any DB Redis helper only used by this lease.

## Retained behavior and non-goals

Keep bounded in-process resource use for each run, queue buffering, BullMQ worker concurrency, retry/backoff/circuit breaking, and reliable release during shutdown. Do not claim cross-process fairness, distributed admission, or multi-replica guarantees. Do not change ERP idempotency or queue dispatch recovery.

## Acceptance

- [x] Admission is a bounded in-process, per-run owner with explicit acquire/release and shutdown cleanup.
- [x] BullMQ concurrency remains the process-wide execution ceiling.
- [x] Queued work, per-run backpressure, retry/backoff, and circuit breaker behavior remain covered.
- [x] Redis lease keys, renewal loops, clients/configuration, docs, and mechanism tests are deleted.
- [x] Runtime documentation states the single-worker-instance scope rather than implying replica coordination.

## Focused verification

Run `pnpm --filter worker test:unit`, focused worker admission/consumer integration tests via `pnpm --filter worker test:integration`, and worker type-check. Do not run composition or characterization suites.

## Working record

- Status: complete, awaiting review and commit.
- Completed scope: Replaced `RedisOrderProcessAdmission` with `ProcessLocalOrderProcessAdmission` at the existing worker application boundary. It resolves each run's frozen `orderProcessConcurrency`, tracks active permits by run ID, uses the configured worker concurrency for catalog work, rejects saturated acquisitions, deletes idle scope counters on release, and rejects new acquisitions after close. The number of active scope entries and permits is bounded by BullMQ's configured worker concurrency because admission occurs only inside a BullMQ handler. The existing BullMQ delayed-job path retains saturated jobs without consuming an attempt, and BullMQ's `ORDER_PROCESS_CONCURRENCY` remains the process-wide handler ceiling.
- Decisions: Kept admission construction in worker composition and queue behavior inside the BullMQ consumer. Kept the existing explicit acquire/release interface and renamed the held resource from a lease to a permit. Kept admission optional in the reusable consumer boundary to avoid adjacent Phase 5 ownership cleanup. Did not introduce a generic limiter framework, cross-process state, or a second concurrency configuration. This local owner intentionally provides no fairness or concurrency guarantee across worker processes; the accepted runtime has one worker instance.
- Removed resources: Deleted `apps/worker/src/queue/redis-order-process-admission.ts`, including the Redis sorted-set key namespace `checkout-surge:order-admission:*`, acquire/renew/release Lua scripts, random lease owners, expiry/renewal timers, and lease-operation logging. Deleted `apps/worker/test/integration/redis-order-process-admission.test.ts`, which pinned atomic cross-adapter ownership, expiry reclamation, owner-checked release, key cleanup, and renewal. No lease-specific worker environment variable existed; `REDIS_URL` remains required for BullMQ, dashboard publication, and circuit-breaker snapshots, while `ORDER_PROCESS_CONCURRENCY` remains the BullMQ ceiling. Updated the worker environment comment and runtime/architecture/repository documentation to remove Redis-backed admission claims.
- Retained evidence: Unit tests cover isolated per-run and catalog bounds, idempotent permit release, missing frozen snapshots, close racing an in-flight snapshot read, and post-close rejection. BullMQ integration tests cover delayed queue buffering without attempt consumption, mixed limits of eight and two beneath an aggregate concurrency of ten, and graceful shutdown waiting for a held handler before closing admission. The full worker integration lane also retains retry/backoff, circuit-breaker deferral, persistence, dispatch, and recovery coverage.
- Verification: `pnpm --filter worker test:unit` passed (14 files, 93 tests). The first `pnpm --filter worker test:integration` attempt failed because the dedicated services were not running (`ECONNREFUSED` at Redis `localhost:6380` and PostgreSQL `localhost:56432`); `pnpm test:infra:up` started and health-checked only `docker-compose.test.yml`'s isolated services, after which `pnpm --filter worker test:integration` passed (7 files, 44 tests). `pnpm test:infra:down` then stopped those services and removed only their dedicated test volumes/network. `pnpm --filter worker type-check` passed. `pnpm --filter worker lint` passed (55 files). `pnpm exec biome check --write apps/worker/src/index.ts apps/worker/src/application/order-process-admission.ts apps/worker/src/queue/bullmq-order-process-consumer.ts apps/worker/test/integration/bullmq-order-process-admission.test.ts apps/worker/test/unit/order-process-admission-boundary.test.ts` formatted the touched TypeScript files. `pnpm exec biome check README.md apps/worker/.env.example apps/worker/src/application/order-process-admission.ts apps/worker/src/index.ts apps/worker/src/queue/bullmq-order-process-consumer.ts apps/worker/test/integration/bullmq-order-process-admission.test.ts apps/worker/test/unit/order-process-admission-boundary.test.ts docs/architecture.md docs/local_development.md docs/repository_layout.md docs/runtime_topology.md` passed for every supported file. `git diff --check` passed.
- Skipped checks: Per repository instruction, `pnpm test:composition` and `pnpm test:characterization` were not run. No broader Phase 5/6 suites or hosted/multi-replica checks were run because those behaviors are outside this task and the accepted topology.
