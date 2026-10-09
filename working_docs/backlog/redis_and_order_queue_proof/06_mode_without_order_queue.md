# 06 — Mode Without the Order Queue

**Design:** sections 4, 5 · **Depends on:** 02, after the owner's go

## Goal

A run can call the ERP inside the buyer's request, paced at the ERP's rate, so that a visitor sees the buyer paying for the back office's slowness.

## Scope

- The ERP call inside the request has a deadline, stops on a reset, and never leaves an order stuck when the ERP fails.
- The accepted answer is given after the ERP confirms, and says so.
- The same protections as the demo's mode.

## Done When

- A run in this mode behaves as designed under a slow ERP, covered by tests.

## Open Points

- None.

## Working Notes

_None yet._
