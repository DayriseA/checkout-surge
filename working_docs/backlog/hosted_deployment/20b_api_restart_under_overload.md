# 20b — API Restart Under Overload

**Design:** section 3 · **Depends on:** none

## Goal

The API restart seen beyond capacity is explained, then fixed or accepted by the owner.

## Context

- Split from task 20 on 2026-10-09, after a read-only investigation.
- **Incident** (15a Fly measurement, 2026-10-08, 23:47). During a constant-arrival run at 5,000 per second (capacity about 3,500), the API container restarted.
  - Its CPU fell from about 1.6 cores to about 0.01 for 8 s, with 10,003 connections open. Then its cgroup was recreated under restart policy `on-failure`.
  - 6,801 requests got `connection reset by peer`.
  - Log streaming started only at 23:54, so no log covers the moment. Fly keeps Machine events only since the last deploy, so the exit code is lost.
  - Neither 13a's 5,000/s run on Fly nor an 8,000/s run on a 4 vCPU cloud VM restarted the API.
  - Only admin runs beyond capacity reach it.
- **What the code says:**
  - no container memory limit, no Node heap flag;
  - file descriptors raised to about 1 million;
  - a SIGTERM exits 0, so it would not restart under `on-failure`;
  - no `uncaughtException` or `unhandledRejection` handler;
  - pino writes synchronously to stdout, and Fastify logs two lines per request.
- **Hypotheses, most likely first:**
  1. **The event loop blocked on a synchronous stdout write**, then the process died.
     - At about 3,650 requests/s, request logging writes about 7,000 lines/s. A slow log reader on Fly would block the process.
     - CPU near 0 while 10,003 sockets stay open means the process was alive but not running; an exited process would reset its sockets at once.
     - Docker's fast log reader would explain why the VM never reproduced it.
  2. **Cgroup memory throttling, then an OOM kill** (exit 137).
  3. **Unlikely or ruled out:**
    - a V8 heap OOM (it burns CPU first);
    - a plain crash (sockets close at once);
    - file descriptor exhaustion;
    - a healthcheck kill (HD-52, and SIGTERM exits 0).

## Scope

Owner decision, 2026-10-09: the cloud VM first, then Fly if needed.

- **Instrument first, temporarily:**
  - Node reports on fatal errors and uncaught exceptions, written to the volume;
  - an exit hook that writes the exit code to a file;
  - an event-loop delay monitor;
  - sampling of the API process's state (`wchan`, `stack`), the cgroup's `memory.events` and pressure files, and the accept backlog.
- **On a cloud VM:** constant arrival at 5,000/s, stock 1, 10,000 VUs, 10 s, about five times. Then the same with the API's stdout piped through a slow reader, and once with that reader paused for 15 s. Control: `LOG_LEVEL=warn`.
- **On Fly, if the VM does not settle it:** the same instrumentation and run, as an owner-run prompt (as for the 15c confirmation).
- **Then fix or accept.**
  - If the blocked write is confirmed, the cheap fix is to stop logging every request on Fly, or to raise the API's log level.
  - Accepting the restart means amending HD-51, whose consequence says overload does not harm the infrastructure.

## Done When

- The restart is explained, and fixed or accepted by the owner, with HD-51 consistent with the outcome.

## Open Points

- None.

## Working Notes

### Reproduction (2026-10-09, cloud VM, 31 overload runs at 5,000/s)

- **Hypothesis 1 is not supported.** pino's default destination (sonic-boom) writes asynchronously, so a slow or paused stdout reader only grows an in-memory backlog (about 15 MB). Hypothesis 2 is not supported either: no memory pressure.
- **The signature reproduces through the exit path.** On exit, sonic-boom flushes the backlog synchronously, retrying `EAGAIN` with a 100 ms `Atomics.wait`.
  - With a slow reader, an exit during overload left the process at about 0.02 CPU, in `futex_wait`, with about 10k sockets open, for 21 s. It then died with exit 1, was restarted under `on-failure`, and reset every open connection.
  - `strace` confirmed the write/wait loop.
  - With Docker's own log reader the linger was 3 s; at `LOG_LEVEL=warn`, 1.1 s.
- **The trigger** was an `unhandledRejection` `CONNECTION_DESTROYED` raised by `end({ timeout: 0 })` on the abort path (`packages/db/src/client.ts:92`). It happened once in 31 overload runs; the call site that leaves the promise unhandled was not found.
- **A SIGTERM during overload** also exited 1 after an unhandled `CONNECTION_DESTROYED` (one run).
- **Volume:** Fastify logs two info lines per request, about 50,000 lines for a run of 25,000 requests. They are collected by Fly's log stream or Docker's, and not stored by the project.

### Owner decisions (2026-10-09)

- **No Fly reproduction.**
- **Stop logging successful requests.** Warnings, errors and failed requests stay logged. This removes the backlog's source, and may give the API back some CPU.
- **Fix the real trigger:** find the query promise left unhandled on the abort path, so an aborted pool no longer crashes the API, including at a SIGTERM under overload.
- **Correct HD-51** so its consequence matches the outcome.
- Not reported upstream.

### Implementation (2026-10-10)

- **Request logging.** The API sets `disableRequestLogging` and an `onResponse` hook logs one line per failed response: warn for a 4xx, error for a 5xx. Not logged: 2xx/3xx, and 409, a business answer (sold out, idempotency conflict, run not accepting traffic, run or preset conflict) received at request rate by a load run. 202 and 429 follow the same rule (202 not logged, 429 logged at warn, low volume). Warnings and errors logged by the code are unchanged.
  - `replaceFastifyCorrelation` (`packages/logger/src/fastify.ts`) rebinds the request logger from the server logger, which dropped Fastify's per-request logging switch, so the buy route still logged "request completed". The rebound logger now keeps that switch (found by its symbol description, `fastify.disableRequestLogging`, Fastify 5.8.5).
  - Other Fastify services keep their per-request lines: worker health server, load orchestrator and gate are low volume. The mock ERP logs two lines per ERP call (bounded by the run's ERP TPS) and `scripts/runtime-acceptance.mjs` reads its "incoming request" lines; left as is, a candidate if its volume ever matters.
- **Unhandled promise: inside postgres.js 3.4.9**, not in the repo's call sites. Each new connection runs `fetchArrayTypes()` after authentication; the ReadyForQuery handler calls it as `return fetchArrayTypes()` from a synchronous parser callback and drops the promise (`node_modules/postgres/src/connection.js:562-564`, function at 768). If the connection is terminated during that fetch, as `end({ timeout: 0 })` does on an aborted pool (readiness deadline, operation deadline, SIGTERM), the type query rejects with `CONNECTION_DESTROYED` and nothing handles it. A fresh short-lived pool per readiness check or operation makes this window recur under overload.
  - Reproduced with a fake PostgreSQL server that authenticates then never answers: one unhandled `CONNECTION_DESTROYED` with `fetch_types` on, none with it off.
  - **First fix, reverted:** `fetch_types: false` in `createSqlClient`. On the cloud test it hit another postgres.js 3.4.9 bug: a `reserve()` that opens a fresh connection becomes that connection's `initial`, `connection.js:567` skips it and nulls `initial`, and `onopen` is never called (`connection.js:554-587`, `index.js:206-210, 410-411`). The reserve never resolves and the connection is stranded: 11 `test:api` hangs, `runtime:reset` timeouts, pool collapse in all-accepted runs at 750/s (p95 30 s), and `db.integration.test.ts:418` failing (a JS array bound as `::text[]` needs the fetched types). The earlier array search covered `src` only and missed that test.
  - **Owner decision (2026-10-10): accept the rare crash.** Type fetching stays on. Under overload the API answers 202/409, which are no longer logged per request, so normal overload builds no log backlog; a fault that makes every request fail is still logged per request. A rare restart remains possible when an aborted pool destroys a connection during the type fetch (seen once in 31 overload runs and once at a SIGTERM under overload), now without the long freeze. HD-51 says so.
  - The repo's own call sites on the abort path were traced and handle their rejections: readiness (`settleWithAbort`), pending-persistence attempts and discovery (awaited, transactions through postgres.js `begin`), dashboard recovery (`Promise.all`), `bindQueryToAbortSignal` (caught). Query cancellation promises reject only on a cancel-socket error, not with `CONNECTION_DESTROYED`.
- **HD-51** consequence corrected in place.
- Tests: a successful request and a sold-out 409 log nothing, a failed readiness (503) logs one error line (`apps/api/test/unit/request-logging.test.ts`). The abort test with a fake PostgreSQL server was removed with the reverted fix.

### Closure (2026-10-10)

- 20a, 20b and 20c were validated together. Cloud verification at `9e54d9cb`: the full suite passed (API 354, integration db 82, worker 103, mock-erp 7); `runtime:reset` passed; the worker stopped in 1.1 s mid-run, with 7,500 orders confirmed and notified and no duplicate; 3 overload runs at 5,000/s had no API restart and no per-request log line; the API stopped under overload in 2.7 s with exit 0. All-accepted runs at 750/s failed alike on the branch and on `dev` on that slower VM.
- Deployed at `b8ffc28c`. Live check by the owner: an admin run at 2,200/s for 10 s with stock 1,000 (the 15c confirmation run) completed, with 22,000 of 22,000 requests and p95 9.2 s, against 11.8 and 13.0 s before.
- Done.
