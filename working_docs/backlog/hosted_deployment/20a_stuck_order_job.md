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

### Reproduction (2026-10-09, cloud VM)

- **Reproduced** at run 10 of a 20-run series (750/s, stock 7,500): job `5748109d…` hung at `await client.reserve()` in the publication fence (`postgres-generated-run-publication-fence.ts:23`), before the advisory lock.
  - The order was already confirmed. The notification was recorded by the recovery scanner.
  - All 10 worker connections were idle, and no lock was waiting.
- **Cause: a bug in postgres.js 3.4.9** (the latest release). `reserve()` queues a placeholder. If a pool connection closes while it waits, `onclose` shifts the placeholder off the queue and never resolves it (`index.js:420-427`, shift at `:426`).
  - The trigger is `max_lifetime` recycling, which defaults to 30–60 min and is not set in the repo.
  - An isolated script hung 3 times out of 3. A `begin()` waiter resolved 4 times out of 4.
- **Stops** (`docker compose stop -t 60`):
  - worker with the hung job: 60.6 s, killed; idle worker: 0.5 s;
  - web with an open SSE client on its own `/dashboard/events`: 30–60 s, killed; without one: 0.5 s.
- The API also calls `reserve()` (`postgres-buy-persistence.ts`, `postgres-demo-reset-workflow-fence.ts`). Not reproduced there.

### Owner decisions (2026-10-09)

- **Turn off `max_lifetime`** recycling in `packages/db/src/client.ts`, which removes the trigger for the worker and the API alike. The core sleeps after 10 idle minutes, so its connections start fresh at each wake.
- **Two deadlines:**
  - on the fence publish, whose callers already tolerate a failed publish (the recovery scanner takes over);
  - on the worker's shutdown, which force-closes after it.
- **No rewrite of `reserve()`** in the worker or the API: the hot path stays as measured.
- **The web's slow stop with an open SSE tab is accepted.** An open tab does not keep the core awake (HD-20), and the only cost is up to 30 s at the stop.
- Not reported upstream.

### Implementation (2026-10-10)

- **`max_lifetime: null`** in `createSqlClient` (`packages/db/src/client.ts`), for every pool. In postgres.js 3.4.9, `null` (or `0`) makes the lifetime timer a no-op (`src/connection.js` `timer()`, typed `number | null`); an explicit key wins over the default (`src/index.js`).
- **Publish deadline: 15 s**, as a decorator on the worker's fence (`withPublicationDeadline`, wired in `apps/worker/src/index.ts`). About twice the API's longest observed exclusive hold (7 s). A timeout is a plain publication failure: the order handler logs it and the notification recovery scanner republishes; the dispatch and order recovery scanners count it as failed and retry. The fenced operation is not cancelled; deterministic job IDs make a late success harmless.
- **Shutdown deadline: 5 s** on the order consumer's `close()`: `pause()` waits for active jobs, then `close(true)` at the deadline (a second `close()` call returns the pending one in BullMQ 5.79, so the wait goes through `pause()`). It fits under the 10 s of Docker's default stop timeout and of the core databases' delayed stop; the Fly stop timeout is 30 s.
  - A cut job stays active until its lock expires, then BullMQ's stalled check moves it back to wait (same job ID), or fails it at the stall limit and the order recovery scanner re-claims the order after its lease. No duplicate: generation and publication-owner fencing, ERP reconciliation before replay, deterministic notification job IDs.
  - A job waiting on a slow ERP call (deadline up to 6 s) can be cut too; it is recovered the same way.
- Fix pass after review (2026-10-10): a rejected `pause()` counts as not drained, and `close(true)` is always called after the wait, so the final Redis close never waits on QUIT. The three scanners stop a batch once closing (`if (closed) break;`), so a stop no longer waits for the rest of a batch's publications.
- The notification consumer keeps its unbounded close: its jobs never use `reserve()`.
- The web's slow stop with an open SSE stream: no change (owner decision).
- Tests: a never-settling fence fails the publish at 15 s; a never-settling job does not hold `close()` past 5 s (BullMQ mocked at the module boundary, no Redis on this host). Integration tests not run.
