# Phase 1-10 Review Findings

| Code | Finding | Severity | Slices |
|------|---------|----------|--------|
| F1 | Redis-secured holds can remain permanently pending after a transient PostgreSQL failure | High | 1 |
| F2 | Run closure is best-effort, so stale Redis eligibility can keep accepting a closed run | High | 4 |
| F3 | Admin reset fails runs without writing immutable run-history summaries | High | 4 |
| F4 | Generated-run cleanup can delete non-generated sale offers | High | 2 |
| F5 | Orders are not constrained to match a secured reservation | High | 2 |
| F6 | Successful ERP confirmations can be replayed after local persistence failures | High | 3 |
| F7 | Open ERP circuit retries can exhaust the job before the circuit can recover | High | 3 |
| F8 | Lost notification enqueue can fail an otherwise completed run | High | 3 |
| F9 | Lost traffic-completion reports can leave runs permanently active | High | 4 |
| F10 | Expected sold-out responses are counted as HTTP failures in k6 summaries | High | 4 |
| F11 | Accepted reservations synchronously run dashboard aggregate reads before responding | Medium | 1 |
| F12 | Mock ERP TPS limiting is global despite request-scoped run config | Medium | 3 |
| F13 | Terminal summary writes can race with direct reset updates and create split-brain run history | Medium | 4 |
| F14 | Stale SSE events can overwrite a fresher recovery snapshot | Medium | 5 |
| F15 | Protected admin proxy routes accept the raw passphrase instead of requiring the documented admin session | Medium | 5 |
| F16 | Internal load-orchestration calls split correlation IDs between bodies, headers, and logs | Medium | 6 |
| F17 | Load-orchestrator readiness can pass with an unreachable API target | Medium | 7 |
| F18 | Load-orchestrator tests do not exercise the production k6 runner or completion reporting path | Medium | 8 |
| F19 | Web tests stop at static markup and proxy units, leaving browser workflows untested | Medium | 8 |
| F20 | Some tests lock in known-bad recovery behavior as expected behavior | Medium | 8 |
| F21 | Admin cleanup can return a correlation ID that disagrees with the response header | Low | 6 |
| F22 | runtime:setup is documented as DB-only but rebuilds the whole app workspace | Low | 7 |
| F23 | Local runtime docs contain stale operational guidance | Low | 7 |

## High

### F1 — Redis-secured holds can remain permanently pending after a transient PostgreSQL failure (High)

**Slices:** 1

When Redis secures stock but `persistSecuredReservation()` fails, the service returns `reservation_pending_persistence` and records the hold. On subsequent requests with the same idempotency key, Redis returns `reservation_pending_persistence`; the service only checks `getPersistedBuyByReservationId()`, re-records pending state, re-marks the Redis sentinel, and returns pending again. It never retries the durable reservation/order insert from the stored hold when no durable row exists.

References:

- `apps/api/src/services/reserve-order-service.ts:173` persists only the initial `reservation_secured` decision.
- `apps/api/src/services/reserve-order-service.ts:182` handles later pending replays by checking for an already-persisted buy, then returns pending at line 204 if none exists.
- `apps/api/src/services/postgres-buy-persistence.ts:143` records `pending_reconciliation`, but repo search shows no code path that later marks it `reconciled`.
- `apps/api/test/api.test.ts:2752` locks in the current behavior: repeated client retries stay pending and do not consume more stock.

Impact: a transient PostgreSQL outage can reserve Redis stock, expose `Retry-After`, and still never create the durable reservation/order when PostgreSQL recovers. The buyer has a secured Redis hold but no order, the queue never receives work, and the run can stay draining until timeout.

Suggested fix: add a reconciliation/retry path that can durably persist a previously secured Redis hold once PostgreSQL is available, then update tests to assert the pending hold is eventually reconciled instead of remaining permanently pending.

### F2 — Run closure is best-effort, so stale Redis eligibility can keep accepting a closed run (High)

**Slices:** 4

The buy path trusts only Redis inventory state for generated-run eligibility. Lifecycle code moves the durable run to `draining` or `failed`, then catches and suppresses failures while closing Redis sale eligibility. If that Redis close command fails transiently, the run is no longer accepting in PostgreSQL while `inventory:{saleOfferId}:state` can still say `runSaleStatus: accepting`, allowing later `/buy` calls with the old `runId` to reserve stock.

References:

- `packages/db/src/redis-stock-reservation.ts:121` accepts generated-run traffic solely from Redis `runId` and `runSaleStatus`.
- `apps/api/src/services/demo-run-service.ts:627` writes the run to `draining`; Redis closure is attempted afterward and failure is only logged at line 645.
- `apps/api/src/services/demo-run-service.ts:887` similarly suppresses Redis close failures while failing a run.

Impact: a stale Redis hash can keep accepting reservations for closed, failed, or draining runs. This violates the hot-path guarantee that generated-run inventory fails closed after lifecycle closure.

Suggested fix: make generated-run closure fail closed, either by making Redis closure part of the guarded lifecycle transition or by adding a durable/repairable closure path that prevents stale Redis eligibility from accepting old runs. Add a regression test covering Redis close failure during run closure.

### F3 — Admin reset fails runs without writing immutable run-history summaries (High)

**Slices:** 4

`reset()` directly updates every `starting`, `active`, or `draining` run to `failed` with `failureReason: "admin_reset"`, but it never calls the terminal summary writer or inserts `demo_run_summaries`.

References:

- `apps/api/src/services/demo-maintenance-service.ts:47` performs the direct failure update.
- `apps/api/src/services/demo-maintenance-service.ts:87` returns without writing terminal summaries.
- `docs/core_business_entities.md:581` and `docs/load_generation_metrics_streaming.md:57` document the invariant that every terminal run should have one summary-backed history record, including admin recovery/reset paths.
- `apps/api/src/services/demo-run-startup-reconciliation-service.ts:84` and `apps/api/src/services/demo-run-finalization-service.ts:95` already use `PostgresTerminalDemoRunSummaryWriter` for other terminal paths.

Impact: a reset during a run leaves a terminal `demo_runs` row with no immutable history summary, no terminal inventory snapshot, and no preserved business outcome/sold-out accounting for Run History. Users see the run disappear from history even though it was made terminal.

Suggested fix: route reset-owned active runs through the shared terminal summary writer before or while marking them failed, with `admin_reset` summaries and captured business outcome/inventory snapshots. Add a maintenance-service regression test asserting summaries are created for reset-failed active runs and existing terminal summaries remain unchanged.

### F4 — Generated-run cleanup can delete non-generated sale offers (High)

**Slices:** 2

`DemoMaintenanceService.cleanupOldRuns()` collects `saleOfferId` values from every deletable terminal run and deletes those `sale_offers` rows by ID only. It never verifies that the referenced offer is generated-run-owned data. The schema allows `demo_runs.sale_offer_id` to reference any sale offer, and generated-run ownership is enforced through `demo_run_sale_contexts`, not by `demo_runs.saleOfferId` itself.

References:

- `apps/api/src/services/demo-maintenance-service.ts:122` through `apps/api/src/services/demo-maintenance-service.ts:129` select deletable runs and collect `saleOfferId` without joining or filtering `sale_offers.purpose`.
- `apps/api/src/services/demo-maintenance-service.ts:150` through `apps/api/src/services/demo-maintenance-service.ts:152` delete `sale_offers` by ID only.
- `packages/db/src/schema.ts:210` defines `demo_runs.saleOfferId` as a plain foreign key to `sale_offers`.
- `packages/db/drizzle/0000_initial_schema.sql:63` through `packages/db/drizzle/0000_initial_schema.sql:72` define `sale_offers.purpose` as `catalog | generated_run`.
- `packages/db/drizzle/0000_initial_schema.sql:455` and `packages/db/drizzle/0000_initial_schema.sql:478` show generated-run purpose/ownership triggers are tied to generated-run context validation, not cleanup's direct sale-offer delete.
- `packages/db/src/scripts/seed.ts:76` through `packages/db/src/scripts/seed.ts:102` seed the baseline catalog sale offer.

Impact: if legacy data, manual repair data, or a bug leaves an old terminal run pointing at a catalog offer, cleanup can delete baseline demo data outside generated-run ownership. At best the transaction fails on unrelated foreign keys; at worst the seeded catalog offer disappears.

Suggested fix: collect/delete sale offers only through verified `demo_run_sale_contexts` rows and/or add `sale_offers.purpose = 'generated_run'` to the delete condition. Add a cleanup regression test proving a terminal run that references a catalog offer does not delete that offer.

### F5 — Orders are not constrained to match a secured reservation (High)

**Slices:** 2

`orders.reservationId` only references `reservations.id` and is unique. There is no database trigger/check ensuring the referenced reservation is `status = 'secured'`, nor that `orders.saleOfferId`, `runId`, `correlationId`, or `quantity` match the reservation row. The existing generated-run trigger validates sale-offer ownership for each row independently, not the order-to-reservation relationship.

References:

- `packages/db/src/schema.ts:282` and `packages/db/src/schema.ts:300` define the order-to-reservation reference/uniqueness.
- `packages/db/drizzle/0000_initial_schema.sql:478` validates generated-run sale-offer ownership independently for each row.
- `docs/core_business_entities.md:202` describes an order as the durable business process started from a successful reservation.

Impact: PostgreSQL accepts orders that point to released, expired, rejected, or mismatched reservations. Worker transitions can then confirm those orders because they validate the job against the order row, not the reservation row. Final summaries and run history can count confirmed orders whose underlying reservation was not actually secured for the same run/offer.

Suggested fix: add a migration-backed trigger or equivalent relational constraint on `orders` inserts/updates requiring a matching secured reservation with the same `saleOfferId`, nullable `runId`, `correlationId`, and `quantity`. Add schema/integration tests proving mismatched and non-secured reservations are rejected.

### F6 — Successful ERP confirmations can be replayed after local persistence failures (High)

**Slices:** 3

The worker calls the external ERP before the order is durably marked confirmed. If `transitionToConfirmed()` fails after a successful ERP call, the order remains `processing`; the next delivery resumes that state and calls the ERP again. The current unit test explicitly locks in this behavior by expecting `confirmation.confirm` to be called twice after confirmed-state persistence fails.

References:

- `apps/worker/src/application/order-process-job-handler.ts:135` calls `confirmation.confirm()` before `transitionToConfirmed()` at line 175.
- `apps/worker/src/persistence/postgres-order-transition-persistence.ts:65` treats an already-`processing` order as resumable, which sends the resumed job back through confirmation.
- `apps/worker/test/unit/order-process-job-handler.test.ts:218` covers a failed `transitionToConfirmed()` retry and expects two confirmation calls at line 241.
- `apps/worker/src/application/erp-confirmation-client.ts:122` sends the POST to ERP, then persists the ERP attempt at line 142; if that local attempt write fails, `ErpAttemptPersistenceError` is classified as retryable at `apps/worker/src/application/erp-confirmation-client.ts:71`.
- `apps/mock-erp/src/application/confirmation-service.ts:59` generates a fresh `confirmationId` for every successful request and does not dedupe by `orderId`.

Impact: a transient PostgreSQL failure after a successful ERP response can create duplicate ERP confirmations for the same order. If local attempt persistence keeps failing while the ERP succeeds, the retry budget can also end with the order marked failed even though the downstream system accepted it.

Suggested fix: make ERP confirmation idempotent at the worker/ERP boundary, for example by using an explicit idempotency key and storing/reusing successful confirmation results before retrying. Separate "ERP succeeded but local persistence failed" from normal dependency failures so retries do not blindly repeat the external confirmation.

### F7 — Open ERP circuit retries can exhaust the job before the circuit can recover (High)

**Slices:** 3

`ErpCircuitOpenError` carries `retryAfterMs`, but the BullMQ retry schedule ignores it. Order jobs use the publisher's fixed retry options, which default to 4 attempts and 500 ms exponential backoff, while the worker's circuit reset timeout defaults to 10 seconds. With those defaults, a job can spend all retries on immediate `circuit open` errors before the circuit reaches its half-open probe window, then the handler persists the order as failed.

References:

- `apps/worker/src/application/erp-circuit-breaker.ts:63` throws `ErpCircuitOpenError` with `retryAfterMs`; the next attempt time is derived from `resetTimeoutMs` at lines 95-96.
- `apps/worker/src/application/order-process-job-handler.ts:138` treats temporary failures as retryable only while attempts remain, then marks the order failed at lines 155-171.
- `apps/api/src/queue/bullmq-order-process-job-publisher.ts:56` configures BullMQ attempts/backoff without reading `retryAfterMs`.
- `apps/api/src/runtime/config.ts:28` defaults order jobs to 4 attempts.
- `apps/api/src/runtime/config.ts:33` defaults the backoff base to 500 ms.
- `apps/worker/src/runtime/config.ts:50` defaults the circuit reset timeout to 10,000 ms.

Impact: an ERP outage can fail otherwise valid orders while the circuit is deliberately open and protecting the ERP, rather than waiting for the configured reset window. This also makes retry pressure and run outcomes look worse than the actual downstream recovery behavior.

Suggested fix: align circuit-open retries with `retryAfterMs`, either through a custom BullMQ backoff strategy, delayed requeue that does not consume the normal ERP attempt budget, or defaults that guarantee attempts span the reset window. Add a regression test that opens the circuit and verifies jobs are not terminally failed before the half-open probe time.

### F8 — Lost notification enqueue can fail an otherwise completed run (High)

**Slices:** 3

After an order is confirmed, notification work is only represented by a BullMQ job. If publishing that job fails, the order handler logs/reports the error and still completes the order job; there is no durable outbox or later repair path for the missing notification. Finalization, however, blocks whenever `notificationsRecorded < confirmedOrders`, so a single transient notification queue publish failure can keep a run draining until it fails with `business_drain_timeout`.

References:

- `apps/worker/src/application/order-process-job-handler.ts:175` persists the order as confirmed before publishing the notification job.
- `apps/worker/src/application/order-process-job-handler.ts:207` attempts the notification publish, but the catch path returns after reporting/logging at lines 218-227.
- `apps/worker/src/queue/bullmq-notification-record-publisher.ts:31` is the only place the notification record job is materialized.
- `apps/api/src/services/demo-run-finalization-service.ts:407` adds `missing_notifications` as a drain blocker.

Impact: notification work is correctly backgrounded from the order-processing perspective, but the finalization contract makes the notification record mandatory. A transient Redis/BullMQ publish failure after confirmation can turn a successful checkout run into a terminal failed run.

Suggested fix: persist a durable notification outbox row or add a confirmed-order recovery scanner that can recreate missing notification jobs/records. Add a regression test where notification enqueue fails once after confirmation and the run can still finalize after recovery.

### F9 — Lost traffic-completion reports can leave runs permanently active (High)

**Slices:** 4

The load orchestrator treats completion delivery to the API as fire-and-forget. When k6 exits, `SpawnK6Runner.reportCompletion()` flushes metrics and posts the completion report once; if that API call fails, the error is logged and the temporary run directory is removed, with no retry, durable outbox, or later reconciliation path. The API only moves a run from `starting`/`active` to `draining` inside `recordTrafficCompletion()`.

References:

- `apps/load-orchestrator/src/application/k6-runner.ts:152` sends the final completion report once.
- `apps/load-orchestrator/src/application/k6-runner.ts:162` catches completion-delivery failures and only logs them before cleanup.
- `apps/api/src/services/demo-run-service.ts:603` stores traffic finalization input only when the completion report reaches the API.
- `apps/api/src/services/demo-run-service.ts:627` is the only normal path that transitions traffic-finished runs into `draining`.

Impact: the local dockerized product can complete k6 traffic successfully but remain stuck as an active run if the API is briefly unavailable, saturated, restarting, or returns a transient 5xx during completion ingestion. This blocks future starts and prevents business-boundary finalization until an operator reset or API restart marks the run failed.

Suggested fix: make completion reporting retry with bounded backoff and/or persist a small load-orchestrator completion outbox until the API accepts it idempotently. Add a regression test where `sendCompletion()` fails once and the run still reaches `draining`.

### F10 — Expected sold-out responses are counted as HTTP failures in k6 summaries (High)

**Slices:** 4

The generated k6 script correctly treats `409` + `outcome: "sold_out"` as an expected checkout response through custom counters and `check()`, but it never configures k6's HTTP expected-status callback. k6's built-in `http_req_failed` metric therefore still classifies expected `409` responses as failed HTTP requests. The accumulator copies that metric directly into `httpSummary.failedRequests` and `failureRate`.

References:

- `apps/load-orchestrator/src/application/k6-script.ts:90` classifies `202` as accepted and `409` sold-out as expected custom outcomes.
- `apps/load-orchestrator/src/application/k6-script.ts:98` checks both `202` and clean `409` sold-out responses as expected.
- `apps/load-orchestrator/src/application/k6-output-parser.ts:54` increments failed request accounting from k6 `http_req_failed`.
- `apps/load-orchestrator/src/application/k6-output-parser.ts:89` stores that count in `httpSummary.failedRequests` and `failureRate`.
- Grafana k6 documents that `http_req_failed` follows `setResponseCallback`, and default expected statuses are `200` through `399`: https://grafana.com/docs/k6/latest/javascript-api/k6-http/set-response-callback/

Impact: run history and dashboard summaries can show expected sold-out traffic as HTTP failure. That weakens the documented sold-out-only demo case and makes traffic health look worse exactly when scarcity behavior is working.

Suggested fix: generate the script with a k6 response callback that treats `202` and the expected `409` sold-out response as successful for `http_req_failed`, or compute `failedRequests` from `unexpectedResponses` instead of raw k6 HTTP failure points. Add a parser/script test that all-sold-out traffic yields `failedRequests: 0` and `failureRate: 0`.

## Medium

### F11 — Accepted reservations synchronously run dashboard aggregate reads before responding (Medium)

**Slices:** 1

After durable persistence, queue enqueue, and Redis promotion, `ReserveOrderService` awaits `publishBusinessOutcomeUpdateWithoutHidingDurableSuccess()` before returning `reservation_secured`. The default publisher reads the full business outcome and consistency lag projections, which fan out into multiple PostgreSQL aggregate queries, on every newly accepted reservation.

References:

- `apps/api/src/services/reserve-order-service.ts:232` awaits enqueue, promotion, and then dashboard publication before building the response.
- `packages/db/src/business-outcome-dashboard.ts:224` publishes by awaiting `readBusinessOutcomeSummary()` and `readConsistencyLagSummary()`.
- `packages/db/src/business-outcome-dashboard.ts:52` shows `readBusinessOutcomeSummary()` running multiple count queries per publication.

Impact: accepted-heavy runs add avoidable PostgreSQL read load and response latency to the API reservation path. This directly works against the documented one-second surge target; dashboard projection should not be in the synchronous buy response path.

Suggested fix: publish only a lightweight event or enqueue/asynchronously refresh dashboard aggregates outside the buy response path. Add a hot-path regression/performance test or service test asserting accepted reservations do not synchronously perform aggregate dashboard reads.

### F12 — Mock ERP TPS limiting is global despite request-scoped run config (Medium)

**Slices:** 3

The mock ERP correctly resolves request-scoped `erpConfig` before deciding a confirmation, but its TPS counter is a single process-wide window. `acceptWithinTpsLimit()` receives only `maxTps`, not `runId` or a config key, so confirmations from one run/config can consume capacity for a different run/config in the same second.

References:

- `apps/mock-erp/src/application/chaos-control-service.ts:115` stores one `windowStartedAtMs` and one `requestsInWindow` for the provider.
- `apps/mock-erp/src/application/chaos-control-service.ts:127` resolves per-request config.
- `apps/mock-erp/src/application/chaos-control-service.ts:144` checks TPS through the shared counter.
- `apps/mock-erp/src/application/chaos-control-service.ts:163` implements `acceptWithinTpsLimit(maxTps)` without run/config scoping.

Impact: quick successive runs, catalog confirmations during a run, or any mixed request-scoped/global ERP traffic can produce unexpected 429s that are attributed to the current run even though another scope consumed the window. That weakens the accepted-run snapshot guarantee for ERP behavior.

Suggested fix: scope the TPS window by `runId` when present, and use a separate key for global/catalog traffic or for materially different request-scoped configs. Add a test proving two different run IDs do not throttle each other.

### F13 — Terminal summary writes can race with direct reset updates and create split-brain run history (Medium)

**Slices:** 4

`PostgresTerminalDemoRunSummaryWriter` takes an advisory lock, inserts the immutable summary, then updates `demo_runs` only if the current status is in the allowed set. It does not verify that the guarded update matched a row before returning `true`. The admin reset path bypasses this writer and directly updates `starting`, `active`, or `draining` runs to `failed` without taking the same advisory lock. If reset races with finalization, the summary writer can insert a `completed` or different `failed` summary for a draining run while the reset update wins the run row with `failureReason: "admin_reset"`.

References:

- `apps/api/src/services/demo-run-finalization-service.ts:66` takes the writer's advisory lock.
- `apps/api/src/services/demo-run-finalization-service.ts:95` inserts the terminal summary before proving the guarded run update succeeded.
- `apps/api/src/services/demo-run-finalization-service.ts:113` updates `demo_runs` under an allowed-status predicate but does not check the affected row count before returning `true` at line 129.
- `apps/api/src/services/demo-maintenance-service.ts:54` directly updates in-progress runs during reset without using the same writer/lock.

Impact: a run can end with `demo_runs` showing `failed/admin_reset` while `demo_run_summaries` shows a different terminal status and reason. Recovery and Run History then disagree about the same benchmark artifact.

Suggested fix: make all terminal transitions, including reset, go through one locked summary writer path, and have the writer insert the summary only when it can atomically claim the allowed current status or otherwise verify/update the run row. Add a concurrency regression test for reset racing with finalization.

### F14 — Stale SSE events can overwrite a fresher recovery snapshot (Medium)

**Slices:** 5

The watch dashboard treats live SSE payloads as direct state patches without checking whether the event belongs to the currently recovered run or whether it is older than the current recovery baseline. `source.onmessage` always calls `applyDashboardEvent()`, and the reducer blindly replaces `currentRun`, inventory, queue, metrics, and business outcome data from the event. The event contract and publishers carry `runId` for run, metric, and business-outcome events, but the browser ignores it.

References:

- `apps/web/src/app/components/operator-dashboard.tsx:139` applies every parsed live event to the current recovery state.
- `apps/web/src/app/components/operator-dashboard.tsx:238` through `apps/web/src/app/components/operator-dashboard.tsx:291` patch run, inventory, queue, metrics, and business outcome fields without any `runId`, `saleOfferId`, or timestamp guard.
- `packages/contracts/src/dashboard-events.ts:29` defines `runId` on dashboard events.
- `packages/db/src/business-outcome-dashboard.ts:231` and `apps/api/src/services/demo-run-service.ts:535` publish business and metric events with run attribution.
- `docs/cross_service_conventions.md:91` says live events are not the durable source of truth.
- `docs/cross_service_conventions.md:94` says recovery establishes the fresh baseline before subsequent live updates.

Impact: after reconnect, manual refresh, reset, or a quick new run, a delayed event from a previous run can make `/watch` show old run state, old business outcomes, or old metrics as if they belong to the current run. Terminal events trigger a follow-up recovery, but stale state is still displayed until that read returns; non-terminal stale metric/business events do not trigger recovery at all.

Suggested fix: treat live events as hints scoped to the recovered current run. Ignore events whose `runId` or `saleOfferId` disagrees with `recovery.data.currentRun`, and ignore events with `occurredAt` older than the current recovery baseline unless they are part of the same accepted baseline window. Add reducer tests for stale previous-run business/metric/run events arriving after a newer recovery snapshot.

### F15 — Protected admin proxy routes accept the raw passphrase instead of requiring the documented admin session (Medium)

**Slices:** 5

The documented protection model says operators exchange the passphrase once for a signed `HttpOnly` admin session, and protected dashboard API routes then verify that session before adding the server-side control token. The shared route helper currently allows either a valid session cookie or a matching `x-admin-passphrase` header, so dangerous actions can be invoked without ever establishing the admin session.

References:

- `docs/admin_access_protection.md:37` through `docs/admin_access_protection.md:43` define the passphrase-to-`HttpOnly` session flow.
- `docs/admin_access_protection.md:120`, `docs/admin_access_protection.md:123`, `docs/admin_access_protection.md:125`, `docs/admin_access_protection.md:127`, and `docs/admin_access_protection.md:128` mark reset, chaos mutation, admin preset mutation, history deletion, and admin starts as requiring an admin session plus the service-token proxy.
- `apps/web/src/app/lib/server/backend-proxy.ts:30` accepts a valid session.
- `apps/web/src/app/lib/server/backend-proxy.ts:34` through `apps/web/src/app/lib/server/backend-proxy.ts:37` also accept the raw passphrase header.
- Admin proxy routes such as `apps/web/src/app/api/admin/demo/runs/start/route.ts:18`, `apps/web/src/app/api/admin/demo/reset/route.ts:11`, and `apps/web/src/app/api/admin/demo/runs/history/route.ts:17` all rely on that helper before forwarding the server-side control token.
- `apps/web/src/app/components/run-history-admin-controls.tsx:53` through `apps/web/src/app/components/run-history-admin-controls.tsx:60` still send the passphrase directly on the deletion request instead of using the established session model.

Impact: the service token is still kept server-side, but the browser/admin client is encouraged to keep and resend the long-lived admin passphrase on individual destructive requests. This bypasses the documented session boundary, increases passphrase exposure in request handling/logging surfaces, and makes it harder to reason about which protected actions are authorized by the trusted session versus a browser-supplied credential header.

Suggested fix: split the helper into `requireAdminSession()` for protected proxy routes and a passphrase-only check used only by `POST /api/admin/session`. After successful sign-in, protected components should call admin proxy routes with the `HttpOnly` cookie only. Remove passphrase headers from destructive action calls and update tests to assert raw-passphrase access is rejected outside the session-creation route.

### F16 — Internal load-orchestration calls split correlation IDs between bodies, headers, and logs (Medium)

**Slices:** 6

The internal API-to-load and load-to-API HTTP clients send contract payloads that contain `correlationId`, but they do not send the shared `x-correlation-id` header. Both Fastify servers derive `request.correlationId`, response headers, error payloads, and log context from that header before route handlers run. The load-orchestrator start route also returns the body correlation ID from the parsed request, so a successful start can expose one correlation ID in the JSON body and a different generated ID in the `x-correlation-id` response header.

References:

- `apps/api/src/services/demo-run-service.ts:202` through `apps/api/src/services/demo-run-service.ts:206` post `TrafficExecutionStartRequest` to the load orchestrator with the control token but without `x-correlation-id`.
- `apps/load-orchestrator/src/server.ts:39` through `apps/load-orchestrator/src/server.ts:45` derive request/log/error correlation from `x-correlation-id`.
- `apps/load-orchestrator/src/server.ts:98` through `apps/load-orchestrator/src/server.ts:102` parse the body and return a response that uses the body correlation ID.
- `apps/load-orchestrator/src/application/api-client.ts:33` through `apps/load-orchestrator/src/application/api-client.ts:41` post metric and completion payloads back to the API without `x-correlation-id`.
- `apps/api/src/server.ts:60` through `apps/api/src/server.ts:66` derive API request/log/error correlation from `x-correlation-id`.
- `apps/api/src/routes/demo-run-routes.ts:163` through `apps/api/src/routes/demo-run-routes.ts:182` do not replace the request correlation ID with the parsed internal payload correlation ID.

Impact: cross-service traces for a single demo run fragment into unrelated IDs exactly around traffic start, metric ingestion, and completion reporting. A caller can see mismatched response header/body IDs, and operational errors from these internal boundaries cannot be reliably joined to the run's dashboard events or persisted records.

Suggested fix: set `x-correlation-id` from the validated contract payload on every internal HTTP client call, and add regression tests asserting the load-orchestrator start response header matches the request body `correlationId` and that load metric/completion calls reach the API with the same header. Consider also normalizing route `request.correlationId` from the parsed internal body after authentication so logs emitted after parsing use the contract correlation.

### F17 — Load-orchestrator readiness can pass with an unreachable API target (Medium)

**Slices:** 7

The load-orchestrator readiness check reports `api_base_url_configured=ok` whenever `config.apiBaseUrl` is non-empty. It does not attempt a request from the load-orchestrator container to the configured API URL. Compose also starts the load orchestrator after the API container is merely started, not healthy.

References:

- `apps/load-orchestrator/src/runtime/readiness.ts:15` through `apps/load-orchestrator/src/runtime/readiness.ts:24` validate only that an API URL string exists, plus k6 executability.
- `docker-compose.yml:179` through `docker-compose.yml:181` use `depends_on: api: condition: service_started` for the load orchestrator.
- `scripts/runtime-health-check.mjs:25` through `scripts/runtime-health-check.mjs:29` trusts the load-orchestrator `/health/ready` response and only adds a nested assertion for `k6_binary_executable`.

Impact: a bad in-container `API_BASE_URL` such as a host-only URL, broken Compose DNS, or an API that is not yet ready can still leave `health:check`, Compose health, and `runtime:smoke` green for the load-orchestrator service. The first dashboard-triggered load run then fails at execution time instead of being caught by readiness.

Suggested fix: have load-orchestrator readiness fetch the configured API liveness/readiness endpoint from inside the service and mark it `unavailable` on failure. Consider changing Compose to wait for `api` health before starting the orchestrator.

### F18 — Load-orchestrator tests do not exercise the production k6 runner or completion reporting path (Medium)

**Slices:** 8

The load-orchestrator suite checks generated script text and parser behavior, then tests the HTTP start route with a fake `K6Runner`. It never instantiates `SpawnK6Runner`, never fakes a spawned k6 process, and never verifies the production path that writes the temporary script, reads k6 stdout, batches metrics, sends completion, handles non-zero exits, or cleans up the temp directory.

References:

- `apps/load-orchestrator/test/load-orchestrator.test.ts:56` string-checks the generated buyer-spike script.
- `apps/load-orchestrator/test/load-orchestrator.test.ts:92` feeds hand-written JSON metric lines straight into `K6RunAccumulator`.
- `apps/load-orchestrator/test/load-orchestrator.test.ts:183` tests the HTTP boundary with a fake runner whose `start()` only resolves `{ startedAt, plannedRequests }`.
- `apps/load-orchestrator/src/application/k6-runner.ts:32` through `apps/load-orchestrator/src/application/k6-runner.ts:154` contain the untested production spawn/stdout/metric/completion path.

Impact: a green suite can miss production-only failures where k6 starts but metrics or completion never reach the API, temp files leak, non-zero exits are misreported, or the generated script is syntactically invalid for real k6. This is especially risky because run finalization depends on the completion callback.

Suggested fix: add a `SpawnK6Runner` unit test with an injected fake `spawnProcess` that emits k6 JSON lines and `close`/`error` events, asserting metric batches, completion reports, failure reports, and cleanup. Add at least one script-level check that can catch real k6 syntax/API drift.

### F19 — Web tests stop at static markup and proxy units, leaving browser workflows untested (Medium)

**Slices:** 8

The dashboard tests render client components with `renderToStaticMarkup()` and the proxy tests call Next route handlers directly. That covers labels and server forwarding, but it does not execute the browser event handlers that actually build request bodies, handle sessions, navigate to `/watch`, refresh recovery, delete selected history rows, or recover from proxy errors. The route/page surfaces themselves are also not smoke-tested as pages.

References:

- `apps/web/test/dashboard-control-surface.test.ts:20` and `apps/web/test/dashboard-control-surface.test.ts:53` render `PublicDemoEntry` and `AdminConsole` to static markup and assert text/disabled strings.
- `apps/web/test/admin-control-proxy.test.ts:60` and `apps/web/test/admin-control-proxy.test.ts:131` test proxy route handlers directly, not the public UI that calls them.
- `apps/web/src/app/components/public-demo-entry.tsx:69`, `apps/web/src/app/components/admin-console.tsx:339`, and `apps/web/src/app/components/run-history-admin-controls.tsx:34` own the user-triggered start/admin/delete workflows that are not driven by a browser-style test.

Impact: the local product can pass the current web tests while public starts, public custom payload construction, admin sign-in/session use, destructive history deletion, or route-level page data loading is broken in the browser.

Suggested fix: add jsdom/Testing Library or Playwright coverage for the key workflows: public curated start, public custom start, admin sign-in plus one protected action, watch recovery refresh/SSE follow-up behavior, and run-history selected/delete-all actions. Include lightweight page smoke tests for `/`, `/watch`, `/admin`, `/run-history`, `/run-history/[runId]`, and `/about`.

### F20 — Some tests lock in known-bad recovery behavior as expected behavior (Medium)

**Slices:** 8

A few tests currently assert the broken behavior reported by other review findings instead of the intended product recovery outcome. That makes the suite actively protect defects until those tests are rewritten, rather than merely lacking coverage.

References:

- `apps/api/test/api.test.ts:2752` names the pending-persistence replay behavior as expected.
- `apps/api/test/api.test.ts:2792` through `apps/api/test/api.test.ts:2795` assert the retry remains `reservation_pending_persistence` with no order.
- `apps/worker/test/unit/order-process-job-handler.test.ts:218` names duplicate confirmation after confirmed-state persistence failure as retryable behavior.
- `apps/worker/test/unit/order-process-job-handler.test.ts:241` asserts `confirmation.confirm` is called twice.

Impact: after the product bugs are fixed, these tests will fail unless they are inverted. Until then, `pnpm test` can be green while still enforcing behavior that loses orders or repeats downstream confirmations.

Suggested fix: replace these with regression tests for the desired behavior: pending Redis holds are durably reconciled/retried once PostgreSQL is available, and successful ERP confirmations are idempotently reused or persisted before retry so the downstream confirmation is not repeated.

## Low

### F21 — Admin cleanup can return a correlation ID that disagrees with the response header (Low)

**Slices:** 6

The generated-run cleanup endpoint accepts `correlationId` in the request body and passes it into the service response, whose shared schema requires `correlationId`. The route updates `request.correlationId` after parsing the body, but it does not update the `x-correlation-id` response header. Other body-correlation routes, such as admin runtime-policy updates and run-history deletion, refresh the header after normalization.

References:

- `packages/contracts/src/demo.ts:527` through `packages/contracts/src/demo.ts:547` define cleanup request/response contracts with optional request `correlationId` and required response `correlationId`.
- `apps/api/src/routes/admin-maintenance-routes.ts:38` through `apps/api/src/routes/admin-maintenance-routes.ts:47` normalize and pass the body correlation ID but never call `reply.header(correlationIdHeaderName, correlationId)`.
- `apps/api/src/services/demo-maintenance-service.ts:156` through `apps/api/src/services/demo-maintenance-service.ts:164` returns that body-derived correlation ID in the response payload.

Impact: clients and logs that key off the standard `x-correlation-id` header can disagree with the JSON payload for cleanup requests that supply a body correlation ID. This weakens the shared correlation vocabulary on an admin maintenance boundary and leaves the current API test coverage checking only the body value.

Suggested fix: import `correlationIdHeaderName`, set the response header after normalizing the cleanup correlation ID, and add a route test that asserts both payload and header equal the supplied body `correlationId`.

### F22 — `runtime:setup` is documented as DB-only but rebuilds the whole app workspace (Low)

**Slices:** 7

The runtime docs say the setup image uses a DB-only Docker target so seed changes do not rebuild the web, API, worker, mock ERP, or load-orchestrator bundles. The Dockerfile does the opposite: every runtime target inherits from `workspace`, and `workspace` runs `pnpm build` for the whole monorepo before `runtime-setup` is created.

References:

- `Dockerfile:21` installs the full workspace.
- `Dockerfile:23` through `Dockerfile:25` copy the entire repository and run `pnpm build`.
- `Dockerfile:56` through `Dockerfile:58` define `runtime-setup` as `FROM workspace`.
- `package.json:34` runs `docker compose run --rm --build runtime-setup`.
- `docs/runtime_topology.md:182` says the setup image uses a DB-only Docker target and does not rebuild application bundles.

Impact: `pnpm runtime:setup` can spend time rebuilding every service bundle after ordinary source or seed changes, contradicting the local runtime command contract and making setup slower and more fragile than intended.

Suggested fix: split a real DB/setup Docker target that copies only the files needed by `@checkout-surge/db` migrations/seeds and its workspace dependencies, or update the docs if the full build is intentional.

### F23 — Local runtime docs contain stale operational guidance (Low)

**Slices:** 7

The local development guide has two stale runtime details:

- The clean wipe-and-rebuild recipe lists only `pnpm runtime:wipe` followed by `pnpm runtime:setup`, but `runtime:wipe` runs `docker compose down --volumes --remove-orphans` and `runtime:setup` starts only PostgreSQL, Redis, and the one-shot setup container. Following the recipe leaves the API, worker, mock ERP, web, load-orchestrator, and dashboard proxy stopped until `pnpm runtime:up` is run again.
- The health-check example/table lists old readiness check names such as `redis_url_configured`, `database_url_configured`, `mock_erp_base_url_configured`, and `erp_circuit_breaker`, while the current API and worker readiness code reports reachable dependency and queue-worker checks.

References:

- `package.json:35` defines `runtime:wipe` as Compose `down --volumes --remove-orphans`.
- `docs/local_development.md:73` says `runtime:setup` by itself does not start the application services.
- `docs/local_development.md:75` through `docs/local_development.md:80` document the incomplete wipe-and-rebuild recipe.
- `docs/local_development.md:195` through `docs/local_development.md:218` show stale readiness response/check names.
- `apps/api/src/runtime/readiness.ts:19` through `apps/api/src/runtime/readiness.ts:56` and `apps/worker/src/runtime/readiness.ts:22` through `apps/worker/src/runtime/readiness.ts:96` show the current readiness checks.

Impact: operators following the docs can believe a wiped runtime has been rebuilt when only data services were restarted, and health troubleshooting points at readiness checks that no longer exist.

Suggested fix: include `pnpm runtime:up` in the clean wipe recipe and update the readiness examples/table to match the implemented check names.
