# Issue 03 - Make ERP confirmation idempotent across local persistence failures

Status: Fixed


## Recommended Order Rationale

Handle external side-effect idempotency before retry tuning. Once successful ERP confirmations are reusable, later circuit and retry changes can focus on scheduling without duplicating downstream confirmations.

## Ownership Boundary

- Worker application service: order process job handler
- Worker ERP client and attempt persistence
- Mock ERP contract only if an idempotency key must be honored downstream

## Problem

The worker calls ERP before the order is durably marked confirmed. If `transitionToConfirmed()` fails after ERP succeeds, the order remains `processing`; the next delivery calls ERP again. The mock ERP generates a fresh confirmation ID each time and does not dedupe by `orderId`.

## Task

Make the worker/ERP boundary idempotent:

- Send a stable idempotency key for the order confirmation attempt.
- Persist or reuse successful ERP confirmation results before retrying the external call.
- Distinguish "ERP succeeded but local persistence failed" from ordinary dependency failures.
- Avoid marking an order failed solely because local attempt persistence failed after ERP accepted the order.

## Acceptance Criteria

- Retrying after confirmed-state persistence failure does not call ERP a second time for the same order.
- The order can still reach `confirmed` using the existing successful ERP result.
- Retryable local persistence errors remain retryable without duplicating downstream confirmations.

## Tests

Update worker unit tests that currently expect duplicate confirmation calls. Add coverage for successful ERP reuse after local persistence failure.
