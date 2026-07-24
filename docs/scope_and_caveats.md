# Scope and Caveats

This page is the single authority for Checkout-Surge's accepted project boundary, intentional non-goals, current caveats, and deferred product decisions. Linked domain documents provide the technical rationale and operating instructions.

## Intentional Non-Goals

These five exclusions are not missing deliverables or roadmap commitments:

- **Production commerce identity and payment-grade security.** Public/admin controls protect the demonstrator without claiming customer identity, tenant authorization, or payment security. See [access-protection non-goals](admin_access_protection.md#non-goals).
- **Payment authorization, customer cancellation, payment-timeout release, and automatic hold-expiry reconciliation.** The demo retains expired holds for visibility rather than modeling a complete payment lifecycle. See the [inventory ownership boundary](redis_inventory_hot_path.md#inventory-ownership-boundary) and [stale-hold behavior](redis_inventory_hot_path.md#stale-holds-and-operator-visibility).
- **Separate per-order realtime feeds, recent-activity panels, and customer order tracking.** The dashboard uses one complete revisioned projection for aggregate request surge, queue depth, inventory drain, consistency lag, completion outcomes, and run outcomes. The durable `GET /orders/:publicOrderId/status` diagnostic and protected Run History remain; the dashboard is not a storefront. See the [dashboard recovery model](load_generation_metrics_streaming.md#dashboard-recovery-model) and [Order domain](core_business_entities.md#5-order).
- **Hosted deployment packaging, horizontal load coordination, and production operational hardening.** The accepted topology is the local reference runtime with one API process as sole maintenance authority, one Next.js process, one worker runtime, one file-journaled load-orchestrator process, and Caddy as the single ingress path rather than an application authority. See the [hosted deployment boundary](runtime_topology.md#hosted-deployment-boundary) and [load-generation boundary](load_generation_metrics_streaming.md#load-generation-and-metrics-streaming---decisions--rationale).
- **In-place upgrades for legacy pre-release local data shapes.** Current-shape state remains durable through documented failures and ordinary restarts, but legacy pre-release state is disposable rather than cross-version compatible. See [storage boundaries](core_business_entities.md#storage-boundaries) and the [intentional wipe-and-rebuild workflow](local_development.md#intentional-pre-release-wipe-and-rebuild).

## Current Caveats

These two limitations apply to the current reference runtime:

- **Local and 10k validation is environment-dependent and is not hosted benchmark evidence.** Local laptop, Dev Container, and Codespaces runs share host resources; the 10k characterization permits capacity-driven dropped iterations while still requiring complete accounting and business invariants. The repository has no hosted benchmark workflow or published hosted result. See [containerized load-run validation](runtime_topology.md#containerized-load-run-validation).
- **Host-native load-orchestrator runs require a separately available k6 executable.** `K6_BINARY` defaults to `k6` on `PATH`; the reference container instead includes pinned k6 2.0.0. See [host-native startup](local_development.md#host-native-startup) and the [reference local topology](runtime_topology.md#reference-local-topology).

## Deferred Decisions

These four design choices are deliberately unfrozen. A deferred decision is neither a defect nor a promise that implementation is scheduled.

- **Physical dead-letter queue topology.** Current durable recovery and dead-letter evidence does not select a production queue topology.
- **Customer/account model.** Synthetic buyers and demo access modes do not define customer identity or tenancy semantics.
- **Payment and reservation-release design.** This capability remains intentionally excluded; its event model, worker ownership, and reconciliation rules remain undecided.
- **External notification-provider integration.** Simulated notification records do not select provider, retry, or delivery semantics.

See [domain decisions deferred to later tasks](core_business_entities.md#decisions-deferred-to-later-tasks).
