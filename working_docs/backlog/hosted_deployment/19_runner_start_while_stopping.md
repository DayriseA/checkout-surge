# 19 — Runner Start While the Previous Runner Stops

**Design:** section 4.1 · **Depends on:** 17

## Goal

A run started right after another one never fails because the runner Machine is still stopping.

## Context

- Found during the Fly measurement for 15a (2026-10-08, see its working notes).
- A run started 1 s after the previous run's teardown failed with `load_orchestrator_unavailable`.
  - Fly answered 412 "machine still active" to the runner start, and the API does not retry.
  - The run slot is released at the previous run's terminal status, before the runner Machine has stopped.
- Two visitors starting runs back to back can hit it.

## Scope

- Find where the start is refused (the pre-start update and start in `apps/api/src/services/fly-runner-host.ts`, the classifier in `packages/fly-machines`), and how the runner stops after a run.
- When the runner is still stopping, wait for it to stop, then start it, within the existing boot deadline. Prefer Fly's wait endpoint to polling if it fits.
- The visitor and the owner see the normal starting state meanwhile, with no new message.
- **Owner decision (2026-10-08):** deployed together with 18.

## Out of Scope

- Capacity relocation (HD-55), which stays unchanged.

## Done When

- A run started right after another one starts normally, with tests through the public API where reachable.

## Open Points

- None.

## Working Notes

_None yet._
