# Current-Branch Codebase Audit

Branch reviewed: `ai/opus-4.8` at `6d2585646ea9`

Reviewer: `gpt-5.6-sol` at high effort — the fixed independent reviewer used for every branch in this series.

This report consolidates the eight independent review slices in `working_docs/codebase_audit/slice_1.md` through `slice_8.md`. Overlapping reports are merged by root cause; slice numbers identify every applicable review area.

## Audit Summary

- 44 findings: 6 High, 30 Medium, 8 Low.
- 4 lower-confidence notes, excluded from finding totals.
- All eight slices were reviewed on the current branch and consolidated with cross-slice overlaps merged by root cause under one permanent finding code.
- Full workspace test, build, and lint gates passed as recorded under Validation Performed; the `pnpm test:unit` and `pnpm format:check` failures are themselves recorded as F35 and F42.

## Finding Index

| Code | Finding | Severity | Slices |
| :-- | :-- | :-- | :-- |
| F1 | Terminalization is not atomic with sale closure and summary creation | High | 1, 2, 4 |
| F2 | The load-orchestrator start endpoint bypasses API ownership and deployment caps | High | 4 |
| F3 | A single failed completion callback strands the API run indefinitely | High | 4 |
| F4 | A non-ERP error can strand the circuit breaker half-open forever | High | 3 |
| F5 | Queue handoff can hang the request or permanently strand durable work | High | 1, 3 |
| F6 | Overlapping deliveries can overwrite a terminal order result | High | 2, 3 |
| F7 | A process failure after the Redis decision leaves no recoverable persistence obligation | Medium | 1 |
| F8 | Best-effort dashboard publication can block the synchronous buy response | Medium | 1 |
| F9 | Unbounded idempotency keys allow disproportionate Redis resource consumption | Medium | 1 |
| F10 | Missing traffic evidence is graded as complete | Medium | 2, 4 |
| F11 | An unguarded failure transition can overwrite another terminal run result | Medium | 2 |
| F12 | Child rows can contradict the reservation or order they describe | Medium | 2 |
| F13 | Notification idempotency is not safe under concurrent delivery | Medium | 2, 3 |
| F14 | Test Redis resets have no target guard | Medium | 2 |
| F15 | PostgreSQL cleanup can commit while Redis cleanup becomes unrecoverable | Medium | 2 |
| F16 | Run-scoped worker concurrency is applied after BullMQ admits work | Medium | 3 |
| F17 | Mock ERP idempotency permits concurrent and post-restart duplicate confirmations | Medium | 3 |
| F18 | Worker readiness reports success without probing PostgreSQL | Medium | 3, 7 |
| F19 | Fast traffic completion can be overwritten back to active | Medium | 4 |
| F20 | Treating every HTTP 409 as expected hides lifecycle and attribution failures | Medium | 4 |
| F21 | The drain timeout does not bound pending-persistence reconciliation failures | Medium | 4 |
| F22 | Direct run starts can forge the per-visitor budget identity | Medium | 5 |
| F23 | Realtime events from other run scopes corrupt the live dashboard | Medium | 5 |
| F24 | A stale live inventory overlay overrides authoritative recovery | Medium | 5 |
| F25 | Recovery omits the existing order-outcome aggregate | Medium | 5 |
| F26 | The public SSE endpoint has no connection limit | Medium | 5 |
| F27 | Run History returns every summary without pagination | Medium | 5 |
| F28 | Admin passphrase login allows unlimited online guesses | Medium | 5 |
| F29 | Invalid advanced VU relationships pass validation and fail after run acceptance | Medium | 6 |
| F30 | Traffic boundary contracts accept impossible lifecycle states | Medium | 6 |
| F31 | The reference runtime can report healthy without required secrets | Medium | 7 |
| F32 | The isolated migration command can target an ambient development database | Medium | 7 |
| F33 | Worker integration files can erase each other's shared Redis state | Medium | 7 |
| F34 | The by-id cleanup command can delete an active run with jobs in flight | Medium | 7 |
| F35 | The root unit, watch, and coverage lane cannot run the complete web unit suite | Medium | 8 |
| F36 | Automated tests never exercise the deployed cross-service composition | Medium | 8 |
| F37 | Catalog offers remain purchasable after their eligibility window closes | Low | 1 |
| F38 | Frozen run snapshots and immutable summaries remain updateable | Low | 2 |
| F39 | API recovery reports traffic as starting for the entire active execution | Low | 4 |
| F40 | The orchestrator breaks the run-start correlation chain for callbacks | Low | 6 |
| F41 | The web BFF exposes two incompatible error payload vocabularies | Low | 6 |
| F42 | The documented format gate fails on the current branch | Low | 7 |
| F43 | Runtime documentation contains stale lifecycle and wipe instructions | Low | 7 |
| F44 | Web tests pass while React reports unsynchronized state updates | Low | 8 |

## High Severity

### F1 — Terminalization is not atomic with sale closure and summary creation (High)
**Slices:** 1, 2, 4

Run-attributed buys check eligibility before the atomic stock decision, but the Lua script does not re-check the eligibility key (`apps/api/src/services/reserve-order-service.ts:105`, `packages/db/src/reserve-stock.ts:63`). Finalization then marks a run terminal, writes its summary, and only afterward closes eligibility (`apps/api/src/services/run-finalization-service.ts:132`, `apps/api/src/services/run-finalization-service.ts:143`, `apps/api/src/services/run-finalization-service.ts:147`). A concurrent buy can therefore commit after terminal accounting. If summary creation fails after the terminal transition, later polls cannot repair it because they scan only `draining` runs (`apps/api/src/services/finalization-store.ts:86`), and eligibility remains open. The result can be a terminal run with no history summary and late orders excluded from immutable accounting.

Close and validate run eligibility in the same Redis decision as stock, and make terminal state plus summary creation a recoverable transaction/workflow. Add close-versus-buy concurrency tests and fault injection after the terminal transition, proving exactly one summary, closed eligibility, and no post-summary business state.

### F2 — The load-orchestrator start endpoint bypasses API ownership and deployment caps (High)
**Slices:** 4

`POST /internal/load/runs` has no service-token guard and accepts traffic values without deployment maxima (`apps/load-orchestrator/src/routes/load-routes.ts:17`, `packages/contracts/src/load.ts:24`). The reference runtime publishes port 4200 directly (`docker-compose.yml:121`, `docker-compose.yml:133`). A reachable caller can start arbitrary k6 traffic with invented or reused run identifiers, bypassing API lifecycle, public budgets, overlap rules, and hard caps.

Require the control token on the orchestrator route, send it from `HttpTrafficRunLauncher`, enforce defense-in-depth traffic caps, and avoid publishing the control port publicly. Add unauthorized and over-cap route/deployment tests.

### F3 — A single failed completion callback strands the API run indefinitely (High)
**Slices:** 4

After k6 exits, the orchestrator attempts one completion callback; network and non-2xx failures are logged and swallowed (`apps/load-orchestrator/src/services/traffic-run-service.ts:128`, `apps/load-orchestrator/src/services/traffic-reporter.ts:109`). Only that callback can move the API run to draining/failed, while finalization scans only draining rows (`apps/api/src/services/load-completion-ingest.ts:59`, `apps/api/src/services/finalization-store.ts:86`). A transient failure leaves the run active forever, blocking later runs and preventing a summary.

Persist completion in a restart-safe outbox and retry the idempotent callback until acknowledged, optionally backed by API reconciliation. Test transient failure, process restart, eventual delivery, and exactly-once summary creation.

### F4 — A non-ERP error can strand the circuit breaker half-open forever (High)
**Slices:** 3

The half-open breaker reserves a single probe (`apps/worker/src/services/circuit-breaker.ts:49`), but the decorator records a result only for ERP success/failure. A database, config, or persistence error is rethrown without releasing the probe (`apps/worker/src/services/circuit-breaking-order-confirmation.ts:88`). Later requests are perpetually deferred because `#probeInFlight` never clears.

Add an explicit aborted-probe transition that releases or reopens the breaker without misclassifying worker faults as ERP failures. Add a regression test for a non-ERP exception during the half-open probe followed by successful recovery.

### F5 — Queue handoff can hang the request or permanently strand durable work (High)
**Slices:** 1, 3

API and worker queue producers use Redis clients with `maxRetriesPerRequest: null` (`apps/api/src/index.ts:108`, `apps/worker/src/index.ts:59`), so an unreachable broker can leave awaited `Queue.add()` calls pending indefinitely. If enqueue does reject, the buy workflow logs and returns success after the durable order commit (`apps/api/src/services/reserve-order-service.ts:372`), but no outbox/reconciler re-drives queued orders and idempotent replay does not enqueue again (`apps/api/src/services/reserve-order-service.ts:247`). The buyer can hang or receive success for an order stranded forever.

Use bounded producer retries/timeouts and a transactional outbox or idempotent queued-order reconciler. Test broker outage, bounded response behavior, restart/redrive, and exactly one job.

### F6 — Overlapping deliveries can overwrite a terminal order result (High)
**Slices:** 2, 3

The worker loads an order, awaits ERP work, then updates by order ID without an expected-status predicate (`apps/worker/src/services/process-order-service.ts:90`, `apps/worker/src/adapters/postgres-order-progress-store.ts:44`). Under BullMQ at-least-once overlap, a stale delivery can overwrite `confirmed` with `failed` or vice versa, and both contradictory events are appended.

Use compare-and-set transitions (`queued -> processing -> confirmed|failed`) and append events only for the winning transition in the same transaction. Add barrier-controlled overlapping-delivery integration coverage.

## Medium Severity

### F7 — A process failure after the Redis decision leaves no recoverable persistence obligation (Medium)
**Slices:** 1

The stock Lua script creates the hold but not a pending-persistence sentinel (`packages/db/src/reserve-stock.ts:96`). The service records that sentinel only in a caught PostgreSQL failure (`apps/api/src/services/reserve-order-service.ts:294`), so process exit or a hung call after Redis commits leaves no work for `PendingPersistenceReconciler`, and replay only returns a pending response (`apps/api/src/services/pending-persistence-reconciler.ts:45`, `apps/api/src/services/reserve-order-service.ts:247`). Inventory is consumed without durable business state or terminal accounting.

Create the recoverable obligation atomically with the hold and clear it after PostgreSQL commits. Add kill/restart fault injection immediately after the Redis result.

### F8 — Best-effort dashboard publication can block the synchronous buy response (Medium)
**Slices:** 1

The accepted path unconditionally awaits dashboard publication before returning (`apps/api/src/services/reserve-order-service.ts:166`, `apps/api/src/services/reserve-order-service.ts:180`), while the publisher directly awaits Redis `PUBLISH` without a timeout (`packages/db/src/dashboard-events.ts:24`). A slow reconnect can hold a successfully persisted checkout open for observability work.

Detach the guarded publish or impose a short swallowed timeout. Test that an unresolved publisher cannot delay the durable response.

### F9 — Unbounded idempotency keys allow disproportionate Redis resource consumption (Medium)
**Slices:** 1

The public schema accepts any non-empty idempotency string (`packages/contracts/src/buy.ts:10`), embeds it verbatim in a Redis key (`packages/db/src/redis-keys.ts:53`), and retains accepted keys for the configured TTL (`packages/db/src/reserve-stock.ts:100`). Large request keys amplify Redis bandwidth and memory across accepted units.

Add a conservative shared byte/character maximum and contract/API boundary tests for the limit.

### F10 — Missing traffic evidence is graded as complete (Medium)
**Slices:** 2, 4

Successful completion moves the run to `draining` before best-effort finalization-input persistence (`apps/api/src/services/load-completion-ingest.ts:62`, `apps/api/src/services/load-completion-ingest.ts:113`). The poller can race the insert, and a failed insert cannot be repaired by a duplicate callback. Missing input or a null k6 summary is then graded `complete` with all delivery measurements null (`apps/api/src/services/grade-traffic-delivery.ts:71`). A run with no trustworthy delivery evidence can become an immutable successful benchmark.

Persist completion evidence atomically with the draining transition, retry duplicate input landing, block finalization until required evidence exists, and grade unmeasured delivery as degraded/failed. Test store failure and transition-versus-poller races.

### F11 — An unguarded failure transition can overwrite another terminal run result (Medium)
**Slices:** 2

`PostgresRunStore.markFailed` updates solely by run ID (`apps/api/src/services/postgres-run-store.ts:90`). Reset can read a nonterminal run, lose a race to normal completion, then overwrite `completed` with `failed`, while the insert-only summary remains completed (`apps/api/src/services/demo-reset-service.ts:75`, `apps/api/src/services/run-summary-writer.ts:104`).

Guard failure transitions by expected nonterminal states and return whether they applied. Add concurrent reset-versus-finalization integration coverage.

### F12 — Child rows can contradict the reservation or order they describe (Medium)
**Slices:** 2

Orders independently store offer, run, correlation, quantity, and status while only foreign-keying `reservation_id`; downstream ERP attempts and notifications likewise duplicate identity without agreement constraints (`packages/db/src/schema.ts:200`, `packages/db/src/schema.ts:232`, `packages/db/src/schema.ts:312`). PostgreSQL accepts a confirmed order backed by a rejected or differently attributed reservation, corrupting run cleanup and summaries.

Add composite keys/foreign keys or constraint triggers tying child identity and secured status to parents, and test cross-offer, cross-run, correlation, quantity, and non-secured cases.

### F13 — Notification idempotency is not safe under concurrent delivery (Medium)
**Slices:** 2, 3

The recorder performs `SELECT` then `INSERT` (`apps/worker/src/adapters/postgres-notification-recorder.ts:53`), but the schema has only a non-unique `order_id` index (`packages/db/src/schema.ts:330`). Concurrent at-least-once deliveries can both insert rows and `notification.recorded` events, inflating terminal summaries.

Add `UNIQUE(order_id)` and use `INSERT ... ON CONFLICT DO NOTHING RETURNING`, emitting an event only for the winner. Add concurrent recorder integration coverage.

### F14 — Test Redis resets have no target guard (Medium)
**Slices:** 2

The PostgreSQL test reset validates a test-only target, but integration suites call Redis `FLUSHDB` directly without equivalent validation (`packages/db/src/testing/index.ts:19`, `packages/db/test/integration/schema.test.ts:47`). A mistaken `TEST_REDIS_URL` can erase a shared logical database before assertions run.

Centralize a guarded `resetTestRedis` helper with an explicitly isolated target policy and add wrong-target rejection tests.

### F15 — PostgreSQL cleanup can commit while Redis cleanup becomes unrecoverable (Medium)
**Slices:** 2

Maintenance cleanup deletes durable run/offer ownership first, then clears Redis (`packages/db/src/run-cleanup.ts:165`, `packages/db/src/cli/cleanup-runs.ts:31`). If Redis cleanup fails, retry can no longer derive the deleted run-to-offer mapping, leaving eligibility/inventory keys orphaned and potentially accepting holds for nonexistent durable state.

Close/clear Redis before deleting ownership or persist a cleanup outbox/tombstone until Redis succeeds. Test Redis failure followed by a successful retry.

### F16 — Run-scoped worker concurrency is applied after BullMQ admits work (Medium)
**Slices:** 3

The worker starts at global default concurrency, and only inside an admitted job does the handler load the run snapshot and mutate `Worker.concurrency` (`apps/worker/src/index.ts:160`, `apps/worker/src/services/run-concurrency-controller.ts:40`). A low-concurrency run can start with a full default-sized batch, violating its frozen backpressure policy.

Apply run concurrency before fetching jobs or enforce a run-aware semaphore inside processing. Test maximum active confirmations from the first queued batch.

### F17 — Mock ERP idempotency permits concurrent and post-restart duplicate confirmations (Medium)
**Slices:** 3

The Mock ERP checks its ledger, awaits latency, then stores a new reference (`apps/mock-erp/src/services/erp-confirmation-service.ts:69`, `apps/mock-erp/src/services/erp-confirmation-service.ts:106`). Concurrent calls can both pass the check and return different confirmations; the in-memory ledger also resets on process restart (`apps/mock-erp/src/services/confirmation-ledger.ts:10`).

Atomically coalesce same-order in-flight calls and persist completed idempotency results if restart recovery is supported. Test concurrent calls, worker timeout overlap, and restart/redelivery.

### F18 — Worker readiness reports success without probing PostgreSQL (Medium)
**Slices:** 3, 7

Readiness receives only `databaseUrlConfigured` and maps any nonempty URL to healthy (`apps/worker/src/services/readiness.ts:23`, `apps/worker/src/index.ts:186`). Redis consumers may remain running while every job fails its required PostgreSQL work, yet `/health/ready` stays 200.

Inject a bounded live database probe and return 503 when it fails. Add configured-but-unreachable database tests.

### F19 — Fast traffic completion can be overwritten back to active (Medium)
**Slices:** 4

Run start launches traffic before promoting the database row (`apps/api/src/services/run-start-service.ts:248`). A fast completion may move `starting` to draining/failed, after which unconditional `markActive` regresses it to active (`apps/api/src/services/postgres-run-store.ts:78`). This can strand a contradictory run outside finalization.

Make `markActive` compare-and-set from `starting` and preserve the authoritative state if it loses. Add completion-during-launch race tests for success and failure.

### F20 — Treating every HTTP 409 as expected hides lifecycle and attribution failures (Medium)
**Slices:** 4

The k6 script marks every 409 expected (`apps/load-orchestrator/src/services/k6-script.ts:119`), but the buy path also uses 409 for closed runs and run/offer mismatch (`apps/api/src/services/reserve-order-service.ts:186`). A completely broken run can therefore report clean traffic delivery just like legitimate sold-out or idempotency conflict traffic.

Classify expected outcomes by validated response code/body and count lifecycle/attribution failures as unexpected. Test all four 409 classes through the generated metric path.

### F21 — The drain timeout does not bound pending-persistence reconciliation failures (Medium)
**Slices:** 4

The settle timeout allows unsettled orders to proceed, but reconciliation runs afterward and is unconditional (`apps/api/src/services/run-finalization-service.ts:114`, `apps/api/src/services/run-finalization-service.ts:172`). A poison record or persistent materialization failure is retried forever, leaving the run draining and blocking new starts.

Apply the timeout to reconciliation and create an explainable terminal failure or durable unresolved artifact after expiry. Test reconciliation failure beyond the timeout.

### F22 — Direct run starts can forge the per-visitor budget identity (Medium)
**Slices:** 5

`POST /demo/runs` trusts caller-provided `x-visitor-id` as the budget key (`apps/api/src/routes/run-routes.ts:59`). Although the web proxy mints a signed visitor cookie, the API is directly published on port 4000 (`docker-compose.yml:60`), letting callers rotate header values and bypass the per-visitor limit while consuming the shared global allowance.

Authenticate the proxy assertion before honoring the header or derive direct identities from a trusted server-side attribute. Add direct-API rotated-header tests.

### F23 — Realtime events from other run scopes corrupt the live dashboard (Medium)
**Slices:** 5

The browser reducer applies global SSE order/notification aggregates without comparing their run/offer to the recovery baseline, and foreign inventory events enter the surge-rate window before scope checking (`apps/web/src/lib/live-dashboard-state.ts:167`, `apps/web/src/lib/live-dashboard-state.ts:185`). Delayed prior-run or catalog traffic can overwrite current-run outcomes.

Apply one run/offer scope predicate before all event mutations, include run attribution on run inventory events, and track ordering. Add foreign-run reducer tests for inventory, order, and notification events.

### F24 — A stale live inventory overlay overrides authoritative recovery (Medium)
**Slices:** 5

Same-run recovery deliberately retains `liveInventory`, and the selector always prefers that overlay over the new backend snapshot (`apps/web/src/lib/live-dashboard-state.ts:138`, `apps/web/src/lib/live-dashboard-state.ts:326`). After a missed SSE event, refresh can fetch correct lower stock but continue displaying stale stock indefinitely.

Clear the overlay on recovery or retain it only with a provably newer source version. Replace the existing stale-preservation expectation with reconnect/missed-event coverage.

### F25 — Recovery omits the existing order-outcome aggregate (Medium)
**Slices:** 5

The Redis package exposes `readOrderOutcomeAggregate`, but the recovery contract and reader omit it (`packages/db/src/order-outcomes.ts:80`, `packages/contracts/src/recovery.ts:54`, `apps/api/src/services/dashboard-recovery-reader.ts:35`). A refreshed viewer can show zero processing/confirmation/failure/notification counts forever if no later event repairs them.

Add a run-scoped outcome recovery DTO/reader and replace live outcome state from the authoritative aggregate before applying newer events. Test fresh load and reconnect after terminal outcomes.

### F26 — The public SSE endpoint has no connection limit (Medium)
**Slices:** 5

The unauthenticated events route registers every hijacked socket, while `DashboardSseHub` keeps an unbounded connection set and fans every heartbeat/event to all clients (`apps/api/src/routes/dashboard-routes.ts:24`, `apps/api/src/services/dashboard-sse-hub.ts:32`). Per-connection buffering does not prevent file-descriptor, memory, or broadcast-work exhaustion.

Add validated global/per-client limits, reject before hijacking, and apply edge rate limits. Test concurrent registration, rejection, and capacity release.

### F27 — Run History returns every summary without pagination (Medium)
**Slices:** 5

The public contract is an unbounded array, the route accepts no cursor, and the database query has no limit (`packages/contracts/src/run-history.ts:98`, `apps/api/src/services/run-history-reader.ts:38`). Anonymous requests grow without a resource bound and the page renders the entire history.

Add cursor pagination with a server maximum and stable `(capturedAt, id)` ordering, plus UI traversal and large-dataset tests.

### F28 — Admin passphrase login allows unlimited online guesses (Medium)
**Slices:** 5

The public session route verifies every submitted passphrase with no client/global budget, delay, or lockout (`apps/web/src/app/api/admin/session/route.ts:19`, `apps/web/src/lib/admin-session.ts:94`). A successful guess grants unsafe administrative controls, making the shared secret an unlimited cheap online oracle.

Use a shared-store per-client and global limiter, return 429 with bounded retry timing, and add edge limits. Test repeated, concurrent, expiry, and multi-instance attempts.

### F29 — Invalid advanced VU relationships pass validation and fail after run acceptance (Medium)
**Slices:** 6

The steady-arrival schema and cap validator check `preAllocatedVUs` and `maxVUs` independently but never require `maxVUs >= preAllocatedVUs` (`packages/contracts/src/load.ts:38`, `packages/contracts/src/preset-validation.ts:120`). The generator copies the invalid pair to k6 (`apps/load-orchestrator/src/services/k6-script.ts:73`), so API acceptance can consume a run slot/budget before execution fails.

Add the cross-field invariant to both schema and cap validation, with equality/increasing/decreasing contract, start, and generator tests.

### F30 — Traffic boundary contracts accept impossible lifecycle states (Medium)
**Slices:** 6

Completion and start-ack schemas reuse the full execution enum (`packages/contracts/src/load.ts:151`, `packages/contracts/src/load.ts:167`). Thus `active` completion passes validation and is treated as terminal failure, while a `failed` start acknowledgement can be treated as successful delegation (`apps/api/src/services/load-completion-ingest.ts:62`, `apps/api/src/services/run-start-service.ts:305`).

Use boundary-specific literal/discriminated schemas: start acknowledgement must be `starting`; completion must be `succeeded|failed` with coherent fields. Add contract and route/service rejection tests.

### F31 — The reference runtime can report healthy without required secrets (Medium)
**Slices:** 7

Compose makes `.env` optional, API/orchestrator allow a missing control token, and web secrets are read lazily; readiness does not expose these unavailable capabilities (`docker-compose.yml:11`, `apps/api/src/runtime/config.ts:179`, `apps/load-orchestrator/src/index.ts:18`). Services can be healthy while completion callbacks are rejected, admin controls are unavailable, and public visitors collapse to the same anonymous identity.

Fail startup or readiness deterministically when reference-runtime secrets are missing, and add clean-environment compose plus authenticated completion-flow tests.

### F32 — The isolated migration command can target an ambient development database (Medium)
**Slices:** 7

The test runner suffixes `TEST_DATABASE_URL` but preserves ambient shell variables, while the migration CLI prefers `DATABASE_URL` (`scripts/run-with-test-env.mjs:50`, `packages/db/src/cli/migrate.ts:17`). With both set, `pnpm test:db:migrate` can silently migrate development/hosted data.

Pass an explicit test target, reject non-test database names, and add a command test with both variables set.

### F33 — Worker integration files can erase each other's shared Redis state (Medium)
**Slices:** 7

The worker package shares one Redis logical DB; DB-backed files serialize a database lock but call `flushdb`, while Redis-only queue tests use the same DB without that lock (`scripts/run-with-test-env.mjs:19`, `apps/worker/test/integration/process-order.test.ts:81`, `apps/worker/test/integration/order-process-worker.test.ts:20`). Parallel files can delete each other's queue state, producing timing-dependent results.

Give each file a namespace/database or use a Redis-scoped lock and owned-key cleanup. Add repeated parallel stress coverage.

### F34 — The by-id cleanup command can delete an active run with jobs in flight (Medium)
**Slices:** 7

`maintenance:cleanup-run` deletes any specified run regardless of status and does not coordinate with queues (`packages/db/src/run-cleanup.ts:170`, `packages/db/src/cli/cleanup-run.ts:20`). The smoke waits a fixed three seconds after traffic success, when the run may still be draining, then invokes it (`scripts/runtime-smoke-load.mjs:186`, `scripts/runtime-smoke-load.mjs:232`). Consumers can race deleted rows and unfinished state is discarded.

Restrict cleanup to owned terminal smoke runs, wait for summary/notification settlement, and coordinate run-attributed jobs for any forced cleanup. Test slow/retrying jobs and rejection of arbitrary active runs.

### F35 — The root unit, watch, and coverage lane cannot run the complete web unit suite (Medium)
**Slices:** 8

Root Vitest includes only `*.test.ts`, uses Node, and lacks the web `@/` alias (`vitest.unit.config.ts:7`, `vitest.aliases.ts:8`), unlike the package config (`apps/web/vitest.config.ts:11`). `pnpm test:unit` fails on an included web import after 572 assertions, and all 13 `.test.tsx` React suites are silently omitted from unit/watch/coverage.

Use Vitest projects or per-package configs so the root lane preserves web aliases, jsdom, plugins, setup, and TSX discovery. Add a command-contract collection test.

### F36 — Automated tests never exercise the deployed cross-service composition (Medium)
**Slices:** 8

API lifecycle tests replace queues/launchers with recorders, worker tests wire consumers with ERP doubles, and notification persistence is exercised separately (`apps/api/test/api/demo-runs.test.ts:102`, `apps/worker/test/integration/process-order.test.ts:220`). No automated test imports the production composition roots, so the full suite can pass if API-to-BullMQ-to-worker-to-HTTP-ERP-to-notification wiring is disabled or miswired.

Extract closeable runtime factories and add a one-request isolated composition test using real PostgreSQL, Redis, BullMQ, Mock ERP HTTP, both consumers, and durable outcome assertions.

## Low Severity

### F37 — Catalog offers remain purchasable after their eligibility window closes (Low)
**Slices:** 1

Catalog offers have active/start/end fields (`packages/db/src/schema.ts:89`), but requests without `runId` skip eligibility checking and go directly to Redis (`apps/api/src/services/reserve-order-service.ts:105`). Stale initialized inventory can authorize an inactive or expired offer.

Materialize catalog eligibility into the atomic Redis authority or retire its namespace on close. Test inactive, future, and ended offers without adding a PostgreSQL read to the sold-out hot path.

### F38 — Frozen run snapshots and immutable summaries remain updateable (Low)
**Slices:** 2

`demo_runs.config_snapshot` and `demo_run_summaries` are ordinary updateable data despite caching and audit assumptions (`packages/db/src/schema.ts:117`, `packages/db/src/schema.ts:350`). Operational or future writes can make workers and API readers disagree or rewrite history.

Reject updates through triggers/roles while preserving intentional deletion, and add migration tests that direct updates fail.

### F39 — API recovery reports traffic as starting for the entire active execution (Low)
**Slices:** 4

The API marks a run active while retaining `trafficStatus: "starting"`, and receives no callback until terminal completion (`apps/api/src/services/run-start-service.ts:255`, `apps/api/src/services/load-completion-ingest.ts:65`). Refreshed dashboards misreport long active executions as still starting.

Add an authenticated active-status callback or define API promotion as traffic-active, with end-to-end status progression coverage.

### F40 — The orchestrator breaks the run-start correlation chain for callbacks (Low)
**Slices:** 6

The API forwards the request correlation ID, but the orchestrator route drops it when starting background work and reporters generate fresh IDs for callbacks (`apps/load-orchestrator/src/routes/load-routes.ts:27`, `apps/load-orchestrator/src/services/traffic-reporter.ts:68`). Start, execution, metric, and completion logs cannot be followed as one trace.

Carry an execution context containing the initiating correlation ID through all callbacks and logs. Add an end-to-end unit chain.

### F41 — The web BFF exposes two incompatible error payload vocabularies (Low)
**Slices:** 6

Upstream API errors use top-level `ErrorPayload`, while local proxy errors are nested `{ error: ... }`; clients only read the nested shape (`apps/web/src/lib/admin-api.ts:33`, `apps/web/src/lib/admin-api.ts:63`, `apps/web/src/components/admin-runtime-policy-form.tsx:54`). Real API details and correlation IDs collapse to generic UI messages.

Validate and normalize every BFF failure to one shared contract, preserving diagnostics, and add proxy-to-client tests for upstream and local failures.

### F42 — The documented format gate fails on the current branch (Low)
**Slices:** 7

`pnpm format:check` exits 1 on `apps/api/test/unit/sold-out-finalization.test.ts:78` and `packages/db/test/integration/schema.test.ts:128`, leaving the standard handoff/CI command red.

Apply the existing formatter and enforce the root gate in CI.

### F43 — Runtime documentation contains stale lifecycle and wipe instructions (Low)
**Slices:** 7

README and smoke/env comments describe delivered finalization/run-offer behavior as future work (`README.md:7`, `scripts/runtime-smoke-load.mjs:9`, `.env.example:27`). Wipe recipes omit `runtime:up` even though setup starts only data services (`docs/local_development.md:65`, `README.md:127`). Reviewers can misread delivered behavior or finish with a stopped runtime.

Update phase-era text and document the complete wipe/setup/up sequence; add lightweight command-reference checks.

### F44 — Web tests pass while React reports unsynchronized state updates (Low)
**Slices:** 8

Web tests assert initial renders while mount effects later update state (`apps/web/test/unit/admin-run-controls.test.tsx:48`, `apps/web/src/components/run-controls.tsx:34`), producing five `act(...)` warnings without failing the suite.

Await settled effects, assert post-fetch state, clean up timers, and fail tests on unexpected console warnings with narrow exceptions.

## Notes

### N1 — Pending-persistence Redis transaction results are not inspected
**Slices:** 1

`markReservationPendingPersistence()` ignores per-command `MULTI/EXEC` result tuples (`packages/db/src/inventory.ts:195`). A command-level error can leave the index/hash partially updated while the wrapper reports success. Validate every tuple and add a wrong-type fault test.

### N2 — Pending-persistence reconciliation materializes but does not resolve the hold
**Slices:** 2

The reconciler copies the Redis sentinel to a durable `pending_reconciliation` row but leaves both unresolved, while finalization may proceed (`apps/api/src/services/pending-persistence-reconciler.ts:44`, `apps/api/src/services/run-finalization-service.ts:117`). Product policy should explicitly decide whether explained pending holds permit completion or require timeout/failure.

### N3 — Startup reconciliation is a one-shot best-effort repair
**Slices:** 4

Per-run errors are swallowed and reconciliation runs only once before listening (`apps/api/src/services/startup-reconciliation-service.ts:69`, `apps/api/src/index.ts:406`). A transient repair failure can leave stale state for the process lifetime. Bounded retry or readiness degradation would improve recovery.

### N4 — Runtime validation is inconsistent outside typed service config loaders
**Slices:** 7

Worker Mock ERP and web upstream URL/numeric settings receive weaker or lazy validation (`apps/worker/src/runtime/config.ts:77`, `apps/web/src/lib/api.ts:32`). Compose defaults are valid, so this is retained as a note; shared startup validation would make the documented fail-fast contract reliable.

## Validation Performed

- All eight slice reviewers re-opened their reports and validated report syntax plus referenced path/line bounds.
- Full `pnpm test` passed: 854 tests across 122 files; two real-k6 tests were capability-skipped because host `k6` is unavailable.
- Full workspace build and lint passed. Focused contracts/logger/API/worker/web/load-orchestrator/Mock ERP suites and relevant type checks also passed in their slices.
- `docker compose config --quiet` and `docker compose -f docker-compose.test.yml config --quiet` passed.
- `pnpm test:unit` failed as documented in F35. `pnpm format:check` failed as documented in F42.
- Destructive runtime reset/wipe/load-smoke/cleanup commands, destructive dependency-outage injection, and the full compose/browser runtime were not run against shared development/demo data.

## Appendix — Checked and found sound

- The Redis reservation decision is atomic and its real-infrastructure concurrency tests prevent oversell; matching duplicates replay one hold, conflicts do not consume stock, and sold-out requests avoid per-request durable rows.
- Buy routes remain thin, validate shared contracts, reconcile run attribution, and delegate workflow logic through injected services.
- Normal buy persistence writes reservation, queued order, and initial events transactionally with run/offer/correlation attribution.
- Generated run sale offers have unique run/offer ownership context, and migrations enforce the normal ownership relationship.
- Required public presets and runtime policy are seeded; public presets remain read-only and public custom does not persist changes.
- Worker queue payloads carry run, offer, order, reservation, correlation, quantity, and occurrence data; consumers validate them at entry.
- Normal sequential worker flow persists `queued -> processing -> confirmed|failed`, records ERP attempts, and creates notification work only after confirmation.
- ERP HTTP calls propagate correlation, use abort timeouts, validate responses, and apply exponential retry/backoff; normal breaker open/recovery paths are covered.
- Load script generation uses JSON literals and argument-array spawning rather than shell interpolation; buyer-spike and steady-arrival modes otherwise preserve accepted snapshot semantics.
- Delivery grading correctly detects measured major under-delivery, and clean sold-out/zero-stock traffic is not inherently failed.
- Admin mutation proxies and API control routes enforce server-side sessions/service tokens; public bodies cannot self-assert admin mode.
- Public history DTOs omit reservation tokens, idempotency keys, service secrets, internal URLs, and raw private payloads.
- Realtime envelopes are schema-validated, malformed frames are dropped, and individual slow SSE clients have bounded buffering.
- Test PostgreSQL/Redis infrastructure is separated from development defaults, and destructive PostgreSQL reset has a test-target guard.
- Reference compose topology, service DNS, Caddy SSE routing, k6 container installation, Turborepo build ordering, and root build/lint commands were validated.
