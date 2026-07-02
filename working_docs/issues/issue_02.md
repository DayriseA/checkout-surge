# Issue 02 - Reconcile Redis-secured pending reservations

Status: Fixed


## Recommended Order Rationale

After the order/reservation invariant is protected, fix the buy-path recovery hole that can leave Redis stock secured without a durable order. This is the highest-impact customer-facing data-loss issue.

## Ownership Boundary

- API application service: `ReserveOrderService`
- Persistence adapter: `PostgresBuyPersistence`
- Redis reservation helper behavior only where needed

## Problem

When Redis secures stock but `persistSecuredReservation()` fails, the service returns `reservation_pending_persistence` and records a pending hold. Later retries with the same idempotency key only check for an already-persisted buy, re-record pending state, re-mark the Redis sentinel, and return pending again.

The service never retries the durable reservation/order insert from the stored Redis hold after PostgreSQL recovers.

## Task

Add a reconciliation path for previously secured Redis holds:

- On pending replay, load enough hold data to retry the durable reservation/order write.
- If no durable buy exists and PostgreSQL is available, persist the original secured reservation/order.
- Mark the pending record reconciled once durable persistence succeeds.
- Preserve idempotency: repeated retries must return the same durable accepted result once reconciled.

## Acceptance Criteria

- A transient PostgreSQL failure after Redis stock security can be recovered by a later client retry.
- Reconciliation does not consume additional Redis stock.
- Queue publication and Redis promotion happen exactly as they would for the original successful secured decision.
- Pending state is not permanent when the durable write can now succeed.

## Tests

Update the current pending-persistence tests so they assert eventual reconciliation instead of permanent pending. Coordinate with Issue 04, which audits tests that currently lock in known-bad behavior.
