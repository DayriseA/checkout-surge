# Issue 05 - Align ERP circuit-open retries with reset timing

Status: Fixed


## Recommended Order Rationale

After ERP confirmation idempotency is fixed, tune retry behavior so circuit-open jobs wait for the half-open window instead of exhausting attempts immediately.

## Ownership Boundary

- Worker application retry classification
- Queue job publisher/backoff configuration
- Runtime config defaults where needed

## Problem

`ErpCircuitOpenError` carries `retryAfterMs`, but BullMQ retry scheduling ignores it. With default attempts and 500 ms exponential backoff, a job can exhaust retries before the worker circuit reset timeout of 10 seconds allows a half-open probe.

## Task

Make circuit-open retries respect the circuit reset window:

- Use `retryAfterMs` in BullMQ scheduling, a custom backoff strategy, or a delayed requeue.
- Avoid consuming normal ERP attempt budget while the circuit is deliberately open if that is the chosen model.
- Review default attempt/backoff values so they span the reset window.

## Acceptance Criteria

- Jobs are not terminally failed merely because the ERP circuit is open and waiting for its reset timeout.
- A half-open probe can occur before the order exhausts retry handling.
- Non-circuit retryable ERP failures still behave as intended.

## Tests

Add a regression test that opens the circuit and verifies the order is not marked failed before the half-open probe time.
