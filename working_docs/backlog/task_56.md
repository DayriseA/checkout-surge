# Task 56: Fix accepted-idempotency TTL lifecycle: promotion must tolerate expiry and refresh the replay window

## Execution context

- **Execution order:** This is task 56 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P3
- **Area:** Redis / idempotency
- **Source:** comparison (worse)
- **Solved elsewhere:** `checkout-forge/packages/db/src/redis-inventory.ts` implements the relevant lifecycle in `storeReservationResponseScript` and `storeRedisReservationResponse()`. The Lua script does not read or require the provisional idempotency record: it unconditionally writes the supplied final `RedisReservationStoredResponse` with `SET idempotency_key stored_response_json EX idempotency_ttl_seconds`. Consequently, finalization recreates a key that expired between stock reservation and durable persistence, and every finalization starts a new full replay window. In the same atomic Lua invocation it best-effort updates the reservation hash (`reservationUpdate = "updated" | "missing" | "not_requested"`) and maintains the pending-persistence sorted set; a missing hold does not prevent the final response from being cached. `checkout-forge/apps/api/src/services/reserve-order-service.ts` passes `this.config.idempotencyTtlSeconds` to `storeRedisReservationResponse()` after durable persistence and queue publication, while `checkout-forge/apps/api/src/config.ts` owns `IDEMPOTENCY_TTL_SECONDS`. The focused reference coverage is `checkout-forge/packages/db/test/redis-inventory.integration.test.ts`, especially `stores idempotency responses when the reservation hold is missing`, which proves final response storage/replay is independent of the hold's presence.
- **Locations:** `packages/db/src/redis-stock-reservation.ts:52`, `packages/db/src/redis-stock-reservation.ts:394`, `apps/api/src/runtime/config.ts:38`

Accepted promotion requires the idempotency key to still exist and uses `KEEPTTL`, so a late promotion can fail after key expiry and successful promotion does not extend replay availability. The hold-window validation improvement (expiry must postdate securing) is worth keeping.

## Required change

Adapt the reference's expiry and TTL semantics without weakening Surge's identity checks:

- Extend `StockReservationGateway.promoteAccepted` in `apps/api/src/services/reserve-order-service.ts` and `promoteReservationIdempotencyToAccepted()` in `packages/db/src/redis-stock-reservation.ts` to receive the configured positive `idempotencyTtlSeconds`. Wire the existing `config.idempotencyTtlSeconds` through the composition root in `apps/api/src/index.ts`; configuration remains owned by `apps/api/src/runtime/config.ts` and no new environment setting is needed.
- Pass that TTL into `promoteAcceptedScript`. On a matching `pending_persistence` record, change the status to `accepted`, write it with `SET ... EX <idempotencyTtlSeconds>` (not `KEEPTTL`), remove the reservation from `pendingPersistence`, and return `promoted`. The TTL after promotion is a fresh replay window measured from promotion, not the remainder of the securing-time window.
- If the idempotency key is missing (including normal expiry), reconstruct the accepted record from the fully validated promotion arguments as `{ status = "accepted", quantity = <quantity>, reservation = <original hold> }`, store it with the full `EX` TTL, remove the same reservation ID from `pendingPersistence`, and return `promoted`. Durable PostgreSQL state is the authority that permits this path: the API invokes promotion only after it has a persisted buy and has successfully re-asserted the deterministic BullMQ job.
- Preserve the existing transition vocabulary and idempotence. A present, identity-matching `accepted` record returns `already_accepted`, but must also refresh the full `EX` replay TTL and remove the pending member. A present `pending_persistence` record may transition to `accepted`. Any other present status remains `invalid_status`; any present record whose quantity or complete reservation identity differs remains `mismatch`, with no write, TTL change, or sorted-set removal.
- Preserve `assertValidHoldWindow()`: `expiresAt` must be strictly later than `securedAt`. Apply it to promotion as well as reservation if promotion will be able to synthesize a record from its arguments.

The reservation identity comparison is deliberately exact and must continue to cover quantity plus `id`, `saleOfferId`, `reservationToken`, `correlationId`, optional `runId` (normalized to an empty string), `securedAt`, and `expiresAt`. Do not make key expiry an opportunity to accept caller-generated replacement identity: the service must promote the original Redis decision/durable reservation hold, not a newly constructed request hold. A concurrent retry after expiry can otherwise reserve stock under the same idempotency key before late promotion runs; if promotion sees that new present record, the exact comparison must reject it as `mismatch` rather than overwrite it. Redis Lua atomicity makes the read/compare/write/ZREM indivisible on a single server, but it does not make Redis promotion atomic with PostgreSQL persistence or BullMQ publication; retain the current ordering and best-effort `promoteWithoutHidingDurableSuccess()` behavior.

`promoteAcceptedScript` touches the sale-offer idempotency key and pending-persistence sorted set in one `EVAL`. Keep using `inventoryKeys(reservation.saleOfferId)` and do not introduce cross-offer keys. The current key format (`inventory:<saleOfferId>:...`) has no Redis Cluster hash tag, so multi-key `EVAL` assumes the repository's current single-node Redis deployment; Redis Cluster key-slot migration is out of scope. Do not copy Forge's stored-response shape or its permissive overwrite behavior: Surge owns a `pending_persistence -> accepted` record state machine and replays the reservation before consulting durable PostgreSQL.

## Focused verification

Update `packages/db/test/integration/db.integration.test.ts` at the Redis adapter boundary to prove:

1. normal pending-to-accepted promotion refreshes TTL to approximately the configured full value rather than preserving the old remaining TTL;
2. promotion after deleting/expiring the idempotency key recreates an accepted record with the original complete hold, removes its pending-persistence member, assigns the configured TTL, and produces `idempotent_replay` without changing stock, reservation count, or inventory event count;
3. repeated promotion of an already-accepted matching record returns `already_accepted` and refreshes its replay TTL;
4. a present conflicting replacement record is rejected and neither overwritten nor removed from pending bookkeeping;
5. invalid/nonpositive TTL input and invalid hold windows fail before Redis execution.

Update `apps/api/test/reserve-order-service.test.ts` (and composition/API tests only where signatures require it) to assert that both new-persistence and durable-replay paths pass `idempotencyTtlSeconds` with the original hold, and retain the ordering `persist/read durable -> enqueue deterministic job -> promote`. Run the focused package DB integration test and API service test, then the affected package typecheck/lint checks.

## Scope and non-goals

This task changes only accepted-idempotency promotion and its dependency wiring/tests. Do not change initial reservation TTL semantics, eligibility-before-replay behavior, pending-persistence reconciliation policy, PostgreSQL schemas, queue retry/job identity, response contracts/status vocabulary, inventory hold expiry, or the rule that promotion failure is reported but cannot hide an already durable success. Do not add distributed locks, transactions spanning Redis/PostgreSQL/BullMQ, Redis Cluster support, or a general idempotency-record redesign.

## Implementation record

- **Status:** Complete.
- **Completed scope:** Accepted promotion now validates a positive configured TTL and the original hold window before Redis execution. Its atomic Lua transition refreshes matching pending or already-accepted records with a full `EX` replay window, reconstructs a missing record from the validated original hold, and clears all pending-persistence bookkeeping only on successful matching promotion. Present identity conflicts and invalid statuses remain non-mutating failures.
- **Dependency wiring:** `StockReservationGateway.promoteAccepted` carries `idempotencyTtlSeconds`; both `ReserveOrderService` paths and `PendingPersistenceReconciler` pass their configured value, with the composition root supplying `config.idempotencyTtlSeconds` to reconciliation.
- **Tests:** Redis integration coverage proves TTL refresh, missing-record reconstruction and replay without inventory mutation, repair of matching persistent pending/accepted records, repeated accepted refresh, conflict preservation without TTL or pending-bookkeeping mutation, and pre-execution TTL/hold validation with an explicit `redis.eval` assertion. API service and reconciler coverage verifies the configured TTL, original hold, and durable persistence/read -> deterministic enqueue -> promotion order.
- **Documentation:** `docs/redis_inventory_hot_path.md` distinguishes the provisional securing-time TTL from the fresh accepted replay window and documents expiry-tolerant promotion plus exact conflict rejection.
- **Verification:** `pnpm --filter @checkout-surge/db test:integration -- test/integration/db.integration.test.ts` passed (3 files, 78 tests); `pnpm --filter api exec vitest run --config vitest.api.config.ts test/reserve-order-service.test.ts test/pending-persistence-reconciler.test.ts` passed (2 files, 39 tests); `pnpm --filter api test:api -- test/api.test.ts test/demo-maintenance-service.test.ts` passed (32 files, 396 tests); DB and API `type-check` and `lint` commands passed; `git diff --check` passed. A direct supplemental Vitest invocation without the repository test-environment wrapper failed because `TEST_DATABASE_URL` was absent, then passed through the supported `test:api` wrapper above. Prohibited composition and characterization suites were not run.
- **Deviation/follow-up:** None.
