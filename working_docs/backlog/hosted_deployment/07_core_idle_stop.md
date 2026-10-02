# 07 — Core Idle Stop

**Design:** sections 1.3, 3.4, 7.2 · **Depends on:** 01

## Goal

The core goes to sleep on its own after 10 minutes without activity, and visitors see it coming.

## Scope

- **Idle-shutdown owner in the API:**
  - it tracks counted activity and owns the deadline;
  - it never stops the core while a run is nonterminal;
  - it stops its own Machine through the Machines API.
- **Off unless configured:** the local topology has no idle stop and shows no countdown (design section 1.3).
- **Endpoints:** a lightweight status endpoint and a "stay awake" action.
- **Countdown widget** on every page, including the run-in-progress state and the alert during the last 2 minutes.
- **"Demo paused" state** for a page left open on a stopped core.
- **Token:** the API's Machines API token for the core app.

## Out of Scope

- The guard's 3-hour cap (task 11) and the gate pages (task 09).

## Done When

- On Fly, an idle core stops about 10 minutes after the last counted request.
- It never stops during a nonterminal run.
- Healthchecks, widget polling and open SSE connections do not extend the deadline.
- "Stay awake" resets the deadline for every visitor.

## Open Points

- None.

## Working Notes

_None yet._
