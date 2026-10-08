# 21 — Comparative Runs Study

**Design:** none · **Depends on:** 15c

## Goal

The owner can decide, with measured numbers, whether to build live comparative runs: the same traffic against the system without its Redis layer and queue, then with them.

## Context

- Owner idea (2026-10-08): on a few fixed presets, show live why an in-memory decision layer and asynchronous processing matter. First run the traffic against a system without them, then the same traffic against the demo's system.
- **The baseline must be credible.** It is the same system with the Redis layer and the queue removed:
  - the stock is decided in PostgreSQL by an atomic conditional update;
  - the ERP is called inside the buyer's request.
  
  A strawman would undo the demonstration for an informed reviewer.
- Implementing the comparison is a separate project after this backlog. This task is only the study.

## Scope

- **Design the baseline path.** Say where it would live (a run mode in the API), and why it is a fair "without" design.
- **Measure the gap** with a throwaway prototype or a benchmark on a cloud VM, on two or three fixed presets. Do it both with the ERP's latency and with the ERP removed, so the share of each layer is known.
- **Estimate the work:**
  - the run mode;
  - the presets;
  - chaining the two runs;
  - a side-by-side report;
  - the texts;
  - the tests.
- **Report to the owner** for a go or no-go.

## Out of Scope

- Building the feature.

## Done When

- The owner has the design, the measured gap and the estimate, and has decided.

## Open Points

- None.

## Working Notes

_None yet._
