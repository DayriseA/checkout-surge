# 10 — Core Recovery

**Design:** sections 2.3, 3.5, 6 · **Depends on:** 06, 09

## Goal

The gate repairs a core that cannot start, without the owner.

## Scope

- **Retry** `start` with back-off.
- **Recreate** on a capacity or dead-host classification:
  1. Create a fresh volume, with the `compute` hint.
  2. Create a new core Machine with the old configuration and the region list `cdg,eu`.
  3. Retire the old Machine and volume once the new core is healthy.
- **Cleanup** of a volume left without a Machine after a failed creation.
- **Pages:** relocating, and no capacity in Europe.
- **Deliberate trigger,** so the path can be tested, and reused by the deploy script (task 12).

## Out of Scope

- Detecting a real capacity incident, which cannot be tested on demand.

## Done When

- A deliberately triggered recovery produces a healthy, freshly installed core, and the visitor sees the relocating page meanwhile.
- The old Machine and volume are gone.
- The next run's runner follows the core's region.

## Open Points

- None.

## Working Notes

_None yet._
