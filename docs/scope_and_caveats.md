# Scope and Caveats

This page is the auditable index for Checkout-Surge scope classifications. It owns each item's classification, live-caveat status, owner/source, and review metadata. The linked domain documents remain authoritative for technical rationale and operating instructions.

When behavior changes, the area that owns that behavior must update its row here in the same change. Documentation maintainers own the taxonomy and periodic stale-entry review, not the accuracy of every subsystem claim.

## Intentional Non-Goals

These are stable exclusions from the current local systems-demo boundary. They are not missing deliverables or roadmap commitments.

| Excluded capability | Rationale | Owner/source | Reconsider only when |
| :-- | :-- | :-- | :-- |
| Production commerce identity and payment-grade security | The public/admin controls protect a demonstrator from abuse without pretending to be a customer identity platform or a payment-security boundary. | Access protection — [Non-Goals](admin_access_protection.md#non-goals) | Checkout-Surge is given a hosted commerce scope that requires customer identity, tenant authorization, or payment-grade controls. |
| Payment authorization, customer cancellation, payment-timeout release, and automatic hold-expiry reconciliation | The demo focuses on the inventory reservation and asynchronous downstream-pressure path; it retains expired holds for visibility instead of modeling a complete payment lifecycle. | Inventory — [Inventory Ownership Boundary](redis_inventory_hot_path.md#inventory-ownership-boundary) and [Stale Holds and Operator Visibility](redis_inventory_hot_path.md#stale-holds-and-operator-visibility) | A payment or reservation-reconciliation workflow becomes part of the implemented product boundary. |
| Hosted deployment packaging, horizontal load coordination, and production operational hardening | The delivered topology is a local reference runtime with one API-owned current run and one file-journaled load execution, not a production hosting design. | Runtime — [Hosted Deployment Boundary](runtime_topology.md#hosted-deployment-boundary) and [Load Generation and Metrics Streaming](load_generation_metrics_streaming.md#load-generation-and-metrics-streaming---decisions--rationale) | A concrete hosted deployment target, scaling model, and operating responsibility are accepted. |
| In-place upgrades for legacy pre-release local data shapes | PostgreSQL records and the load journal remain durable through failures and ordinary restarts within the current supported runtime/data shape; that durability is not a cross-version compatibility promise. The reference Compose file declares project-scoped PostgreSQL, Redis, and load-journal named volumes, none external. After an incompatible pre-release change, intentionally [wipe and rebuild the selected local runtime](local_development.md#intentional-pre-release-wipe-and-rebuild) instead of translating legacy state. | Local runtime — `docker-compose.yml`, `package.json`, and [Core Business Entities](core_business_entities.md#storage-boundaries) | A retained external volume, hosted data-retention contract, or release-stability requirement is explicitly accepted. |

## Live Caveats

The only statuses used in this table are:

- `active`: verified current behavior or evidence gap.
- `partially mitigated`: still externally relevant, with a linked mitigation that narrows its impact.
- `resolved`: retained only long enough to link the resolving change, then removed at the next documentation review.

Roadmap phases and age-sensitive phrases are not statuses. Every row must carry concrete evidence and a review or expiry trigger.

| Caveat | Status | Owner/source | Evidence or verification | Review/expiry trigger | Last reviewed |
| :-- | :-- | :-- | :-- | :-- | :-- |
| Local and 10k validation is environment-dependent and is not hosted benchmark evidence. | `active` | Runtime validation — [Containerized Load-Run Validation](runtime_topology.md#containerized-load-run-validation) | Local laptop, Dev Container, and Codespaces runs share host resources. The 10k characterization permits capacity-driven dropped iterations while still requiring complete accounting and business invariants; the repository contains no hosted benchmark workflow or published hosted result. | Publish a reproducible benchmark from a defined hosted topology. | 2026-07-16 |
| Host-native load-orchestrator runs require a separately available k6 executable. | `partially mitigated` | Load runtime — [Host-Native Startup](local_development.md#host-native-startup) | `apps/load-orchestrator/src/runtime/config.ts` defaults `K6_BINARY` to `k6` on `PATH`. The [reference local topology](runtime_topology.md#reference-local-topology) mitigates this by copying pinned k6 2.0.0 to `/usr/local/bin/k6` in its load-orchestrator image. | The host-native workflow bundles or manages its k6 executable, or the host-native load workflow is removed. | 2026-07-16 |

## Deferred Decisions

These design choices are deliberately unfrozen. A deferred decision is neither a defect nor a promise that implementation is scheduled.

| Deferred decision | Why it remains unfrozen | Owner/source | Decision trigger |
| :-- | :-- | :-- | :-- |
| Physical dead-letter queue topology | Current durable recovery and dead-letter evidence does not require committing to a production queue topology. | Domain model — [Decisions Deferred to Later Tasks](core_business_entities.md#decisions-deferred-to-later-tasks) | A production queue recovery and operations model is accepted. |
| Customer/account model | Synthetic buyers and demo access modes do not establish customer identity or tenancy semantics. | Domain model — [Decisions Deferred to Later Tasks](core_business_entities.md#decisions-deferred-to-later-tasks) | Customer identity or tenancy enters the product boundary. |
| Payment and reservation-release design | The capability is intentionally excluded today; its eventual event model, worker ownership, and reconciliation rules remain undecided. | Domain model — [Decisions Deferred to Later Tasks](core_business_entities.md#decisions-deferred-to-later-tasks) | The corresponding intentional non-goal is explicitly reversed. |
| External notification-provider integration | The demo records simulated notifications without choosing provider, retry, or delivery semantics. | Domain model — [Decisions Deferred to Later Tasks](core_business_entities.md#decisions-deferred-to-later-tasks) | External delivery becomes a required product capability. |
