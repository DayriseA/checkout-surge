# Scope and Caveats

This page is the single authority for Checkout-Surge's accepted project boundary, intentional non-goals, current caveats, and deferred product decisions. Linked domain documents provide the technical rationale and operating instructions.

## Intentional Non-Goals

These five exclusions are not missing deliverables or roadmap commitments:

- **Production commerce identity and payment-grade security.** Public/admin controls protect the demonstrator without claiming customer identity, tenant authorization, or payment security. See [access-protection non-goals](admin_access_protection.md#non-goals).
- **Payment authorization, customer cancellation, payment-timeout release, and automatic hold-expiry reconciliation.** The demo retains expired holds for visibility rather than modeling a complete payment lifecycle. See the [inventory ownership boundary](redis_inventory_hot_path.md#inventory-ownership-boundary) and [stale-hold behavior](redis_inventory_hot_path.md#stale-holds-and-operator-visibility).
- **Separate per-order realtime feeds, recent-activity panels, public order rows, and customer order tracking.** The dashboard uses one complete revisioned projection for aggregate request surge, run-owned durable processing backlog, inventory drain, consistency lag, and run outcomes; shared system status carries physical queue and catalog ERP protection context. The durable `GET /orders/:publicOrderId/status` diagnostic and protected Run History remain; the dashboard is not a storefront. See the [dashboard recovery model](load_generation_metrics_streaming.md#dashboard-recovery-model) and [Order domain](core_business_entities.md#5-order).
- **Hosted deployment packaging, horizontal load coordination, and production operational hardening.** The accepted topology is the local reference runtime with one API process as sole maintenance authority, one Next.js process, one worker runtime, one file-journaled load-orchestrator process, and Caddy as the single ingress path rather than an application authority. See the [hosted deployment boundary](runtime_topology.md#hosted-deployment-boundary) and [load-generation boundary](load_generation_metrics_streaming.md#load-generation-and-metrics-streaming---decisions--rationale).
- **In-place upgrades for legacy pre-release local data shapes.** Current-shape state remains durable through documented failures and ordinary restarts, but legacy pre-release state is disposable rather than cross-version compatible. See [storage boundaries](core_business_entities.md#storage-boundaries) and the [intentional wipe-and-rebuild workflow](local_development.md#intentional-pre-release-wipe-and-rebuild).

## Current Caveats

These four limitations apply to the current reference runtime:

- **Local and 10k validation is environment-dependent and is not hosted benchmark evidence.** Local laptop, Dev Container, and Codespaces runs share host resources; the 10k characterization permits capacity-driven dropped iterations while still requiring complete accounting and business invariants. The repository has no hosted benchmark workflow or published hosted result. See [containerized load-run validation](runtime_topology.md#containerized-load-run-validation).
- **Host-native load-orchestrator runs require a separately available k6 executable.** `K6_BINARY` defaults to `k6` on `PATH`; the reference container instead includes pinned k6 2.0.0. See [host-native startup](local_development.md#host-native-startup) and the [reference local topology](runtime_topology.md#reference-local-topology).
- **A single API process has a finite cold-connection establishment ceiling.** The reference runtime makes the configured listen backlog real, but does not claim that one Node.js process can accept an unlimited simultaneous connection burst. See the [connection-establishment ceiling](#connection-establishment-ceiling) for the `surge-10k` boundary and its measured evidence.
- **Published circuit-breaker snapshots are authoritative only under the single-worker topology.** Run and catalog `ErpCircuitBreaker` instances are process-local, and each scope publishes its snapshot to one shared Redis key. With multiple worker processes the displayed state would be last-writer-wins across breakers that do not share state, presenting one worker's view as the system view. This is latent under the accepted one-worker-runtime topology above; multi-worker deployment would first require moving breaker state or aggregation to an authoritative shared boundary. See [downstream outage handling](architecture.md#5-downstream-outage-partial-or-total).

### Connection-establishment ceiling

The reference runtime binds the API container's `net.core.somaxconn` to the same `API_LISTEN_BACKLOG` value that the Node.js server requests. This prevents Docker's kernel-level accept backlog from silently capping the application configuration. It separately widens only the load-orchestrator's ephemeral port range and enables outbound TIME_WAIT reuse for repeated cold-connection surges. Platforms that reject container sysctls can remove both blocks with the supplied override:

```bash
docker compose -f docker-compose.yml -f docker-compose.no-sysctls.yml up -d
```

The override clears both blocks with the Compose `!reset` tag, verified on Docker Compose v2.40.3. A plain `sysctls: []` merges instead of clearing and would silently leave the sysctls in place, so the tag is required rather than cosmetic. If a Compose implementation does not support the tag correctly, deploy from a copy of `docker-compose.yml` with the `sysctls:` blocks removed.

That escape hatch intentionally restores both platform defaults. It therefore no longer guarantees that `API_LISTEN_BACKLOG` is fully honoured or that the load generator has the wider ephemeral range and outbound TIME_WAIT reuse. The API reads `/proc/sys/net/core/somaxconn` at startup and logs a warning when the kernel limit is below the configured backlog, so its divergence is reported rather than silent. The load-orchestrator persists its effective network values in each run's `networkDiagnostics`.

`surge-10k` opens 10,000 cold connections simultaneously: its `per-vu-iterations` executor runs one iteration per VU, so connection reuse is structurally impossible. Raising `somaxconn` from the Docker default of 4096 to the configured 8192 moves the connection-establishment cliff; it does not remove the finite capacity of one Node.js API process on the measured six-core host. Multi-second k6 `blocked` and `connecting` times at this boundary are TCP connection-establishment queueing rather than API processing time and are expected rather than anomalous. Scaling the system under test remains outside the demonstrator's scope.

On 2026-07-28, matched fully delivered `surge-10k` runs on the same reference Docker host produced these cumulative-counter deltas:

| API `somaxconn` | `API_LISTEN_BACKLOG` | `ListenOverflows` delta | `ListenDrops` delta |
| --- | --- | ---: | ---: |
| 4096 | 8192 | 40,384 | 40,384 |
| 8192 | 8192 | 0 | 0 |

The load-orchestrator namespace remained unchanged at `somaxconn=4096`. The near-zero result after alignment shows that the significant fact was the static silent cap, so it belongs in environment configuration and documentation rather than the per-run diagnostics record. Future evidence of sustained accept-queue overflow with an aligned backlog would be the reason to revisit that decision.

## Deferred Decisions

These five design choices are deliberately unfrozen. A deferred decision is neither a defect nor a promise that implementation is scheduled.

- **Physical dead-letter queue topology.** Current durable recovery and dead-letter evidence does not select a production queue topology.
- **Customer/account model.** Synthetic buyers and demo access modes do not define customer identity or tenancy semantics.
- **Payment and reservation-release design.** This capability remains intentionally excluded; its event model, worker ownership, and reconciliation rules remain undecided.
- **External notification-provider integration.** Simulated notification records do not select provider, retry, or delivery semantics.
- **Ownership of per-field form-validation messages.** The native browser constraint engine remains the per-field authority, so its `validationMessage` text follows the browser locale while app-owned surrounding copy (such as the custom-run error summary heading) stays English. A mixed-language summary is therefore expected rather than a defect. Replacing it with app-owned constraint messages is a deliberate open choice, not scheduled work.

See [domain decisions deferred to later tasks](core_business_entities.md#decisions-deferred-to-later-tasks).
