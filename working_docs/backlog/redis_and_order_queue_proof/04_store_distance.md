# 04 — Store Distance

**Design:** sections 3, 5 · **Depends on:** 02, after the owner's go

## Goal

PostgreSQL and Redis sit at the same realistic network distance from the API, as in production systems.

## Scope

- The option chosen at the checkpoint: separate Machines for the stores, or a simulated latency on the core.
- Lifecycle, recovery and idle stop keep working with the new topology.
- The narrative presents a simulated latency as a simulation.

## Done When

- The chosen distance is in place in the proof environment, and every run kind works.

## Open Points

- Separate Machines or simulated latency, and the round-trip time, both from task 02.

## Working Notes

### Proof topology source — 2026-10-11

- The owner authorized continuation after the feasibility checkpoint. This source slice chooses the measured native `cdg` distance: PostgreSQL and Redis share a separate authenticated private stores Machine, performance 2 CPUs / 4 GiB, with one 6 GiB volume. No simulated delay is added. Native RTT and hosted functional behavior still require measurement.
- `proof-topology.mjs` transforms the existing templates explicitly for the four-app proof environment. Production templates and default singleton behavior remain unchanged. The proof core remains performance 6 CPUs / 12 GiB; its one control authority and three dedicated buyer processes use loopback ports 4000 and 4001–4003. Private API ingress 4004 routes buys to buyers and control/callback/readiness paths to the authority. Runner target URLs use the current Machine's private IPv6, while web uses loopback ingress. The proof runner moves to the retained performance 16 CPU / 32 GiB allocation and enables native capture.
- The configured steady business PostgreSQL pool budget is 56: 30 buyer, 10 control, one control reset workflow, 10 worker and five ERP connections. This is not a total connection ceiling: readiness/setup and scoped pending-persistence recovery operations also open bounded/transient connections. It differs from the experimental prototype's 53 and must not be reported as the same pool budget or as a measured simultaneous connection count.
- Initial migration may intentionally destroy/recreate the disposable three-app proof environment and generate fresh proof credentials. Full proof destroy/recreate also handles incompatible/corrupt store state; no automatic store wipe or separate rebuild command is introduced. Stateless core recovery preserves store data and is pinned to `cdg`; production keeps its existing volume and European fallback behavior.
- The optional gate coordinator starts stores before ordinary/recovery core work under leases, including repair when core is already started. Setup has a finite authenticated PG/Redis preflight. Idle shutdown uses a dedicated token and current-core ID at the gate's public HTTPS endpoint so a sleeping gate can wake; it stops core, waits for actual stopped, then stops stores. A false/failed Fly wait never permits store stop. Socket loss does not cancel gate-owned work. The sleeping gate remains interruptible, so the optional guard completes orphan-store cleanup while preserving active, transitional, leased or uncertain topology. The rejected stores-first shortcut would weaken graceful drain and make self-stop retry depend on an already-stopped database.
- Proof operator changes retain organization/production-target checks. Optional proof runtime clients freshly verify app organization before each mutation; longer proof leases include these reads, store preparation and recovery. No extra application authority, always-on gate, job framework or speculative surplus-store recovery is added.
- Local source validation and independent review precede any hosted build/deploy. This source slice does not deploy, resize, start, stop or destroy Fly resources. Existing Task 02 retained resource inventory remains authoritative until the later hosted transition. Task 03/04 remain incomplete until hosted run-kind/lifecycle coverage and capacity recalibration are finished.
- Focused local checks passed: proof environment/topology 13/13, gate lifecycle/guard/recovery 87/87, shared Fly client 34/34, and API configuration/runner/idle 86/86. API and gate source types and the joined workspace test types passed. The latter exposed three missing `NODE_ENV` values in the separately owned capture-test fixtures; after the focused fixture correction, its six capture tests and joined types passed. Touched Task 04 source formatting/lint is clean. These checks are configuration/unit evidence, not hosted measurement or lifecycle proof. The proof-only Caddy process raises its file-descriptor limit because it now carries runner traffic; its actual load overhead remains part of later recalibration.
- Independent review found a shared-store authority overlap in the first stateless recovery implementation: unlike HD-34's isolated fresh volumes, booting the replacement before retiring the old core can run two controllers/workers/ERPs against the same stores. The proof branch now requires a usable old-core lease, confirmed shutdown and a fresh healthy-host/stopped observation before creating its replacement; it keeps that lease through readiness. Missing role metadata does not prove absence: any Machine still listed when no recognized old core is selected blocks replacement. Unreachable/uncertain old authorities fail closed, accepting longer outages until shutdown can be established. The stores lease is refreshed after startup to cover the additional old-core shutdown work. Production's fresh-volume create-first recovery remains unchanged. A code comment and the proof runtime documentation explain this variant-specific ordering, so no new decision-log entry is needed to prevent an accidental reversal.
- Operator preflight identified that the first capture directory was a sibling of the image's node-owned state directory. The proof runner now writes capture under `/var/lib/checkout-surge/load-orchestrator/proof-capture`, inside the directory already provisioned for its dropped UID. No production image ownership or directory scope is expanded.
- Focused review-repair validation passed: recovery/wake/stores lifecycle 43/43 tests, proof topology/preflight 2/2 tests, gate source types and scoped gate test types, and touched-source Biome. Existing production fresh-volume recovery tests were retained in that focused suite. No hosted operation, image build or deployment was performed.
