# 05 — Mode Without Redis

**Design:** sections 4, 5 · **Depends on:** 02, after the owner's go

## Goal

A run can use PostgreSQL alone for the stock decision, the sold-out answers and the order queue, with the same protections and answers as the demo's mode.

## Scope

- PostgreSQL decides the stock and holds the order queue.
- The same idempotency, run fence, bookkeeping, live counters and teardown as the demo's mode.
- The mode is a property of the run, set only by a comparative preset.
- None of the 2026-10-08 prototype's defects (design section 2.3).

## Done When

- A run in this mode completes with the same correctness guarantees as the demo's mode, covered by tests.

## Open Points

- None.

## Working Notes

### Durable mode and buyer activation prerequisite - 2026-10-11

- Run records now carry a separate immutable execution mode, currently only `demo`. No comparative preset is registered and no start/override/save/copy input accepts a mode. The full PostgreSQL purchasing path remains later work.
- Each buyer and combined API holds one authoritative generated-run context. Startup hydrates it before listening; acceptance requires all peers to install it before publishing accepting stock. Requests never query PostgreSQL to resolve mode, including unknown or stale IDs; existing Redis inventory rejection vocabulary remains authoritative.
- The existing authenticated timing baseline round trip carries required activation separately from advisory timing evidence. Failed activation uses the existing initialization-failure terminal transition and public-budget release. Startup replay reactivates peers without resetting timing baseline evidence or reopening inventory.
- The consolidated baseline SQL/schema/snapshot changes require fresh proof stores after exporting existing evidence; no production deployment is authorized by this prerequisite.
- Validation in the Linux dev container passed: API and web source types; aggregate test types; 48 database unit tests including enum parity and migration metadata/no accidental migration; 377 API unit tests; and 169 focused API/integration tests covering lifecycle, startup, presets, buying and actual multiple buyer processes. Checks ran sequentially with at most two unit workers and one API worker. The dedicated PostgreSQL/Redis containers used no published ports; their network, containers and volumes were removed after validation. The only builds were the touched contracts/database declarations. These checks establish the prerequisite, not the later PostgreSQL backend or hosted comparative behavior.

### Unwired PostgreSQL stock and acceptance adapter - 2026-10-11

- Added explicit migrated PostgreSQL inventory, full retained holds with pending recovery metadata, and independently expiring idempotency records. Ownership uses generated run/sale constraints. Secured observations survive compensation as reversed holds; expired holds remain reserved, with no payment/expiry release behavior.
- Obvious sold-out requests use one read-only SELECT, with no stock-row or counter-row writes. Positive and pending paths take the existing shared terminal fence and a per-key transaction lock, then read in a separate READ COMMITTED command so a waiter sees the preceding winner's commit. Conditional stock mutation and hold/idempotency insertion commit together. Promotion and compensation check complete identity and preserve durable success.
- The request/attempt-scoped publication adapter explicitly shares the reserved admission session for both ordinary acceptance and pending-persistence recovery. It creates no client and does not hold an extra pooled connection. No PostgreSQL queue, worker or application activation is introduced.
- Exact rejection counters remain an activation prerequisite, not a weakened guarantee: current Redis increments are atomic, dirty-signal coalescing does not record counts, and PostgreSQL's existing count row is populated from terminal inventory. Later integration must supply truthful live/final count durability and fencing; a separate atomic count-row increment remains available if lossless bounded batching cannot match the guarantee. This slice returns stock decisions without exposing fake zero counters or a purported complete inventory projection.
- Validation: focused database declaration/API source/new-test types; 7 real PostgreSQL adapter tests including two observed same-key lock waits, stock contention, one-SELECT sold-out, full pending state, promotion, compensation and expired idempotency; and one real pool-of-one acceptance/replay/pending-publication test. PostgreSQL ran on a dedicated network with no published host ports and was removed immediately after the tests. No Redis client/server was involved in these tests. Migration metadata checks passed 3/3 and the existing persistence seam's unit checks passed 8/8. Runtime activation, bounded recovery scheduling, exact counters, delivery and full lifecycle/teardown remain later work.
- Independent review found that a terminal admission race could discover durable acceptance outside the reserved publication session. The fallback now performs its lookup, identity check and re-enqueue inside the existing pending-persistence lock/session. The real pool-of-one regression completes the run between stock replay and admission and verifies preserved acceptance on the same backend connection. The affected reservation/persistence unit checks passed 36/36, the revised integration test passed, focused types and touched-file Biome passed, and disposable infrastructure was removed. Independent confirmation and the supervisor's final pass were clear.
