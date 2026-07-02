# Issue 11 - Make load completion reporting retryable or durable

Status: Fixed

## Recommended Order Rationale

Once API lifecycle closure is fail-closed, fix the load-orchestrator path that tells the API traffic is complete. Without this, runs can remain active forever even when k6 finished correctly.

## Ownership Boundary

- Load-orchestrator `SpawnK6Runner`
- Load-to-API client
- Completion report contract/idempotency

## Problem

When k6 exits, `SpawnK6Runner.reportCompletion()` posts completion once. If that API call fails, the error is logged, the temp run directory is removed, and there is no retry, outbox, or reconciliation. The API only moves a run from `starting`/`active` to `draining` when completion reaches `recordTrafficCompletion()`.

## Task

Make completion delivery reliable:

- Add bounded retry with backoff and/or persist a small completion outbox until the API accepts the report.
- Ensure completion submission is idempotent.
- Preserve temp artifacts until the completion path no longer needs them, or persist the needed payload separately.

## Acceptance Criteria

- A transient API failure during completion reporting does not leave the run permanently active.
- The run reaches `draining` after retry/recovery.
- Completion retries do not duplicate or corrupt run finalization input.

## Tests

Add a regression test where `sendCompletion()` fails once and the run still reaches the completion-reported path.
