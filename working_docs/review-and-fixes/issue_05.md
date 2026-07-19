# Issue 05 — Watch can ignore a valid terminal transition until Manual Refresh

## Classification

- Priority: P1
- Status: Fixed (2026-07-19)
- Affected path: Watch live lifecycle, terminal recovery, public demo narrative
- Audit run: `43336c35-00cc-4e8d-a644-eef226783131` (small custom run)

## Resolution

Fixed on both sides of the race while keeping recovery authoritative:

- Producer (`apps/api/src/services/demo-run-finalization-service.ts`): the terminal `load.run.updated` event no longer reuses the pre-commit finalization-attempt clock value. `publishTerminalRunEvent()` captures a fresh post-commit `occurredAt` after the terminal writer's durable transaction and the committed-run re-read. The durable `finalizedAt` in the event's run snapshot remains the transition identity/time.
- Consumer (`apps/web/src/app/lib/dashboard-state.ts`): a matching terminal signal (terminal status, envelope/run-payload run-ID agreement, same run, same sale offer, currently nonterminal client, lifecycle advance) is exempt from the generic `occurredAt < recoveredAt` rejection and triggers exactly one authoritative recovery. Lifecycle monotonicity is enforced by rank (`starting < active < draining < completed/failed`, one shared terminal rank) and durable transition timestamps (`startedAt`/`trafficStartedAt`/`trafficEndedAt`/`finalizedAt`) instead of the recovery-start watermark. Foreign run/sale isolation, duplicate-terminal suppression, terminal-state switching prevention, and stale metric rejection are preserved; `useDashboardRecovery` request serialization is unchanged.

Deterministic coverage:

- API: advisory-lock overlap test proving `t0` attempt time, `t1` stale draining recovery, post-commit `t2` event time, one summary, one terminal event with the committed run and durable `finalizedAt`.
- Web: reducer/predicate tests for the `t0`/`t1` overlap (completed and failed), foreign run, foreign sale, duplicate terminal, terminal-to-draining regression, and stale metric rejection; a hook-level test asserting exactly one recovery request and convergence without Manual Refresh.

## Issue observed

A small custom demo completed successfully in the backend with the expected business result:

- 20 attempts;
- 5 accepted, confirmed, and notified;
- 15 sold out;
- queue drained and the run became terminal;
- history/detail showed the completed result.

The open Watch page nevertheless remained in `draining` for more than two minutes. During that period, a direct same-origin recovery request already returned the authoritative idle/terminal projection. Selecting Manual Refresh immediately corrected Watch.

The product therefore performs the run successfully but can fail to tell the story on its primary live screen. This is particularly misleading for a short demo, where the terminal result is the outcome the viewer is waiting for.

## How to reproduce

The defect is a race and should be reproduced deterministically in a test rather than by relying only on timing:

1. Begin finalization and capture its initial clock value `t0`.
2. Before finalization commits, begin recovery at `t1`, where `t1 > t0`.
3. Let recovery read and return the still-draining projection with `recoveredAt = t1`.
4. Commit the terminal transition and publish its lifecycle event with `occurredAt = t0`.
5. Deliver that event to the client holding the recovery snapshot.

The client rejects the same-run terminal event as older than the recovery watermark and does not request another authoritative recovery.

## Identified cause

The producer and consumer use timestamps with different causal meanings:

- `DemoRunFinalizationService` captures `now` near the start of the finalization attempt, before drain checks and terminal persistence (`apps/api/src/services/demo-run-finalization-service.ts`).
- It later writes the terminal transition and publishes the lifecycle event using that earlier timestamp.
- `DashboardRecoveryService` captures its `now` at request start and returns it as `recoveredAt` after several non-transactional reads (`apps/api/src/services/dashboard-recovery-service.ts`).

A recovery can therefore read the old state but receive a watermark later than the timestamp attached to a terminal event that commits afterward.

The web client then rejects the corrective signal twice (`apps/web/src/app/lib/dashboard-state.ts`):

1. the event-to-recovery predicate declines to request recovery when `occurredAt < recoveredAt`; and
2. the lifecycle reducer also initializes its event watermark from `recoveredAt` and rejects an event at or below it.

The current tests cover generally old metric events and normal terminal events, but not this producer/consumer overlap.

## Recommended actions

1. Give terminal lifecycle events a post-commit causal timestamp, ideally the durable transition timestamp, rather than a clock value captured before finalization work begins.
2. Independently make a valid same-run/same-sale terminal event trigger authoritative recovery when the client is not already terminal, even if a generic recovery timestamp makes the event look older. Recovery should remain the source of truth rather than synthesizing final state from the event.
3. Track lifecycle monotonicity by lifecycle rank and durable transition identity/time instead of treating the start time of a multi-projection recovery as a universal event watermark.
4. Continue rejecting foreign run/sale events, duplicate terminal events, and genuine lifecycle regressions.
5. Add a deterministic concurrency test with the ordering described above, plus negative tests for stale metrics, a terminal event for another run, and an actual terminal-to-draining regression.

## Acceptance criteria

- In the `t0`/`t1` overlap, the client requests one authoritative follow-up recovery.
- Watch reaches terminal/idle without Manual Refresh after the backend commits the terminal transition.
- The terminal event is published after the durable transition, and its lifecycle timestamp/identity represents that committed transition rather than the earlier finalization-attempt time.
- Duplicate or genuinely stale events do not create recovery loops.
- Foreign run/sale events remain isolated.
- Existing metric monotonicity protections remain effective.

## Scope guard

This restores convergence of the existing live dashboard. It does not require a new event system, a new terminal animation, or additional UI features.
