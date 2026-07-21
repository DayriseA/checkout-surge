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

- [ ] Focused tests cover the four gold signals and terminal quiet-period convergence.
- [ ] A deterministic C1 new-run-overlap regression is present at the browser/recovery boundary.
- [ ] Reconnect/dropped-message, slow-consumer/latest-state, and refresh-failure/last-known-good behaviours are covered.
- [ ] Representative-load message/frame baseline is recorded with counting method and preset.
- [ ] Current incremental implementation remains the normal protocol.

## Focused verification

Run the affected contract, API/dashboard unit or integration, and browser tests plus the bounded representative-load measurement. Do not run `pnpm test:composition` or `pnpm test:characterization` unless explicitly authorized. Report the exact commands and outcome.

## Working record

Pending — implementation, baseline measurements, and focused verification have not yet been recorded.
