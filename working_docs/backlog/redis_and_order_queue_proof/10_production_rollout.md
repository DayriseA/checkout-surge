# 10 — Production Rollout

**Design:** sections 3, 6 · **Depends on:** 09

## Goal

The project reaches production after the owner's review, without downtime for visitors.

## Scope

- The owner reviews the project in the proof environment.
- The merges into `dev`, then `main`, are done by the owner or with the owner's approval.
- Deploy production, check it live, and recalibrate the capacity values on production if they differ.
- Destroy the proof environment, or keep it stopped, as the owner decides.
- Delete `tmp/21-baseline-prototype`.

## Done When

- Production runs the comparisons, and the proof environment is cleaned up.

## Open Points

- None.

## Working Notes

_None yet._
