# Repository Layout — Decisions & Rationale

This is the current repository structure and ownership map.

---

## Decisions Summary

| Decision | Choice | Rationale |
| :-- | :-- | :-- |
| Repo strategy | Monorepo | Shared contracts, single boot, atomic cross-service commits. Polyrepo overhead unjustified for this project. |
| Monorepo tooling | Turborepo + pnpm workspaces | Task pipeline awareness (e.g. `contracts` builds before `api`) and incremental caching with minimal setup cost. |
| Frontend shape | One Next.js dashboard app with public, watch, admin, and history routes | Portfolio value is in the backend and realistic simulation behavior; frontend work should support operating and explaining the system, not become a commerce storefront. |
| Worker placement | Separate `apps/worker` | Must be an independent runtime and must not share the API event loop — required by the delivery constraint that the API stays responsive under queue pressure. The accepted topology runs one worker instance. |
| Mock ERP placement | Separate `apps/mock-erp` | Must be a real HTTP service across a real network boundary for circuit breakers and backpressure patterns to be meaningful. |
| Load orchestrator placement | Separate `apps/load-orchestrator` | Realistic load simulation is a first-class deliverable. Dashboard integration requires a wrapper service to trigger runs and stream metrics. |
| Shared packages | `contracts`, `logger`, `db` | All three are blockers for parallel service work. See rationale per package below. |
| Docs home | `docs/` alongside `working_docs/` | Current architecture and operator/developer references need a stable home separate from in-progress planning notes and backlog records. |

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
│   ├── logger/               # Pino wrapper and Fastify request-correlation integration
│   └── db/                   # Drizzle schema/migrations, PostgreSQL client, Redis adapters
├── infra/                    # Caddy single-origin proxy configuration
├── scripts/                  # Environment, runtime, maintenance, smoke, and composition tooling
├── docs/                     # Current architecture, access, runtime, testing, and developer references
├── working_docs/             # Project vision, delivery constraints, planning, and agent working docs
├── .devcontainer/            # Dev Container/Codespaces definition and lifecycle helpers
├── docker-compose.yml        # Full local reference runtime
├── docker-compose.dev.yml    # Loopback-only debug/infra port overrides
├── docker-compose.test.yml   # Isolated PostgreSQL and Redis test infrastructure
├── Dockerfile                # Development workspace and operational-tooling image
├── docker/                   # Validated shared production Dockerfile for Node services
├── pnpm-workspace.yaml        # Workspace membership for apps/* and packages/*
├── turbo.json                 # Cross-package build/test/dev task graph
├── AGENTS.md
├── README.md
└── package.json              # Root command surface and workspace tool dependencies
```

---

## Ownership Boundaries

### `apps/web`

- Owns the project overview and static "how it works" explainer (`/`), public demo picker (`/demo`), current-run spectator (`/watch`), admin console (`/admin`), and run history (`/run-history`).
- Exposes public-safe starts and live observation separately from admin preset editing, ERP diagnostics, recovery, and cleanup controls.
- Must not be treated as the source of high-volume traffic; load generation belongs to `apps/load-orchestrator` and k6.
- Should keep the frontend dependency strategy intentionally small: Tailwind CSS for utility styling, local React components for the current dashboard controls, and additional component, toast, or icon libraries only when a scoped need justifies the dependency.
- Consumes `packages/contracts` for API request/response types.
- Communicates with `apps/api` over same-origin HTTP routes and the live SSE stream at `/dashboard/events`.
- Keeps atomic projection comparison in one small pure state module, EventSource and single-flight current-read recovery coordination in focused hooks, and the watch page as a phase-aware narrative whose lifecycle-to-layout mapping lives in one pure presentation helper (`deriveWatchComposition`) rather than in individual panels.
- Uses a server-side admin session gate and protected read helpers, then composes independent current-run, policy, preset/start, and maintenance client controllers.

### `apps/api`

- Owns the buy flow: validates requests, runs the Redis atomic reservation, enqueues BullMQ jobs.
- Owns one bounded, per-sale pending-persistence recovery scheduler for nonterminal run scopes; request replay delegates exact due work to the same owner, while startup reconciliation and finalization only observe its state.
- Owns the browser-facing SSE transport for complete revisioned projection delivery to `apps/web`.
- Subscribes once per API process to the strict internal Redis projection-dirty signal, builds bounded complete projections, and fans only that projection schema out to connected dashboard clients.
- Composes separate preset-administration, public-runtime-policy, run-lifecycle, and traffic-completion application services. Demo routes receive those narrow controllers explicitly; lifecycle reads active presets and the effective policy through minimal injected readers before freezing one validated run snapshot, while completion alone validates and persists immutable load evidence before handing a draining run to finalization.
- Composes one focused traffic-execution HTTP gateway that owns bounded, authenticated start/status/abort calls to `apps/load-orchestrator`; run lifecycle receives only start capability and maintenance receives only exact-run abort capability.
- Composes separate destructive reset, old generated-run retention selection, and exact generated-run teardown workflows behind one process-local maintenance authority. Reset and teardown share one exact-run BullMQ pause/clean/resume boundary. Reset writes one summary and then purges internal run data regardless of outstanding work; retention and exact teardown retain the outstanding-work guard. Admin routes receive only the workflow for their endpoint.
- Keeps background starting-intent replay and draining-run startup repair on the explicit startup reconciliation owner rather than the request-facing lifecycle service. This owner observes or delegates pending-persistence state only; `PendingPersistenceRecoveryService` remains the sole discovery, retry, and resolution authority.
- Supplies operation configuration from `apps/api/src/index.ts`, while focused runtime factories own construction, abort wiring, and exactly-once cleanup for dashboard recovery, pending-persistence discovery/attempts, terminal inventory reads, and concurrent API readiness probes. The composition root injects one closeable readiness owner into the health route and closes it during API shutdown; routes and application services do not construct infrastructure clients.
- Composes narrow lifecycle ports such as `TerminalDemoRunWriter` in `apps/api/src/index.ts`; start-failure, finalization, and reset paths receive only the terminal capabilities they use, while traffic completion receives only the finalization controller used for its explicit handoff.
- Must never call `apps/mock-erp` directly — all ERP interaction goes through the queue.
- Consumes `packages/contracts`, `packages/logger`, `packages/db`.

### `apps/worker`

- Owns order state transitions: queued → processing → confirmed / failed.
- Is the only service that calls `apps/mock-erp`.
- Uses generation-scoped BullMQ wake-ups with `attempts: 1`, applies one paced adaptive admission authority to actual ERP confirmation calls, durably defers denied work, restores PostgreSQL safety expiries on restart, and reconciles unresolved calls before admitted same-key replay.
- Runs autonomous scanners for committed-but-undispatched queued orders, durable ERP-result recovery, and missing simulated-notification jobs.
- Persists poison order-job audit records and recovery/escalation state through `packages/db` adapters.
- Publishes the internal dashboard projection-dirty signal through Redis Pub/Sub without importing or hosting the browser-facing SSE runtime.
- Coalesces aggregate business-outcome dirty work without constructing per-order realtime payloads.
- Consumes `packages/contracts`, `packages/logger`, `packages/db`.

### `apps/mock-erp`

- Owns the simulated legacy ERP HTTP surface.
- Applies the accepted run configuration supplied by attributed jobs. Global chaos mutation endpoints and environment-backed business fallbacks have been removed; health and canonical status lookup remain service diagnostics.
- Enforces each TPS scope with an in-process rolling one-second limiter in the single supported Mock ERP process; additional processes are outside the local topology and would not share limiter history.
- Replays terminal confirmations from its PostgreSQL ledger and rejects contradictory business identity, retaining canonical results across process restarts.
- Has no knowledge of the queue or any other internal service.
- Consumes `packages/contracts`, `packages/logger`, and the shared PostgreSQL client; it has no Redis dependency.

### `apps/load-orchestrator`

- Owns k6 script execution, scenario parameterization, traffic execution state, and the output-parsing pipeline.
- Persists one atomic execution journal outside PostgreSQL with only `accepted`, `executing`, `completion_pending`, and `completed` states, and retains slot ownership until completion acknowledgement. Reads accept only the current single-slot journal and completion-report schemas; malformed state reports the durable file path and validation field instead of being migrated.
- Uses one focused child-process supervisor for identity, streams, close/error observation, run-ID-fenced cancellation, bounded termination/reap, and work-directory cleanup. It retains the slot until child exit is confirmed; routes own authentication and callers never signal k6 directly.
- Uses one focused completion-delivery coordinator as the only owner from durable report publication through matching API acknowledgement. It serializes normal/startup attempts, retries `completion_pending` after one fixed bounded interval, and stops without creating a shutdown attempt. The execution store conditionally serializes report publication and acknowledgement with all local journal mutations so stale or conflicting evidence is never overwritten.
- Keeps the supervisor's `idle | starting | running | stopping | exited` execution lifecycle separate from durable journal and API completion-delivery state. `K6_CANCELLATION_TIMEOUT_MS` is the single end-to-end stop/reap bound, defaults to 10 seconds, and is capped at 15 seconds. `COMPLETION_DELIVERY_RETRY_INTERVAL_MS` defaults to 5 seconds and is capped at 60 seconds.
- Directly probes the configured k6 executable for readiness and attaches bounded stderr plus system, k6-version, resolved-plan, and sampled generator-utilisation diagnostics to natural completion reports. Sampling is advisory, timer-unref'd, reduced to bounded scalars, and stopped with every child-process exit path.
- Uses the traffic-execution lifecycle `starting -> active -> succeeded | failed`.
- Receives only an API-accepted run ID, generated sale offer, and frozen configuration; the API establishes the durable dashboard recovery baseline before delegation.
- Forwards fixed-window traffic metrics (observed RPS, mean latency, and failure-observation fraction) and traffic-completion reports to `apps/api`; terminal completion continues to report p95 latency separately.
- Does not own API/business draining, demo-run finalization, dashboard recovery state, or run-summary persistence.
- Exposes a traffic-execution control API consumed by `apps/api`; the dashboard starts demo runs through the API lifecycle rather than driving load scenarios directly.

### `packages/contracts`

- Single source of truth for buy requests/responses, demo-run and traffic snapshots, queue jobs and retry policy, dashboard projection/read models, ERP contracts, public visitor credentials, metrics, lifecycle vocabulary, and error shapes.
- Must be built before any service that depends on it (enforced by Turborepo pipeline).

### `packages/logger`

- Thin Pino wrapper that stamps every log line with the service name, normalizes `x-correlation-id`, and exposes the shared Fastify request-child-logger integration.
- Used by `apps/api`, `apps/worker`, `apps/mock-erp`, `apps/load-orchestrator`, and the server-only web BFF correlation boundary.

### `packages/db`

- Drizzle ORM schema definitions and migration tooling; the package artifact includes the compiled modules plus the reviewed ordered migration SQL files, their journal entries, and their linked snapshots.
- The baseline appends only the `pgcrypto` extension and constant-expression single-nonterminal-run index because those objects do not reliably round-trip through this repository's schema and generator setup. Keys, foreign keys, uniqueness, and row-local checks remain declared in `schema.ts`; the current baseline has no trigger functions or non-internal triggers.
- Owns PostgreSQL connection construction, Redis inventory/dashboard/resilience helpers, the reusable bounded business-outcome publication scheduler used by API and worker composition roots, seed/reset helpers, and the public testing entry point.
- Shared by `apps/api` and `apps/worker` so durable checkout records and worker ERP-attempt semantics remain one source of truth.
- `apps/load-orchestrator` deliberately does not use this package; its traffic execution journal is file-backed.

---

## What Goes in `docs/` vs `working_docs/`

`working_docs/` holds the process- and governance-oriented documents that drive the work:

| `working_docs/` |
| :-- |
| Project vision / blueprint (`project_description.md`) |
| Delivery constraints and system guarantees (`delivery_constraints.md`) |

`docs/` holds the checked-in architecture and reference documentation for the implemented system:

| `docs/` |
| :-- |
| Architecture overview and failure modes (`architecture.md`) |
| Local development guide (`local_development.md`) |
| Domain model and cross-service conventions (`core_business_entities.md`, `cross_service_conventions.md`) |
| Runtime topology, testing infrastructure, load/metrics, inventory hot path, and admin access references |
| Agent quality checklists (`quality_checklists.md`) |

There are currently no separate ADR, hosted benchmark-result, or portfolio-write-up directories under `docs/`. Add and label those artifact types only when concrete files and reproducible evidence exist; they are not part of the current repository layout.
