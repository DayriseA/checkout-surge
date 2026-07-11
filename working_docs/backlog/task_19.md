# Task 19: Add resource limits to public dashboard reads and SSE connections

## Execution context

- **Execution order:** This is task 19 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1 (security/availability)
- **Area:** API / realtime
- **Source:** independent review (medium)
- **Donor/reference findings (inlined; no external checkout required):** See the verified GLM mechanics, current-branch gap analysis, and adaptation map below. The useful donor code is limited to a per-process SSE ceiling and shared-timer lifecycle; it does not solve per-source admission, recovery-read throttling, or deployment-wide accounting.
- **Locations:** `apps/api/src/realtime/dashboard-event-fanout.ts:30`, `apps/api/src/services/dashboard-recovery-service.ts:149`

Every public SSE client enters an unbounded in-memory map with no global or per-source cap, and unthrottled public recovery fans each request into seven PostgreSQL/Redis/BullMQ/ERP projections. An unauthenticated caller can consume sockets, memory, and dependency capacity in direct competition with the buy path.

## Verified donor and design context

At GLM commit `c07e0de15be815d84419a1c2abd2967f72de0463`, the relevant implementation is:

- `apps/api/src/app/config.ts`, `ApiConfig.dashboardHeartbeatIntervalMs` and `ApiConfig.dashboardMaxSseClients`, parse positive integers from `DASHBOARD_HEARTBEAT_INTERVAL_MS` (default `15000`) and `DASHBOARD_MAX_SSE_CLIENTS` (default `200`). The same fields are documented in `apps/api/.env.example` and `docs/local_development.md`.
- `apps/api/src/app/routes/dashboard.ts`, `dashboardRoutes`, checks `fanout.clientCount >= config.dashboardMaxSseClients` before hijacking the reply. A full gateway returns HTTP `503` with the normal error envelope and code `realtime_at_capacity`; accepted clients receive the SSE headers, `retry: 3000`, and an opening heartbeat before registration. The route unregisters on request `close`/`error`; a thrown write or `response.write(...) === false` closes the client rather than buffering it.
- `apps/api/src/app/dashboard-realtime/fanout.ts`, `createDashboardRealtimeFanout`, owns one `Set<DashboardRealtimeSink>` and one process-wide interval, not one timer per connection. `start()` subscribes once and starts the unref'd interval; each tick sends `formatSseHeartbeat()` to all sinks. `stop()` clears the timer, removes the Redis message listener, clears all sinks, and unsubscribes. A throwing sink is removed without aborting delivery to the remaining sinks.
- `apps/api/src/app/dashboard-realtime/sse-frame.ts`, `formatSseHeartbeat`, emits the comment frame `:heartbeat\n\n`, which keeps intermediaries alive without surfacing a browser event.
- `apps/api/tests/dashboard-fanout.unit.test.ts` covers registration counts, shared heartbeat delivery, throwing-sink detachment, and stop cleanup. `apps/api/tests/dashboard-realtime.integration.test.ts` covers the opening frames, real disconnect decrementing `clientCount`, and end-to-end fan-out. The donor does **not** appear to have a focused test for the at-capacity response, so that behavior should not be copied without adding one.

The controlling design requirement is already in GLM's `docs/admin_access_protection.md`: the **Configured Safety Caps** table explicitly lists connection limits, request rate limits, and maximum snapshot page sizes for realtime/read paths. Its implementation boundary also says rate limits/run budgets should use an explicit shared or injected store where needed, not module-level infrastructure clients. Public observability remains intentional; these are availability controls, not an authentication requirement.

## Current branch facts and amplification

The current branch already implements part of the donor pattern, so do not replace it wholesale:

- `apps/api/src/realtime/dashboard-event-fanout.ts`, `DashboardEventFanout`, has one `clients: Map<string, DashboardSseClient>` and one `heartbeatTimer`. `ensureHeartbeat()` starts the unref'd timer only when the first client is added, and `closeClient()` stops it when the last client leaves. `connect()` writes `retry: 3000` plus `: connected`, and `publish()`/heartbeat delivery close clients on exceptions or backpressure. Request close, response close, and `DashboardEventFanout.close()` all remove clients. Preserve this on-first-client/off-last-client lifecycle; GLM's always-on process timer is not an improvement for this class.
- `DashboardEventFanout.connect()` currently returns `void`, always writes HTTP `200`, and adds every connection to the map. `apps/api/src/routes/dashboard-routes.ts`, `registerDashboardRoutes`, hijacks first and delegates without any admission decision. `apps/api/src/runtime/config.ts`, `ApiConfig`/`loadApiConfig`, has no SSE or recovery limit fields. Once a reply is hijacked, it is too late to return a normal JSON capacity error.
- `DashboardRecoveryService.getRecovery()` first calls `DashboardRecoveryContextReader.readContext()` (a PostgreSQL active-run/catalog lookup), then launches seven logical projections with `Promise.all`: inventory (Redis), queue status (BullMQ/Redis), ERP status, business outcome (PostgreSQL), consistency lag (PostgreSQL), recent traffic metrics (Redis), and completion outcomes (PostgreSQL). ERP status itself reads the Redis circuit snapshot, calls queue status **again**, and performs four PostgreSQL queries in `PostgresErpAttemptStatusReader.readStatus()`. Thus one HTTP recovery is more than seven physical dependency operations and duplicates the expensive queue inspection.
- `apps/api/src/routes/dashboard-routes.ts` calls this workflow for every `GET /dashboard/recovery` with no rate, concurrency, or coalescing boundary. `apps/web/src/app/api/dashboard/recovery/route.ts` is a no-store public proxy and does not throttle either. Browser reconnect/refresh behavior can legitimately request recovery repeatedly, so rejection must be explicit and retryable rather than looking like a corrupt snapshot.

## Required implementation shape

### 1. Make SSE admission bounded and atomic at the fan-out boundary

Add positive, startup-validated API configuration for a total per-process SSE ceiling and a per-source ceiling (for example `DASHBOARD_MAX_SSE_CLIENTS` and `DASHBOARD_MAX_SSE_CLIENTS_PER_SOURCE`), wire it in the composition root, and document/default it in the same runtime/env surfaces as the other API limits. A value of `0` must not silently mean unlimited.

Move the admission decision into `DashboardEventFanout` rather than doing a route-level `clientCount()` check followed by an unrelated `connect()`. Give each stored client its normalized `sourceKey`, reserve total and per-source capacity synchronously, and return a discriminated result such as `connected | total_capacity | source_capacity`. Only an accepted result may write the `200` SSE headers and enter the map. All teardown paths must decrement both the map and per-source count exactly once; repeated request/response close events and server shutdown must remain idempotent. Do not create a timer, queue, Redis subscriber, or replay buffer per browser.

`registerDashboardRoutes` must ask for admission before `reply.hijack()` (or let a fan-out admission method clearly separate reservation from stream opening). Reject total capacity with HTTP `503`, stable code `dashboard_sse_at_capacity`, the shared `ErrorPayload` shape, and `Retry-After`; reject a source ceiling with HTTP `429`, stable code `dashboard_sse_source_limit_exceeded`, and `Retry-After`. Never emit partial SSE headers/frames on rejection. Preserve accepted-stream correlation ID, reconnect guidance, heartbeat comments, backpressure-close behavior, and cleanup logging.

Source identity must not be a raw caller-controlled header. Use `request.ip`/socket address under an explicitly configured trusted-proxy policy, normalizing IPv4-mapped IPv6 and IPv6 prefixes consistently. The reference Caddy/web topology must forward the address, and Fastify must trust only the known proxy boundary; `trustProxy: true` against arbitrary direct callers would let them rotate `X-Forwarded-For`. If a trustworthy per-visitor identifier is introduced later, keep the source resolver injectable so the accounting policy can change without entering the fan-out class.

The total and per-source connection counts are process-local unless a lease protocol is deliberately added. Document that replicas multiply the deployment total. Do not pretend a Redis increment/decrement is sufficient for long-lived connections: a deployment-global counter requires expiring leases, renewal, disconnect cleanup, and crash recovery. For this task, a conservative per-process cap combined with the deployment's replica count is acceptable; if a true deployment-global cap is selected, implement and test the complete lease lifecycle.

### 2. Bound the expensive recovery read before dependencies are touched

Add an injected recovery-admission/rate-limit capability at the API application boundary and call it from the thin `/dashboard/recovery` route **before** `DashboardRecoveryService.getRecovery()`. It must enforce:

- a small per-process maximum of concurrent in-flight recovery builds, so an allowed burst cannot occupy the PostgreSQL pool and Redis/BullMQ connections indefinitely; release the permit in `finally` on success, projection failure, client disconnect, or thrown validation;
- a deployment-shared global request budget and a per-source request budget with bounded TTL state (Redis is already the shared store). The update/check must be atomic, keys must expire, and limiter dependency failure must fail closed for this expensive public path rather than silently removing protection.

Keep Redis construction in `apps/api/src/index.ts`; inject a focused port/service into route registration. Do not put Redis calls or business work directly in `dashboard-routes.ts`. Use a trustworthy source resolver as described above. Because the normal `/api/dashboard/recovery` browser request is server-proxied by `apps/web`, do not accidentally identify every visitor as the web container: either enforce the per-visitor edge budget in the web route and retain an API global/shared budget, or forward an API-verifiable server-derived source identity across an authenticated internal boundary. A browser-supplied forwarding header alone is not acceptable.

When a request exceeds a source/global rate budget, return HTTP `429`, `Retry-After`, and the existing contract-valid error envelope with a stable code such as `dashboard_recovery_rate_limited`. When the local concurrency guard is full, return HTTP `503` with code `dashboard_recovery_at_capacity` and `Retry-After`. Rejected requests must perform zero context/projection reads. Keep the successful `DashboardRecoveryResponse` contract and its current best-effort per-projection null/empty fallbacks unchanged.

Short-TTL successful-result coalescing may be added behind `DashboardRecoveryService` to reduce duplicate builds, but it is not a substitute for admission control. If used, share only an in-flight/successful immutable snapshot for the same current-run scope, never cache failures, bound its lifetime, and preserve `recoveredAt` semantics. Do not serve a prior run's snapshot after start/reset/terminal transitions.

### 3. Preserve buy-path capacity and observability

Choose defaults relative to `API_POSTGRES_POOL_MAX`, expected dashboard tabs, proxy timeouts, and replica count; document the reasoning rather than copying GLM's `200` blindly. Emit structured, low-cardinality logs/metrics for accepted/rejected SSE counts, active total connections, recovery rejection reason, and in-flight recovery count. Do not log raw IP addresses/source identifiers; hash or aggregate them if source diagnostics are necessary. Rate-limiter keys and metrics must remain bounded and must not use correlation IDs as identities.

## Adaptation map

| Concern | Current owner to change | Reusable donor detail | Required adaptation |
| :-- | :-- | :-- | :-- |
| Typed limits | `apps/api/src/runtime/config.ts`, `ApiConfig`/`loadApiConfig`; composition in `apps/api/src/index.ts`; env/runtime docs | GLM positive-integer parsing and `15000`/`200` documented fields | Preserve current heartbeat default unless configurability is desired; add total/per-source SSE and recovery budget/concurrency fields with explicit defaults and validation. |
| SSE admission/accounting | `apps/api/src/realtime/dashboard-event-fanout.ts`, `DashboardEventFanout` | `clientCount` ceiling concept, one registry, no per-client backlog | Make admission atomic in the owner; track normalized source counts; keep the current timer's first-client/last-client behavior and idempotent cleanup. |
| SSE HTTP errors | `apps/api/src/routes/dashboard-routes.ts`, `registerDashboardRoutes` | GLM rejects before hijack with `503 realtime_at_capacity` | Distinguish total `503` from per-source `429`, use current `ApiHttpError`/`createErrorPayload`, add `Retry-After`, and never partially open rejected streams. |
| Recovery admission | New focused service/port composed in `apps/api/src/index.ts`, invoked by `registerDashboardRoutes` | No donor implementation | Shared atomic TTL budgets plus local in-flight guard; reject before `getRecovery()` and always release permits. |
| Expensive workflow | `apps/api/src/services/dashboard-recovery-service.ts`, `DashboardRecoveryService.getRecovery` | No donor implementation | Preserve response/fallback semantics; optional bounded coalescing only after admission. Note and avoid compounding the duplicate queue read where practical without widening the task into an ERP redesign. |
| Browser proxy/source identity | `apps/web/src/app/api/dashboard/recovery/route.ts` and trusted proxy configuration | No donor implementation | Enforce/forward only server-derived identity; do not trust arbitrary browser headers or collapse all visitors into one proxy source bucket. |
| Focused coverage | `apps/api/test/dashboard-event-fanout.test.ts`, `apps/api/test/api.test.ts`, plus focused limiter tests; web proxy test if changed | GLM fan-out and disconnect tests | Add cap, race/cleanup, zero-downstream-work rejection, limiter failure, expiry/window, proxy identity, and multi-instance-assumption coverage. |

## Focused verification

- Config tests reject missing/invalid/non-positive limit values where required and accept documented defaults/overrides.
- Fan-out unit tests fill total and per-source limits, prove the next connection receives the correct result without entering the map or starting extra timers, and prove a different source can connect when only one source is capped.
- Exercise request close, response close, initial-write backpressure, heartbeat/event backpressure, thrown writes, repeated close events, and server shutdown; each must free exactly one total/per-source slot, stop the sole timer at zero clients, and allow a later reconnect.
- Route/API tests assert `503 dashboard_sse_at_capacity` and `429 dashboard_sse_source_limit_exceeded`, contract-valid correlation/timestamp fields, `Retry-After`, and no SSE headers/body prefix on rejected connections. Keep the accepted reconnect/heartbeat/event tests.
- Recovery limiter tests use deterministic time and an injected fake/shared store to cover per-source and global windows, atomic concurrent attempts, TTL expiry, local in-flight saturation, permit release after success and throw, and fail-closed store errors.
- API tests prove every rejected recovery request invokes neither `DashboardRecoveryContextReader` nor any of the seven projection readers; an allowed request still returns the unchanged schema and projection failures retain existing null/empty degradation behavior.
- If web-edge source limiting/forwarding is added, test that caller-provided identity headers are ignored, distinct trusted visitor sources remain distinct, and the API verifies the internal assertion.
- Do not run apps or broad end-to-end load tests for this task. The implementing agent should run only the focused unit/API integration/config/web-route checks that cover the changed boundaries and report any infrastructure-backed Redis test that could not run.

## Scope and non-goals

This task is limited to availability controls for `/dashboard/events` and the expensive `/dashboard/recovery` read, their configuration/composition, trusted source derivation, observability, and focused tests. Keep both surfaces publicly readable. Do not add dashboard authentication, change buy-path limits, redesign recovery payloads, add event replay/IDs/backlogs, replace SSE, introduce a general-purpose API gateway rate-limiting platform, paginate unrelated run-history endpoints, or broaden this into the Task 73 transport-mechanics work beyond preserving existing retry/header/backpressure behavior. Cross-replica SSE leases are optional only if implemented completely; otherwise document the per-process multiplication explicitly.
