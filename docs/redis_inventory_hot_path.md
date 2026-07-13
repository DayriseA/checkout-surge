# Redis Inventory Hot Path

This document describes the Redis inventory hot path: key structure, the inventory ownership boundary, the atomic reservation gate, durable persistence, and operator visibility.

## Redis Key Structure

Inventory keys are scoped per sale offer:

- `inventory:{saleOfferId}:state` stores the live inventory counters and authoritative inventory scope. Catalog state carries `inventoryScope: catalog`; generated-run state carries `inventoryScope: generated_run`, its `runId`, and `runSaleStatus` (`accepting` or `closed`). Legacy or test inventory state without `inventoryScope` is treated as catalog state for backward compatibility.
- `inventory:{saleOfferId}:reservations` stores reservation hold records by reservation ID.
- `inventory:{saleOfferId}:reservation-expirations` stores reservation IDs scored by hold expiry time.
- `inventory:{saleOfferId}:pending-persistence` stores reservation IDs that have a Redis hold but still need durable PostgreSQL reconciliation.
- `inventory:{saleOfferId}:pending-persistence-records` stores the self-sufficient hold and idempotency context needed to reconcile those IDs without scanning Redis keys.
- `inventory:pending-persistence-index` is a global sorted index of namespaced pending reservation IDs used in bounded batches by API startup reconciliation.
- `inventory:{saleOfferId}:events` stores recent hot-path inventory events.
- `inventory:{saleOfferId}:reservation-throughput` stores an exact fixed 60-slot ring of per-second successful reservation-request counts.
- `inventory:{saleOfferId}:reservation-outcomes` stores run-scoped aggregate reservation-outcome counters, initially the `api_sold_out_decision` count and its latest-observed time, for durable sold-out accounting at finalization.
- `inventory:{saleOfferId}:idempotency:{idempotencyKey}` stores per-sale idempotency outcomes.

The local seed path initializes these keys from `sale_offers.allocated_stock`, and generated demo runs initialize them from the accepted run configuration snapshot. `sale_offers.allocated_stock` is the durable starting allocation for this demo; it is not a live remaining-inventory counter.

Generated-run inventory keys and the separate `demo-run:{runId}:sale-eligibility` projection are persistent lifecycle state and do not rely on an arbitrary TTL. Old-run maintenance first commits one ownership-guarded PostgreSQL subtree deletion, then scans and asynchronously unlinks the entire `inventory:{saleOfferId}:*` namespace plus that run's eligibility key. Dynamic idempotency children are therefore included. Redis teardown is idempotent and best effort: a failure is logged with the run, offer, and correlation IDs and does not make truthful committed database counts fail or stop later candidates.

## Inventory Ownership Boundary

Checkout-Surge acknowledges ERP/database inventory ownership at the allocation boundary: a catalog sale offer or generated demo-run sale offer receives a durable stock allocation before traffic starts. PostgreSQL records that allocation on `sale_offers.allocated_stock` and records the run configuration snapshot that selected it.

Redis is the live authority while a run is active. The API uses Redis for the millisecond reservation gate, runtime inventory status, reservation holds, pending persistence visibility, recent hot-path inventory events, and aggregate sold-out outcome counters. The buy path does not update PostgreSQL inventory counters per request.

Traffic-completion enrichment closes run admission before reading inventory and stores a Redis-derived terminal snapshot inside the durable traffic-outcome finalization record. The row has an explicit `pending`/`completed` enrichment state, so finalization cannot mistake an in-progress capture for a legitimate no-snapshot result. Redis is read outside the PostgreSQL transaction; a database compare-and-set lets only the first durably completed attempt persist its snapshot, paired traffic-completion business outcome, and sold-out aggregate. Duplicate delivery and lifecycle recovery re-drive closure and pending work, while completed enrichment never recaptures Redis. If the inventory namespace is already absent, closure is already fail-closed and delivery may continue; connection failures and all other closure errors remain retryable because closure cannot be proven. A pending capture against absent inventory concludes as an explicit no-snapshot result. Normal business finalization strictly validates and copies the durable nested snapshot into immutable run history without a live Redis fallback; legacy or failed-capture rows therefore retain a `null` history value.

Payment authorization, customer cancel, payment timeout release, and automatic hold-expiry reconciliation are intentionally out of scope for this demo. A production implementation would add a payment/reconciliation worker that releases or expires holds atomically in Redis, persists reservation lifecycle events such as `reservation.released` or `reservation.expired`, and reconciles terminal Redis snapshots against the durable order/reservation ledger.

## Atomic Reservation Behavior

Generated-run buy requests first pass the Redis inventory projection. The projection verifies that the supplied `runId` owns the generated `saleOfferId` and that `runSaleStatus` is `accepting`; catalog requests must omit `runId`. Missing, malformed, closed, or mismatched projections fail before PostgreSQL is touched. Lifecycle compare-and-set transitions close the projection when traffic begins draining or the run becomes terminal.

The stock-decision Lua operation reads inventory scope, run identity, and accepting/closed state directly from the inventory hash before considering idempotency or stock. Generated-run inventory fails closed when `runId` is omitted, mismatched, or no longer accepting traffic. Catalog inventory rejects requests that supply a `runId`. Redis is the first persistence operation and the stock-decision authority. Only an accepted generated-run hold reaches the subsequent PostgreSQL advisory-lock boundary, where durable run/sale ownership and non-terminal status are checked before business rows commit.

Run lifecycle changes update the authoritative inventory hash and the separate run-scoped eligibility payload in one Redis Lua operation. The separate payload remains a useful lifecycle/read projection, but the buy path never consults it. Because closure and reservation are both Redis Lua operations, they serialize: a reservation ordered before closure may succeed, while one ordered after closure rejects without changing counters, holds, pending-persistence state, throughput, events, or idempotency records. A late traffic-start acknowledgement is fenced by the durable lifecycle compare-and-set and does not write Redis, so it cannot reopen a closed projection.

The Lua operation:

- checks inventory scope, run identity, and accepting state before idempotency replay, so closure also prevents replay through the buy path;
- replays an existing idempotency record when the same eligible sale offer, idempotency key, and quantity are repeated;
- rejects mismatched duplicate payloads as an idempotency conflict;
- rejects sold-out attempts without decrementing stock or storing a per-request sold-out idempotency response, incrementing only the run-scoped `api_sold_out_decision` aggregate counter;
- decrements `remainingStock` and increments `reservedStock` atomically when stock is available;
- records the reservation hold, expiration score, pending-persistence sentinel, and `inventory.updated` event before returning success.
- records the companion pending-persistence recovery payload and global index member in that same atomic operation.

Before its first write, the operation validates the required stock counters, their allocation invariant, and the Redis types of every collection it controls. This matters because Redis does not roll back writes performed before a Lua runtime error.

Inventory status reads enforce the same allocation invariant: `remainingStock + reservedStock` must equal `allocatedStock`. Contradictory counters are reported as malformed state rather than returned to operators.

Each successful `inventory.updated` event carries `reservationCount: 1`, `reservedQuantity`, remaining stock, reserved stock, and the event time. Initialization events intentionally omit the reservation-only fields. The event list remains capped at 100 and is suitable for bounded recent updates, but throughput does not depend on the list retaining every surge event.

The successful reservation-request throughput projection uses a 60-second ring with one slot per epoch second. A successful non-replay reservation increments one request regardless of its reserved quantity; idempotent replays do not increment it. Reads sum only slots in the inclusive interval from the measurement second minus 59 through the measurement second, then report the count, fixed 60-second window, `reservations_per_second` unit, rate as `count / 60`, and measurement time. The ring has at most 120 hash fields and is reset with the inventory namespace, so write and read cost do not grow with run volume.

Sold-out pressure remains one aggregate rejection count plus its latest-observed timestamp. Sold-out attempts do not create per-loser records or events.

## Durable Persistence Behavior

A Redis stock hold is the authoritative fast-path decision. PostgreSQL remains the durable business record.

After Redis succeeds, the API writes:

- the `reservations` row;
- the initial `orders` row in `queued` state;
- `reservation.secured` and `order.queued` events.

If concurrent requests for the same secured hold race the durable insert, recovery is deliberately narrow: only the reservation primary-key or reservation-token uniqueness boundary is eligible. After the losing transaction has rolled back, the adapter rereads through the outer database connection and returns the winner only when reservation and order identity fully match. Unrelated constraint failures or mismatched/incomplete rows stay on the real persistence-failure path instead of creating a false reconciled outcome.

The initial stock decision and pending-persistence sentinel are one atomic Redis operation, so a process crash immediately after stock is secured cannot hide the hold from inventory status. After PostgreSQL commits, accepted-idempotency promotion and sentinel removal are also one atomic Redis operation.

If PostgreSQL persistence fails after Redis has secured stock, the API preserves the Redis hold and returns `reservation_pending_persistence`.

That response intentionally has `order: null` because no durable order row exists yet.

On an eligible retry with the same idempotency key, the API reuses the original Redis hold to retry the durable reservation/order write. When that write succeeds, PostgreSQL marks the pending-persistence row `reconciled`, the API enqueues the order-processing job, promotes the Redis idempotency record to accepted, removes the Redis pending metadata, and returns the durable accepted replay without consuming additional stock.

Admission closure intentionally prevents `/buy` from replaying a pending hold. The API-owned `PendingPersistenceReconciler` therefore runs outside the buy path during draining finalization and startup repair. It reads self-sufficient pending records without a keyspace scan, finds or creates the durable reservation/order, reasserts the deterministic queue job, marks the durable pending row reconciled, and promotes Redis. If the durable boundary definitively proves a run/sale attribution mismatch, an atomic reversal restores stock and removes the hold, expiration, idempotency, and pending metadata. Other failures remain discoverable and retryable.

## Idempotency and Retry Behavior

Idempotency is scoped by `saleOfferId + idempotencyKey`.

Request retries for accepted or pending reservations with the same sale offer, key, and quantity replay the stored Redis hold only while the inventory scope and run state remain eligible. Accepted holds return the existing durable acceptance projection, always shaped as reservation `secured` plus order `queued` even if the live order has since advanced. Pending holds first check for a durable buy and otherwise retry durable persistence from the original hold; they return `reservation_pending_persistence` again only while the durable write is still unavailable. After closure, only the autonomous reconciler may converge an existing pending hold, and it does not admit a new purchase.

Retries with the same sale offer and key but a different quantity are rejected with `idempotency_conflict`.

Sold-out responses are intentionally not stored per request, so a repeated sold-out attempt is evaluated as a fresh sold-out stock check. Late retries after the idempotency TTL are also treated as new attempts. In practice, a late retry will either reserve remaining stock or receive a normal sold-out response.

Hold expiry does not change retry semantics while the idempotency record remains live. A stale accepted hold still replays its durable reservation and order; a stale pending hold still uses the original secured hold for reconciliation and returns `reservation_pending_persistence` with `order: null` and `Retry-After` only if durable persistence is still unavailable. Once the idempotency TTL expires, either retry is a new attempt even though the original hold remains reserved and operator-visible.

## Stale Holds and Operator Visibility

Reservation holds use the API's configured hold window. The default is 15 minutes.

Expired reservation holds are tracked in Redis via `reservation-expirations`, but the local demo intentionally retains them instead of releasing or reconciling them automatically. Active release/reconciliation belongs with payment or reconciliation work outside the current Node.js demo track.

`expiredReservationCount` includes a hold when its expiry timestamp is equal to or earlier than the status measurement time. Expiry changes visibility only: it does not change `remainingStock`, `reservedStock`, pending-persistence membership, or the stored retry outcome.

Operators can inspect:

- remaining stock;
- reserved stock;
- expired reservation count;
- pending persistence count;
- oldest pending persistence age;
- successful reservation-request throughput over the fixed rolling window;
- aggregate sold-out rejection count and latest-observed time.

The API exposes these signals through `GET /inventory/:saleOfferId/status`.

## Partial-Failure Rule

The system prefers preserving a secured Redis hold over immediately punishing the buyer for a transient PostgreSQL failure.

Pending persistence is not hidden:

- the API response is explicit;
- Redis tracks the reservation in `pending-persistence`;
- inventory status exposes pending count and oldest pending age.

The service may idempotently ensure the marker again after a PostgreSQL failure. If that ensure reports an error, the API still returns the explicit pending response because the original atomic stock decision already created the sentinel and recovery record. PostgreSQL persistence, marker-ensure, enqueue, and accepted-promotion failures are reported through structured logs with correlation and reservation context. A request retry or autonomous lifecycle reconciliation can converge the original hold into durable rows, mark the pending record reconciled, reassert the deterministic order job, promote the Redis outcome, and remove pending metadata. A promotion failure after PostgreSQL commits still returns truthful `reservation_secured`; the sentinel remains visible until the next reconciliation finds the durable rows and repairs Redis.

This keeps the user-facing behavior realistic while making reconciliation work visible to operators.
