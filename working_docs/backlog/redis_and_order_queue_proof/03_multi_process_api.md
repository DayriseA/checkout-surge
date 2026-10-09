# 03 — Multi-Process API

**Design:** section 3 · **Depends on:** 02, after the owner's go

## Goal

The API runs correctly as several processes on one core, so that it is no longer the first bottleneck.

## Context

- HD-51 kept one API process.
- HD-11 serializes runner operations and run starts in-process, and is correct only under the single-process contract.

## Scope

- **Inventory every single-process assumption:** runner operations, run starts and reconciliation, resets, live streams, in-process pacing or state.
- Make each of them safe across processes.
- Supersede HD-51 and update HD-11 in the decision log.
- Recalibrate the capacity values and the admission model for the new topology (`CAPACITY_*`, `docs/capacity_measurement.md`).

## Done When

- Every run kind works with several API processes in the proof environment, and the capacity is recalibrated.

## Open Points

- The number of processes, which task 02 provides.

## Working Notes

_None yet._
