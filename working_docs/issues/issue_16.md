# Issue 16 - Move dashboard aggregate reads out of the synchronous buy path

Status: Fixed


## Recommended Order Rationale

After correctness issues in the reservation/order path are handled, reduce hot-path latency and PostgreSQL read load for accepted-heavy runs.

## Ownership Boundary

- API `ReserveOrderService`
- Business outcome dashboard publisher
- Event or async refresh boundary

## Problem

After durable persistence, queue enqueue, and Redis promotion, `ReserveOrderService` awaits dashboard publication before returning `reservation_secured`. The default publisher reads full business outcome and consistency lag projections with multiple PostgreSQL aggregate queries on every accepted reservation.

## Task

Move dashboard aggregate refresh out of the synchronous buy response path:

- Publish a lightweight event, enqueue an async refresh, or otherwise decouple aggregate reads from the accepted response.
- Preserve durable success semantics and error reporting for the reservation/order write.
- Keep dashboard projection eventually consistent with documented recovery behavior.

## Acceptance Criteria

- Accepted reservations do not synchronously perform full dashboard aggregate reads before responding.
- Dashboard updates still arrive or recover through the durable read model.
- Buy-path error handling does not hide durable success.

## Tests

Add a service-level regression/performance-style test asserting accepted reservations do not await aggregate dashboard reads.
