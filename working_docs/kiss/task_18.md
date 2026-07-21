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

- [ ] Admission is a bounded in-process, per-run owner with explicit acquire/release and shutdown cleanup.
- [ ] BullMQ concurrency remains the process-wide execution ceiling.
- [ ] Queued work, per-run backpressure, retry/backoff, and circuit breaker behavior remain covered.
- [ ] Redis lease keys, renewal loops, clients/configuration, docs, and mechanism tests are deleted.
- [ ] Runtime documentation states the single-worker-instance scope rather than implying replica coordination.

## Focused verification

Run `pnpm --filter worker test:unit`, focused worker admission/consumer integration tests via `pnpm --filter worker test:integration`, and worker type-check. Do not run composition or characterization suites.

## Working record

Pending — record local admission bounds, BullMQ concurrency relationship, removed Redis resources, shutdown evidence, commands run, and skipped checks.
