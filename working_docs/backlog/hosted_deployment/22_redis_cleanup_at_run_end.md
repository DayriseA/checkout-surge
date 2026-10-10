# 22 — Redis Cleanup at Run End

**Design:** section 3 · **Depends on:** none

## Goal

A finished run leaves no working state in Redis: its history lives in PostgreSQL only, and Redis holds only what a run in progress needs.

## Context

- Found during the 13d review (2026-10-10). On the live core: Redis at 10.8 MB, 3,763 keys, 2,701 completed `orders-process` jobs, an AOF of 37 MB, and the 3 GB volume 6 % used. That is about 3–4 MB per full public run.
- **What stays after a run, and why it is useless.** Run history reads PostgreSQL only: finalization copies the final inventory into a PostgreSQL `terminalInventorySnapshot` (`demo-run-finalization-service.ts`). Two kinds of Redis state outlive the run, and nothing removes them except a run teardown or the on-demand retention cleanup:
  - **Completed order jobs.** The order queue has no `removeOnComplete`, and its job id is the order id. That id deduplicates concurrent publishes while a job waits or runs, and nothing needs it after completion. The queue counts leave `completed` out, the scanners read only waiting, active or failed jobs, and a re-created job for a processed order is acknowledged without reprocessing.
  - **The run's inventory namespace** (`inventory:{offer}:*`: state, reservations, expirations, pending persistence, events, throughput, sold-out) and `demo-run:{runId}:dashboard-projection-revision`. None has a TTL.
- **Already self-cleaning:** idempotency keys (1,800 s), live metrics, the accepted metric-batch set and the reset fence (24 h), sale eligibility (7 days). Notification jobs keep the last 1,000.
- **Existing removal code:**
  - `generated-run-teardown-service.ts` deletes a run's queue jobs and Redis keys, plus its PostgreSQL rows;
  - `packages/db/src/redis-inventory.ts` deletes an inventory namespace;
  - `bullmq-demo-queue-maintenance.ts` finds a run's jobs by scanning every state and filtering on `data.runId`.
- **The only reader of completed jobs after a run** is the local calibration tool `scripts/runtime-acceptance.mjs` (see `docs/estimator_calibration.md`). Some worker integration tests also assert a job's `completed` state right after processing.

## Scope

- **When a run is finalized**, after its terminal summary is written to PostgreSQL, remove its working state from Redis:
  - its completed order jobs;
  - its inventory namespace and dashboard revision key.
- **Never touch another run's state.** Never pause the queues, which a run starting right after must not notice. Leave failed jobs alone, since the recovery scanner reads them. Leave keys that expire on their own.
- **A cleanup that fails** is logged. It must not fail the run or change its history; the retention cleanup remains the fallback.
- **The calibration tool** reads what it needs before the cleanup, or from PostgreSQL, and its doc says so.
- **Docs** where the Redis lifecycle is described (`docs/redis_inventory_hot_path.md`, `docs/architecture.md`) and the operations doc. A decision log entry only if it passes the inclusion test.
- **Tests at the boundaries:** finalization removes the run's jobs and keys, and keeps another run's; a failed cleanup leaves the run finalized.

## Out of Scope

- **The retention cleanup ("Cleanup runs").** It is the history retention policy (terminal runs older than 7 days, beyond the latest 15), and it stays on demand. Known and accepted (2026-10-10): it pauses both queues for each run it cleans, even while another run is active, so it should not be used during a run.
- `GET /inventory/:saleOfferId/status`, which reads inventory namespaces and is not used by the web.

## Done When

- After a run, Redis holds none of its jobs or inventory keys, and the history pages are unchanged.

## Open Points

- None.

## Working Notes

_None yet._
