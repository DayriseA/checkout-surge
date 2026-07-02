# Issue 07 - Make terminal summary writes atomic with run terminal updates


## Recommended Order Rationale

Fix the shared terminal transition primitive before changing reset behavior. Reset summary work in Issue 08 should use this corrected path instead of adding another special case.

## Ownership Boundary

- API terminal summary writer
- Demo run finalization service
- Maintenance reset service interface where it shares terminal transitions

## Problem

`PostgresTerminalDemoRunSummaryWriter` inserts the immutable summary before proving the guarded `demo_runs` update succeeded. It returns `true` without checking the affected row count. Reset bypasses the writer and directly updates in-progress runs without the same advisory lock.

This can produce split-brain history: `demo_runs` says `failed/admin_reset`, while `demo_run_summaries` says `completed` or a different failure reason.

## Task

Make terminal transitions use one locked, atomic claim path:

- Have the writer claim/update the run row under the allowed-status predicate before or atomically with inserting the summary.
- Verify affected row count and return failure/no-op when the run could not be claimed.
- Route all terminal paths through the same advisory lock discipline.

## Acceptance Criteria

- A terminal summary cannot be inserted for a run unless the matching terminal run update is also valid.
- Competing terminal transitions cannot leave run row and summary row disagreeing.
- Existing successful finalization behavior remains intact.

## Tests

Add a concurrency regression test for reset racing with finalization.
