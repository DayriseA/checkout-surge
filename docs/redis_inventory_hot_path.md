# Redis Inventory Hot Path

This document describes the Redis inventory hot path: key structure, the inventory ownership boundary, the atomic reservation gate, durable persistence, and operator visibility.

## Redis Key Structure

Inventory keys are scoped per sale offer:

- `inventory:{saleOfferId}:state` stores the live inventory counters.
- `inventory:{saleOfferId}:reservations` stores reservation hold records by reservation ID.
- `inventory:{saleOfferId}:reservation-expirations` stores reservation IDs scored by hold expiry time.
- `inventory:{saleOfferId}:pending-persistence` stores reservation IDs that have a Redis hold but still need durable PostgreSQL reconciliation.
- `inventory:{saleOfferId}:events` stores recent hot-path inventory events.
- `inventory:{saleOfferId}:reservation-outcomes` stores run-scoped aggregate reservation-outcome counters, initially the `api_sold_out_decision` count and its latest-observed time, for durable sold-out accounting at finalization.
- `inventory:{saleOfferId}:idempotency:{idempotencyKey}` stores per-sale idempotency outcomes.

The local seed path initializes these keys from `sale_offers.allocated_stock`, and generated demo runs initialize them from the accepted run configuration snapshot. `sale_offers.allocated_stock` is the durable starting allocation for this demo; it is not a live remaining-inventory counter.

## Inventory Ownership Boundary

Checkout-Surge acknowledges ERP/database inventory ownership at the allocation boundary: a catalog sale offer or generated demo-run sale offer receives a durable stock allocation before traffic starts. PostgreSQL records that allocation on `sale_offers.allocated_stock` and records the run configuration snapshot that selected it.

Redis is the live authority while a run is active. The API uses Redis for the millisecond reservation gate, runtime inventory status, reservation holds, pending persistence visibility, recent hot-path inventory events, and aggregate sold-out outcome counters. The buy path does not update PostgreSQL inventory counters per request.

When a run reaches a terminal summary, the API copies a Redis-derived terminal inventory snapshot into immutable run history. That snapshot records the starting stock, final remaining and reserved stock, accepted reservations, sold-out rejections, pending persistence count, capture time, and `redis` source so completed runs remain auditable after the live Redis state is reset or deleted.

Payment authorization, customer cancel, payment timeout release, and automatic hold-expiry reconciliation are intentionally out of scope for this demo. A production implementation would add a payment/reconciliation worker that releases or expires holds atomically in Redis, persists reservation lifecycle events such as `reservation.released` or `reservation.expired`, and reconciles terminal Redis snapshots against the durable order/reservation ledger.

## Atomic Reservation Behavior

The API checks run sale eligibility from the Redis run-scoped eligibility payload, keyed by `runId`, then validates the supplied `saleOfferId` and accepting status from that cached record before using one Redis Lua operation for the stock decision. PostgreSQL is not part of the per-request losing path.

The Lua operation:

- replays an existing idempotency record when the same sale offer, idempotency key, and quantity are repeated;
- rejects mismatched duplicate payloads as an idempotency conflict;
- rejects sold-out attempts without decrementing stock or storing a per-request sold-out idempotency response, incrementing only the run-scoped `api_sold_out_decision` aggregate counter;
- decrements `remainingStock` and increments `reservedStock` atomically when stock is available;
- records the reservation hold, expiration score, and `inventory.updated` event before returning success.

## Durable Persistence Behavior

A Redis stock hold is the authoritative fast-path decision. PostgreSQL remains the durable business record.

After Redis succeeds, the API writes:

- the `reservations` row;
- the initial `orders` row in `queued` state;
- `reservation.secured` and `order.queued` events.

If PostgreSQL persistence fails after Redis has secured stock, the API preserves the Redis hold and returns `reservation_pending_persistence`.

That response intentionally has `order: null` because no durable order row exists yet.

## Idempotency and Retry Behavior

Idempotency is scoped by `saleOfferId + idempotencyKey`.

Retries for accepted or pending reservations with the same sale offer, key, and quantity replay the stored outcome.

Retries with the same sale offer and key but a different quantity are rejected with `idempotency_conflict`.

Sold-out responses are intentionally not stored per request, so a repeated sold-out attempt is evaluated as a fresh sold-out stock check. Late retries after the idempotency TTL are also treated as new attempts. In practice, a late retry will either reserve remaining stock or receive a normal sold-out response.

## Stale Holds and Operator Visibility

Reservation holds use the API's configured hold window. The initial default should be 15 minutes.

Expired reservation holds are tracked in Redis via `reservation-expirations`, but are not yet released or reconciled automatically. That active reconciliation belongs with payment/reconciliation work in a future production extension.

Operators can inspect:

- remaining stock;
- reserved stock;
- expired reservation count;
- pending persistence count;
- oldest pending persistence age.

The API exposes these signals through `GET /inventory/:saleOfferId/status`.

## Partial-Failure Rule

The system prefers preserving a secured Redis hold over immediately punishing the buyer for a transient PostgreSQL failure.

Pending persistence is not hidden:

- the API response is explicit;
- Redis tracks the reservation in `pending-persistence`;
- inventory status exposes pending count and oldest pending age.

This keeps the user-facing behavior realistic while making reconciliation work visible to operators.
