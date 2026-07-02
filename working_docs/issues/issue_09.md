# Issue 09 - Fail closed when generated-run Redis eligibility cannot be closed

Status: Fixed


## Recommended Order Rationale

After terminal state handling is consistent, close the hot-path lifecycle gap where stale Redis state can keep accepting buys for a run that durable state has already closed.

## Ownership Boundary

- API demo run lifecycle service
- Redis generated-run eligibility helper
- Reservation hot path only where needed to fail closed

## Problem

The buy path trusts Redis inventory state for generated-run eligibility. Lifecycle code updates PostgreSQL to `draining` or `failed`, then attempts Redis sale closure as best-effort and suppresses closure failures. If Redis close fails, stale Redis state can still say `runSaleStatus: accepting`.

## Task

Make generated-run closure fail closed:

- Either make Redis closure part of the guarded lifecycle transition, or add a durable/repairable closure path that prevents stale Redis eligibility from accepting old runs.
- Ensure generated-run buy eligibility cannot remain open after durable run closure.
- Avoid adding queue, worker, or dashboard behavior into route layers.

## Acceptance Criteria

- A run moved to `draining` or `failed` cannot continue accepting `/buy` calls because of stale Redis hash state.
- Redis close failure is observable and repairable instead of silently leaving eligibility open.
- Existing active-run hot-path behavior remains fast for valid accepting runs.

## Tests

Add regression coverage for Redis close failure during run closure followed by a buy attempt for the old run.
