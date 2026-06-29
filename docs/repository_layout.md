# Repository Layout — Decisions & Rationale

This is the target repository structure.

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
| Docs home | `docs/` alongside `working_docs/` | Target architecture docs, ADRs, and benchmark results need a stable home separate from in-progress planning notes. |

---

## Target Repository Layout

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
│   └── db/                   # Drizzle ORM schema + generated client
├── docs/                     # Architecture, reference, and decision docs; ADRs; benchmark results; portfolio write-ups (this folder)
├── working_docs/             # Project vision, delivery constraints, planning, and agent working docs
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
- May call `apps/mock-erp` admin-only chaos endpoints directly in local simulation mode so the API gateway does not couple itself to ERP control behavior.

### `apps/api`

- Owns the buy flow: validates requests, runs the Redis atomic reservation, enqueues BullMQ jobs.
- Owns the browser-facing SSE transport for live event delivery to `apps/web`.
- Subscribes once per API process to Redis Pub/Sub dashboard events and fans browser-safe updates out to connected dashboard clients.
- Must never call `apps/mock-erp` directly — all ERP interaction goes through the queue.
- Consumes `packages/contracts`, `packages/logger`, `packages/db`.

### `apps/worker`

- Owns order state transitions: queued → processing → confirmed / failed.
- Is the only service that calls `apps/mock-erp`.
- Implements retry logic and circuit-breaker behavior around the ERP.
- Publishes transport-neutral dashboard realtime events through Redis Pub/Sub without importing or hosting the browser-facing SSE runtime.
- Consumes `packages/contracts`, `packages/logger`, `packages/db`.

### `apps/mock-erp`

- Owns the simulated legacy ERP HTTP surface.
- Reads `LATENCY_MS`, `MAX_TPS`, and `ERROR_RATE` from environment — never hardcoded.
- Owns runtime admin chaos controls for latency, TPS cap, error rate, and forced outage.
- Has no knowledge of the queue or any other internal service.

### `apps/load-orchestrator`

- Owns k6 script execution, scenario parameterization, traffic execution state, and the output-parsing pipeline.
- Uses the traffic-execution lifecycle `starting -> active -> succeeded | failed`.
- Asks `apps/api` to accept a run start and establish the dashboard recovery baseline before spawning k6 or returning start success.
- Forwards parsed traffic metrics (RPS, p95 latency, failure rate) and traffic-completion reports to `apps/api`.
- Does not own API/business draining, demo-run finalization, dashboard recovery state, or run-summary persistence.
- Exposes a traffic-execution control API consumed by `apps/api`; the dashboard starts demo runs through the API lifecycle rather than driving load scenarios directly.

### `packages/contracts`

- Single source of truth for: buy-request shape, reservation-response shape, queue job payloads, dashboard realtime event names and payloads, ERP request/response shapes, metric event shapes.
- Must be built before any service that depends on it (enforced by Turborepo pipeline).

### `packages/logger`

- Thin Pino wrapper that stamps every log line with the service name and propagates `correlationId`.
- Used by `apps/api`, `apps/worker`, `apps/mock-erp`, and `apps/load-orchestrator`.

### `packages/db`

- Drizzle ORM schema definitions and migration tooling.
- Shared between `apps/api` and `apps/worker` so schema migrations are one source of truth.
- `apps/mock-erp` and `apps/load-orchestrator` do not use this package.

---

## What Goes in `docs/` vs `working_docs/`

`working_docs/` holds the process- and governance-oriented documents that drive the work:

| `working_docs/` |
| :-- |
| Project vision / blueprint (`project_description.md`) |
| Delivery constraints and system guarantees (`delivery_constraints.md`) |
| Project planning and task tracking (`project_planning.md`) |
| Agent quality checklists (`quality_checklists.md`) |

`docs/` holds target architecture and reference documentation for the system to be built:

| `docs/` |
| :-- |
| Architecture overview and failure modes (`architecture.md`) |
| Local development guide (`local_development.md`) |
| Domain model, conventions, runtime topology, and per-area decision records (like this file) |
| ADRs, benchmark results, and portfolio-facing write-ups |
