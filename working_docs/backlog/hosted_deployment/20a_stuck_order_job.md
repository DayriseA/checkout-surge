# 20a — Stuck Order Job and Slow Stops

**Design:** section 3 · **Depends on:** none

## Goal

An order job always finishes or gives up within a bounded time, and the worker and the web stop within their stop timeout.

## Context

- Task 20 was split into 20a, 20b and 20c on 2026-10-09, after a read-only investigation.
- **Incident** (15a Fly measurement, 2026-10-08). After an all-accepted run (750/s, stock 7,500, every order confirmed), one `orders:process` job stayed active.
  - `DELETE /admin/demo/runs/:runId` answered 409 `active_job` for 10 minutes.
  - At the idle stop, the worker and the web did not exit and were killed at the 30 s stop timeout (32.6 s instead of about 11 s, HD-52).
- **What the code says.**
  - The job's handler promise never settled inside a live worker. The worker keeps renewing the lock of an active job, so the stalled check never takes it back, and the recovery scanner leaves an order with an active delivery alone.
  - The worker's `close()` waits for every active job, without a deadline (`bullmq-order-process-consumer.ts`, `worker-runtime.ts`, `apps/worker/src/index.ts`). That one hung job explains both the 409 and the worker's slow stop.
- **Where it hangs, most likely first.**
  1. After the order is confirmed, in the notification publish. It goes through the publication fence: `client.reserve()`, then a blocking `pg_advisory_lock_shared` (`postgres-generated-run-publication-fence.ts`). No PostgreSQL statement or lock timeout exists anywhere (`packages/db/src/client.ts`). The worker's pool of 10 is shared by 10 order jobs, 5 notification jobs, 3 scanners and the fences.
  2. In BullMQ's own completion call to Redis. The worker's connection uses `maxRetriesPerRequest: null`, so a command can wait forever.
  3. Before confirmation, with the order confirmed by another delivery. Unlikely.
  - Ruled out: the circuit breaker and admission (they never wait), a hung ERP call (bounded by its abort timer), the rate limiter and the teardown's pause.
- **The web** probably has its own cause.
  - Next.js waits for open requests on SIGTERM, and an open dashboard SSE stream proxied by the web (`apps/web/src/app/dashboard/events/route.ts`) keeps one open. HD-20 does not count SSE as activity, so an open tab does not prevent the idle stop.
  - A healthcheck process left unreaped (the HD-52 mechanism) is the other candidate.

## Scope

- **Reproduce first, on a cloud VM** (owner decision, 2026-10-09), with temporary instrumentation:
  - about 20 all-accepted runs with `scripts/capacity-measurement.mjs` (750/s, stock 7,500, ERP 0 ms / 1000 TPS / concurrency 10, 10 s);
  - a per-job stage log that dumps jobs active for more than 60 s;
  - PostgreSQL `log_lock_waits` with `deadlock_timeout=1s`;
  - `pg_stat_activity` and the advisory locks in `pg_locks` sampled every 5 s.
  - When a job sticks: its stage, its Redis job and lock, and the timed stops of the worker and the web, with and without an open SSE client.
  - Fly only if it does not reproduce, with the owner's approval.
- **Fix** the step that hangs: bound it, for example with a lock or statement timeout for the worker or a deadline on `reserve()`, so the job fails and is retried or recovered instead of hanging.
- Give the worker's shutdown a deadline, after which it force-closes.
- The web: fix only if the SSE stream is confirmed as the cause; otherwise record it.

## Done When

- The hanging step is identified and bounded. A run's teardown no longer meets a never-ending job, and the worker stops within its stop timeout.
- The web's slow stop is explained, and fixed or accepted by the owner.

## Open Points

- None.

## Working Notes

_None yet._
