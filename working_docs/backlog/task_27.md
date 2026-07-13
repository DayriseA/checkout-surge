# Task 27: Complete the live dashboard gold signals: publish inventory and queue updates and promote latency/failure rate

## Execution context

- **Execution order:** This is task 27 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1
- **Area:** realtime / dashboard
- **Source:** independent review (medium) + comparison (worse)
- **Implementation context:** the evidence needed from the comparison implementations is inlined below. The target branch already has the strongest breaker snapshot shape; use the other designs only to complete live publication, freshness, and operator presentation without replacing the current contracts with a foreign vocabulary.
- **Locations:** `packages/contracts/src/dashboard-events.ts:16`, `packages/db/src/redis-stock-reservation.ts:256`

Contracts and the dashboard client handle inventory-updated and queue-updated events, but no production code publishes them: inventory mutation writes to a separate internal list with no bridge, and no queue producer exists. Live inventory-drain and queue-pressure panels stay frozen at HTTP recovery values, undermining the realtime demo — the dashboard depends on recovery refreshes for gold signals the event contract promises live.

The watch surface also gives request rate first-class treatment while latency and failure rate are less prominent than the reference's gold-signal presentation. Make all three traffic signals immediately visible and consistently windowed/labeled; coordinate the rate semantics with entry 30 and the bounded publication design with entry 44. If any promised signal is intentionally recovery-only rather than live, narrow the event contract and UI wording instead of leaving an unwired event type.

## Verified current state

The named comparison worktrees were inspected at the recorded donor heads (`c07e0de15be815d84419a1c2abd2967f72de0463` for GLM and `6d2585646ea94fc357aab10769ff805314e0d396` for Opus). The target worktree has advanced beyond the delegation base, so prefer the symbols and contracts below over the original line numbers.

- `packages/contracts/src/dashboard-events.ts` exposes `inventory.updated` with a complete `InventoryStatus`, `queue.updated` with a complete `QueueStatus`, and `traffic.metric` with `metricName`, `value`, `unit`, and `occurredAt`. `DashboardEvent` is validated by the discriminated union before Redis publication and browser consumption.
- `packages/db/src/redis-stock-reservation.ts` atomically decrements `remainingStock`, increments `reservedStock`, updates `lastUpdatedAt`, and appends an internal `inventory.updated` record to `inventoryKeys(...).events`, trimmed to `inventoryEventHistoryLimit = 100`. That list is bounded audit/recovery material; nothing consumes it into `dashboardEventsRedisChannel`.
- `packages/db/src/redis-dashboard-events.ts` already owns the shared transport primitives: `publishDashboardEvent`, `createRedisDashboardEventSubscriber`, schema validation, and the `dashboard-events` Redis channel. `apps/api/src/index.ts` constructs one subscriber, and `DashboardEventFanout` forwards validated messages to all SSE clients with heartbeats and slow-client eviction.
- `apps/web/src/app/components/operator-dashboard.tsx` already handles both promised events in `applyDashboardEvent`: inventory replaces `recovery.data.inventory`, queue replaces `recovery.data.queue`, and traffic samples append to a 20-item client window. It rejects events older than `recoveredAt` or outside the recovered run/sale-offer scope, refreshes recovery on SSE open, and serializes follow-up recovery when an event arrives during a recovery read.
- Production publishers currently exist for run lifecycle, traffic, and business-outcome updates. No production call site emits `inventory.updated` or `queue.updated`; their contract and reducer tests therefore prove only hypothetical delivery.
- `apps/api/src/services/dashboard-recovery-service.ts` remains the authoritative baseline. It independently reads inventory, queue, ERP, outcomes, lag, recent traffic metrics, and recent completions, degrading failed projections without making the live event stream authoritative.
- `apps/web/src/app/components/dashboard-panels.tsx` gives the latest `traffic.scheduled_request_rate` the headline in `RequestSurgePanel`; latency and failure-rate samples are not equally prominent. The present load parser also forwards raw k6 points (`http_reqs` as unit `requests`, `http_req_duration` as `ms`, `http_req_failed` as `ratio`), so entry 30 must define the actual window aggregation before this task labels values as observed rates/latencies/failure rates.

## Required live-signal contracts and ownership

Keep the existing event names unless implementation deliberately decides a signal is recovery-only and removes the corresponding event variant and live wording end-to-end.

| Signal | Source/owner | Live payload and meaning | Freshness and recovery |
| --- | --- | --- | --- |
| `inventory.updated` | The API reservation workflow, immediately after the atomic Redis hold reports a fresh `reservation_secured` decision | A contract-valid full `InventoryStatus` for the affected `saleOfferId`; counters must describe the post-mutation state. Include the current `runId` and request correlation ID when present. Idempotent replay must not publish a second drain event. | `inventory.lastUpdatedAt` and event `occurredAt` identify the observation. SSE is advisory; `/dashboard/recovery` re-reads Redis and repairs missed events. |
| `queue.updated` | The API queue handoff boundary after a durable order is successfully enqueued, plus any bounded mechanism selected for dequeue/retry/failure changes | A contract-valid full `QueueStatus`, with `depth` using the existing inspector definition and all `counts`, retry pressure, failed-job details, and `updatedAt` coherent from one inspection. Do not synthesize a partial object merely to satisfy the event schema. | `queue.updatedAt` and event `occurredAt` identify the inspection. Publish after enqueue success; recovery must remain authoritative for missed worker-side changes. |
| `traffic.metric` | Load-metric ingestion/projection | The three gold signals are `traffic.scheduled_request_rate`, `traffic.latency`, and `traffic.failure_rate`. Values and units must use the same explicit observation window/aggregation semantics produced by entry 30. | Each sample has `occurredAt`; retain only current-run samples and make the displayed window/aggregation legible. Recovery returns recent samples after reconnect. |
| ERP breaker/resilience | Worker owns the in-process breaker; Redis carries its cross-process snapshot; API owns the dashboard read model | Preserve current `ErpCircuitBreakerSnapshot`: `state`, `consecutiveFailureCount`, `failureThreshold`, `resetTimeoutMs`, `openedAt`, `nextAttemptAt`, `halfOpenProbeInFlight`, `updatedAt`. The API combines it with recent attempt counts, queue retry pressure, latest attempt, and confirmation delay into `ErpResilienceStatus`. | The snapshot's `updatedAt`, attempt window, and API `updatedAt` must be visible enough not to present an old worker report as current. Recovery/polling, not a fabricated API-side breaker, refreshes this panel. |

## Useful implementation patterns already recovered

### Inventory and queue publication

A proven pattern is a transport-neutral application publisher invoked at the mutation/handoff boundary, with the concrete Redis publisher injected at the composition root:

1. One donor narrows its inventory event to the post-decrement `remainingStock` and post-increment `reservedStock` returned by the atomic gate, avoiding an `HGETALL`/`ZCOUNT` round trip per accepted request. The target event currently requires a full `InventoryStatus` (including pending/expired state, throughput, and sold-out pressure), so either schedule one coherent `InventoryStatusService` read off the hot path, extend the atomic result with every required field, or deliberately narrow the event contract. Do not combine fresh counters with fabricated or independently stale fields.
2. Publication is scheduled after the mutation and is best-effort: validate the event, publish asynchronously, log failures with correlation/run/sale-offer context, and never turn a successful reservation or enqueue into an HTTP failure because the dashboard transport failed.
3. Queue depth can be inspected after a successful `orders:process` enqueue. One donor counts non-terminal BullMQ states (`waiting`, `active`, `delayed`, `prioritized`) and emits a narrow depth signal; the target contract is richer, so adapt this by using the existing `OrderProcessQueueInspector`/`QueueStatusService` to obtain one coherent `QueueStatus`, or intentionally narrow the target event contract. Do not mix a depth sampled at one instant with stale detailed counts.
4. A background publication scheduler owns in-flight tasks, returns immediately from `schedule`, swallows/logs rejected advisory tasks, exposes `flush()` for deterministic tests and graceful shutdown, and is constructed only in the API composition root. Coordinate this exact cost policy with entry 44 rather than adding an unbounded promise per request.

Publishing on every accepted reservation may still create one Redis publish per winner. Entry 44 owns coalescing/batching and burst-cost limits. This task must leave a seam that entry 44 can batch (for example latest-value coalescing per run/sale offer), and must not couple correctness to every intermediate event reaching the browser. The final value and recovery correctness matter; SSE is not an audit log.

For queue drain after workers claim or finish jobs, choose explicitly between a bounded publisher driven by BullMQ lifecycle observations and periodic authoritative recovery. If only enqueue-side queue updates are live, label the UI accordingly or retain a short recovery poll while a run is active; do not claim the entire queue panel is live from an enqueue-only feed.

### Breaker visibility

Two comparison designs establish the cross-service rule, but the target already contains their useful superset:

- The worker's single shared breaker publishes state on transitions to a shared Redis key and publishes an initial `closed` snapshot at startup. Reconfiguration also republishes effective threshold/reset values so operator state does not wait for a future transition.
- Missing/malformed state maps to an explicit unknown/missing condition; it must not impersonate `closed`. Redis publication failure is logged and swallowed because the breaker must continue protecting ERP traffic in-process.
- The strongest read model combines breaker state with bounded recent attempts and BullMQ pressure. Its vocabulary distinguishes `open -> unavailable`, `half_open -> degraded`, `closed` with recent failures -> degraded, clean `closed -> healthy`, and no worker report -> unknown/degraded. It shows consecutive failures, time to the next probe, last report time, delayed/waiting/active queue pressure, recent average/max/latest latency, last outcome, and last-attempt time.
- The target `ErpStatusService`, `RedisErpCircuitBreakerStateReader`, `PostgresErpAttemptStatusReader`, and `ErpHealthPanel` already implement most of this with an even richer circuit snapshot. Adaptation should therefore add an initial snapshot publish if absent, preserve missing/stale semantics, and promote the existing timing/threshold fields in the panel; do not replace the target types with donor names such as `reportedAt` or `retryAfterMs`.

The Redis breaker snapshot is exact only for the intended single worker process. With multiple workers it becomes last-writer-wins unless keyed/aggregated by worker identity. Do not silently market it as fleet-wide state; durable ERP attempts remain the cross-worker evidence.

### Gold-signal presentation

The complete watch layout presents inventory drain, queue depth/pressure, ERP circuit condition, and all three traffic signals without requiring navigation. For this task:

- Put observed request rate, windowed latency (state whether latest/average/p50/p95), and windowed failure rate together at equal visual rank in `RequestSurgePanel` or a dedicated gold-signals row.
- Labels must distinguish configured/scheduled traffic from observed traffic. `traffic.scheduled_request_rate` is a plan unless entry 30 changes the source and name to an observed completed-request rate; do not label raw `http_reqs` counts as RPS.
- Display units consistently (`requests/s`, `ms`, `%`) and name the common window (for example, `last 1 s` or `last 5 s`). Failure rate uses failed requests divided by completed requests in that same window; latency uses samples from that same window. Empty windows render `Awaiting metrics`/`n/a`, not zero.
- Retain timestamps or a stale indicator for the latest traffic window, inventory update, queue inspection, ERP breaker snapshot, and API recovery capture. A connected SSE socket is not proof that each panel's producer is fresh.

## Target adaptation map

- `packages/contracts/src/dashboard-events.ts`: keep full `inventory.updated`/`queue.updated` only if full coherent snapshots will actually be produced. If a bounded narrow metric is selected, introduce and test that explicit schema instead of overloading `traffic.metric` with undocumented payloads. Preserve event/run/correlation timestamps and strict validation.
- `packages/db/src/redis-stock-reservation.ts`: expose post-mutation fields only if the selected event shape can remain coherent without a second read; otherwise leave the atomic gate focused and schedule the existing status reader from the application boundary. Do not publish to Redis Pub/Sub from Lua or couple the DB package to SSE. Keep the internal 100-item event list bounded and distinct from advisory dashboard delivery.
- `apps/api/src/services/reserve-order-service.ts` and its injected ports: schedule inventory publication only for a fresh secured hold, and queue publication only after successful enqueue. Replays, sold-out outcomes, persistence-pending recovery, and enqueue failures need explicit behavior.
- `apps/api/src/queue/bullmq-order-process-job-publisher.ts`, `queue-status-service.ts`, and `bullmq-order-process-queue-inspector.ts`: reuse the existing queue vocabulary/inspection rules; avoid constructing a second inconsistent queue-depth definition.
- `packages/db/src/redis-dashboard-events.ts` and `apps/api/src/index.ts`: reuse the validated Redis publisher/subscriber and compose any scheduler/publisher ports here. Keep routes and `DashboardEventFanout` transport-only.
- `apps/worker/src/application/erp-circuit-breaker.ts`, `apps/worker/src/index.ts`, and `packages/db/src/redis-erp-resilience.ts`: ensure startup and every meaningful transition/configuration change publish the existing snapshot best-effort. Do not make breaker decisions depend on Redis success.
- `apps/api/src/services/erp-status-service.ts` and `dashboard-recovery-service.ts`: retain the API-owned projection, bounded attempt window, independent failure degradation, and explicit missing/stale breaker behavior.
- `apps/web/src/app/components/operator-dashboard.tsx` and `dashboard-panels.tsx`: keep recovery-before/live-after ordering guards, render freshness, and promote all three windowed traffic signals plus breaker timing/threshold details. Add active-run recovery polling only if needed for intentionally recovery-only signals; serialize it through the existing recovery coordinator.

## Scope and non-goals

- Do not turn Redis Pub/Sub into a durable event log, add replay cursors, or make SSE delivery part of reservation/order correctness.
- Do not publish directly from HTTP routes, Lua, or UI code. Mutation services own emission decisions; the DB package owns shared Redis helpers; the API composition root owns infrastructure construction.
- Do not invent a second metric vocabulary. Coordinate observed-rate/window semantics with entry 30 and burst batching/coalescing with entry 44.
- Do not broaden this task into run-history redesign, terminal summary changes, worker queue semantics, or multi-worker breaker aggregation.
- Do not present recovery-only values as continuously live. Either wire a bounded producer, poll the authoritative recovery read with honest freshness, or narrow the contract and wording.

## Focused verification

- Contract tests accept the exact inventory, queue, traffic, and breaker vocabularies and reject malformed/partial events, invalid units, and non-finite values.
- Reservation service tests prove exactly one post-mutation inventory publication for a fresh secured hold; none for idempotent replay, sold-out, invalid, or non-mutating outcomes; publisher failure never changes the buy result.
- Queue handoff tests prove publication occurs only after enqueue succeeds, uses the existing coherent inspector result, and publisher/inspection failure does not hide the durable reservation/order outcome.
- Scheduler tests prove `schedule()` does not await transport, rejections are contained, in-flight work is removed on settlement, and `flush()` waits for outstanding tasks. Add burst/coalescing assertions required by entry 44 rather than only single-call tests.
- Redis integration tests deliver production `inventory.updated` and `queue.updated` through `publishDashboardEvent -> createRedisDashboardEventSubscriber -> DashboardEventFanout`, while malformed messages are rejected and slow SSE clients remain bounded.
- Browser reducer/component tests prove newer in-scope events update inventory/queue, older or foreign-run/sale-offer events cannot overwrite recovery, reconnect recovery repairs missed events, and events arriving during recovery trigger one serialized follow-up.
- Traffic presentation tests cover all three signals together, shared window labels, honest scheduled-versus-observed wording, unit formatting, empty windows, and freshness/staleness.
- ERP tests cover initial `closed` publication, open/half-open/closed transitions, missing/corrupt/stale snapshots, Redis write failure isolation, attempt-window aggregation, queue-read degradation, and visible threshold/next-attempt/last-update fields.
- Run the relevant contract, API service, DB integration, worker unit, and web component suites after implementation. No application needs to be started for verification.

## Implementation record (2026-07-13)

### Status

Implemented at the Task 27 ownership boundaries. Production API composition now publishes contract-valid full inventory and queue snapshots through a bounded best-effort application scheduler; the watch surface promotes all three current traffic samples without claiming Task 30 window semantics and exposes inventory, queue, ERP breaker/API, traffic, and recovery timestamps.

### Decisions and completed scope

- Added an API-owned `DashboardSnapshotPublicationScheduler` with a maximum of 64 pending scopes, latest-value coalescing per sale offer plus one global queue scope, sequential single-flight inspection/publication, contained logging, deterministic `flush()`, and composition-root `close()`. Shutdown drains it after request acceptance stops and before Redis disconnects.
- A fresh `reservation_secured` Redis decision dirties inventory immediately; replay, rejection, and non-mutating paths do not. Every successful API-owned deterministic BullMQ handoff dirties queue state, including request replay reassertion and pending-persistence reconciliation; enqueue failure publishes nothing. Scheduling and inspection/publication failure cannot alter the buy or reconciliation result.
- The scheduler reuses `InventoryStatusService`, `QueueStatusService`, and the existing validated Redis dashboard publisher. Events carry complete existing contracts and use `inventory.lastUpdatedAt` / `queue.updatedAt` as `occurredAt`. The browser separately rejects an older source snapshot even when its publication completed later.
- Worker dequeue/retry/failure freshness is driven by the API scheduler rather than advertised as enqueue-only or charged to browser recovery. If a full queue snapshot observes depth or active work, one unref'd process timer dirties the global queue scope again after two seconds. The existing single-flight drain re-inspects/publishes until a final snapshot observes no queued or active work; new enqueues update the latest context and trigger immediate coalesced inspection without multiplying timers. Close cancels the timer and does not reschedule.
- The three current traffic points have equal visual rank. Task 30 subsequently replaced the temporary raw-sample labels with shared one-second producer-window semantics: observed requests per second, window mean latency, and window failure-observation fraction. Ratio failure samples remain formatted as percentages without changing their contract value.
- Inventory, queue, latest traffic sample, recovery capture, ERP breaker report, and ERP API projection timestamps are visible. Existing ERP missing semantics and startup/transition snapshot behavior were preserved; threshold, consecutive failures, reset timeout, next probe, report time, projection time, and attempt window were promoted. Added a worker unit assertion for initial configured `closed` publication and Redis-reporting failure isolation.
- Updated `docs/architecture.md`, `docs/cross_service_conventions.md`, and `docs/load_generation_metrics_streaming.md` to document bounded process-owned queue refresh, freshness, and raw metric semantics.

### Verification

- `node ../../scripts/run-with-test-env.mjs pnpm exec vitest run --config vitest.api.config.ts test/reserve-order-service.test.ts test/dashboard-snapshot-publication-scheduler.test.ts test/api-resource-cleanup.test.ts` (from `apps/api`): 3 files, 35 tests passed, including fake-timer queue refresh/drain/single-flight/close coverage.
- `node scripts/run-with-test-env.mjs pnpm --filter api exec vitest run --config vitest.api.config.ts test/reserve-order-service.test.ts test/pending-persistence-reconciler.test.ts test/dashboard-snapshot-publication-scheduler.test.ts` (from the repository root): 3 files, 42 tests passed, including API pending-persistence queue handoff scheduling and negative/failure-isolation coverage.
- `node ../../scripts/run-with-test-env.mjs pnpm exec vitest run --config vitest.config.ts test/dashboard-phase6.test.ts test/dashboard-hooks.test.tsx` (from `apps/web`): 2 files, 13 tests passed.
- `pnpm exec vitest run --config vitest.unit.config.ts test/unit/erp-circuit-breaker.test.ts` (from `apps/worker`): 1 file, 4 tests passed.
- `pnpm --filter @checkout-surge/contracts test:unit`: 2 files, 50 tests passed.
- `pnpm --filter api type-check`, `pnpm --filter web type-check`, `pnpm --filter worker type-check`, and `pnpm --filter @checkout-surge/contracts type-check`: passed.
- `pnpm --filter api lint`, `pnpm --filter web lint`, `pnpm --filter worker lint`, and `pnpm --filter @checkout-surge/contracts lint`: passed.
- `git diff --check`: passed.
- `pnpm type-check:test` was run after correcting the new inventory fixture and Task 27 test typing. It remains blocked by unrelated existing test-type errors in API integration helpers, dashboard-route mocks, load-orchestrator tests, missing web `server-only` declarations, and worker tests; no reported error remains in the Task 27 scheduler fixture or focused tests.
- Focused DB Redis Pub/Sub integration was attempted with `node ../../scripts/run-with-test-env.mjs pnpm exec vitest run --config vitest.integration.config.ts test/integration/db.integration.test.ts -t "publishes validated dashboard events through the shared Redis Pub/Sub channel"`; it could not run because test Redis at `127.0.0.1:6380` refused the connection, so 47 tests were skipped by suite setup. Existing transport integration code was not changed.
- `pnpm test:composition` and `pnpm test:characterization` were not run, per repository instructions.

### Follow-up dependencies

- Task 30 resolved the fixed event-time aggregation follow-up and replaced the raw-sample disclaimer and labels with observed/windowed vocabulary. Terminal p95 remains separate from the live window mean.
- Task 44 still owns broader burst-cost redesign. The scheduler is intentionally a bounded/single-flight/coalescing seam, but Task 44 may revise the 64-scope limit, cadence, cross-instance policy, and integrate sold-out/business-outcome coalescing without changing reservation or recovery authority.
- The two-second queue refresh is bounded per API process, not globally across replicas. Task 44 may introduce a shared lease if deployment-wide inspection bounds are required; any such change must continue using `OrderProcessQueueInspector` semantics and cumulative full snapshots.
