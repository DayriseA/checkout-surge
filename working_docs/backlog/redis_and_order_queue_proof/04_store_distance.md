# 04 — Store Distance

**Design:** sections 3, 5 · **Depends on:** 02, after the owner's go

## Goal

PostgreSQL and Redis sit at the same realistic network distance from the API, as in production systems.

## Scope

- The option chosen at the checkpoint: separate Machines for the stores, or a simulated latency on the core.
- Lifecycle, recovery and idle stop keep working with the new topology.
- The narrative presents a simulated latency as a simulation.

## Done When

- The chosen distance is in place in the proof environment, and every run kind works.

## Open Points

- Separate Machines or simulated latency, and the round-trip time, both from task 02.

## Working Notes

_None yet._
