# Checkout-Surge

Checkout-Surge is a realistic limited-inventory checkout simulation for surge traffic. The implemented Node.js track uses Redis atomic reservations, BullMQ workers, durable PostgreSQL records, and observable backpressure to show how a checkout system can absorb request bursts without overselling or overwhelming a slow downstream business system. The same pressure pattern appears in ticket launches, product drops, presales, and other scarcity-driven purchase flows. The mock ERP gives the downstream dependency a concrete back-office shape, but the boundary applies equally to payment, risk, warehouse, fulfillment, tax, accounting, supplier APIs, or other fragile business systems.

The current implementation covers the complete local simulation and the reliability/security hardening delivered through backlog task 20: the inventory hot path, durable asynchronous handoffs and recovery scanners, run-scoped worker admission/retry/circuit-breaker policy, realtime dashboard recovery with bounded public reads, durable k6 execution and completion delivery, simulated notifications, API-owned benchmark finalization, immutable Run History list/detail reads, public runtime policy management, protected admin controls, demo reset/cleanup tools, admin preset management, and the containerized local reference runtime. Hosted deployment readiness and the optional Go comparison track remain later roadmap work.

The buyers, mock ERP downstream dependency, and post-confirmation notifications are simulated because this is a systems demonstration, not a commerce business. The architecture proof is real: the project must measure whether the services protect inventory consistency, keep the API responsive, and make delayed downstream processing visible.

---

## How It Works

During a simulated limited-inventory surge:

1. A public or admin preset creates an isolated demonstration run with a generated sale offer and frozen configuration snapshot.
2. k6 generates direct API traffic from synthetic buyers using the run ID and generated sale offer ID.
3. Redis atomically reserves inventory for that run-scoped limited-stock offer.
4. The API returns a reservation response and pushes order processing to BullMQ; a worker-owned dispatch scanner repairs a committed order whose immediate enqueue was lost.
5. A worker confirms orders against the mock ERP / downstream business system with run-scoped distributed admission, retry, timeout, and circuit-breaker behavior. Durable ERP-result and recovery records protect accepted downstream results across retries and restarts.
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
- Frozen per-run retry, concurrency, and circuit-breaker behavior around downstream calls
- Real-time live spectator view with bounded SSE admission and rate-limited recovery reads
- k6-based load orchestration with a durable execution journal, retried completion delivery, and API-owned business-boundary finalization
- Public Run History summaries and sanitized detail views for terminal runs
- Simulated post-confirmation notification recording
- Signed public visitor identity and non-burning public run-budget reservations
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

Before starting the reference runtime, populate these blank entries in `.env` with private, distinct values: `CONTROL_SERVICE_TOKEN`, `ADMIN_DASHBOARD_PASSPHRASE`, `ADMIN_SESSION_SECRET`, `PUBLIC_CLIENT_COOKIE_SECRET`, and `ADMIN_EDGE_ATTESTATION_SECRET`. The Compose services run in production mode and intentionally reject missing, weak, or placeholder trust secrets.

Start the full containerized reference runtime:

```bash
pnpm runtime:up
```

Run migrations and seed the demo product, baseline sale offer, durable presets, PostgreSQL records, and Redis inventory inside the Compose network:

```bash
pnpm runtime:setup
```

Open the dashboard through the single-origin proxy:

```text
http://localhost:8080
```

Verify the runtime:

```bash
pnpm health:check
pnpm runtime:smoke
```

Run a small dashboard-triggered load smoke check:

```bash
pnpm runtime:smoke:load
```

For focused host-native development, use the infra-only and `dev:*` commands documented in [docs/local_development.md](docs/local_development.md). Host-native load runs require a local `k6` binary.

Stop the full runtime:

```bash
pnpm runtime:down
```

Run API/web/load flows from the dashboard or call the owning services directly while developing. The public start path also uses the private control-service channel plus the server-issued visitor credential; public mode is not trusted from a browser-supplied header or body.

Run the test suite with isolated PostgreSQL and Redis:

```bash
pnpm test:infra:up
pnpm test
pnpm test:infra:down
```

Admin reset and generated-run cleanup are implemented for local recovery/maintenance:

```bash
pnpm runtime:reset
pnpm maintenance:cleanup-runs
```

For local ports, environment variables, health endpoints, and command references, see [docs/local_development.md](docs/local_development.md).

## Testing

Run the automated suite:

```bash
pnpm test
```

Some API and integration tests use isolated PostgreSQL and Redis services. The full setup and narrower test commands are documented in [docs/local_development.md](docs/local_development.md#testing-workflow).

The deployed-topology characterization is intentionally opt-in because it is slow and requires Docker. Run `pnpm test:composition` or `pnpm test:characterization` only when that cross-service safety net is specifically needed.

## Documentation

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
