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

- [ ] No dashboard consumer uses incremental event reduction or delta/recovery reconciliation.
- [ ] Watermarks, dedupe, recovery buffers, replay categories, and obsolete contract variants are deleted with their tests/docs.
- [ ] Per-order worker status/lag fan-out is removed; durable diagnostic and aggregate lag remain.
- [ ] A focused read test proves durable per-order status/lag evidence remains queryable after realtime fan-out removal, without publishing or reconstructing a per-order dashboard stream.
- [ ] Any explicitly retained activity is bounded, sampled/rate-limited, and embedded only in the shared projection.
- [ ] Heartbeat, caps, cancellation, and bounded fan-out remain tested.
- [ ] The resulting normal protocol has one schema, one revision model, and one current-read recovery path.

## Focused verification

Run affected contract, API/SSE, dashboard state, and browser tests, including the Task 36 public outcomes. Exercise the focused diagnostic read against persisted per-order evidence and assert the expected status/lag result while SSE carries no corresponding per-order event. Use a bounded representative-load check to confirm no per-order stream returns. Do not run composition or characterization unless explicitly authorized.

## Working record

Pending — consumer audit, deletions, retained-diagnostic evidence, and focused verification remain to be recorded.
