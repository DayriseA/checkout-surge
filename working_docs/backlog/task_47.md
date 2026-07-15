# Task 47: Emit per-order realtime transitions and per-confirmed-order consistency-lag metrics

## Execution context

- **Execution order:** This is task 47 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P2
- **Area:** worker / realtime contract
- **Source:** comparison (worse, two topics)
- **Reference context:** Inlined below. This task is standalone; implementation does not require access to another repository or branch.
- **Locations:** `apps/worker/src/persistence/postgres-order-transition-persistence.ts:74`, `apps/worker/src/application/order-process-job-handler.ts:181`

Durable event coverage is fine, but the only live signal is an aggregate business-outcome event; there is no per-order transition stream and lag is emitted only as recomputed aggregates (avg/p95/max), so individual delay diagnosis is impossible. Coordinate with entry 44 so per-order emission stays bounded under surge.

## Verified current behavior

- `packages/contracts/src/dashboard-events.ts` has no per-order dashboard event. Its only relevant live contract is `businessOutcomeDashboardEventSchema`, a full replacement containing `saleOfferId`, `outcome`, and aggregate `consistencyLag`; the base supplies `eventId`, optional `runId`/`correlationId`, and `occurredAt`.
- `packages/db/src/business-outcome-dashboard.ts::publishBusinessOutcomeDashboardUpdate()` recomputes `readBusinessOutcomeSummary()` and `readConsistencyLagSummary()` and then publishes one `business.outcome.updated` through Redis. `readConsistencyLagSummary()` joins orders to reservations and calculates count, average, p95, and max from `orders.confirmedAt - reservations.securedAt`; it does not expose the contributing order-level samples.
- `apps/worker/src/persistence/postgres-order-transition-persistence.ts::PostgresOrderTransitionPersistence` already writes the order row and its `orderEvents` row in one transaction. `transitionToProcessing()` distinguishes a fresh transition from a resumed delivery, but `transitionToConfirmed()` and `transitionToFailed()` return `void`, so the handler cannot distinguish a fresh terminal transition from an idempotent no-op or obtain the durable event ID/timestamp.
- `apps/worker/src/application/order-process-job-handler.ts::createOrderProcessJobHandler()` calls the aggregate publisher after fresh processing, retry announcements, confirmation, and failure. A terminal redelivery is acknowledged before confirmation work. A resumed processing delivery does not republish the processing aggregate, but confirmation/failure publishing lacks an explicit fresh-transition result. The confirmed notification timestamp is independently created with `new Date()` after persistence and is not the durable `confirmedAt`.
- `apps/worker/src/index.ts` wires each worker transition to `publishBusinessOutcomeDashboardUpdate()`, so a small per-order mutation causes a full PostgreSQL aggregate rebuild before Redis publication. `packages/db/src/redis-dashboard-events.ts::publishDashboardEvent()` is an awaited Redis Pub/Sub publish; Pub/Sub is transient and has no replay or delivery acknowledgement.
- `apps/web/src/app/components/operator-dashboard.tsx::applyDashboardEvent()` replaces the full outcome/lag projections for `business.outcome.updated`. It filters events older than the recovery baseline and outside the current run/sale-offer scope, but it has no per-order identity, transition ordering, or `eventId` deduplication policy today.
- `packages/contracts/src/queue.ts::orderProcessJobSchema` already carries `orderId`, `publicOrderId`, `reservationId`, `saleOfferId`, `correlationId`, optional `runId`, and `queuedAt`. `apps/api/src/services/postgres-buy-persistence.ts` sets `orders.queuedAt` to the reservation hold's `securedAt`, so those timestamps are currently equal for persisted buys. This is the timestamp used by the existing aggregate lag reader.
- The cross-cutting requirement in `working_docs/delivery_constraints.md` is stronger than an aggregate-only dashboard: consistency lag must be tracked and exposed from the initial buy request to final ERP confirmation for every order. Durable per-order records plus a live point per fresh confirmation satisfy diagnosis; aggregate average/p95/max alone do not.

## Inlined donor behavior

The reference implementation supplies the following concrete design, useful as a shape rather than as code to copy:

- `packages/contracts/src/events.ts::orderStatusUpdatedEventSchema` defines `order.status.updated` as `{ type, correlationId, timestamp, payload: { publicOrderId, eventName, customerStatus, runId?, saleOfferId? } }` and includes it in `dashboardRealtimeEventSchema`.
- `packages/contracts/src/metrics.ts::dashboardMetricEventSchema` defines a generic metric point with `metricName`, finite numeric `value`, `unit`, `observedAt`, optional `correlationId`, optional `runId`, and string `dimensions`. `order.consistency_lag` is part of the metric vocabulary.
- `apps/worker/src/services/order-processing-service.ts::emitOrderStatus()` emits `order.processing`, `order.confirmed`, `order.failed`, and retry-attempt `erp.attempt.failed` events. The successful confirmation path also emits one `dashboard.metric.observed` point with `metricName: "order.consistency_lag"`, `unit: "ms"`, `observedAt` and envelope `timestamp` both equal to `finishedAt`, the order correlation ID, and dimensions `{ publicOrderId, saleOfferId }`.
- The reference point formula is `max(0, finishedAt - payload.enqueuedAt)` in milliseconds. It is emitted only after `recordSucceededAttempt()` has persisted the successful attempt and confirmed order. Status events are also emitted after their corresponding persistence call.
- `apps/worker/src/realtime/dashboard-realtime-publisher.ts::DashboardRealtimePublisher.emit()` validates the whole event, starts `redis.publish()` without awaiting it, and logs validation/publish failures. The channel is Redis Pub/Sub, so delivery is advisory and lossy; recovery remains authoritative.
- `apps/web/src/app/dashboard-view-model.ts` scopes status events by `runId` and `saleOfferId`, merges them by `publicOrderId`, and treats the latest `order.consistency_lag` point as a live value. Recovery separately supplies aggregate lag. This is not a durable point store or an exact percentile calculation.

### Donor caveats to correct

- The reference's `markProcessing()` result can be `processing` for a resumed retry, and the service emits `order.processing` whenever that is returned. A retry can therefore duplicate the same logical transition. Surge must publish only when persistence reports a newly committed transition.
- The reference status envelope timestamp is a separate `new Date()` taken after persistence, not the durable transition's `occurredAt`. That permits timestamp drift and makes ordering less defensible.
- The lag point omits `runId` even though its generic metric contract supports it, and puts only the public order ID and sale-offer ID in dimensions. Surge should carry both internal and public order identity plus run/correlation scope explicitly.
- The donor status contract has no stable event/transition ID, no previous status, and a free-form `customerStatus`. It cannot reliably deduplicate redelivery or reject regressions/out-of-order delivery.
- The donor clamps negative lag silently. This prevents an invalid negative chart value but hides cross-host clock skew or malformed source timestamps.
- Fire-and-forget Pub/Sub protects worker latency but provides no backpressure bound, replay, or proof that every live event reached a browser. The per-order requirement must rest on durable transition/confirmation records; realtime is a recoverable projection.

## Target contract and ownership

Extend the strict shared dashboard union in `packages/contracts/src/dashboard-events.ts`; keep mutation truth in worker persistence, publication behind an injected worker-side port, Redis construction in `apps/worker/src/index.ts`, and UI projection in the web reducer. Do not make a route or the handler query aggregate tables.

Add a per-order event whose contract is semantically equivalent to:

```ts
{
  type: "order.status.updated";
  eventId: string;                 // stable durable orderEvents.id, not random per publish attempt
  orderId: string;
  publicOrderId: string;
  saleOfferId: string;
  runId?: string;
  correlationId: string;
  occurredAt: string;              // the committed orderEvents.occurredAt/status timestamp
  eventName: "order.processing" | "order.confirmed" | "order.failed";
  previousStatus: "queued" | "processing";
  status: "processing" | "confirmed" | "failed";
  attemptNumber: number;
  attemptsMade: number;
}
```

Use the repository's UUID/timestamp/status/event-name schemas and `.strict()` rather than redefining loose strings. If the event remains envelope-plus-payload for consistency with other contracts, preserve exactly the same required fields and meanings. `eventId` must identify the durable transition so retrying a Redis publish does not create a second logical event. `orderId` is the durable identity; `publicOrderId` is display identity. `correlationId`, optional `runId`, and `saleOfferId` are required for trace and scope isolation. Do not model `erp.attempt.failed` as an order status transition: it leaves the order in `processing`; expose it later as a separately typed attempt event if needed.

Add one metric point for each newly committed confirmation, either as a dedicated `order.consistency_lag.observed` event or a strictly typed `dashboard.metric.observed` variant:

```ts
{
  type: "dashboard.metric.observed";
  eventId: string;                 // deterministic from, or explicitly linked to, the confirmed transition
  runId?: string;
  correlationId: string;
  occurredAt: string;              // confirmedAt
  metricName: "order.consistency_lag";
  value: number;                   // finite, nonnegative milliseconds
  unit: "ms";
  observedAt: string;              // confirmedAt
  orderId: string;
  publicOrderId: string;
  saleOfferId: string;
  startedAt: string;               // canonical lag start timestamp
  confirmedAt: string;
}
```

The point's order, correlation, run, and sale-offer fields must be first-class validated fields (or required typed dimensions), not recoverable only from logs. Link status and metric events to the same confirmed transition identity while keeping their event IDs unique if both share one stream. Consumers must deduplicate by `eventId`, scope by run/sale offer, and reject a regressive status based on the allowed lifecycle, not simply arrival order.

## Timestamp and lag semantics

- Persistence owns the transition clock. Have each transition method return a discriminated result containing `changed`, resulting/previous status, durable `eventId`, and the exact committed `occurredAt`; confirmation also returns `confirmedAt`. Publish only from that result after the transaction commits. Do not call `new Date()` again for the status event, lag point, or notification job.
- For the current Surge model, use the persisted buy's canonical start (`reservations.securedAt`, equal to `orders.queuedAt` and `job.queuedAt`) and the committed `orders.confirmedAt`. The per-order formula is `lagMs = max(0, confirmedAt.getTime() - queuedAt.getTime())`. This deliberately agrees with the existing aggregate projection, which uses `confirmedAt - securedAt`.
- The requirement says “initial buy request,” while the current stored timestamp is reservation-secured/queued time, not an independently captured HTTP-ingress timestamp. Do not label it as ingress latency. If product interpretation requires literal request arrival, add and propagate a canonical `requestedAt` in the buy persistence/job contract in a separately reviewed schema change, then update both point and aggregate formulas together. Do not mix formulas on one dashboard.
- Prefer one authoritative time source for start and confirmation (database timestamps where practical). Contract parsing must reject invalid timestamps. If `confirmedAt < startedAt`, emit a clamped zero only with an explicit clock-anomaly log/counter containing order, correlation, run, both timestamps, and raw negative delta; never allow NaN/Infinity or silently hide the anomaly.

## Delivery, boundedness, and aggregation

- Coordinate with task 44's bounded publisher/coalescer. Per-order events are small write-derived messages and must never trigger a business-outcome aggregate read. Enqueue them after commit into a bounded, single-flight, best-effort realtime publisher; worker completion/retry decisions must not await browser delivery.
- A bounded realtime queue may batch transport writes, but it must preserve each validated point/event and its timestamp/identity. Do not coalesce distinct orders into one “latest status” or turn individual lag points into only avg/p95/max. Define maximum queue/batch size and overflow behavior. Overflow may drop advisory live events only because durable order rows/events and recovery remain authoritative.
- Keep `business.outcome.updated` as an authoritative full snapshot for recovery/finalization and, if retained live, coalesce its expensive rebuild as task 44 specifies. Do not send deltas under that existing name because the web currently replaces its projections.
- Redis Pub/Sub remains at-most-best-effort fanout: duplicate publication and subscriber gaps are possible, there is no acknowledgement, and reconnect requires recovery. The web must deduplicate event IDs, ignore out-of-scope events, prevent terminal-to-nonterminal regression, and request/use authoritative recovery after gaps or terminal run events. A live lag point may show the latest individual sample; p95/average/max must continue to come from an authoritative aggregate or a clearly specified bounded sample window, never from treating the latest point as an aggregate.
- Publisher validation failures, queue overflow, publish rejection, and subscriber parse drops must be observable. Record bounded-queue depth/high-water mark and counters for enqueued, published, dropped/overflowed, invalid, and failed events by event type. Logs must include `eventId`, `orderId`, `publicOrderId`, `correlationId`, optional `runId`, and `saleOfferId`; metric-point logs additionally include start/confirm timestamps and raw/clamped lag when anomalous. Observability failures must not alter durable order state or BullMQ acknowledgement/retry behavior.

## Implementation outline

1. Extend shared dashboard contracts and contract tests with strict per-order transition and per-confirmation lag-point variants, including exact identity/scope/time fields and invalid-event cases.
2. Change `OrderTransitionPersistence` results and `PostgresOrderTransitionPersistence` to return committed transition metadata. Obtain the inserted `orderEvents.id` and exact timestamp in the transaction; return `changed: false` for resumed/terminal no-ops without inventing a new event ID.
3. Inject a small `OrderRealtimePublisher` port into `createOrderProcessJobHandler()`. After a fresh processing/failed/confirmed transition, enqueue the corresponding status event. After a fresh confirmation, enqueue exactly one consistency-lag point using the returned `confirmedAt` and canonical queued/start time, then pass that same `confirmedAt` to notification publication.
4. Wire the port to task 44's bounded publisher in `apps/worker/src/index.ts`. Publication/validation/overflow failures are reported and swallowed at this observability boundary. Remove per-transition full aggregate rebuilds or route their dirty notifications through task 44's coalescer; retain authoritative recovery/finalization reads.
5. Extend the web live reducer/view model to maintain bounded recent per-order state, deduplicate by event ID, enforce scope and monotonic lifecycle rules, and display/retain individual lag points without confusing latest with p95. Recovery must replace/reconcile this advisory state.

## Focused verification

- Contract tests accept processing/confirmed/failed status events and confirmed lag points with complete order/sale/correlation/run identity, durable IDs, exact ISO timestamps, and `ms`; they reject missing identity, unknown statuses/event names, negative/non-finite values, mismatched metric name/unit, and extra fields.
- Persistence tests prove a fresh transition returns the inserted durable event ID and the exact row/event timestamp, while resumed processing and terminal redelivery return `changed: false` and create no event. Transaction rollback publishes nothing.
- Handler tests prove one fresh processing transition emits one status event; retry/resume does not duplicate processing; retryable ERP failure does not masquerade as an order status change; fresh terminal failure emits once; fresh confirmation emits one confirmed status, one lag point, and a notification using the identical `confirmedAt`.
- Retry/idempotency tests cover ERP success followed by confirmed-persistence failure, handler redelivery after a committed confirmation, and publisher failure followed by job redelivery. Durable transition identity prevents duplicate logical status/lag points, and an observability failure never repeats the ERP call or changes job outcome beyond existing retry policy.
- Timestamp tests use fixed start/confirmation times and assert the exact millisecond formula. Equal timestamps produce zero. A backwards clock produces zero plus the anomaly report/counter. Invalid timestamps are rejected before publication; large finite durations remain valid.
- Bounded-publisher tests prove a burst never exceeds configured queue/batch/in-flight bounds, preserves order/event identity inside batches, reports overflow, and does not block or fail domain processing. Publish rejection is logged/counted and later events can still drain.
- Web reducer tests prove duplicate IDs are ignored, confirmed/failed cannot regress to processing, out-of-order distinct-order events are retained correctly, run/sale-offer mismatches are ignored, pre-recovery events are ignored, and the latest individual lag point is not presented as aggregate p95.
- Recovery/integration coverage proves missed live Pub/Sub messages are reconstructed from durable order/event data and aggregate lag, while a received event retains correlation/run/order scope end to end.

## Scope and non-goals

- This task owns worker-originated per-order transition events, per-confirmed-order lag points, their shared contracts, bounded delivery integration, live projection behavior, and focused observability/tests.
- Task 44 owns the general surge-safe batching/coalescing mechanism and removal of per-mutation aggregate-query amplification. Reuse that boundary rather than introducing a second unbounded queue.
- Keep durable `orderEvents`, order-state transitions, retry policy, ERP confirmation behavior, notification semantics, and authoritative recovery/finalization as the source of truth. Realtime publication is advisory and cannot fail a durable transition.
- Do not add real notifications, payments, a durable analytics warehouse, a new message broker, exactly-once delivery claims, or a broad dashboard rewrite. Do not change the consistency-lag start definition silently; point and aggregate formulas must agree.

## Implementation record (2026-07-15)

### Status

Implemented.

### Completed scope and decisions

- Added strict shared `order.status.updated` and `order.consistency_lag.observed` variants. Status identity is the durable `order_events.id`; the lag point has a deterministic UUID and a required `confirmedTransitionEventId` link. Contracts reject extra fields, inconsistent lifecycle names/statuses, invalid timestamps, non-finite/negative lag, and wrong metric/unit values.
- Persistence now returns discriminated fresh/no-op results. Fresh results contain the inserted event ID, previous/resulting status, exact committed transition timestamp, and canonical queued time; confirmation also returns the identical `confirmedAt`. Resumed processing and terminal replay return `changed: false` without fabricated event metadata.
- The handler synchronously enqueues only committed fresh transitions. Confirmation enqueues the confirmed status and lag point as one group, uses persisted queued/confirmed times, reports both raw and clamped values for negative clock deltas, and passes the same `confirmedAt` to notification publication. Realtime failures remain swallowed and do not change ERP, retry, persistence, notification, or BullMQ outcomes.
- Added a worker-owned publisher with a 1,024-event queue, 64-event drain batch, one publish in flight, whole-group drop-on-overflow, strict validation, rejection continuation, orderly close before Redis, and exposed per-type counters plus depth/high-water state. It does not coalesce distinct events or invoke aggregate readers; Task 44's scheduler remains responsible for `business.outcome.updated`.
- The publisher also whole-group drops any enqueue larger than the configured batch maximum, so neither atomicity nor the batch bound can be bypassed. Runtime stats include largest batch and current/maximum in-flight publication; invalid/drop/failure logs include raw event identity and queue/counter context.
- The browser event-time orders recovery-derived and live per-order states with stable order-ID ties before retaining the newest 20; it also retains 20 observation-time-ordered individual lag points and 100 deduplication IDs. It applies run/sale/recovery scope, rejects lifecycle regression, keeps distinct orders independent, visibly presents five recent reconciled/realtime statuses, labels the latest point as an individual value rather than p95, and replaces state from durable recent completion outcomes on recovery.
- Recovery-derived order state now uses the durable timestamp for the displayed status (`queuedAt`, `processingAt`, `confirmedAt`, or `failedAt`) rather than `latestEventAt`, which may describe a later notification. Because the recovery contract permits a missing `processingAt`, that state alone conservatively falls back to `queuedAt`; terminal records without their exact status timestamp are omitted from the advisory transition panel rather than assigned a misleading time. Bounding and ordering therefore use actual order-transition time.
- Updated architecture, realtime conventions, and repository ownership documentation.

### Verification

The full worker/web unit-suite results below were recorded before the two focused review cycles. Review corrections were verified with the explicitly listed focused reruns, type checks, lints, and `git diff --check`; the full suites were not rerun after cycle 2.

- `pnpm --filter @checkout-surge/contracts test:unit`: 2 files, 81 tests passed.
- `pnpm --filter worker exec vitest run --config vitest.unit.config.ts test/unit/order-process-job-handler.test.ts test/unit/order-realtime-publisher.test.ts`: 2 files, 33 tests passed after review corrections.
- `pnpm --filter worker test:unit`: 14 files, 78 tests passed.
- `pnpm --filter web test:unit`: 17 files, 163 tests passed.
- `pnpm --filter web exec vitest run --config vitest.config.ts test/dashboard-phase6.test.ts`: 1 file, 30 tests passed after review corrections.
- Final cycle-2 focused reruns: contract `test/contracts.test.ts` (1 file, 77 tests), worker `test/unit/order-process-job-handler.test.ts` (1 file, 32 tests), and web `test/dashboard-phase6.test.ts` (1 file, 31 tests) passed.
- Final takeover correction: `pnpm --filter web exec vitest run --config vitest.config.ts test/dashboard-phase6.test.ts` passed (1 file, 32 tests), including conflicting confirmation/notification timestamps and newest-20 transition-time bounding.
- Final takeover checks: `pnpm --filter web type-check` and `pnpm --filter web lint` passed; `git diff --check` passed.
- Contract, worker, and web type checks and lints passed; `git diff --check` passed.

### Skipped and caveats

- PostgreSQL/Redis integration suites require externally configured services; no Docker services were started. The persistence integration assertions were updated for the new discriminated result shape but are skipped when services are unavailable.
- `pnpm test:composition` and `pnpm test:characterization` were not run per repository instructions.
