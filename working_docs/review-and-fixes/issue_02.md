# Issue 02 — Recovery and readiness calls can wait indefinitely and exhaust recovery admission

## Classification

- Priority: P1
- Status: Fix implemented and regression-tested
- Affected path: Public home, Watch, Admin, API readiness, runtime health
- Trigger observed alongside: `issue_01.md`

## Resolution status (2026-07-19)

Recovery and readiness now have bounded, cancellation-aware control-plane workflows:

- Dashboard recovery uses one five-second `DASHBOARD_RECOVERY_TIMEOUT_MS` deadline covering Redis admission and the full recovery operation. The HTTP lifecycle aborts that operation when the request is aborted or the response connection closes.
- `DashboardRecoveryWorkflow` owns admission and exact-once release. Admission-pending work, successful recovery, ordinary rejection, deadline expiry, client disconnect, and abort/completion races all return the local permit.
- Deadline expiry returns the shared-contract-valid HTTP `503 dashboard_recovery_timed_out` error with the request correlation ID. A disconnected caller releases its work without attempting another response.
- Recovery projection reads receive the operation `AbortSignal`. Each admitted recovery owns bounded PostgreSQL, Redis, and BullMQ clients that are closed after success and disconnected or terminated on abort.
- The abort-aware PostgreSQL adapter retains the postgres.js cancellation handle hidden by the ordinary Drizzle adapter. Aborting removes a query still queued for a pool checkout, sends PostgreSQL cancellation for an active statement, and terminates the operation-owned pool.
- API readiness starts its PostgreSQL, Redis, and BullMQ checks concurrently under one validated `API_READINESS_TIMEOUT_MS` deadline, two seconds by default and strictly below the Compose three-second health-check timeout. Missing the deadline produces the existing unavailable readiness checks and HTTP 503 representation.
- Readiness is single-flight per API process. Concurrent callers share the active operation, preventing health traffic from creating unbounded operation-owned dependency clients; a later request starts a fresh check after the shared operation settles.
- The default per-process PostgreSQL capacity is documented as the ten-connection long-lived application pool, one reset-workflow client, up to three one-connection recovery pools, and at most one coalesced readiness connection.

Coverage added or updated:

- HTTP lifecycle tests cover disconnect signals, stable deadline reasons, listener removal, and timer cleanup.
- Workflow and admission tests cover a limiter promise that never settles, three abandoned admitted recoveries, recovery after temporary capacity exhaustion, exact-once release, non-cooperative recovery work, and simultaneous abort/completion.
- Recovery service tests prove a pending projection settles on abort and closes its operation-owned resources.
- Readiness tests prove concurrent dependency execution, bounded unavailable results for never-settling checks, single-flight sharing, caller-isolated results, and fresh checks after settlement.
- The PostgreSQL integration test starts an actual `pg_sleep`, queues a second query behind a max-one pool, aborts both, verifies the active statement disappears from `pg_stat_activity`, closes the owned pool within a hard bound, and proves a later healthy pool can query successfully.

Verification completed:

- Full API suite: 37 files and 448 tests passed before the two focused review corrections; the corrected workflow, route, service, admission, lifecycle, readiness, and runtime-config suites passed afterward.
- Focused recovery/readiness verification reached 54 passing tests, including the real PostgreSQL cancellation and pool-reuse integration.
- Contracts tests passed with 111 tests; database unit tests passed with 54 tests.
- API, contracts, and database builds/type-checks passed, as did all 11 production Turbo type-check tasks.
- Repository lint checked 408 files successfully; runtime image contract tests passed with 7 tests; root, test, and Dev Container Compose configurations passed `config --quiet`; `git diff --check` passed.
- The prohibited composition and characterization suites were not run.

Known unrelated verification limitation:

- The root test-source type-check remains blocked only by the pre-existing Drizzle `PgEnum` generic variance errors in `packages/db/test/unit/vocabulary-parity.test.ts`; no Issue 02 file remains in its error output.

No fresh live reference-runtime fault-injection run was performed for this issue. The underlying cancellation guarantee is exercised against real PostgreSQL, while the HTTP, admission, readiness, Redis/BullMQ teardown boundaries, configuration, and Compose budget are covered deterministically or statically.

## Issue observed

While PostgreSQL was exhausted by the generated-run deadlock, three dashboard recovery requests entered the API and remained pending for more than nine minutes:

- `9eb98988-ccac-4c34-8177-591e0513ee1c` started at `16:25:03.051` UTC.
- `681858d3-d858-4d93-a1c8-fc1a8800f0ef` started at `16:25:04.183` UTC.
- `c89e002e-eaa0-4699-bf5f-b6fac9bc2f0f` started at `16:25:13.109` UTC.

The upstream health/browser clients had already timed out or disconnected, but the API work continued to occupy all three `DASHBOARD_RECOVERY_MAX_CONCURRENT` permits. Every later recovery request then failed immediately with HTTP `503 dashboard_recovery_at_capacity` (logged internally as `local_capacity`), affecting `/`, `/watch`, and `/admin` even after the initiating clients were gone.

API readiness also waited indefinitely on its dependency calls. Compose consequently marked the API unhealthy, and orchestrator completion delivery repeatedly timed out.

The database deadlock is documented separately, but recovery/readiness must remain bounded when a dependency is slow or unavailable. Otherwise any database or Redis incident is amplified into a persistent control-plane outage.

## How to reproduce

1. Start the reference runtime.
2. Make the API database pool unavailable or saturate it with calls that do not complete.
3. Start three dashboard recovery requests and let the clients time out/disconnect.
4. Send another recovery request.
5. Call API readiness.

The fourth recovery request returns HTTP `503 dashboard_recovery_at_capacity` (logged as `local_capacity`), the original recovery operations remain active, and readiness does not return within the caller's health-check window.

## Identified cause

Recovery admission is released only when the full recovery promise settles:

- the route acquires a permit and releases it in `finally` after `getRecovery` (`apps/api/src/routes/dashboard-routes.ts`);
- client disconnect/abort is not connected to cancellation of `getRecovery`;
- recovery first performs a PostgreSQL context lookup and then several projection reads (`apps/api/src/services/dashboard-recovery-service.ts`);
- `readSafely` converts dependency rejections into degraded results, but it supplies no deadline or `AbortSignal` and cannot help when a call never settles;
- the admission implementation correctly accounts for explicit acquire/release, but cannot reclaim an abandoned operation by itself (`apps/api/src/services/dashboard-recovery-admission.ts`).

Readiness has the same boundedness problem at a different boundary. It awaits database, Redis, and queue checks without a per-check deadline or propagated cancellation (`apps/api/src/runtime/readiness.ts`). A stuck dependency therefore prevents the HTTP response instead of producing a contract-valid unavailable/degraded response.

The recovery tests cover successful completion, thrown failures, and explicit release. They do not cover client disconnect while downstream I/O is pending.

## Recommended actions

1. Give recovery an end-to-end deadline and propagate an `AbortSignal` through the route, recovery service, and dependency adapters.
2. Tie request close/abort events to cancellation, and make permit release exactly-once for success, rejection, deadline, and disconnect paths.
3. Cancel or terminate the underlying PostgreSQL/Redis operation where supported. A `Promise.race` that returns early while hidden work continues is insufficient because it still consumes pool connections and server work.
4. Bound each readiness dependency check and the overall readiness response. Return the existing contract-valid `503`/degraded representation within the health-check budget when a required dependency is not responsive.
5. Keep the routes thin: put deadline/cancellation behavior in injectable services or adapters so it can be tested deterministically.
6. Add tests for a dependency promise that remains pending, a disconnected client, simultaneous timeout and completion, and recovery after all permits were temporarily occupied.

## Acceptance criteria

- [x] Recovery completes or returns a contract-valid error within a documented bound when PostgreSQL, Redis, or the queue is blocked. The five-second end-to-end deadline maps to `503 dashboard_recovery_timed_out`, and operation-owned dependency clients receive the same abort signal.
- [x] Disconnecting the client cancels downstream work where possible and releases the recovery permit exactly once. HTTP lifecycle, workflow, service, and admission tests cover disconnect and release races.
- [x] After three abandoned requests, admission returns to zero active permits and a later healthy recovery request succeeds. The workflow regression occupies all three permits, aborts them, and then completes a healthy recovery.
- [x] Readiness always responds within the Compose health-check budget, including during dependency failure. All three checks share a validated two-second deadline below the three-second probe timeout, and never-settling dependency coverage returns unavailable checks.
- [x] No orphan PostgreSQL statement or pool checkout remains after the request deadline/abort path. The real PostgreSQL integration test cancels active and pool-queued work, observes the statement leave `pg_stat_activity`, terminates the owned pool, and succeeds through a later pool.
- [x] Existing recovery degradation and correlation/error contracts remain intact. Existing projection-failure behavior remains best-effort, successful responses retain schema validation, and timeout errors use the shared error vocabulary and request correlation ID.

## Scope guard

This is resilience work for existing control-plane paths. It does not require a new monitoring feature or a redesign of the dashboard projections.
