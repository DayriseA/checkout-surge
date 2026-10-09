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

_None yet._
