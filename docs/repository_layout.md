# Repository Layout — Decisions & Rationale

This is the current repository structure and ownership map.

---

## Decisions Summary

| Decision | Choice | Rationale |
| :-- | :-- | :-- |
| Repo strategy | Monorepo | Shared contracts, single boot, atomic cross-service commits. Polyrepo overhead unjustified for this project. |
| Monorepo tooling | Turborepo + pnpm workspaces | Task pipeline awareness (e.g. `contracts` builds before `api`) and incremental caching with minimal setup cost. |
| Frontend shape | One Next.js dashboard app with public, watch, admin, and history routes | Portfolio value is in the backend and realistic simulation behavior; frontend work should support operating and explaining the system, not become a commerce storefront. |
| Worker placement | Separate `apps/worker` | Must be independently scalable and must not share the API event loop — required by the delivery constraint that the API stays responsive under queue pressure. |
| Mock ERP placement | Separate `apps/mock-erp` | Must be a real HTTP service across a real network boundary for circuit breakers and backpressure patterns to be meaningful. |
| Load orchestrator placement | Separate `apps/load-orchestrator` | Realistic load simulation is a first-class deliverable. Dashboard integration requires a wrapper service to trigger runs and stream metrics. |
| Shared packages | `contracts`, `logger`, `db` | All three are blockers for parallel service work. See rationale per package below. |
| Docs home | `docs/` alongside `working_docs/` | Current architecture docs, ADRs, and benchmark results need a stable home separate from in-progress planning notes. |

---

## Current Repository Layout

```
checkout-surge/
├── apps/
│   ├── web/                  # Next.js — public demo, live watch, admin console, run history
│   ├── api/                  # Fastify API gateway (Node.js)
│   ├── worker/               # BullMQ background worker (Node.js)
│   ├── mock-erp/             # Mock ERP service — configurable latency, TPS cap, error rate
│   └── load-orchestrator/    # k6 wrapper — triggers runs, streams metrics to dashboard
├── packages/
│   ├── contracts/            # Shared TypeScript types and Zod schemas
│   ├── logger/               # Pino wrapper with correlation-ID convention
│   └── db/                   # Drizzle schema/migrations, PostgreSQL client, Redis adapters
├── infra/                    # Caddy single-origin proxy configuration
├── scripts/                  # Environment, runtime, maintenance, smoke, and composition tooling
├── docs/                     # Architecture, reference, and decision docs; ADRs; benchmark results; portfolio write-ups (this folder)
├── working_docs/             # Project vision, delivery constraints, planning, and agent working docs
├── docker-compose.yml        # Full local reference runtime
├── docker-compose.dev.yml    # Loopback-only debug/infra port overrides
├── docker-compose.test.yml   # Isolated PostgreSQL and Redis test infrastructure
├── Dockerfile                # Multi-target application/runtime images
├── AGENTS.md
├── README.md
└── package.json              # pnpm workspace root + turbo.json
```

---

## Ownership Boundaries

### `apps/web`

- Owns the public demo picker (`/`), current-run spectator (`/watch`), admin console (`/admin`), run history (`/run-history`), and a static "how it works" explainer (`/about`).
- Exposes public-safe starts and live observation separately from admin preset editing, ERP diagnostics, recovery, and cleanup controls.
- Must not be treated as the source of high-volume traffic; load generation belongs to `apps/load-orchestrator` and k6.
- Should keep the frontend dependency strategy intentionally small: Tailwind CSS for utility styling, local React components for the current dashboard controls, and additional component, toast, or icon libraries only when a scoped need justifies the dependency.
- Consumes `packages/contracts` for API request/response types.
- Communicates with `apps/api` over same-origin HTTP routes and the live SSE stream at `/dashboard/events`.
- Proxies `apps/mock-erp` admin-only chaos endpoints server-side so the API gateway does not couple itself to ERP control behavior.
- Keeps watch event reconciliation in a pure state module, EventSource and recovery coordination in focused hooks, and the watch component as panel composition.
- Uses a server-side admin session gate and protected read helpers, then composes independent current-run, policy, preset/start, maintenance, and ERP client controllers.

### `apps/api`

- Owns the buy flow: validates requests, runs the Redis atomic reservation, enqueues BullMQ jobs.
- Owns the browser-facing SSE transport for live event delivery to `apps/web`.
- Subscribes once per API process to Redis Pub/Sub dashboard events and fans browser-safe updates out to connected dashboard clients.
- Composes narrow lifecycle ports such as `TerminalDemoRunWriter` in `apps/api/src/index.ts`; start, finalization, startup-reconciliation, and reset services receive only the terminal capabilities they use.
- Must never call `apps/mock-erp` directly — all ERP interaction goes through the queue.
- Consumes `packages/contracts`, `packages/logger`, `packages/db`.

### `apps/worker`

- Owns order state transitions: queued → processing → confirmed / failed.
- Is the only service that calls `apps/mock-erp`.
- Resolves frozen run retry policy, applies Redis-backed per-run admission, and selects run-scoped circuit breakers around ERP calls.
- Runs autonomous scanners for committed-but-undispatched queued orders, durable ERP-result recovery, and missing simulated-notification jobs.
- Persists poison order-job audit records and recovery/escalation state through `packages/db` adapters.
- Publishes transport-neutral dashboard realtime events through Redis Pub/Sub without importing or hosting the browser-facing SSE runtime.
- Consumes `packages/contracts`, `packages/logger`, `packages/db`.

### `apps/mock-erp`

- Owns the simulated legacy ERP HTTP surface.
- Applies run-scoped ERP behavior supplied by accepted jobs; `LATENCY_MS`, `MAX_TPS`, `ERROR_RATE`, and `FORCED_OUTAGE` remain environment-backed catalog/fallback diagnostics.
- Owns runtime admin chaos controls for latency, TPS cap, error rate, and forced outage.
- Uses `packages/db` for the durable first-write-wins ERP confirmation-result ledger.
- Has no knowledge of the queue or any other internal service.

### `apps/load-orchestrator`

- Owns k6 script execution, scenario parameterization, traffic execution state, and the output-parsing pipeline.
- Persists one atomic execution journal outside PostgreSQL, including accepted/executing/completed state, and retains slot ownership until completion acknowledgement.
- Uses the traffic-execution lifecycle `starting -> active -> succeeded | failed`.
- Receives only an API-accepted run ID, generated sale offer, and frozen configuration; the API establishes the durable dashboard recovery baseline before delegation.
- Forwards fixed-window traffic metrics (observed RPS, mean latency, and failure-observation fraction) and traffic-completion reports to `apps/api`; terminal completion continues to report p95 latency separately.
- Does not own API/business draining, demo-run finalization, dashboard recovery state, or run-summary persistence.
- Exposes a traffic-execution control API consumed by `apps/api`; the dashboard starts demo runs through the API lifecycle rather than driving load scenarios directly.

### `packages/contracts`

- Single source of truth for buy requests/responses, demo-run and traffic snapshots, queue jobs and retry policy, dashboard events/read models, ERP contracts, public visitor credentials, metrics, lifecycle vocabulary, and error shapes.
- Must be built before any service that depends on it (enforced by Turborepo pipeline).

### `packages/logger`

- Thin Pino wrapper that stamps every log line with the service name and propagates `correlationId`.
- Used by `apps/api`, `apps/worker`, `apps/mock-erp`, and `apps/load-orchestrator`.

### `packages/db`

- Drizzle ORM schema definitions and migration tooling.
- Owns PostgreSQL connection construction, Redis inventory/dashboard/resilience helpers, seed/reset helpers, and the public testing entry point.
- Shared by `apps/api`, `apps/worker`, and `apps/mock-erp` so schema migrations and durable ERP-result semantics are one source of truth.
- `apps/load-orchestrator` deliberately does not use this package; its traffic execution journal is file-backed.

---

## What Goes in `docs/` vs `working_docs/`

`working_docs/` holds the process- and governance-oriented documents that drive the work:

| `working_docs/` |
| :-- |
| Project vision / blueprint (`project_description.md`) |
| Delivery constraints and system guarantees (`delivery_constraints.md`) |
| Project planning and task tracking (`project_planning.md`) |
| Agent quality checklists (`quality_checklists.md`) |

`docs/` holds current architecture and reference documentation for the implemented system:

| `docs/` |
| :-- |
| Architecture overview and failure modes (`architecture.md`) |
| Local development guide (`local_development.md`) |
| Domain model, conventions, runtime topology, and per-area decision records (like this file) |
| ADRs, benchmark results, and portfolio-facing write-ups |
