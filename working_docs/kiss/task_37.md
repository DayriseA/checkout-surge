# Task 37 — Establish one revisioned dashboard projection authority

## Execution context

- **Position:** 37/45; Phase 6, after Task 36 baseline evidence and before coalesced publication or browser migration.
- **Dependencies:** Task 36 must have pinned public behaviour and measured the existing delivery volume. The current recovery data must be sufficient to build a coherent UI view.
- **Standalone:** Build one server-owned, complete UI projection per run/offer scope, identified by scope and monotonic revision, and make it the only authoritative dashboard state source for both live and recovery paths.
- **Checklist / working record:** Primary ownership is the shared dashboard projection contract and its server-side builder/authority. `@checkout-surge/contracts` owns public schema/types; application services own assembly and revision allocation; HTTP/SSE routes only invoke those services. Record projection-size evidence, revision/order decisions, tests, and skipped checks below.

## Why

The current mixed delta-plus-recovery model requires browser reconstruction, watermarks, deduplication, and replay-like repair. A complete, revisioned projection makes the server the sole assembler of dashboard state and lets every consumer choose the newest coherent view.

## Required outcome

Introduce exactly one small projection schema and one builder/authority. The same scope ID and monotonic revision semantics must be used for a live view and a recovery read, and be safe across reconnect and process restart ordering.

## Concrete scope and paths

- `packages/contracts/src/**`: a versioned/dashboard projection schema containing scope identity, revision, lifecycle/outcome state, and the complete small UI model needed per run/offer.
- `apps/api/src/**`: dashboard projection builder, persistence/revision authority, recovery service and route integration, and producer adapters for existing aggregate readers.
- Existing dashboard event/recovery tests and fixtures.

The projection must contain the four dashboard gold signals (request surge, queue depth, inventory drain, and run/business outcomes), lifecycle/terminal data, and only UI data needed for coherent replacement. Use one explicit authority to allocate monotonically increasing revisions per scope; do not derive ordering from clocks or event arrival order. A process-local counter that resets on restart is insufficient. Use the smallest durable per-scope counter already compatible with the runtime (for example, a Redis atomic counter beside the projection) or a persistently allocated ordered restart epoch plus sequence, and name that storage/owner in the Working record. This ordering state is not an event log and must not grow per revision. Build the projection from the existing one-second load aggregate and coalesced inventory, queue, and business readers rather than adding raw-event subscriptions or duplicate stores. Define restart/reconnect behaviour: a returned projection is self-contained, revision comparisons are scoped, and an old connection cannot overwrite a newer recovered projection.

Measure representative serialized projection size against Task 36's frame baseline. If a full projection cannot meet the desired display cadence, select **revisioned invalidation plus one atomic projection read** as the sole normal protocol, document the measured evidence and threshold, and do not retain full-projection streaming alongside it. Otherwise use full-replacement projections as the sole target protocol. In either case, do not build an event replay system or a second state model.

## Retained behaviour and non-goals

Retain current server-side aggregation/coalescing and durable diagnostic reads. Do not migrate the web client yet, delete the existing reducer yet, add per-order live fan-out, introduce another projection builder, or alter reservation/queue/ERP ownership.

## Acceptance

- [ ] One public projection contract has a scope ID and monotonic scoped revision.
- [ ] One server authority builds the complete coherent UI model and owns revision allocation.
- [ ] Live and recovery expose the same schema and ordering semantics.
- [ ] Ordering is safe for reconnect and process restart; tests prove stale scoped data cannot win.
- [ ] Revision allocation cannot reset or reuse an older value after API restart, and a focused restart test proves it.
- [ ] Existing aggregation/readers are reused, not duplicated.
- [ ] Projection-size evidence selects full streaming or sole revisioned invalidation-plus-read; no replay/second normal protocol is added.

## Focused verification

Run contract tests, projection-builder/service tests, recovery-route tests, and the focused ordering/restart scenarios. Repeat the bounded representative measurement for serialized size. Do not run composition or characterization lanes without explicit authorization.

## Working record

Pending — contract, authority choice, measurement, and focused verification remain to be recorded.
