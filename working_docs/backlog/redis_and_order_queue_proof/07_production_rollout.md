# 07 — Production Rollout

**Design:** sections 3, 3.1, 6 · **Depends on:** 06

## Goal

The project reaches production after the owner's review, without downtime for visitors.

## Scope

- The owner reviews the project in the proof environment.
- The merges into `dev`, then `main`, are done by the owner or with the owner's approval.
- Deploy production and check it live: both comparison presets complete and show their point on the production hardware, and ordinary runs behave as before.
- Destroy the proof environment, or keep it stopped, as the owner decides.
- Delete `tmp/21-baseline-prototype`, and decide the fate of the archived branch `codex/redis-order-queue-feasibility`.

## Done When

- Production runs the comparisons, and the proof environment is cleaned up.

## Open Points

- None.

## Working Notes

_None yet._
