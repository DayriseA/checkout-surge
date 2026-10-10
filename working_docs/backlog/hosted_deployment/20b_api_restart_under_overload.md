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
