# Task 40 — Remove the mixed dashboard protocol and obsolete order fan-out

## Execution context

- **Position:** 40/45; Phase 6 completion task.
- **Dependencies:** Task 11's recorded decision in `docs/scope_and_caveats.md` controls whether bounded recent activity remains. Task 39 must prove every dashboard consumer uses atomic revisioned projection replacement and Task 38 must provide bounded delivery/recovery. Do not begin deletion while an old delta consumer remains.
- **Standalone:** After migration, retain one dashboard protocol—shared revisioned projection (or its selected invalidation-plus-atomic-read form)—and remove all mechanisms that existed solely to reconcile incremental SSE deltas with recovery snapshots.
- **Checklist / working record:** Primary ownership is dashboard transport/state protocol removal across contracts, API fan-out/recovery, web state, and mechanism tests/docs. Keep contracts coherent; remove route/service behaviour at its owning boundary; record deleted authorities/states/tests, retained diagnostics, and focused verification below.

## Why

Keeping the old reducer and transport alongside the projection preserves two sources of truth and their synchronization machinery. The project needs durable focused per-order diagnostics, not an unbounded second realtime order protocol.

## Required outcome

Delete mixed delta/recovery protocol machinery and obsolete per-order fan-out once all consumers use the shared projection. Preserve bounded delivery protections and durable evidence.

## Concrete scope and paths

- `packages/contracts/src/**`: remove obsolete dashboard event variants, watermarks, replay/recovery categories, and associated schemas/types.
- `apps/api/src/**`: remove incremental event emitters, recovery buffers/replay paths, obsolete fan-out categories, and unused route/service glue.
- `apps/worker/src/realtime/order-realtime-publisher.ts` and its composition/tests: remove individual worker order-status/lag publishing.
- `apps/web/src/**`: remove incremental reducers, event dedupe, per-metric watermarks, replay/buffer state, and old protocol tests.
- Dashboard/SSE/browser/API tests and protocol documentation that pins deleted behaviour.

Read and implement the exact Task 11 decision recorded in `docs/scope_and_caveats.md`: do **not** retain a separate per-order realtime panel by default. Keep a durable, focused diagnostic read and aggregate consistency-lag signal. If that decision explicitly retained recent activity, include only a sampled, rate-limited, bounded collection within the shared projection; it must not become a second event stream or authoritative state model. Retain heartbeat, connection caps, cancellation, cleanup, and bounded latest-projection fan-out.

## Retained behaviour and non-goals

Retain the complete revisioned projection, current recovery read, gold signals, terminal immediacy, and durable business/order evidence. Do not replace removed code with an event log, replay service, compatibility adapter, or alternate delta transport. Do not delete durable diagnostics merely because realtime fan-out is removed.

## Acceptance

- [x] No dashboard consumer uses incremental event reduction or delta/recovery reconciliation.
- [x] Watermarks, dedupe, recovery buffers, replay categories, and obsolete contract variants are deleted with their tests/docs.
- [x] Per-order worker status/lag fan-out is removed; durable diagnostic and aggregate lag remain.
- [x] A focused read test proves durable per-order status/lag evidence remains queryable after realtime fan-out removal, without publishing or reconstructing a per-order dashboard stream.
- [x] Any explicitly retained activity is bounded, sampled/rate-limited, and embedded only in the shared projection.
- [x] Heartbeat, caps, cancellation, and bounded fan-out remain tested.
- [x] The resulting normal protocol has one schema, one revision model, and one current-read recovery path.

## Focused verification

Run affected contract, API/SSE, dashboard state, and browser tests, including the Task 36 public outcomes. Exercise the focused diagnostic read against persisted per-order evidence and assert the expected status/lag result while SSE carries no corresponding per-order event. Use a bounded representative-load check to confirm no per-order stream returns. Do not run composition or characterization unless explicitly authorized.

## Working record

Completed 2026-07-23.

### Ownership and resulting protocol

- Contracts own one public browser/recovery schema: `checkout-surge.dashboard-projection` version 1, with one scoped revision comparison model and the shared `/dashboard/recovery` current read.
- API owns bounded SSE connection admission, heartbeat/cancellation/cleanup, latest-projection fan-out, projection assembly cadence, and terminal/immediate publication.
- API and worker producers publish one strict internal `dashboard.projection.dirty` Redis signal. An unscoped signal is cadence-coalesced; an optional exact run/offer scope itself requests the immediate build, so no independent urgency flag or dead signal combination exists. This signal is an invalidation trigger, not a browser event or second state model.
- Web consumers parse and atomically replace complete projections from SSE or recovery. The Task 11 decision remains no recent-activity exception, so no sampled collection or separate per-order panel is retained.

### Deleted authorities and synchronization state

- Deleted the shared dashboard delta-event union and its order, lifecycle, metric, business-outcome, watermark, and recovery aliases; recovery now validates the projection schema directly.
- Deleted API legacy event fan-out/formatting, event subscriber glue, snapshot publication scheduler, and parallel per-source event construction. The replacement source scheduler only coalesces bounded dirty triggers.
- Deleted the web incremental reducer, dedupe/watermark/replay state, recent-order transition presentation, and the old protocol-focused test matrix.
- Deleted worker `order-realtime-publisher.ts`, its composition/cleanup path, status/lag payload assembly, deterministic realtime IDs, and publisher tests.
- Narrowed traffic-metric dirty publication to fenced, published, or one advisory failure; removed indexed batch outcomes left by event publication. Removed business-outcome `occurredAt` from dirty marking and narrowed fresh worker transition results to the status plus confirmed notification time still consumed by the application. Durable transition event timestamps, payloads, and insert-identity assertions remain persistence-owned.
- Removed `order.consistency_lag` from the lifecycle metric vocabulary. Aggregate lag remains a projection field derived from durable order evidence.
- Runtime smoke instrumentation now accepts and counts only exact complete projections; raw legacy-event subscription/counters were removed.

### Retained evidence and protections

- `OrderStatusService` still reads persisted order lifecycle timestamps and computes confirmed-order consistency lag. Its focused PostgreSQL-backed test proves a confirmed order remains queryable with `120000` ms lag after realtime fan-out removal.
- The API SSE test publishes one projection and explicitly proves no `order.status.updated` frame is emitted. The bounded representative-load parser fixture rejects a per-order delta while retaining only exact projection frames.
- Aggregate business outcomes, consistency lag, all four gold signals, recent bounded completion outcomes, terminal immediacy, durable order events, Run History, and the protected order-status read remain.
- Heartbeat lifecycle, total/per-source connection caps, write failure isolation, cancellation/listener cleanup, byte/frame/scope bounds, same-scope latest replacement, and slow-client eviction/reconnect remain covered.

### Original implementation verification

These broad results were completed before the review correction and were not rerun during the focused correction pass:

- `pnpm type-check`: all 11 production/build tasks passed; `pnpm type-check:test` passed after the focused diagnostic test was added.
- `pnpm lint`, `pnpm format:check`, and `git diff --check` passed at that point.
- Contracts: 96 tests passed.
- API: all 554 tests passed. Focused subsets also proved the 69 projection/dirty/fan-out/recovery/metric/cleanup route cases, 5 persisted-order diagnostic cases, 35 finalization/projection/metric-store cases, and the projection-only SSE assertion.
- Worker: 86 unit tests and 20 order-processing integration tests passed.
- Web dashboard state/hooks/routes and Task 36 public outcomes: all 202 unit tests passed.
- DB: 6 scheduler unit tests, 1 business-outcome reader integration test, and 3 projection-dirty transport integration tests passed.
- Runtime smoke-load/SSE helpers: 30 tests passed, including bounded burst/occupancy and strict projection-only evidence.
- Per repository instructions, `pnpm test:composition` and `pnpm test:characterization` were not run.

### Review correction verification

- Projection-dirty transport and business-outcome scheduler unit tests: 12 passed, including strict ordinary/exact-scope shapes, rejection of the removed urgency flag and malformed scopes, handler-error/invalid-message isolation, and idempotent subscriber start/close.
- API source/projection schedulers, subscriber metadata, traffic metric, ingestion, and reservation tests: 72 passed. The source scheduler's 8 focused cases now prove single-flight trailing dirtiness, run cleanup, one non-overlapping queue refresh timer, failure isolation, and no post-close work.
- Redis boundaries: 3 projection-dirty integration tests and 3 traffic-metric fence/publication integration tests passed.
- Terminal exact-scope publication: 3 focused finalization tests passed, with 26 unrelated cases skipped.
- Worker transition narrowing: 27 handler unit tests, 20 PostgreSQL workflow integration tests, and 12 BullMQ consumer integration tests passed.
- Web projection-hook labels/behavior: 8 tests passed.
- Current package type checks passed for DB, API, and worker; `pnpm type-check:test` passed.
- Focused changed-file formatting and `git diff --check` passed. The required revert of the unrelated import-order-only edit in `pending-persistence-operation-factory.ts` restores that pre-Task-40 ordering, so the repository-wide format check was not rerun or claimed for the correction.

### Independent re-review

- The first review produced one consolidated correction cycle covering the dirty-signal shape, obsolete payload residue, retained scheduler/subscriber protections, stale documentation/test labels, and the unrelated import-order edit. The corrected complete diff then passed a second independent review with no material findings.
- Reviewer-owned targeted checks passed: 32 API projection fan-out/publication-scheduler tests, 5 strict projection contract cases, and 2 projection-only runtime-smoke parser/delivery cases.
- Final residue scans found no old dashboard contract, Redis event transport, browser reducer, recovery alias, or worker per-order realtime API. The only old per-order wire literals are intentional negative fixtures proving those frames are rejected.

### Final self-review

- The change stays within dashboard protocol removal and its direct producer/consumer/test/documentation boundaries; it adds no replay service, event log, compatibility adapter, alternate stream, or activity panel.
- Routes remain thin, infrastructure clients remain composition-owned, and the contracts/API/DB/worker/web boundaries agree on the single projection protocol.
- Correlation IDs and advisory failure isolation remain intact. Durable checkout, queue, ERP, notification, retry/recovery, reset, finalization, and diagnostic behavior were preserved.
