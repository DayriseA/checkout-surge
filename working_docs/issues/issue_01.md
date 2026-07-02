# Issue 01 - Enforce orders against secured reservations

Status: Fixed


## Recommended Order Rationale

Start with the database/business invariant that every order must be backed by the exact secured reservation it claims. Later worker, finalization, and summary fixes become easier to reason about once PostgreSQL rejects impossible order/reservation pairs.

## Ownership Boundary

- Shared package: `@checkout-surge/db`
- Persistence adapter and schema/migration tests

## Problem

`orders.reservationId` is unique and references `reservations.id`, but PostgreSQL does not require the reservation to be `secured` or to match the order's `saleOfferId`, `runId`, `correlationId`, and `quantity`.

This allows confirmed orders to exist for released, expired, rejected, or mismatched reservations.

## Task

Add a migration-backed relational guard, most likely a trigger, that rejects order inserts/updates unless the referenced reservation:

- Exists and has `status = 'secured'`.
- Has the same `saleOfferId`.
- Has the same nullable `runId`.
- Has the same `correlationId`.
- Has the same `quantity`.

Keep the generated-run sale-offer ownership trigger separate from this order-to-reservation invariant.

## Acceptance Criteria

- Invalid orders for non-secured reservations are rejected.
- Invalid orders with mismatched offer, run, correlation ID, or quantity are rejected.
- Valid orders for matching secured reservations still insert/update successfully.
- Worker transitions cannot confirm an order whose backing reservation violates the invariant.

## Tests

Add DB schema/integration tests for valid, non-secured, and mismatched reservation cases.
