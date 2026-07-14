# Task 45: Isolate metric-ingestion failures from pub/sub fan-out

## Execution context

- **Execution order:** This is task 45 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P2
- **Area:** API / realtime
- **Source:** comparison (worse)
- **Standalone reference context:** `checkout-forge` makes its concrete realtime publisher advisory, while this repository already catches the same Pub/Sub failure on run lifecycle and finalization paths. The exact files, symbols, failure semantics, target adaptation, and verification are inlined below; no other branch or repository is required.
- **Locations:** `apps/api/src/services/demo-run-service.ts::DemoRunService.ingestMetrics()`; compare `DemoRunService.publishRunEvent()` and `apps/api/src/services/demo-run-finalization-service.ts::DemoRunFinalizationService.publishTerminalRunEvent()`

Metric ingestion appends samples to Redis and then awaits every dashboard publish without a local catch, so a single pub/sub failure fails the internal metric-ingestion request. Observability delivery must never fail measurement acceptance.

## Current defective path and transaction boundary

- `apps/api/src/routes/demo-run-routes.ts` owns the thin `POST /internal/load/metrics` adapter. After service-token validation and contract parsing it calls `await demoRunService.ingestMetrics(parsedRequest)` and only then returns `202 { accepted: true }`. Consequently, any rejection escaping the service becomes an HTTP failure even when the metric batch was already accepted into the recovery projection.
- `apps/api/src/services/demo-run-service.ts::DemoRunService.ingestMetrics()` parses the request, awaits `trafficMetricStore.append(request)`, then loops over `request.samples` and directly awaits `publishDashboardEvent()` for each `traffic.metric`. The event preserves `runId`, request `correlationId`, sample `metricName`, `value`, `unit`, and sample timestamp as `occurredAt`, and generates a distinct `eventId`.
- `RedisDashboardTrafficMetricStore.append()` writes the JSON samples to `demo-run:{runId}:traffic-metrics` with `RPUSH`, trims to `recentMetricLimit` (50) with `LTRIM`, and sets a 24-hour expiry. `DashboardRecoveryService.recover()` reads this retained projection through `trafficMetricReader.readRecent()` and independently degrades a failed read to `recentMetrics: []` while logging `Dashboard recovery projection unavailable.`
- `packages/db/src/redis-dashboard-events.ts::publishDashboardEvent()` validates/serializes one `DashboardEvent` and awaits `redis.publish(dashboardEventsRedisChannel, ...)`. Serialization/contract errors and Redis Pub/Sub rejection both escape to the caller. Redis list retention and Redis Pub/Sub are separate operations; there is no transaction spanning them and one must not be introduced. Once `append()` succeeds, a later advisory publication failure must not roll back, conceal, or relabel that accepted recovery update.
- The observable defect is therefore a partial-success inversion: sample retention has completed, the first failed publish rejects `ingestMetrics()`, later samples are not offered to Pub/Sub, and the route cannot return its intended 202. A load-orchestrator retry can then duplicate retained samples even though the original request was already stored.

## Correct local patterns already present

- `DemoRunService.publishRunEvent()` wraps `publishDashboardEvent()` in `try/catch`; on failure it logs at `warn` with `{ err, runId }` and `Could not publish run dashboard event.`, then resolves. `startRun()`, `recordTrafficCompletion()`, and failure handling therefore do not lose their durable workflow result merely because a run event could not fan out.
- `DemoRunFinalizationService.publishTerminalRunEvent()` uses the same shape after terminal persistence: it catches the publish rejection, warns with `{ err, runId }` and `Could not publish terminal run dashboard event.`, and does not undo or fail finalization.
- `ReserveOrderService.scheduleBusinessOutcomeUpdateWithoutHidingDurableSuccess()` and `publishBusinessOutcomeUpdateWithoutHidingDurableSuccess()` are an even stronger example for post-acceptance observability: scheduling and async publication errors are reported but cannot hide a persisted buy. Its `reportBusinessOutcomeUpdateFailureSafely()` also ensures a reporting callback cannot turn advisory failure into domain failure. Metric ingestion does not need that entire scheduling abstraction, but it must preserve the same durable/accepted-result precedence.

## Embedded `checkout-forge` reference behavior

- `checkout-forge/apps/api/src/realtime/dashboard-realtime-publisher.ts::DashboardRealtimePublisher.emit()` is a synchronous `void` port. It validates with `dashboardRealtimeEventSchema.safeParse()`; invalid events are warned and dropped with `eventType`, `correlationId`, and `validationError`. Valid events call Redis `PUBLISH` without making the caller await it, and attach a rejection handler that warns with `error`, `eventType`, and `correlationId`: `dashboard realtime event publish failed`.
- `checkout-forge/apps/api/src/services/load-metric-stream-service.ts::LoadMetricStreamService.observeLoadMetrics()` first performs its persistence/recovery-state work, then calls the publisher port for `load.run.updated` and each `dashboard.metric.observed`. `emitDashboardEvent()` merely invokes the injected advisory publisher; the concrete publisher owns validation and async transport-failure containment.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts::emitDashboardEvent()` additionally catches a synchronous exception from an injected publisher and logs `{ error, eventType }`, protecting the reservation even if a test/custom adapter violates the normal `emit()` behavior.
- `checkout-forge/apps/api/test/dashboard-realtime-publisher.test.ts` proves a rejected Redis publish does not throw from `emit()` and eventually produces a warning containing the event type and correlation ID. This is useful semantic evidence, not a requirement to copy Forge's publisher API or fire-and-forget implementation wholesale.

The reference's fire-and-forget design is safe only because failure containment is built into the publisher and that publisher has composition-root lifecycle ownership. In this repository `publishDashboardEvent()` deliberately returns a rejecting promise and is shared by callers with different semantics. Do not globally change it to swallow failures: containment belongs at the application workflow that declares the event advisory (or at the bounded publisher introduced by task 44).

## Required adaptation

1. Keep request parsing and `trafficMetricStore.append(request)` before fan-out. A retention failure is still a real ingestion failure and must continue to reject; this task only isolates the post-acceptance realtime side effect.
2. Add a small metric-publication helper in `DemoRunService` (or adapt task 44's API-owned bounded metric publisher if it is already present) that catches both event serialization/validation errors and Redis `PUBLISH` rejections. Do not put Redis calls or error-handling policy in `demo-run-routes.ts`.
3. On a failed sample publication, warn with at least `{ err, runId, correlationId, metricName }` and a stable message such as `Could not publish traffic metric dashboard event.` Including the event type is acceptable; avoid logging the whole request/batch. Logging must make a dropped live point attributable to its run and metric without exposing unrelated payload data.
4. Continue processing the remaining samples after one publication fails. A batch with mixed successful/failed Pub/Sub attempts still resolves after the retained append succeeds, and the route returns 202. Do not throw an aggregate error after the loop.
5. Preserve the event contract and identities: one accepted sample still maps to a contract-valid `traffic.metric` with the original run/correlation scope, name, value, unit, and timestamp. Generate an event ID for each attempted event. Do not fabricate a success event, retry indefinitely, or write a second durable record to compensate for Pub/Sub loss.
6. Keep the narrow failure semantics compatible with task 44, which precedes this task and owns batching/cost. If task 44 replaces the sequential loop with an enqueue/flush boundary, catch and log validation/enqueue failures synchronously and transport failures inside the lifecycle-owned flush; an async flush rejection must never become an unhandled promise rejection. Do not restore `N` awaited round trips merely to implement this task, and do not add a naked untracked `void publish...` call without bounded shutdown/flush ownership.
7. Do not weaken terminal truth. Recent Redis traffic samples are a lossy, expiring dashboard recovery projection and Pub/Sub is more ephemeral still. Traffic completion is durably recorded separately by `recordTrafficCompletion()` in the `demoRunFinalizations` PostgreSQL transaction (`httpSummary`, delivery/timing/diagnostic summaries, and `trafficSummaryReceivedAt`), then terminal finalization writes the run summary. Neither terminal status nor terminal totals may depend on successful live publication.

## Focused verification

- Add service-level coverage at `apps/api/test/demo-run-service.test.ts`, using an in-memory/fake `trafficMetricStore`, Redis fake, and logger spy; no running API, PostgreSQL, Redis, worker, browser, or load test is needed for the failure-isolation rule.
- Prove a valid multi-sample request calls `append()` exactly once before publication, and that a rejected publish for one sample does not reject `ingestMetrics()` or prevent later samples from being attempted.
- Assert the failure warning contains the thrown error plus `runId`, `correlationId`, and failed `metricName`, with the stable message selected by the implementation. Prove successful publishes do not produce that warning.
- Prove `append()` rejection still rejects `ingestMetrics()` and no Pub/Sub attempt occurs. This guards the intended acceptance boundary rather than accidentally swallowing all Redis failures.
- At the HTTP boundary, retain or add one focused assertion that the authenticated metric route returns 202 when retention succeeds despite advisory publisher failure. Existing route tests should continue to cover token enforcement, body correlation propagation, and normal delegation; do not duplicate those concerns in every service test.
- If task 44 has installed a buffered publisher, use fake time/deferred promises to prove a transport rejection is observed exactly once, later batches can still flush, and `flush()/close()` does not leak an unhandled rejection. Event-count assertions should follow task 44's batching contract rather than assuming one network round trip per sample.

## Scope and non-goals

- This task owns failure containment and observability for metric realtime fan-out after accepted retention. It does not redesign the metric schema, aggregation windows, batch sizing, Redis retention limit/TTL, SSE transport, dashboard reducer, or load-orchestrator forwarding policy.
- Do not make the route responsible for infrastructure, change the successful 202 response shape, add retries that can amplify a burst, or claim exactly-once/replay guarantees for Redis Pub/Sub.
- Do not swallow validation or retention errors that occur before the accepted boundary. Conversely, do not let a logging or realtime adapter redefine an already accepted metric batch as failed.
- Do not change demo-run finalization, completion summaries, stock/order correctness, or recovery authority. A dropped live event is acceptable operator-signal loss; retained recovery state and durable terminal summaries remain the repair/truth paths appropriate to their respective lifetimes.

## Implementation record (2026-07-14)

### Status

Implemented. Metric retention remains the request acceptance boundary, while event construction and Redis Pub/Sub are advisory after accepted retention.

### Completed scope and decisions

- Split Task 44's combined Lua operation into a bounded two-phase protocol inside the same ten-batch, single-flight store queue. The first `EVAL` fence-checks and atomically appends/trims/expires recovery samples. The second `EVAL` fence-checks again and uses `redis.pcall` to attempt every valid event payload independently within one batched command. It returns a typed indexed failure result, preserving later-sample attempts, the reset guarantee, and the two-command bound without restoring per-sample network round trips.
- `DemoRunService` now generates one event ID per attempted retained sample, validates and serializes samples individually, warns and continues after an event failure, warns only the indexed metric after an isolated Pub/Sub failure, and contains whole-command Pub/Sub rejection. Warnings use `Could not publish traffic metric dashboard event.` with `err`, `runId`, `correlationId`, and `metricName`; logger failure is also contained.
- Request/schema, active-run, and retention failures remain pre-acceptance failures. A reset fence, terminal/missing run, or ten-batch overflow retains Task 44's acknowledge-and-drop behavior. No global `publishDashboardEvent()` semantics or route ownership changed.
- Focused service, store, reset, and route coverage was added for ordering, identity preservation, validation continuation, indexed sample failure with a later successful attempt, warning shape, no warning for successful samples, throwing-logger containment, retention rejection, 202 after advisory failure, two-command/single-flight/queue bounds, continuation after rejected operations, and reset winning between retention and publication. Executed versus unavailable checks are recorded below.

### Verification

- `pnpm --filter api type-check`: passed.
- `pnpm --filter api exec vitest run --config vitest.api.config.ts test/dashboard-traffic-metric-store-unit.test.ts`: 1 file, 5 tests passed.
- `pnpm --filter api exec vitest run --config vitest.api.config.ts test/demo-run-service.test.ts -t "demo-run metric ingestion acceptance"`: 5 tests passed, 63 skipped by focus filter.
- `pnpm --filter api exec vitest run --config vitest.api.config.ts test/api.test.ts -t "returns 202 after the metric service contains post-retention publication failure"`: 1 test passed, 76 skipped by focus filter.
- `pnpm --filter api lint`: passed with no warnings.
- `git diff --check`: passed.

### Skipped and caveats

- `node scripts/run-with-test-env.mjs pnpm --filter api exec vitest run --config vitest.api.config.ts test/dashboard-traffic-metric-store.test.ts` could not run because the configured Redis service at `127.0.0.1:6380` was unavailable (`ECONNREFUSED`); Docker was not started for this task.
- `pnpm test:composition` and `pnpm test:characterization` are not run per repository instructions.
