# Checkout-Surge

Checkout-Surge is a realistic limited-inventory checkout simulation for surge traffic. The implemented Node.js track uses Redis atomic reservations, BullMQ workers, durable PostgreSQL records, and observable backpressure to show how a checkout system can absorb request bursts without overselling or overwhelming a slow downstream business system. The same pressure pattern appears in ticket launches, product drops, presales, and other scarcity-driven purchase flows. The mock ERP gives the downstream dependency a concrete back-office shape, but the boundary applies equally to payment, risk, warehouse, fulfillment, tax, accounting, supplier APIs, or other fragile business systems.

The Node.js system and its containerized reference runtime are implemented and locally demoable. The implemented path includes the inventory hot path, durable asynchronous handoffs and recovery scanners, run-scoped worker admission/retry/circuit-breaker policy, realtime dashboard recovery with bounded public reads, durable k6 execution and completion delivery, simulated notifications, API-owned run finalization, immutable public aggregate and protected admin row-level Run History reads, public runtime policy management, protected admin controls, demo reset/cleanup tools, admin preset management, and the Compose runtime. This local status is not evidence of hosted or production readiness, a reproducible hosted benchmark, horizontal scaling, or operational hardening. Hosted deployment work and the optional Go comparison track remain future work.

The buyers, mock ERP downstream dependency, and post-confirmation notifications are simulated because this is a systems demonstration, not a commerce business. The local runtime and verification paths are designed to make inventory consistency, API responsiveness, downstream pressure, and delayed processing observable; benchmark claims require separate reproducible evidence from the environment in which they are measured.

The supported local topology is single-instance: one API process is also the sole maintenance authority, one Next.js process serves the web application, one load-orchestrator process owns one journal, and one worker runtime owns background processing. These remain separate containers. The single Caddy dashboard proxy/edge is only the ingress and routing boundary; it is not another web application process or application authority. Horizontally scaled application services are outside the accepted product and verification contract.

---

## How It Works

During a simulated limited-inventory surge:

1. A public or admin preset creates an isolated demonstration run with a generated sale offer and frozen configuration snapshot.
2. k6 generates direct API traffic from synthetic buyers using the run ID and generated sale offer ID.
3. Redis atomically reserves inventory for that run-scoped limited-stock offer.
4. The API returns a reservation response and pushes order processing to BullMQ; a worker-owned dispatch scanner repairs a committed order whose immediate enqueue was lost.
5. The worker runtime confirms orders against the mock ERP / downstream business system with process-local run-scoped admission, retry, timeout, and circuit-breaker behavior. BullMQ keeps excess work queued or delayed and supplies the worker process-wide concurrency ceiling. Durable ERP-result and recovery records protect accepted downstream results across retries and restarts.
6. A simulated notification record is written after successful confirmation.
7. The live spectator view shows request rate, queue depth, inventory drain, completion outcomes, and consistency lag in real time.

## Architecture

```text
Load Orchestrator (k6 wrapper)
      |
      v
API Gateway (Fastify)  <---- Web Dashboard (Next.js)
      |
      |--> Redis (atomic reservation for generated run offer)
      |         |
      |         `--> BullMQ Queue
      |                   |
      |                   v
      |             Background Worker
      |                   |
      |                   v
      |             Mock ERP / Downstream Service
      |
      v
PostgreSQL (durable business records)
```

For the deeper design rationale and failure modes, see [docs/architecture.md](docs/architecture.md).

## Tech Stack

| Layer                   | Technology                  |
| :---------------------- | :-------------------------- |
| Web UI                  | React / Next.js             |
| UI Styling / Components | Tailwind CSS / local React components |
| Backend API             | Node.js / Fastify           |
| Worker Runtime          | Node.js / BullMQ            |
| Primary Database        | PostgreSQL / Drizzle ORM    |
| Cache and Queue Backend | Redis                       |
| Load Testing            | k6                          |
| Real-time Updates       | SSE / Redis Pub/Sub         |
| Shared Contracts        | TypeScript / Zod            |
| Monorepo Tooling        | pnpm workspaces / Turborepo |

## Features

- Redis-backed atomic inventory reservation with idempotency protection
- Async order processing through BullMQ workers, with autonomous order-dispatch, ERP-result, pending-hold, and notification recovery
- Mock ERP / downstream latency, TPS, error-rate, and outage controls
- Frozen per-run retry, process-local concurrency, and circuit-breaker behavior around downstream calls
- Real-time live spectator view with bounded SSE admission and rate-limited recovery reads
- k6-based load orchestration with a durable execution journal, retried completion delivery, and API-owned business-boundary finalization
- Public Run History summaries and aggregate-only detail views for terminal runs, with bounded row detail reserved for admins
- Simulated post-confirmation notification recording
- Signed anonymous public budget principals and non-burning public run-budget reservations
- Public demonstration presets plus rate-limited, CSRF-protected admin preset, runtime policy, reset, recovery, and cleanup controls

## Prerequisites

- Node.js 22 or newer and pnpm 10 or newer (Corepack recommended for the pinned version)
- Docker with Docker Compose
- k6 CLI only for the alternate host-native load-orchestrator workflow

## Quick Start

Create a local environment file:

```bash
cp .env.example .env
```

Before starting the reference runtime, populate these blank entries in `.env` with private values: `CONTROL_SERVICE_TOKEN`, `ADMIN_DASHBOARD_PASSPHRASE`, `ADMIN_SESSION_SECRET`, and `PUBLIC_CLIENT_COOKIE_SECRET`. Use distinct values, especially for the two signing secrets. The production-mode Compose services reject missing/blank and known-placeholder required values; `PUBLIC_CLIENT_COOKIE_SECRET` must contain at least 16 UTF-8 bytes and must differ from `ADMIN_SESSION_SECRET`.

Build and start the full containerized reference runtime. This starts or recreates containers but does not run migrations or seed data, and it preserves existing named-volume state:

```bash
pnpm runtime:up
```

Run migrations and seed the demo product, baseline sale offer, durable presets, PostgreSQL records, and Redis inventory inside the Compose network. This mutates PostgreSQL and Redis; reruns preserve an existing active public runtime policy and its admin edits:

```bash
pnpm runtime:setup
```

Open the dashboard through the single-origin proxy:

```text
http://localhost:8080
```

Verify service readiness, dashboard reachability, Compose health, the in-container k6 binary, a same-origin recovery read, and delivery of an SSE frame. These checks do not mutate durable business or run state; the recovery read does consume short-lived admission capacity and may issue a visitor cookie:

```bash
pnpm health:check
pnpm runtime:smoke
```

Run a small dashboard-triggered load smoke check. It first calls the API reset workflow, which may terminalize an existing recoverable run and clear that run's live projection without resetting Mock ERP chaos. It then starts and completes a public smoke run, consuming a visitor/global start-budget reservation until its fixed window expires, and deletes the smoke run's durable graph, run-scoped Redis state, and attributed queue jobs through protected teardown:

```bash
pnpm runtime:smoke:load
```

For focused host-native development, use the infra-only and `dev:*` commands documented in [docs/local_development.md](docs/local_development.md). Host-native load runs require a local `k6` binary.

Run API/web/load flows from the dashboard or call the owning services directly while developing. The public start path also uses the private control-service channel plus the server-issued visitor credential; public mode is not trusted from a browser-supplied header or body.

While the API and Mock ERP are still running, optional local recovery and maintenance commands are available. `runtime:reset` terminalizes a recoverable current run as failed, writes its immutable summary, clears only its live traffic projection, and restores Mock ERP chaos defaults; it does not delete history or flush Redis. `maintenance:cleanup-runs` defaults to deleting eligible terminal generated runs created at least seven days ago, while preserving active runs, catalog-backed runs, and the latest 15 runs across the full run population, then attempts best-effort related Redis cleanup:

```bash
pnpm runtime:reset
pnpm maintenance:cleanup-runs
```

Stop the full runtime while preserving the PostgreSQL, Redis, and load-orchestrator named volumes:

```bash
pnpm runtime:down
```

Run the test suite with isolated PostgreSQL and Redis. The tests mutate only dedicated test databases and Redis logical databases; the final command stops the test services and deletes their named volumes:

```bash
pnpm test:infra:up
pnpm test
pnpm test:infra:down
```

Pre-release reference-runtime state is disposable, and in-place upgrades of legacy local data shapes are not promised. After an incompatible change, follow the single [intentional wipe-and-rebuild workflow](docs/local_development.md#intentional-pre-release-wipe-and-rebuild); it is destructive only to the selected Compose project's runtime resources and does not remove the host-native load-orchestrator journal. The authoritative compatibility boundary is recorded in [Scope and Caveats](docs/scope_and_caveats.md#intentional-non-goals).

For local ports, environment variables, health endpoints, and command references, see [docs/local_development.md](docs/local_development.md).

## Testing

Run the automated suite:

```bash
pnpm test
```

Some API and integration tests use isolated PostgreSQL and Redis services. The full setup and narrower test commands are documented in [docs/local_development.md](docs/local_development.md#testing-workflow).

The deployed-topology characterization is intentionally opt-in because it is slow and requires Docker. Run `pnpm test:composition` or `pnpm test:characterization` only when that cross-service safety net is specifically needed.

## Documentation

- [Scope and caveats](docs/scope_and_caveats.md) - intentional non-goals, live caveats, and deferred decisions with review metadata
- [Architecture](docs/architecture.md) - system design, flow boundaries, and failure-mode handling
- [Runtime topology](docs/runtime_topology.md) and [repository layout](docs/repository_layout.md) - process, container, and package ownership
- [Core business entities](docs/core_business_entities.md) and [cross-service conventions](docs/cross_service_conventions.md) - domain model and shared vocabulary
- [Redis inventory hot path](docs/redis_inventory_hot_path.md) - atomic reservation, idempotency, and pending-persistence recovery
- [Load generation and metrics streaming](docs/load_generation_metrics_streaming.md) - k6 execution, delivery, recovery, and finalization ownership
- [Admin access protection](docs/admin_access_protection.md) - public/admin trust boundaries and resource protection
- [Automated testing infrastructure](docs/automated_testing_infrastructure.md) - test taxonomy, isolated infrastructure, and composition coverage
- [Local development](docs/local_development.md) - setup details, ports, commands, health checks, testing, and configuration

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
