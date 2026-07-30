# Redis Inventory Hot Path

This document describes the Redis inventory hot path: key structure, the inventory ownership boundary, the atomic reservation gate, durable persistence, and operator visibility.

## Redis Key Structure

Inventory keys are scoped per sale offer:

- `inventory:{saleOfferId}:state` stores the live inventory counters and authoritative inventory scope. Catalog state carries `inventoryScope: catalog`; generated-run state carries `inventoryScope: generated_run`, its `runId`, and `runSaleStatus` (`accepting` or `closed`). Missing or invalid scope data is rejected rather than translated to another shape.
- `inventory:{saleOfferId}:reservations` stores reservation hold records by reservation ID.
- `inventory:{saleOfferId}:reservation-expirations` stores reservation IDs scored by hold expiry time.
- `inventory:{saleOfferId}:pending-persistence` stores reservation IDs that have a Redis hold but still need durable PostgreSQL reconciliation.
- `inventory:{saleOfferId}:pending-persistence-records` stores the self-sufficient hold, idempotency context, retry timing, attempt count, recovery deadline, last error, and pending/exhausted state used by the sole per-sale recovery owner. There is no global pending index.
- `inventory:{saleOfferId}:events` stores the newest 500 hot-path inventory updates in chronological insertion order. It is a bounded diagnostic window, not a recovery source or supported public API.
- `inventory:{saleOfferId}:reservation-throughput` stores an exact fixed 60-slot ring of per-second successful reservation-request counts.
- `inventory:{saleOfferId}:sold-out` stores the run-scoped sold-out count and its latest-observed time for durable accounting at finalization.
- `inventory:{saleOfferId}:idempotency:{idempotencyKey}` stores per-sale idempotency outcomes.

The local seed path initializes these keys from `sale_offers.allocated_stock`, and generated demo runs initialize them from the accepted run configuration snapshot. `sale_offers.allocated_stock` is the durable starting allocation for this demo; it is not a live remaining-inventory counter.

Generated-run inventory keys are persistent lifecycle state and are never expired while live. The separate `demo-run:{runId}:sale-eligibility` authorization projection has a fixed seven-day TTL as a fail-closed backstop for a missed close; setting it to `accepting` creates or refreshes that TTL, while closing preserves the remaining lifetime and never recreates an absent key. API startup rejects configuration unless maximum start delay, traffic duration, drain timeout, the pending-persistence recovery window, and finalization cadence together leave a full 24-hour safety margin before expiry. The TTL is defense in depth, not evidence of lifecycle completion, and uses Redis server time. The `demo-run:{runId}:traffic-metrics` list and `demo-run:{runId}:traffic-metrics-pinned` hash independently refresh bounded 24-hour TTLs as metrics arrive; the `demo-run:{runId}:traffic-metrics-reset-fence` key uses the same bounded TTL. Broad old-run and protected targeted maintenance remove all of this run-owned state without waiting for expiry: the complete `inventory:{saleOfferId}:*` namespace plus the run's eligibility, traffic-metrics, pinned-metrics, and reset-fence keys. Dynamic idempotency children are therefore included.

Reset does not delete inventory namespaces. Retention and protected single-run teardown use the same strict exact-run workflow: a Redis failure fails the operation before durable deletion, logs the run, offer, and correlation IDs, and leaves the durable identity available for an idempotent retry.

## Inventory Ownership Boundary

Checkout-Surge acknowledges ERP/database inventory ownership at the allocation boundary: a catalog sale offer or generated demo-run sale offer receives a durable stock allocation before traffic starts. PostgreSQL records that allocation on `sale_offers.allocated_stock` and records the run configuration snapshot that selected it.

Redis is the live authority while a run is active. The API uses Redis for the millisecond reservation gate, runtime inventory status, reservation holds, pending persistence visibility, recent hot-path inventory events, and aggregate sold-out outcome counters. The buy path does not update PostgreSQL inventory counters per request.

Traffic-completion enrichment closes run admission before reading inventory and stores a Redis-derived traffic-boundary snapshot inside the durable traffic-outcome finalization record. The row has an explicit `pending`/`completed` enrichment state, so finalization cannot mistake an in-progress capture for a legitimate no-snapshot result. Redis is read outside the PostgreSQL transaction; a database compare-and-set lets only the first durably completed attempt persist its snapshot, paired traffic-completion business outcome, and sold-out aggregate. Exact completion redelivery and startup reconciliation re-drive closure and pending work; there is no periodic enrichment scanner, and completed enrichment never recaptures Redis. If the inventory namespace is already absent, closure is already fail-closed and delivery may continue; connection failures and all other closure errors remain retryable because closure cannot be proven. A pending capture against absent inventory concludes as an explicit no-snapshot result. Normal business finalization independently captures the actual terminal inventory after pending cleanup; it does not copy the earlier traffic-boundary observation into immutable history.

Payment authorization, customer cancel, payment timeout release, and automatic hold-expiry reconciliation are intentionally out of scope for this demo. A production implementation would add a payment/reconciliation worker that releases or expires holds atomically in Redis, defines and persists the corresponding lifecycle facts, and reconciles terminal Redis snapshots against the durable order/reservation ledger.

The scope classification is recorded in [Scope and Caveats](scope_and_caveats.md#intentional-non-goals); this section remains authoritative for inventory ownership and the required reconciliation shape.

## Atomic Reservation Behavior

Generated-run buy requests first pass the atomic Redis inventory projection. The reservation command verifies that the supplied `runId` owns the generated `saleOfferId`, inventory `runSaleStatus` is `accepting`, and the synchronized JSON eligibility key safely decodes to an object with the same run, offer, and accepting state. Catalog requests must omit `runId` and do not use a run eligibility key. Missing, expired, wrong-type, malformed, primitive, closed, or mismatched generated-run projections all return the same ineligible decision before idempotency replay, stock mutation, or PostgreSQL access. Lifecycle compare-and-set transitions close the projection when traffic begins draining or the run becomes terminal.

The stock-decision Lua operation reads inventory scope, run identity, and accepting/closed state directly from the inventory hash before considering idempotency or stock. Generated-run inventory fails closed when `runId` is omitted, mismatched, or no longer accepting traffic. Catalog inventory rejects requests that supply a `runId`. Redis is the first persistence operation and the stock-decision authority. Only an accepted generated-run hold resolves its frozen run retry policy and reaches the subsequent shared PostgreSQL admission boundary, where durable run/sale ownership and non-terminal status are checked before business rows commit. Terminal and reset transitions take the corresponding exclusive lock.

Run lifecycle changes update the authoritative inventory hash and the separate run-scoped eligibility payload in one Redis Lua operation. The buy Lua command validates both projections in that same atomic reservation decision, so expiry of the authorization key fails closed even if a missed lifecycle transition left the inventory hash accepting. Because closure and reservation are both Redis Lua operations, they serialize: a reservation ordered before closure may succeed, while one ordered after closure rejects without changing counters, holds, pending-persistence state, throughput, events, or idempotency records. A late traffic-start acknowledgement is fenced by the durable lifecycle compare-and-set and does not write Redis, so it cannot reopen a closed projection.

The Lua operation:

- checks inventory scope, run identity, and accepting state before idempotency replay, so closure also prevents replay through the buy path;
- replays an existing idempotency record when the same eligible sale offer, idempotency key, and quantity are repeated;
- rejects mismatched duplicate payloads as an idempotency conflict;
- rejects sold-out attempts without decrementing stock or storing a per-request sold-out idempotency response, incrementing only the run-scoped sold-out counter;
- decrements `remainingStock` and increments `reservedStock` atomically when stock is available;
- records the reservation hold, expiration score, pending-persistence sentinel, and `inventory.updated` event before returning success.
- records the companion per-sale pending-persistence recovery payload in that same atomic operation.

Before its first write, the operation validates the required stock counters, their allocation invariant, and the Redis types of every collection it controls. This matters because Redis does not roll back writes performed before a Lua runtime error.

Inventory status reads enforce the same allocation invariant: `remainingStock + reservedStock` must equal `allocatedStock`. Contradictory counters are reported as malformed state rather than returned to operators.

Each fresh successful reservation appends an `inventory.updated` event carrying `reservationCount: 1`, `reservedQuantity`, remaining stock, reserved stock, and the event time. Initialization and reservation-reversal events intentionally omit the reservation-only fields. All three writers use the same DB-owned retention policy: `RPUSH` followed by negative-index `LTRIM` keeps at most the newest 500 updates in chronological insertion order. Sold-out decisions and idempotent replays do not consume slots. Initialization clears the inventory namespace first, so a newly initialized offer starts with exactly its initialization event.

This list is bounded operator/debug evidence, not a complete audit trail, recovery source, workflow input, or realtime delivery channel. It has no production reader and no TTL, so retained entries may remain indefinitely until explicit initialization, reset, or maintenance removes the inventory namespace. The 500-entry limit is an implementation policy rather than runtime configuration. Retention is per sale offer and measures successful updates rather than elapsed time; raising it increases this key's worst-case retained entries fivefold, while key lifecycle remains governed by those explicit operations. PostgreSQL reservation and order events remain the durable business record.

The successful reservation-request throughput projection uses a 60-second ring with one slot per epoch second. A successful non-replay reservation increments one request regardless of its reserved quantity; idempotent replays do not increment it. Reads include only slots in the inclusive interval from the measurement second minus 59 through the measurement second, then report the total count, fixed 60-second retention window, peak count in any included one-second slot as `peakRatePerSecond`, `peakWindowSeconds: 1`, `reservations_per_second` unit, and measurement time. The ring has at most 120 hash fields and is reset with the inventory namespace, so write and read cost do not grow with run volume.

Sold-out pressure remains one aggregate rejection count plus its latest-observed timestamp. Sold-out attempts do not create per-loser records or events.

## Durable Persistence Behavior

A Redis stock hold is the authoritative fast-path decision. PostgreSQL remains the durable business record. After Redis succeeds, the API writes the reservation, queued order, and initial durable events. Concurrent durable inserts recover only from matching reservation identity; no inventory decision is applied twice.

If PostgreSQL persistence fails, the API preserves the hold and returns `reservation_pending_persistence` with `order: null`. `PendingPersistenceRecoveryService` is the only component that discovers, schedules, or resolves this handoff. It enumerates known nonterminal run/sale scopes and active catalog offers from PostgreSQL, then reads due work from each per-sale Redis index in fixed bounded pages. Catalog holds therefore use the same owner without a global Redis index. Run-attributed recovery uses the recovery-only shared run lock without reopening buy admission. Request replay performs an exact per-sale/reservation lookup and delegates only when the stored next-attempt time is due.

The owner first writes the attempt audit, verifies or materializes the exact durable reservation/order, deterministically reasserts the BullMQ job, durably marks the audit resolved, and only then atomically promotes the Redis idempotency record and removes per-sale pending metadata. An attempt or resolution-audit failure leaves Redis pending. If promotion fails while the cursor remains, the owner restores the audit to retryable or exhausted state and a later attempt reasserts the same durable identities. If promotion applied but its response was lost, Redis reports that the cursor is already absent; the owner preserves the resolved audit and successful durable result instead of inventing pending or exhausted history. Repetition cannot consume stock again, duplicate business rows, or create a second queue identity.

The PostgreSQL `reservation_pending_persistence` row is subordinate audit evidence, not discovery or scheduling state. Its minimal coordinates are reservation, sale, optional run, and correlation IDs; its evidence is status, attempt count, last error, exhaustion time, and creation/update times. Business-outcome projection may display pending/exhausted audit evidence, but finalization replaces that field with the authoritative Redis count for accepted-response accounting and blocking decisions, so an audit row cannot independently terminalize or strand a run.

Recovery is bounded and observable. Defaults are a 300-second window, six attempts, exponential backoff from 1 second to 30 seconds, a 1-second owner poll, a 2-second whole-discovery deadline, three concurrent direct replay attempts, and a bounded page of 100. The deadline is derived once from the original secured time and stored with the first failed/audit-deferred attempt; later processes honor that stored deadline even if configuration changes. Marker ensure preserves the status, attempts, deadline, error, next-attempt time, and scheduling score. Future and exhausted records are excluded from due polling. Malformed or missing companion metadata is logged and its per-sale cursor is quarantined outside the due range only if that cursor still exists when Redis applies the update, leaving genuine raw hold/evidence operator-visible without starving later valid work or recreating concurrently resolved work.

Exhaustion first marks the Redis cursor authoritatively exhausted and outside due work while leaving the hold and pending sentinel intact, then attempts a separately bounded subordinate PostgreSQL audit write and emits an attributable error log. If the cursor was concurrently removed, the owner does not overwrite already-resolved audit truth. A first observation at the deadline records zero attempts truthfully. Run reset remains the explicit operator escape hatch; catalog exhaustion stays visible in its per-sale Redis state and audit for explicit operational cleanup. Recovery never silently reverses an exhausted, terminal, invalid, or mismatched hold.

Startup reconciliation only closes draining-run admission and completes traffic enrichment. Completion enrichment, finalization, routes, maintenance, and workers do not discover, schedule, or resolve this handoff. Finalization observes Redis pending state and cannot write a successful or failed terminal summary before or after drain timeout while that state is nonzero, exhausted, malformed, or unreadable. Its final inventory read remains inside the terminal fence and has the existing two-second operation deadline. PostgreSQL-to-BullMQ dispatch recovery and worker failed-set/order/notification recovery remain separate guarantees.

The recovery scheduler starts once, never overlaps its own passes, reschedules after a pass failure, and cancels an unstarted tick. Discovery has its own whole-operation deadline: PostgreSQL statements receive the discovery abort signal and the dedicated Redis client has the same command timeout, so one hung scope read cannot wedge the scheduler. Every admitted record attempt owns abortable PostgreSQL, command-bounded Redis, and disconnectable BullMQ resources until its persisted deadline. A focused API runtime factory constructs those discovery and attempt resources and owns partial-construction rollback, abort-triggered release, idempotent close, and aggregate cleanup errors; the recovery service remains the single scheduling and repair authority. Shutdown closes admission, aborts discovery and attempts, treats only those close-triggered cancellation/disconnect results as expected, drains admitted work, and still runs all remaining API resource cleanup. Unexpected cleanup failures remain aggregated and visible.

## Idempotency and Retry Behavior

Idempotency is scoped by `saleOfferId + idempotencyKey`.

Request retries for accepted or pending reservations with the same sale offer, key, and quantity replay the stored Redis hold only while the inventory scope and run state remain eligible. Accepted holds return the existing durable acceptance projection with public outcome `reservation_secured` and order `queued`, even if the live order has since advanced. Pending retries delegate the original hold to the sole recovery owner. Distinct direct attempts use a process-local permit cap; overload deterministically returns the unchanged public `reservation_pending_persistence` response and leaves the cursor retryable, while same-reservation callers still coalesce. After durable persistence and deterministic queue publication, accepted promotion starts a fresh full idempotency replay TTL. Promotion can recreate an accepted record from the original fully validated durable hold if the provisional record expired, while an intervening conflicting record is preserved and rejected by exact identity comparison. After closure, only the self-scheduling recovery owner may converge an existing pending hold, and it does not admit a new purchase.

Current downstream progress is intentionally separate from Redis idempotency replay. `GET /orders/:publicOrderId/status` reads the live PostgreSQL order, reservation, and event timeline and can therefore report `processing`, `confirmed`, or `failed` without changing `/buy` semantics or consulting Redis.

Retries with the same sale offer and key but a different quantity are rejected with `idempotency_conflict`.

Sold-out responses are intentionally not stored per request, so a repeated sold-out attempt is evaluated as a fresh sold-out stock check. Late retries after the applicable idempotency TTL are also treated as new attempts. For a durable acceptance, that window is measured from accepted promotion rather than initial stock securing. In practice, a retry after that accepted replay window will either reserve remaining stock or receive a normal sold-out response.

Hold expiry does not change retry semantics while the idempotency record remains live. A stale accepted hold still replays its durable reservation and order; a stale pending hold still uses the original secured hold for reconciliation and returns `reservation_pending_persistence` with `order: null` and `Retry-After` only if durable persistence is still unavailable. Expiry of the provisional record does not prevent a later durable handoff from recreating the accepted replay record. Once the final accepted replay TTL expires, a retry is a new attempt even though the original hold remains reserved and operator-visible.

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

The service may idempotently ensure the marker again after a PostgreSQL failure. If that ensure reports an error, the API still returns the explicit pending response because the original atomic stock decision already created the sentinel and recovery record. PostgreSQL persistence, marker-ensure, enqueue, and accepted-promotion failures are reported through structured logs with correlation and reservation context. The sole recovery owner can converge the original hold into durable rows, reassert the deterministic order job, promote the Redis outcome, and remove pending metadata. A promotion failure after PostgreSQL commits still returns truthful `reservation_secured`; the sentinel remains visible until the owner's next attempt finds the durable rows and repairs Redis.

This keeps the user-facing behavior realistic while making reconciliation work visible to operators.

## Generated-run teardown

Protected single-run maintenance removes the complete `inventory:<saleOfferId>:*` namespace together with `demo-run:<runId>:sale-eligibility`, `demo-run:<runId>:traffic-metrics`, `demo-run:<runId>:traffic-metrics-pinned`, and `demo-run:<runId>:traffic-metrics-reset-fence`. It validates the terminal generated identity, completes exact BullMQ cleanup with queue restoration, deletes these Redis keys, and only then transactionally revalidates and deletes the durable graph. Any queue, resume, Redis, or database failure remains visible while PostgreSQL still holds the run/offer retry coordinates. A successful commit has no external cleanup left, so no teardown receipt is persisted. The sole API maintenance authority serializes these workflows in process. Redis stores no generated-run maintenance pause marker or ownership claim; the queue adapter keeps only a process-local set of its own still-unrestored pauses and retries them on the next cleanup or close.
