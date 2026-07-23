# Task 36 — Pin dashboard boundary behaviour before replacing its protocol

## Execution context

- **Position:** 36/45; Phase 6, first task.
- **Dependencies:** Phase 0's C1 new-run convergence correction and the earlier dashboard/current recovery implementation must be present and working. This task establishes evidence only; Tasks 37–40 consume it.
- **Standalone:** If the audit is unavailable, the dashboard still needs proof that its public behaviour is preserved before its live-update protocol is replaced. This record defines that proof and a representative-volume baseline.
- **Checklist / working record:** Primary ownership is the dashboard public-boundary test and measurement record. Contract changes belong in `@checkout-surge/contracts`; server workflow belongs in the dashboard/recovery application service; routes remain thin; browser assertions belong at the dashboard boundary. Record commands, fixture/preset, measured frame/message counts, results, and any skipped checks below before closing.

## Why

The current browser combines incremental SSE messages with an authoritative recovery read. Removing its guards without pinning outcomes would make a regression look like intended simplification. The replacement must retain four useful dashboard signals—request surge, queue depth, inventory drain, and run/business outcome—while converging correctly at terminal state and after missed updates.

## Required outcome

Create focused, deterministic boundary evidence for the current implementation and measure its representative load delivery volume. Keep the current incremental protocol intact in this task.

## Concrete scope and paths

- `packages/contracts/src/**` dashboard event/recovery contracts, only where test fixtures need an exported public shape.
- `apps/api/src/**` dashboard event, recovery, and snapshot services/routes; fan-out and scheduler seams needed to observe delivery.
- `apps/web/src/**` dashboard state/hooks and browser-facing tests.
- Existing focused dashboard, SSE, recovery, and load test locations; add a small measurement helper only when it reports actual delivered messages/frames without becoming a second harness.

Pin at public boundaries:

1. all four gold signals render/converge from normal updates;
2. a terminal transition converges immediately and stays correct during subsequent quiet time;
3. the C1 ordering `start t0 -> idle recovery t1 -> commit/event t2` establishes the new run via the existing safe recovery path;
4. reconnect or a dropped update obtains the current view from the authoritative read;
5. a slow consumer reaches the latest state rather than accumulating stale work; and
6. a failed refresh preserves a labelled last-known-good view rather than fabricating a new one.

Run one representative bounded load preset and record raw producer events, SSE frames/messages delivered per client, active scope count, duration, and the resulting dashboard update count. State the exact counting point so later tasks compare like with like.

## Retained behaviour and non-goals

Retain existing one-second load aggregation, coalesced inventory/queue/business publication, connection protections, and current recovery semantics. Do not introduce revisions, a new schema, replay, alternative transport, broad browser refactor, or a slow composition/characterization run. This is a behavioural baseline, not an opportunity to clean up the reducer.

## Acceptance

- [x] Focused tests cover the four gold signals and terminal quiet-period convergence.
- [x] A deterministic C1 new-run-overlap regression is present at the browser/recovery boundary.
- [x] Reconnect/dropped-message, slow-consumer/latest-state, and refresh-failure/last-known-good behaviours are covered.
- [x] Representative-load message/frame baseline is recorded with counting method and preset.
- [x] Current incremental implementation remains the normal protocol.

## Focused verification

Run the affected contract, API/dashboard unit or integration, and browser tests plus the bounded representative-load measurement. Do not run `pnpm test:composition` or `pnpm test:characterization` unless explicitly authorized. Report the exact commands and outcome.

## Working record

Completed 2026-07-23.

Boundary evidence remains on the current incremental SSE plus authoritative-recovery protocol:

- `apps/web/test/dashboard-phase6.test.ts` pins rendering and convergence for request surge, inventory drain, queue pressure, consistency lag, and run/business outcomes, including terminal ordering.
- `apps/web/test/dashboard-hooks.test.tsx` pins terminal quiet-period convergence, the deterministic C1 `start t0 -> idle recovery t1 -> commit/event t2` overlap, bounded mixed Preview 1k buffering, and authoritative recovery coalescing.
- `apps/web/test/browser-workflows.test.ts` pins reconnect-after-drop recovery to the latest authoritative terminal view and labelled last-known-good rendering after refresh failure.
- `apps/api/test/dashboard-event-fanout.test.ts` proves a slow client is bounded and disconnected on overflow while healthy clients continue; the disconnected source can reconnect without receiving its stale queue. The browser reconnect test then proves latest-state convergence through the authoritative read. This is the retained Task 36 behavior, not Task 38's future latest-only replaceable projection queue.

Representative measurement:

- Command: `pnpm runtime:smoke:load -- --dashboard-delivery-baseline`
- Fixture: seeded public `preview-1k` preset; buyer-spike with 1,000 planned requests and stock 250.
- Window: the direct Redis subscription and one SSE response with its first complete setup frame were established before counting. One common gate then reset both counters and opened immediately before the dashboard start request. Its deadline was exactly 30,000 ms after that boundary; the start request consumed part of the window and the harness slept only the remaining time. Delivery callbacks at or after the shared deadline were excluded before asynchronous collector shutdown. Reported duration: **30,000 ms**.
- Active-scope counting point: a distinct `{ runId, saleOfferId }` identity is registered only while the common gate is open, after the start response passes `startDemoRunResponseSchema`. Duplicate identities are deduplicated, and the result is accepted only with in-window contract-valid SSE evidence attributable to that same run. Observed: **1 active measured scope**. The post-window recovery response was separately contract-validated and used only to corroborate either the matching still-active scope or the measured run's terminal history; it does not define this count. Exact-run reset/teardown then returned recovery to idle.
- Raw producer counting point: every Redis Pub/Sub `message` callback on the canonical `dashboard-events` channel while the common gate accepted delivery, before API fan-out parsing. Observed: **1,043 raw producer events**.
- SSE frame counting point: every non-empty complete wire frame delimited by a blank line at the existing dashboard SSE client while the same gate accepted delivery. Observed per connected client: **1,045 frames**. The pre-window retry/connected setup frame was drained and excluded; in-window heartbeat frames remain included.
- SSE message counting point: every accepted completed frame containing at least one `data:` line. Observed per client: **1,043 data messages**, all **1,043 contract-valid** and attributable to the measured run.
- Dashboard update counting point: every accepted contract-valid message at the same post-schema-validation boundary used to represent a browser dashboard event-handler call, matching `useDashboardEvents` dispatch behavior. Observed per client: **1,043 dashboard updates**.

Focused verification completed:

- `pnpm build:shared` — passed.
- `node --test scripts/runtime-smoke-load.test.mjs` — passed (18 tests, including the common fixed gate, pre-window SSE exclusion, and Redis subscriber failure/stop lifecycle).
- `node --test scripts/runtime-image-contract.test.mjs` — passed (8 tests); the runtime-tools environment contract now includes `REDIS_URL`.
- `pnpm --filter api exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.api.config.ts test/dashboard-event-fanout.test.ts` — passed (21 tests).
- `pnpm --filter web exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.config.ts test/dashboard-phase6.test.ts test/dashboard-hooks.test.tsx test/browser-workflows.test.ts` — passed (67 tests).
- `pnpm type-check` — passed.
- `pnpm lint` — passed across 421 files.
- `pnpm exec biome check apps/api/test/dashboard-event-fanout.test.ts apps/web/test/browser-workflows.test.ts scripts/runtime-smoke-load.mjs scripts/runtime-smoke-load.test.mjs working_docs/kiss/task_36.md docs/load_generation_metrics_streaming.md docs/runtime_topology.md` — passed for the four Biome-managed source files; the Markdown files are not managed by this Biome configuration.
- `pnpm format:check` — the Task 36 files passed, but the repository-wide command exited 1 on a pre-existing import-order finding in `apps/api/src/runtime/pending-persistence-operation-factory.ts`, outside this task's clean starting diff and ownership boundary.
- `docker compose config --quiet` — passed.
- `pnpm runtime:setup` — migrations and seed completed on the fresh runtime volume.
- `pnpm exec biome check scripts/runtime-smoke-load.mjs scripts/runtime-smoke-load.test.mjs scripts/runtime-image-contract.test.mjs` — passed (3 files).
- `pnpm runtime:up` — rebuilt the runtime and started all services successfully; the existing Next.js Edge-runtime warnings remained non-fatal.
- `pnpm runtime:smoke:load -- --dashboard-delivery-baseline` — final corrected run passed with `durationMs=30000`, `activeScopeCount=1`, `rawRedisProducerEvents=1043`, `deliveredFrames=1045`, and all four SSE data/valid/attributable/update counts equal to `1043`; exact cleanup completed. An intermediate review run correctly measured `durationMs=30000` but exited 1 because it required an end-of-window active recovery scope even after terminalization; exact cleanup still returned recovery to idle, and the final definition above replaced that invalid inference.

No contract, projection schema, revision, replay, alternate transport, or reducer cleanup was introduced. Composition and characterization lanes were not run because Task 36 explicitly excludes those slow lanes.
