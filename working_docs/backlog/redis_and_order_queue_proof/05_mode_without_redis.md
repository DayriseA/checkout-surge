# 05 — Mode Without Redis

**Design:** sections 4, 5 · **Depends on:** 02, after the owner's go

## Goal

A run can use PostgreSQL alone for the stock decision, the sold-out answers and the order queue, with the same protections and answers as the demo's mode.

## Scope

- PostgreSQL decides the stock and holds the order queue.
- The same idempotency, run fence, bookkeeping, live counters and teardown as the demo's mode.
- The mode is a property of the run, set only by a comparative preset.
- None of the 2026-10-08 prototype's defects (design section 2.3).

## Done When

- A run in this mode completes with the same correctness guarantees as the demo's mode, covered by tests.

## Open Points

- None.

## Working Notes

_None yet._
