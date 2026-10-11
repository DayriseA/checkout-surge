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
