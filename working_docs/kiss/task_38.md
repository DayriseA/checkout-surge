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

- [ ] Publication is bounded by max latency and documented meaningful-work policy.
- [ ] Lifecycle and terminal updates publish immediately; quiet final state cannot be stranded.
- [ ] Each slow consumer keeps at most the newest pending replaceable view per scope.
- [ ] Connection caps, heartbeat, cancellation, cleanup, and bounded fan-out remain effective.
- [ ] Full-stream mode uses the same complete schema over SSE and HTTP; invalidation mode instead uses one documented scope/revision invalidation envelope plus the complete HTTP projection, never both normal streams.
- [ ] Representative load demonstrates delivery scales with scopes/cadence rather than raw event count.

## Focused verification

Run scheduler/fan-out unit tests, SSE and recovery route tests, Redis producer-boundary tests, and a bounded slow-consumer plus representative-load scenario. Do not run composition or characterization by default.

## Working record

Pending — publication policy, implementation evidence, measurements, and focused verification have not yet been recorded.
