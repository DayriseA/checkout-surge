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

Revised by the owner decision of 2026-10-10 (option A+, see Working Notes).

- **When a run is finalized**, after its terminal summary is written to PostgreSQL, remove its completed order jobs, found from the run's order ids in PostgreSQL: check each job's state and remove completed ones only.
- **When a new run is admitted**, remove the inventory namespace and dashboard revision key of earlier runs that are terminal and finalized: never the new run's, never a run still draining or with a hold awaiting persistence, never an unfinished reset.
- **Never touch another run's state.** Never pause the queues, which a run starting right after must not notice. Leave failed jobs alone, since the recovery scanner reads them. Leave keys that expire on their own (idempotency, sale eligibility, metrics, reset fence).
- **A cleanup that fails** is logged. It must not fail the run, change its history, or block the start; the retention cleanup remains the fallback.
- **`failRun` runs** get no finalization cleanup; their namespaces go at a later start once no hold is pending.
- **The dashboard** treats a retired scope (the revision script refusing with `scope_retired`) as final: the publication scheduler drops it with one info line, and a recovery read with a retired known run answers with the current projection.
- **The calibration tool** reads its timings from PostgreSQL, and its doc says so.
- **Docs** where the Redis lifecycle is described (`docs/redis_inventory_hot_path.md`, `docs/architecture.md`) and the operations doc. A decision log entry only if it passes the inclusion test.
- **Tests at the boundaries:** finalization removes only the run's completed jobs; a new start removes earlier terminal runs' namespaces but not those still needed; failures fail neither the run nor the start; a retired scope is dropped once while another error is retried.

## Out of Scope

- **The retention cleanup ("Cleanup runs").** It is the history retention policy (terminal runs older than 7 days, beyond the latest 15), and it stays on demand. Known and accepted (2026-10-10): it pauses both queues for each run it cleans, even while another run is active, so it should not be used during a run.
- `GET /inventory/:saleOfferId/status`, which reads inventory namespaces and is not used by the web.

## Done When

- After a run, Redis holds none of its completed jobs; once the next run starts, none of its inventory keys; and the history pages and the finished run's live result are unchanged.

## Open Points

- None.

## Working Notes

- **Why the original Scope changed (2026-10-10).** Removing the inventory namespace and revision key at finalization breaks the live dashboard. Finalization publishes a scoped dirty signal and the API builds the terminal projection asynchronously; that build reads the inventory from Redis and allocates its revision through a script that refuses (`scope_retired`) once the inventory state is gone. The Watch page's run result is that projection. A build after the cleanup would never publish the result, the publication scheduler would retry the retired scope every second forever, and a tab recovering a missed terminal with `knownRunId` would get an error.
- **Options weighed.**
  - A: completed jobs only at finalization; inventory and revision left to a later point.
  - B: everything at finalization, with an idle fallback for retired scopes; viewers who miss the build race lose the result.
  - C: rebuild terminal projections from PostgreSQL; the snapshot lacks fields and the revision needs a new source, so a larger change.
- **Decision: A+.** Jobs at finalization; inventory namespaces and revision keys at the next run's admission, when no earlier projection is displayed; retired scopes handled as final by the dashboard.
- **Jobs.** The order job id is the order id, and the worker names recovery publications `recovery-<orderId>-<attempt>`, so the ids come from `orders` joined to `order_recovery_jobs.attempts`. Each id costs a state check plus, when completed, a removal, in concurrent batches of 100: about 2,000 to 15,000 cheap Redis calls at 1,000 to 7,500 orders, with no job data transferred, against the existing scan's read of every job in every state with its data. Removal is added to the BullMQ maintenance adapter, reusing its order queue, without `cleanRuns`, which pauses the queues.
- **Start path.** Runs under the maintenance authority, after the new run is admitted and before inventory initialization. Candidates are terminal runs with a sale offer, except an unfinished admin reset. Each is skipped while its pending-persistence set is not empty, which covers `failRun` runs with a hold left for recovery; the check is one `ZCARD`, so they are cleaned at a later start once recovery drains. The fixed inventory keys are removed by name after the existing retire script, leaving idempotency children to expire; the teardown helper reuses the same steps and still scans for the rest.
- **Retired scopes.** The revision allocator now throws a typed `DashboardProjectionScopeRetiredError`. Before, the scheduler re-queued a failed scope every second with an error log, indefinitely; this already happened after an admin reset whose build ran after its Redis deletion. A recovery with a retired `knownRunId` answered HTTP 500; it now answers the current projection, which the browser accepts as an authoritative idle read while keeping the retained result.
- **Calibration.** Timings now come from `orders.processing_at` to `confirmed_at`/`failed_at`, read with the other durable evidence.
- **Decision log.** No entry: the comment on the start-path cleanup states why the inventory is not removed at finalization.
