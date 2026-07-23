# Task 38 — Publish revisioned projections with bounded delivery

## Execution context

- **Position:** 38/45; Phase 6, after Task 37 creates the shared revisioned projection and before the browser consumes it in Task 39.
- **Dependencies:** Task 37's one projection authority, scope/revision contract, and chosen normal protocol are required. Task 36 provides baseline volume and slow-consumer expectations.
- **Standalone:** Deliver the latest coherent dashboard view at bounded cadence and bounded memory, without turning raw producer events or missed frames into a replay protocol.
- **Checklist / working record:** Primary ownership is snapshot publication scheduling and SSE/HTTP fan-out behaviour. Producers continue to own their aggregates; the projection service owns publication decisions; routes remain thin. Record cadence/thresholds, capacity limits, message counts, tests, and skipped checks below.

## Why

Complete projections are safe only if transport does not queue obsolete copies for slow clients or leave a final change stranded during a quiet period. The schedule must bound traffic by active scopes and cadence, not request/order count.

## Required outcome

Publish Task 37 projections through bounded coalescing/backpressure: a maximum-latency timer, an optional meaningful-work threshold, immediate lifecycle/terminal publication, and exactly the latest pending replaceable projection per scope for each slow consumer. Full-projection streaming must serve the same projection schema/revision over SSE and HTTP recovery. If Task 37 selected invalidation, SSE serves only a small scope/revision invalidation envelope and HTTP serves the complete projection with that same ordering contract.

## Concrete scope and paths

- `apps/api/src/**` snapshot/projection scheduler, fan-out, recovery service/routes, producer integration, and Redis event-boundary adapters.
- `packages/contracts/src/**` only for finalizing the shared projection/invalidation shape from Task 37.
- Existing API/SSE/recovery/Redis boundary tests and focused load helpers.

Use existing one-second load aggregation and coalesced inventory, queue, and business readers. Dirtied scopes schedule publication no later than a documented max latency; publication may occur sooner only after a documented meaningful-work threshold. Lifecycle and terminal changes bypass the delay. A quiet period must still flush the pending final state. Under slow writes/backpressure, replace—not append—the pending projection for a scope; never retain an unbounded per-message queue. Preserve bounded fan-out, connection caps, heartbeat, cancellation, and disconnect cleanup. HTTP recovery returns precisely the same schema and revision semantics as live delivery. If Task 37 selected invalidation, publish bounded revisioned invalidations and have the recovery read return the atomic projection; do not also send a parallel full stream.

## Retained behaviour and non-goals

Retain durable focused diagnostics and producer-side coalescing. Do not expose raw request/order occurrences, add replay buffers or sequence catch-up, reintroduce individual order-status/lag messages, or migrate/delete browser code in this task.

## Acceptance

- [x] Publication is bounded by max latency and documented meaningful-work policy.
- [x] Lifecycle and terminal updates publish immediately; quiet final state cannot be stranded.
- [x] Each slow consumer keeps at most the newest pending replaceable view per scope.
- [x] Connection caps, heartbeat, cancellation, cleanup, and bounded fan-out remain effective.
- [x] Full-stream mode uses the same complete schema over SSE and HTTP; invalidation mode instead uses one documented scope/revision invalidation envelope plus the complete HTTP projection, never both normal streams.
- [x] Representative load demonstrates delivery scales with scopes/cadence rather than raw event count.

## Focused verification

Run scheduler/fan-out unit tests, SSE and recovery route tests, Redis producer-boundary tests, and a bounded slow-consumer plus representative-load scenario. Do not run composition or characterization by default.

## Working record

Completed 2026-07-23.

Publication policy and ownership:

- `DashboardProjectionPublicationScheduler` is the one focused live-publication owner. The existing validated `DashboardEvent` subscription remains the only Redis input; each event is a dirty signal, never replay or projection data. The scheduler adds no subscription, cache, raw-event store, history, or aggregate reader.
- Ordinary dirty scope publication uses a **1,000 ms maximum-latency cadence**. There is **no meaningful-work/event-count threshold**: Task 36/37 evidence shows existing traffic, inventory, queue, and business producers already aggregate useful work, so another threshold has no measured justification.
- All `load.run.updated` lifecycle signals bypass the timer. A terminal `completed`/`failed` signal uses the event's exact `{ runId, saleOfferId }` scope so the terminal row remains selectable after it leaves the nonterminal-current query.
- `DashboardProjectionService` keeps actual assembly and operation cleanup serialized. A signal received during a build becomes one coalesced trailing dirty scope with its own deadline; it does not inherit the completed build's expired deadline or overlap the earlier operation. Every attempt receives a fresh abort signal and the existing `DASHBOARD_RECOVERY_TIMEOUT_MS` deadline (5,000 ms by default). A deadline failure settles the scheduler-facing attempt, aborts operation-owned resources, and retains the quiet scope for retry after one second; that retry remains behind actual cleanup. Real adapters must honor abort as required by the shared operation lifecycle. Shutdown stops admission, clears pending shutdown-only work, aborts the active attempt, disposes its timer, and does not requeue. Pending scopes are bounded at eight for the accepted one-API topology; the oldest dirty scope is dropped with a warning only if that fixed bound is crossed.
- `DashboardProjectionService` remains the sole assembler/revision allocator for both live and HTTP. The fan-out parses every live value through `dashboardProjectionSchema`; the recovery route parses the exact alias schema. No invalidation envelope or second projection protocol was introduced.

Fan-out and staged compatibility:

- Healthy sockets receive projection frames immediately. Once a socket reports backpressure, its existing complete-frame queue stores only the newest pending projection for each `scopeId`; a newer same-scope projection replaces the older pending bytes in place.
- Each client is bounded by eight pending projection scopes, the existing 32 total pending frames, and 256 KiB of pending UTF-8 bytes. Exceeding any bound disconnects only that client. Existing heartbeat serialization, total/per-source caps, cancellation, request/response listener cleanup, reconnect admission, and server shutdown remain covered.
- Task 38 intentionally keeps the legacy event fan-out and browser reducer functional. The Redis boundary delivers each validated event to the legacy fan-out and separately marks the projection scheduler dirty. The unchanged Task 38 browser ignores projection-shaped messages. Task 39 owns atomic browser replacement and Task 40 owns legacy producer/fan-out deletion.

Terminal recovery edge:

- The shared optional recovery query is an all-or-nothing `knownRunId` plus `knownSaleOfferId` pair. The web proxy validates and forwards only that pair; partial, malformed, or unknown query input returns contract-valid `400 invalid_request` without calling upstream.
- One PostgreSQL context statement selects the current nonterminal run and an exact run-and-sale known candidate. Selection prefers a current `starting`/`active`/`draining` run, otherwise falls back only to the explicitly known terminal. A nonexistent or mismatched advisory pair yields idle rather than an internal error; the internal exact live-build scope remains strict. Thus one Task 39 recovery read can either discover a newer active run or repair a missed terminal without promoting unrelated history, adding a cache, or adding another authority.

Representative measurement:

- Command: `pnpm runtime:smoke:load -- --dashboard-delivery-baseline`.
- Fixture/window: seeded public `preview-1k`, 1,000 planned requests and one measured run/offer scope; the existing common fixed 30,000 ms gate starts immediately before the run request after Redis and SSE establishment.
- Counting: the raw count remains the canonical Redis channel callback before API parsing/fan-out. Complete SSE data frames are separately parsed against `dashboardEventSchema` and exact `dashboardProjectionSchema`; projection attribution requires the measured run in the parsed projection scope. The cadence envelope is `ceil(duration / 1000) × activeScopeCount + 8`, with eight as a conservative immediate/lifecycle allowance.
- Final result: **1 active scope**, **1,057 raw Redis events**, **22 exact-schema/run-attributable projection frames**, and a **38-frame upper bound**. Projection delivery was 2.1% of raw event volume. Transitional compatibility also delivered all **1,057 legacy contract-valid/run-attributable updates**; total SSE delivery was 1,081 complete frames, 1,079 data frames, plus setup/heartbeat frames. The largest of six bounded HTTP projection samples was 8,434 UTF-8 bytes.
- An initial review run correctly failed the new cadence assertion with 1,040 raw events and 82 projection frames. Signals arriving during an in-flight build had inherited its expired deadline. The scheduler now removes captured work from the pending map, so a later signal owns a fresh deadline; the focused regression and final runtime result above prove the correction.

Focused verification:

- `pnpm build:shared` — passed.
- `pnpm exec vitest run packages/contracts/test/contracts.test.ts` — passed, 98 tests.
- Focused API scheduler, fan-out, Redis-boundary, recovery-service/workflow, and route command — passed, 67 tests across 6 files.
- Final scheduler/fan-out regression rerun after review — passed, 31 tests across 2 files.
- Focused web recovery-proxy command — passed, 21 tests.
- Real Redis dashboard Pub/Sub integration selection — passed, 3 tests (61 skipped by the focused name filter).
- `node --test scripts/runtime-smoke-load.test.mjs` — passed, 19 tests.
- `pnpm test:infra:up` and `pnpm --filter @checkout-surge/db test:db:migrate` — focused PostgreSQL/Redis started and migrations rebuilt.
- `pnpm runtime:up` and `pnpm runtime:setup` — reference runtime built, started, migrated, and seeded; existing non-fatal Next.js Edge-runtime warnings remained.
- `pnpm runtime:smoke:load -- --dashboard-delivery-baseline` — final corrected run passed with the measurements above and exact generated-run cleanup.
- `pnpm type-check` — passed for all production/build targets and test sources.
- `pnpm lint` — passed, 427 files.
- Focused Biome checks for all managed changed source/test files, `git diff --check`, and `docker compose config --quiet` — passed.
- `pnpm format:check` — the repository-wide check still reports only the pre-existing import-order finding in unchanged `apps/api/src/runtime/pending-persistence-operation-factory.ts`; Task 38's focused formatting checks pass.
- `pnpm runtime:down` and `pnpm test:infra:down` — passed; the reference runtime and focused PostgreSQL/Redis test stack, including test volumes, were removed.
- Review follow-up regression pass: scheduler/API route — 16 tests passed; recovery service with focused PostgreSQL — 25 tests passed; web recovery proxy — 24 tests passed; `pnpm type-check` passed again.
- Review serialization correction: scheduler — 8 tests passed; recovery service with focused PostgreSQL — 25 tests passed, including caller abort with actual cleanup still gating later assembly; API and test-source type checks, focused Biome, and `git diff --check` passed.

Composition and characterization were not run because Task 38 explicitly excludes those slow lanes.
