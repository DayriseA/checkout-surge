# Task 39 — Move the web dashboard to atomic projection replacement

## Execution context

- **Position:** 39/45; Phase 6, after Tasks 37–38 expose the shared bounded projection and before Task 40 deletes the old protocol.
- **Dependencies:** The server must already provide the chosen normal projection/invalidation protocol, same-schema recovery read, and boundary evidence from Tasks 36–38.
- **Standalone:** Make the browser's dashboard state the highest complete revision it has accepted for its current scope; it must never reconstruct authoritative totals from advisory deltas.
- **Checklist / working record:** Primary ownership is frontend dashboard state, hooks, and browser tests. Shared contract vocabulary remains in `@checkout-surge/contracts`; HTTP/SSE setup stays at the client boundary. Record cutover feature/removal state, browser test results, and skipped checks below.

## Why

Browser-side incremental reduction is the source of watermarks, event dedupe, recovery buffers, and races. Atomic replacement turns a missed update into one current projection read and makes ordering visible and testable.

## Required outcome

Consume complete newer same-scope projections atomically; switch coherently to an eligible new scope; ignore stale or foreign projections. Reconnect and dropped-message repair must use one current projection read, with no reconstruction or replay.

## Concrete scope and paths

- `apps/web/src/**` dashboard state/reducer replacement, stream and recovery hooks, UI warning/gating paths, and browser tests.
- `packages/contracts/src/**` only for generated/client contract use.
- `apps/api/src/**` only for small client-facing integration adjustments required to consume Task 38's normal protocol.

Implement explicit acceptance rules: replace state only when projection scope matches the current scope and revision is higher; a coherent, eligible new scope replaces the previous scope as one whole state; ignore foreign scope, lower revision, and duplicate revision data. On stream reconnect, disconnect, or detected dropped update, request the current projection exactly once through a coalesced recovery path and apply the same comparison rules. Preserve initial loading/gating, labelled last-known-good warnings on failed reads, and immediate terminal display. If Task 37 selected revisioned invalidation, use that invalidation solely to trigger the atomic read and never incrementally patch state.

The old reducer may exist temporarily only behind a bounded cutover that keeps all consumers using the new normal protocol. Mark every remaining old-reducer caller and test for deletion in Task 40; do not add new delta consumers or maintain dual normal modes.

## Retained behaviour and non-goals

Retain all four gold signals, connection lifecycle UX, current diagnostic views, and server-side coalescing. Do not delete server legacy paths, per-order fan-out, contracts, or mechanism tests here—that is Task 40 once no consumer remains.

## Acceptance

- [ ] Browser atomically accepts only a complete higher revision for the active scope.
- [ ] Coherent new-scope transition works; stale, duplicate, and foreign projections cannot overwrite it.
- [ ] Reconnect/dropped updates use one current projection read and no event replay/reconstruction.
- [ ] Initial gating, last-known-good warning, and terminal immediacy remain covered.
- [ ] Any temporary old reducer is bounded, unused by new paths, and enumerated for Task 40 deletion.

## Focused verification

Run dashboard state/hook tests and browser tests covering scope/revision ordering, C1/new-scope overlap, reconnect/drop recovery, refresh failure, and terminal quiet-period behaviour. Do not run composition or characterization without explicit authorization.

## Working record

Pending — browser migration, temporary-cutover inventory, and focused verification remain to be recorded.
