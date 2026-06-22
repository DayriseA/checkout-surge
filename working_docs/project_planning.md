# Checkout-Surge - Implementation Planning

This document turns the seeded project blueprint and architecture references into an incremental implementation plan. Checkout-Surge starts from documentation, workspace guidance, and decision records rather than application source code, so this roadmap is intentionally focused on work that still has to be built.

The seeded decision documents are authoritative inputs. Implementation agents should use them as constraints and references, not rediscover or re-decide the same choices unless the implementation exposes a real conflict that needs an explicit documentation update.

Planning assumptions:

- Each numbered task below is intended to fit in a single coherent commit when practical.
- Subtasks describe implementation work that belongs inside that commit.
- Each commit should leave the repository in a runnable or reviewable state, even if some downstream features are still stubbed.
- Shared contracts should land before parallel service work begins, so humans or AI agents can work without drifting apart.
- Reference documents may still need wording updates as implementation lands, but those updates should reflect delivered behavior rather than repeat already-seeded design work.

---

## ✅ Seeded Decision Baseline

### Goal

Make the reset project start from a clear specification instead of from a blank ideation phase. The documents below should be treated as implementation inputs.

Decisions references:

- `working_docs/project_description.md` - project blueprint and portfolio goal.
- `docs/architecture.md` - target architecture, service ownership, buy path, failure modes, and key constraints.
- `working_docs/delivery_constraints.md` - reference scenario, delivery constraints, benchmark narrative, and cross-cutting guarantees.
- `docs/repository_layout.md` - monorepo shape, app/package boundaries, and docs ownership.
- `docs/local_development.md` - target local workflows, ports, environment variables, health endpoints, and command contracts.
- `docs/cross_service_conventions.md` - lifecycle vocabulary, event naming, correlation IDs, timestamps, error shape, queues, metrics, and dashboard realtime conventions.
- `docs/automated_testing_infrastructure.md` - testing taxonomy, isolated PostgreSQL/Redis test infrastructure, root test commands, reset rules, and testability expectations.
- `docs/core_business_entities.md` - domain model, storage boundaries, statuses, run-control entities, and persistence relationships.
- `docs/redis_inventory_hot_path.md` - Redis key structure, atomic reservation behavior, idempotency, pending persistence, and operator visibility rules.
- `docs/load_generation_metrics_streaming.md` - preset traffic model, load-orchestrator ownership, k6 metric handling, dashboard recovery, and run-summary split.
- `docs/admin_access_protection.md` - public/admin access model, protected controls, service-token boundaries, and safety caps.
- `docs/runtime_topology.md` - reference local topology, runtime command contract, Dev Container/Codespaces expectations, and hosted-boundary rules.

Notes:

- These documents describe target behavior. They do not imply the corresponding source code, scripts, containers, migrations, or tests already exist.
- If an implementation task discovers a contradiction between seeded references, update the relevant reference explicitly in the same commit or call out the conflict before proceeding.

---

## ✅ Phase 1 - Repository and Shared Platform Baseline

### Goal

Create the monorepo, shared contracts, persistence foundation, test infrastructure, and platform conventions that later service work depends on.

Primary references:

- `docs/repository_layout.md`
- `docs/local_development.md`
- `docs/automated_testing_infrastructure.md`
- `docs/core_business_entities.md`
- `docs/cross_service_conventions.md`

Completion commits:

- `5e46e9e` - `feat: scaffold monorepo baseline`
- `7c49239` - `feat: add local and test infrastructure scaffolding`
- `c119ebd` - `feat: add initial database schema and seed path`
- `8f91542` - `feat: add shared service contracts`
- `b4a9486` - `feat: add platform logging helpers`
- `dc1e4fe` - `test: add shared platform test foundation`

Final verification completed:

- `pnpm build`
- `pnpm type-check`
- `pnpm type-check:test`
- `pnpm lint`
- `pnpm format:check`
- `pnpm test:unit`
- `pnpm test:coverage`
- `pnpm test:infra:up && pnpm test && pnpm test:api && pnpm test:infra:down`

Phase 1 intentionally leaves full service runtimes, API routes, dashboard UI, queue/worker processing, mock ERP behavior, load orchestration behavior, Redis atomic reservation behavior, and full reference runtime smoke checks to later phases. Root commands for those later surfaces remain explicit placeholders where the implementation has not landed.

### ✅ Task 1.1 - Scaffold the monorepo baseline

Subtasks:

- ✅ Initialize the pnpm workspace root with `package.json`, `pnpm-workspace.yaml`, `turbo.json`, baseline TypeScript config, formatting/linting config, and ignore files.
- ✅ Create the `apps/` and `packages/` skeletons described in `docs/repository_layout.md`.
- ✅ Add package and app manifests for `apps/web`, `apps/api`, `apps/worker`, `apps/mock-erp`, `apps/load-orchestrator`, `packages/contracts`, `packages/logger`, and `packages/db`.
- ✅ Configure the Turborepo pipeline so shared packages build before services that consume them.
- ✅ Add stable root command names from `docs/local_development.md`, using honest placeholders only where the implementation behind a command has not landed yet.
- ✅ Preserve the reset-project expectation that commands, paths, and packages described in docs are target contracts that implementation work must create.

### ✅ Task 1.2 - Materialize local and test infrastructure scaffolding

Subtasks:

- ✅ Add `.env.example` files for root and per-service configuration surfaces.
- ✅ Add the initial Docker Compose files for development PostgreSQL/Redis and isolated test PostgreSQL/Redis.
- ✅ Add root scripts for `infra:up`, `infra:down`, `test:infra:up`, `test:infra:down`, and `test:infra:reset`.
- ✅ Add test environment loading conventions so package tests use isolated `TEST_DATABASE_URL` and `TEST_REDIS_URL` values rather than normal development state.
- ✅ Add baseline Dev Container and Codespaces configuration with Docker-in-Docker readiness checks and dependency isolation through named volumes.
- ✅ Keep Dev Container and Codespaces startup explicit: do not auto-start the full reference runtime.

### ✅ Task 1.3 - Create the initial database schema and seed path

Subtasks:

- ✅ Create the first migrations for the core entities described in `docs/core_business_entities.md`.
- ✅ Add Drizzle schema exports through `packages/db` without leaking private test helpers across package boundaries.
- ✅ Seed a small but realistic demo dataset: product, baseline sale offer, durable public/admin presets, public custom base preset, public runtime policy, and Redis inventory for the seeded active offer.
- ✅ Ensure seeded data supports happy-path, sold-out, failure-path, and later run-history demos.
- ✅ Add reset helpers only behind explicit test or local-maintenance entry points.

### ✅ Task 1.4 - Implement shared request/response contracts

Subtasks:

- ✅ Create Zod schemas and public TypeScript types in `packages/contracts`.
- ✅ Cover buy requests/responses, error payloads, order and reservation statuses, dashboard events, ERP requests/responses, demo preset/run control, load execution, run history, public runtime policy, and health/readiness responses.
- ✅ Keep lifecycle and vocabulary choices aligned with `docs/cross_service_conventions.md`.
- ✅ Make contract exports the shared source of truth for services and frontend code.

### ✅ Task 1.5 - Add baseline platform observability

Subtasks:

- ✅ Implement `packages/logger` with service names, structured log fields, and correlation ID helpers.
- ✅ Add correlation ID normalization helpers that can be shared by API, worker, mock ERP, and load orchestrator code.
- ✅ Add health and readiness response helpers that match the shared contracts.
- ✅ Keep infrastructure construction in composition roots; do not create PostgreSQL, Redis, BullMQ, or HTTP clients at module import time in route or service modules.

### ✅ Task 1.6 - Add automated tests for shared platform foundations

Subtasks:

- ✅ Add unit tests for contracts, domain enums, validation rules, and error payload conventions.
- ✅ Add database integration tests for migrations, seed data, and reset behavior against isolated test infrastructure.
- ✅ Add focused tests for logger metadata, correlation ID handling, and health/readiness response shapes.
- ✅ Ensure root and package test commands follow the taxonomy in `docs/automated_testing_infrastructure.md`.

---

## ✅ Phase 2 - Thin End-to-End Vertical Slice

### Goal

Make the system runnable early by connecting a dashboard shell, API boundary, and persistence path before high-scale behavior is introduced.

Primary references:

- `docs/architecture.md`
- `docs/repository_layout.md`
- `docs/core_business_entities.md`
- `docs/cross_service_conventions.md`

Completion commits:

- `cb8f680` - `feat(api): add Phase 2 gateway slice`
- `4722995` - `feat(web): add Phase 2 dashboard shell`
- `56fe589` - `test: wire Phase 2 verification commands`

Final verification completed:

- `pnpm build`
- `pnpm type-check`
- `pnpm type-check:test`
- `pnpm lint`
- `pnpm format:check`
- `pnpm test`
- `pnpm test:coverage`

Phase 2 intentionally leaves Redis atomic inventory, queue processing, worker behavior, mock ERP calls, load orchestration, browser-facing SSE/realtime fan-out, demo-run start/finalization lifecycle, and full runtime smoke checks to later phases.

### ✅ Task 2.1 - Scaffold the initial dashboard UI shell

Subtasks:

- ✅ Build an initial Next.js dashboard shell with public demo, live watch, admin, run-history, and static `/about` explainer route placeholders.
- ✅ Add placeholder areas for load-run controls, inventory drain, queue pressure, ERP health, run outcomes, and recovery status.
- ✅ Avoid building a customer storefront; synthetic buyers are generated through k6/API traffic.

### ✅ Task 2.2 - Scaffold the API gateway service

Subtasks:

- ✅ Stand up the Fastify service with routing, validation, shared error handling, correlation ID propagation, and health/readiness endpoints.
- ✅ Add a first buy endpoint with stubbed or simplified behavior behind a thin route and application service boundary.
- ✅ Return response shapes validated against `packages/contracts` so k6, API tests, and dashboard projections have a stable early target.

### ✅ Task 2.3 - Connect the dashboard shell to initial backend reads

Subtasks:

- ✅ Wire the dashboard shell to API health/status information where useful.
- ✅ Display placeholder system state while Redis, queue, realtime, and load-orchestrator behavior are still landing.
- ✅ Keep direct buy-flow validation in API tests and preset traffic runs rather than adding a customer UI.

### ✅ Task 2.4 - Persist a simple first order or reservation record

Subtasks:

- ✅ Replace purely mocked buy behavior with a minimal persisted reservation/order path in PostgreSQL.
- ✅ Ensure a request becomes visible through a durable record and a stable read path.
- ✅ Keep this slice intentionally narrow; do not add Redis atomic inventory, queue processing, or ERP calls before their phases.

### ✅ Task 2.5 - Add automated tests for the thin vertical slice

Subtasks:

- ✅ Add API/service-boundary tests for the first buy endpoint, validation failures, correlation IDs, and stable response shapes.
- ✅ Add persistence integration tests proving a successful request creates the expected record.
- ✅ Add read-path tests for any API response consumed by the dashboard shell.
- ✅ Add a frontend smoke or component test if the UI contains behavior beyond static placeholders.

---

## ✅ Phase 3 - Redis Inventory Hot Path

### Goal

Move stock handling onto the fast path that makes the limited-inventory surge scenario credible and prevents overselling under concurrency.

Primary reference:

- `docs/redis_inventory_hot_path.md`

Completion commits:

- `d5e1df2` - `feat(inventory): add Redis-backed inventory state`
- `20b3aea` - `feat(inventory): add atomic stock reservations`
- `d0ed743` - `feat(api): persist Redis-secured reservations`
- `d1d659f` - `feat(inventory): expose bounded drain projections`
- `cd42216` - `fix(inventory): harden reservation edge cases`
- `62e81c7` - `test(inventory): complete hot-path coverage`
- `91d6af6` - `fix(inventory): enforce atomic run eligibility`

Final verification completed:

- `pnpm turbo run build --force`
- `pnpm type-check`
- `pnpm type-check:test`
- `pnpm lint`
- `pnpm format:check`
- `TURBO_FORCE=true pnpm test`
  - Unit: 18 total (contracts 11, logger 6, web 1)
  - API/service: 32
  - DB/Redis integration: 24
- `pnpm test:coverage`
- Fresh `pnpm test:infra:up` / `pnpm test:infra:down` cycle with volumes removed

Phase 3 completed the Redis inventory hot path, including Redis-secured durable reservations, bounded drain projections, hardened edge cases, comprehensive hot-path coverage, and atomic run eligibility enforcement added by the final audit fix.

Phase 3 intentionally leaves queue/worker processing to Phase 4, ERP behavior to Phase 5, Redis Pub/Sub, SSE, and browser realtime behavior to Phase 6, and run-start/load orchestration to Phase 7. Automatic hold release and reconciliation remain a deferred production extension, and terminal run finalization remains for a later phase.

### ✅ Task 3.1 - Implement Redis-backed inventory state

Subtasks:

- ✅ Add Redis key helpers and inventory state operations that follow the documented key structure.
- ✅ Add stock initialization from seeded sale offers and generated run sale offers.
- ✅ Add an API-readable inventory status path with remaining stock, reserved stock, pending persistence, expired hold count, and oldest pending age.
- ✅ Keep PostgreSQL as the durable allocation source and Redis as the live hot-path authority.

### ✅ Task 3.2 - Implement atomic stock reservation

Subtasks:

- ✅ Add the Redis Lua or equivalent atomic reservation operation.
- ✅ Handle success, sold-out, missing inventory, idempotent replay, idempotency conflict, and quantity validation outcomes.
- ✅ Ensure sold-out attempts stay on the cheap Redis-first losing path without per-loser PostgreSQL writes.
- ✅ Return reservation outcomes through shared contract schemas the API and dashboard can trust.

### ✅ Task 3.3 - Persist reservation intent after successful stock hold

Subtasks:

- ✅ Persist successful reservations, initial queued orders, and order events in PostgreSQL after Redis accepts stock.
- ✅ Preserve the distinction between fast reservation and slow final confirmation.
- ✅ Add pending-persistence sentinel handling when Redis succeeds but PostgreSQL persistence fails.
- ✅ Keep durable order/reservation/event writes behind persistence modules, not inside route handlers.

### ✅ Task 3.4 - Surface inventory drain in near real time

Subtasks:

- ✅ Publish bounded inventory updates after successful reservations and aggregate sold-out pressure.
- ✅ Reflect remaining stock, reserved stock, and reservation throughput in API-readable state.
- ✅ Prepare the inventory projection so dashboard realtime can consume it in Phase 6 without changing hot-path ownership.

### ✅ Task 3.5 - Harden reservation edge cases

Subtasks:

- ✅ Add idempotency protection for duplicate accepted requests.
- ✅ Add behavior for stale holds, late duplicate submissions, and mismatched idempotency payloads.
- ✅ Make partial-failure behavior explicit in API responses, logs, Redis state, and operator-visible status.

### ✅ Task 3.6 - Add automated tests for the Redis inventory hot path

Subtasks:

- ✅ Add Redis integration tests for initialization, successful reservation, sold-out rejection, idempotent replay, and idempotency conflict.
- ✅ Add concurrency tests proving the atomic reservation path cannot oversell under competing requests.
- ✅ Add API integration tests for reservation-secured, sold-out, inventory-not-initialized, duplicate, and pending-persistence outcomes.
- ✅ Add persistence tests proving successful Redis reservations create the expected reservation, order, and order-event records.
- ✅ Add partial-failure tests proving a Redis stock hold is preserved for reconciliation when durable persistence fails.

---

## ✅ Phase 4 - Asynchronous Order Pipeline

### Goal

Separate immediate API reservation responsiveness from slow downstream processing by introducing queue-backed background work.

Primary references:

- `docs/architecture.md`
- `docs/core_business_entities.md`
- `docs/cross_service_conventions.md`

Completion summary: Phase 4 delivers the durable API-to-BullMQ handoff, immediate queued `202` reservation responses, worker-owned `queued -> processing -> confirmed | failed` transitions, append-only correlated event history with delivery metadata, terminal idempotency and transactional atomicity, readiness integration, and a validated bounded `/queue/status` projection. Integration coverage now proves the no-worker API response boundary, real enqueue and pickup, BullMQ metadata across test-only retry deliveries, terminal PostgreSQL state and reconstructable history, and live Redis/BullMQ backlog, paused, delayed, retrying, truncated, and recent-failure visibility. ERP behavior and attempt persistence, production retry/backoff policy, circuit breaking, dead-letter routing, notifications, Redis Pub/Sub, SSE, and dashboard behavior remain deferred to later phases.

### ✅ Task 4.1 - Introduce the queue layer and worker skeleton

Subtasks:

- ✅ Add BullMQ queue construction in the appropriate composition roots.
- ✅ Implement the `orders:process` semantic queue and physical queue naming rule from the shared conventions.
- ✅ Add the first worker process with structured logging, explicit dependencies, health/readiness endpoints, and basic failure reporting.
- ✅ Keep queue producers and consumers behind application-service or adapter boundaries.

### ✅ Task 4.2 - Hand off reservations to asynchronous processing

Subtasks:

- ✅ Change the API flow so successful reservations enqueue order-processing work instead of assuming completion inline.
- ✅ Return an immediate `reservation_secured` / queued-processing response without waiting for downstream confirmation.
- ✅ Persist the transition from reservation secured to order queued.

### ✅ Task 4.3 - Implement order state transitions inside the worker

Subtasks:

- ✅ Move orders through `queued -> processing -> confirmed | failed`.
- ✅ Persist worker progress and order events so operators can reconstruct what happened.
- ✅ Capture retry metadata hooks even if full ERP resilience lands in Phase 5.

### ✅ Task 4.4 - Expose queue health and backlog visibility

Subtasks:

- ✅ Track queue depth, wait time, retry count, and failed-job visibility.
- ✅ Surface queue health in readiness checks, logs, API-readable state, and later dashboard projections.
- ✅ Make the backlog behavior observable before the full dashboard is complete.

### ✅ Task 4.5 - Add automated tests for the asynchronous order pipeline

Subtasks:

- ✅ Add worker integration tests for enqueueing, pickup, retry metadata capture, and terminal state persistence.
- ✅ Add API integration tests proving successful reservations return immediately without waiting for worker completion.
- ✅ Add queue integration tests covering backlog visibility, failed-job reporting, and queue-health projections.
- ✅ Add persistence tests proving order-state transitions and event history remain reconstructable.

---

## ✅ Phase 5 - Mock ERP and Resilience Controls

### Goal

Create the controlled bottleneck that proves the architecture can absorb downstream slowness and failure.

Primary references:

- `docs/architecture.md`
- `docs/core_business_entities.md`
- `docs/cross_service_conventions.md`

Completion summary: Phase 5 now delivers the controlled downstream bottleneck end to end. Mock ERP owns configurable latency, TPS throttling, injected errors, and forced outages behind validated contracts and protected controls; the worker calls that real HTTP boundary, persists ERP attempts and timing data, retries temporary failures with exponential backoff, and protects the dependency with a circuit breaker. The API exposes operator-readable ERP resilience state from Redis, BullMQ, and PostgreSQL read models. Phase 6 still owns the live dashboard/realtime UI, while later run-control phases can supply run-scoped ERP behavior snapshots into the boundaries prepared here.

### ✅ Task 5.1 - Build the mock ERP service

Subtasks:

- ✅ Create the ERP-facing API contract that the worker calls.
- ✅ Implement realistic success and failure responses that resemble a slow legacy dependency.
- ✅ Add request logging, correlation ID propagation, health/readiness endpoints, and service-level tests.

Completion summary: The standalone Fastify Mock ERP now owns the shared `POST /confirmations` boundary, contract-validated success and dependency-failure responses, correlation-aware request logs, liveness/readiness endpoints, host-native startup, and service-level coverage. Its injected confirmation-decision boundary defaults to success and is ready for Task 5.2 to add latency, TPS, error-rate, and forced-outage controls without moving chaos behavior into the HTTP route.

### ✅ Task 5.2 - Add configurable chaos controls

Subtasks:

- ✅ Add latency, TPS cap, error-rate, and forced-outage controls.
- ✅ Read global fallback controls from environment and later allow run-scoped behavior from accepted snapshots.
- ✅ Keep dangerous controls behind the protection model described in `docs/admin_access_protection.md` when exposed through dashboard/admin paths.

Completion summary: Mock ERP now owns an environment-backed chaos configuration store with validated admin safety caps, a request-aware decision provider for latency, TPS throttling, forced errors, and forced outage behavior, public read-only chaos status, and service-token-protected update/reset endpoints. Shared contracts define the control paths and token header so later dashboard/admin proxy work can call the boundary without duplicating strings. Focused Mock ERP and contract tests cover fallback config loading, cap enforcement, status/update/reset routes, delayed decisions, throttling, injected failures, and forced outage responses.

### ✅ Task 5.3 - Integrate the worker with the mock ERP

Subtasks:

- ✅ Replace placeholder confirmation behavior with real ERP HTTP calls from the worker only.
- ✅ Persist ERP attempt results, HTTP status, errors, timing, and attempt numbers.
- ✅ Ensure the order lifecycle reflects actual downstream behavior rather than assumed success.

Completion summary: The worker startup path now composes a real Mock ERP HTTP confirmation adapter using `MOCK_ERP_BASE_URL` and `ERP_REQUEST_TIMEOUT_MS` instead of the local success placeholder. ERP responses, invalid responses, transport failures, and timeouts are recorded through a PostgreSQL attempt persistence adapter that writes `erp_attempts` rows and correlated `erp.attempt.succeeded` / `erp.attempt.failed` events. Worker unit tests cover request shape, success, dependency failure, timeout, invalid response, transport failure, and config validation; integration tests prove real BullMQ deliveries persist ERP attempt history before terminal order outcomes.

### ✅ Task 5.4 - Add resilience patterns around the ERP dependency

Subtasks:

- ✅ Add retry behavior with exponential backoff.
- ✅ Add a circuit breaker or equivalent protective mechanism.
- ✅ Define temporary failure versus terminal failure in code and tests.
- ✅ Protect the ERP from retry thrash under prolonged failure.

Completion summary: Order-processing jobs now receive an environment-backed retry budget and exponential BullMQ backoff from the API queue handoff. The worker distinguishes temporary ERP dependency failures from terminal confirmation failures, leaves orders in `processing` while retry attempts remain, and only marks exhausted or terminal failures as `failed`. A worker-owned circuit breaker wraps ERP calls, opens after configured consecutive temporary failures, suppresses downstream calls during the reset window, probes half-open recovery, and closes on successful recovery. Tests cover retry metadata, retryable versus exhausted handler behavior, temporary/terminal classification, circuit open/half-open behavior, and a real BullMQ retry that records failed and successful ERP attempts before confirming the order.

### ✅ Task 5.5 - Surface resilience state to operators

Subtasks:

- ✅ Expose whether the ERP is healthy, degraded, or unavailable.
- ✅ Show circuit state, retry pressure, and confirmation delay through API-readable state.
- ✅ Prepare these signals for dashboard panels and benchmark summaries.

Completion summary: Shared contracts now define the API-readable ERP resilience projection at `/erp/status`, including dependency status, reason, circuit snapshot, retry pressure, latest attempt, recent failure/timeout counts, and confirmation-delay metrics. The worker publishes circuit snapshots through a shared Redis helper whenever breaker state changes, and the API combines that snapshot with BullMQ retry pressure plus PostgreSQL ERP/order read models. API route and service tests cover healthy, degraded, unavailable, and missing-circuit states, while contract tests pin the response shape for later dashboard and benchmark-summary consumers.

### ✅ Task 5.6 - Add automated tests for mock ERP and resilience controls

Subtasks:

- ✅ Add mock-ERP tests for success, throttled, delayed, forced-error, and forced-outage responses.
- ✅ Add worker integration tests proving ERP attempt results, timing data, retry scheduling, and terminal outcomes are persisted correctly.
- ✅ Add resilience tests for exponential backoff, circuit-breaker open/recovery behavior, and retry-thrash protection.
- ✅ Add API/read-model tests proving operator-facing resilience signals reflect degraded and unavailable ERP states accurately.

Completion summary: The Phase 5 test pass now covers the Mock ERP chaos behavior through the HTTP confirmation boundary, including delayed success, TPS throttling, forced errors, and forced outages. Worker integration coverage proves ERP attempts, timing data, retry metadata, retry recovery, exhausted retry budgets, and terminal order outcomes are durably recorded. Unit and API tests cover exponential backoff metadata, circuit open/half-open/recovery behavior, retry-thrash suppression, and operator-facing healthy, degraded, unavailable, and missing-circuit resilience projections.

---

## ⬜ Phase 6 - Real-Time Admin Simulation Experience

### Goal

Turn internal state transitions into live feedback for operators and public observers. The dashboard proves system behavior; high-volume synthetic buyers remain k6/API traffic, not browser clients.

Primary references:

- `docs/cross_service_conventions.md`
- `docs/architecture.md`
- `docs/load_generation_metrics_streaming.md`

### ⬜ Task 6.1 - Implement the realtime transport layer

Subtasks:

- Add the API-owned SSE stream at `/dashboard/events`.
- Add validated dashboard realtime event contracts and Redis Pub/Sub publication helpers.
- Add one shared Redis subscriber per API process and fan out transport-neutral API/worker events to browser SSE clients.
- Implement connection lifecycle, heartbeat behavior, backpressure handling, and reconnect expectations.

### ⬜ Task 6.2 - Deliver live order and run outcome updates

Subtasks:

- Publish aggregate order status changes to the dashboard in real time.
- Show the difference between reservations secured and final confirmations at run level.
- Represent waiting, retrying, confirmed, failed, and simulated-notification outcomes clearly in operator-facing projections.

### ⬜ Task 6.3 - Build the first usable operator dashboard

Subtasks:

- Add panels for request surge, queue depth, inventory drain, ERP health, and consistency lag.
- Favor clear, scannable operational UI over marketing-style presentation.
- Make the dashboard explain system behavior during a burst without requiring logs.

### ⬜ Task 6.4 - Add simulation control actions to the dashboard UI

Subtasks:

- Add public-safe preset starts and admin-protected controls through the intended API/web boundary.
- Add controls for ERP chaos knobs, recovery, reset, and local maintenance where appropriate.
- Use the API-owned run lifecycle as the source of truth for start gating and recovery state.

### ⬜ Task 6.5 - Add consistency-lag visibility

Subtasks:

- Measure the time between the initial buy request and final ERP confirmation.
- Surface consistency lag as a first-class dashboard metric.
- Make it easy to compare fast reservation with slow final confirmation.

### ⬜ Task 6.6 - Add automated tests for the real-time admin simulation experience

Subtasks:

- Add transport-layer tests for connection lifecycle, channel subscription, reconnect behavior, and event fan-out.
- Add backend integration tests proving order, queue, inventory, and ERP state changes emit expected realtime events.
- Add frontend component or integration tests covering live dashboard updates, simulation controls, and consistency-lag presentation.
- Add tests for run-level aggregate projections distinguishing reservations secured from final confirmations and failures.

---

## ⬜ Phase 7 - Load Generation and Metrics Streaming

### Goal

Drive the system under realistic synthetic pressure and make resulting behavior observable from the dashboard.

Primary reference:

- `docs/load_generation_metrics_streaming.md`

### ⬜ Task 7.1 - Implement preset traffic contracts and validation

Subtasks:

- Implement the discriminated buyer-spike and steady-arrival traffic models in shared contracts.
- Add public/admin preset validation, public runtime policy enforcement, and deployment hard-cap checks.
- Seed durable public presets, editable admin presets, and the public custom base in the database seed path if not already present.
- Public preset set: `preview-1k`, `surge-5k`, `surge-10k`, `idempotency-check-200`, and read-only `public-custom`.
- Ensure every accepted traffic snapshot includes API-generated `runId` and generated `saleOfferId`.

### ⬜ Task 7.2 - Build the load-orchestrator wrapper

Subtasks:

- Create the Fastify load-orchestrator service.
- Generate k6 execution input from validated preset traffic snapshots without unsafe shell interpolation.
- Parse k6 JSON output into stable traffic execution and metric payloads.
- Keep the load orchestrator out of `packages/db`; persistence remains API-owned.

### ⬜ Task 7.3 - Stream load metrics into the main application

Subtasks:

- Forward request rate, latency, and failure-rate signals from k6 to the API.
- Align k6 metrics with the reserved metric names in shared conventions.
- Preserve run metadata so benchmark sessions are distinguishable.
- Keep HTTP-level traffic metrics separate from asynchronous business outcomes.

### ⬜ Task 7.4 - Connect dashboard actions to load execution

Subtasks:

- Let the dashboard start public or admin demo runs through the API lifecycle.
- Have the API accept a run, establish dashboard recovery state, and delegate the accepted traffic snapshot to the load orchestrator.
- Show current run state across `starting`, `active`, `draining`, `completed`, and `failed`.
- Prevent overlapping or conflicting simulation runs through both UI affordances and API enforcement.

### ⬜ Task 7.5 - Capture benchmark artifacts

Subtasks:

- Persist run summaries that combine HTTP-level traffic data with business outcome summaries.
- Capture request surge, queue depth, inventory drain, consistency lag, total attempts, durable accepted reservations, sold-out rejections, queued orders, confirmed orders, failed orders, and simulated notifications recorded.
- Copy a Redis-derived terminal inventory snapshot into each immutable run summary, including starting stock, final remaining/reserved stock, accepted reservations, sold-out aggregate counts, pending persistence count, capture time, and source.
- Preserve sold-out pressure as aggregate reservation-outcome accounting rather than per-loser PostgreSQL rows.
- Prepare the structure for later side-by-side backend comparisons.

### ⬜ Task 7.6 - Add automated tests for load generation and metrics streaming

Subtasks:

- Add tests for preset validation, cap enforcement, parameter passing, and load-orchestrator request handling.
- Add parser and adapter tests proving k6 output becomes stable metric-stream payloads.
- Add integration tests for dashboard-triggered run start, run-state transitions, overlap prevention, and benchmark-artifact persistence.
- Add tests proving HTTP traffic metrics remain separate from asynchronous business outcomes in stored summaries and live streams.

---

## ⬜ Phase 8 - Product Polish, Reliability, and Demo Completeness

### Goal

Add finishing features that make the project presentation-ready while tightening operational reliability.

Primary references:

- `docs/admin_access_protection.md`
- `docs/core_business_entities.md`
- `docs/load_generation_metrics_streaming.md`

### ⬜ Task 8.1 - Add simulated notification records

Subtasks:

- Record a post-confirmation notification event after an order is confirmed.
- Keep the implementation intentionally simulated; do not add real email, SMS, or external provider dependencies.
- Persist order ID, channel, recipient placeholder, status, timestamp, run ID, sale offer ID, and correlation ID.

### ⬜ Task 8.2 - Surface completion outcomes

Subtasks:

- Show run-level and order-level completion outcomes in the dashboard and read models.
- Represent confirmed, failed, delayed, retrying, and notification-recorded outcomes without changing canonical persistence states.
- Reuse background job patterns so post-confirmation workflow steps do not block order processing.

### ⬜ Task 8.3 - Add operational reset and demo tools

Subtasks:

- Provide safe admin recovery/reset workflows for local maintenance and demo recovery.
- Make queue inspection and reset-owned queue cleanup explicit, auditable operations.
- Ensure normal preset starts use generated run sale offers with isolated inventory, so reset is not required before every run.
- Add maintenance cleanup for old generated runs while preserving active runs and recent history.

### ⬜ Task 8.4 - Protect admin controls and unsafe paths

Subtasks:

- Add passphrase-backed admin session handling in the web app.
- Proxy protected dashboard actions through server-side routes with service tokens.
- Enforce server-side caps for public starts, public custom runs, admin traffic, ERP diagnostics, reset, realtime reads, and internal ingestion.
- Implement admin preset management explicitly: save editable admin-only presets, duplicate public presets into editable admin copies, copy presets into the persisted `Custom` scratch preset, and keep public presets plus `public-custom` read-only.
- Review secret handling, browser-exposed values, error leakage, and direct service mutation endpoints.

### ⬜ Task 8.5 - Write portfolio-facing technical documentation

Subtasks:

- Summarize the architecture in plain but credible engineering language.
- Explain the failure modes the system absorbs and how the dashboard proves them.
- Document what is simulated versus what is architecturally real.
- Keep public docs aligned with implemented behavior rather than future-tense aspirations.

### ⬜ Task 8.6 - Add automated tests for product polish and operational reliability

Subtasks:

- Add tests proving simulated notifications are recorded only after successful confirmation and contain expected metadata.
- Add dashboard/read-model tests for confirmed, failed, delayed, retrying, and notification-recorded outcomes.
- Add integration tests for reset, recovery, maintenance cleanup, and queue cleanup workflows.
- Add security-focused tests for admin protection, rate limiting, server-side caps, and unsafe control prevention.

---

## ⬜ Phase 9 - Runtime Topology and Containerized Local Development

### Goal

Make the architecture-realistic runtime the default local reference path. The load orchestrator is part of the demonstrated system, so it should run in its own container with k6 installed inside the image.

Primary reference:

- `docs/runtime_topology.md`

### ⬜ Task 9.1 - Containerize the load orchestrator with k6

Subtasks:

- Add a load-orchestrator image that installs the k6 binary as part of the runtime.
- Ensure `K6_BINARY` resolves inside the container without host machine setup.
- Add readiness coverage that verifies the configured k6 binary is executable before the load orchestrator reports full readiness.

### ⬜ Task 9.2 - Add the application-service compose path

Subtasks:

- Expand the root local compose topology to include API, worker, mock ERP, web, load orchestrator, PostgreSQL, Redis, and the dashboard proxy.
- Add a `.devcontainer` compose override only for Dev Container/Codespaces concerns such as bind mounts, dev-mode commands, Docker-in-Docker compatibility, dependency-volume isolation, and forwarded ports.
- Preserve host-native `pnpm dev:*` workflows and infra-only convenience commands.
- Add `runtime:up`, `runtime:down`, `runtime:setup`, `runtime:wipe`, `runtime:reset`, and related command contracts.
- Ensure Dev Container/Codespaces startup does not auto-run the full reference runtime.
- Keep compose-internal service DNS, browser-facing localhost URLs, secrets, boot order, and port-forwarding behavior aligned with `docs/runtime_topology.md`.

### ⬜ Task 9.3 - Validate dashboard-triggered load runs in the containerized topology

Subtasks:

- Prove the dashboard can start a load run through the containerized load orchestrator.
- Prove the load orchestrator streams k6 metrics back to the API and dashboard without host-installed k6.
- Capture host, Dev Container, and Codespaces limitations that affect local 10k-style validation.
- Verify the same dashboard-triggered flow from host-native and containerized entry points where practical.

### ⬜ Task 9.4 - Add automated checks for the containerized local runtime

Subtasks:

- Add smoke checks for container startup, dependency readiness, direct service health, dashboard proxy reachability, same-origin dashboard reads, SSE reachability, and k6 execution inside the load-orchestrator container.
- Add a repeatable smoke path for dashboard-triggered load runs that cleans up only its own generated rows and Redis keys.
- Include Dev Container and Codespaces setup validation in runtime checks where practical.

### ⬜ Task 9.5 - Promote the containerized runtime in public docs

Subtasks:

- Update README and local-development docs so the containerized reference runtime is the primary demo path after it is implemented.
- Move host-native k6 installation guidance into an alternate workflow section.
- Remove transitional wording that no longer matches delivered runtime behavior.
- Ensure architecture and working-doc references describe the final local topology without stale future-tense language.

---

## ⬜ Phase 10 - Run Lifecycle and Benchmark Finalization

### Goal

Implement the API-owned benchmark lifecycle so a completed benchmark means both k6 traffic generation and run-scoped asynchronous business work have reached a final, explainable outcome.

Primary references:

- `docs/architecture.md`
- `docs/load_generation_metrics_streaming.md`
- `docs/core_business_entities.md`
- `docs/cross_service_conventions.md`

### ⬜ Task 10.1 - Add first-class run attribution

Subtasks:

- Accept run attribution at the buy API boundary from the shared request body and `x-load-run-id` header, rejecting mismatches.
- Track run membership for reservations, orders, queue jobs, ERP attempts, simulated notifications, finalization inputs, and summaries.
- Persist enough run-scoped pending-persistence state to explain Redis-accepted reservations when durable order creation initially fails.
- Prefer explicit run identity over correlation ID parsing while preserving correlation IDs for tracing and diagnostics.

### ⬜ Task 10.2 - Implement business-boundary finalization

Subtasks:

- Treat k6 process success as traffic completion, not benchmark completion.
- Add API-owned traffic-completion/failure ingestion so the load orchestrator reports k6 results and HTTP summaries.
- Add an API-owned finalization service or poller that evaluates draining runs and transitions them to `completed` or `failed`.
- Enforce one immutable final benchmark artifact per run ID with idempotent duplicate-finalization behavior.
- Combine persisted k6 traffic aggregates with durable async business outcomes only after run-scoped business work settles or an explicit timeout/failure policy applies.
- Preserve sold-out rejection totals from traffic/Redis aggregate sources rather than per-rejection PostgreSQL rows.

### ⬜ Task 10.3 - Implement dashboard recovery and lifecycle ownership

Subtasks:

- Split live dashboard recovery from historical benchmark summaries.
- Make `/dashboard/recovery` the authoritative current-run recovery read for initial load, SSE reconnect, manual refresh, start controls, and reset controls.
- Add API startup reconciliation: durable `starting` and `active` runs left behind by process restart are failed with `api_restart_interrupted_run`, sale eligibility is closed, and immutable run-history summaries are written; durable `draining` runs remain recoverable so finalization can continue.
- Discard live events received while recovery is in progress and schedule a serialized follow-up recovery when needed.
- Keep SSE events ephemeral and best-effort; do not add event logs, replay cursors, or catch-up endpoints.
- Move in-progress start gating and benchmark lifecycle ownership to the API.
- Keep the load orchestrator limited to k6 traffic execution, metric streaming, and traffic-completion reporting.
- Preserve `trafficEndedAt` and `finalizedAt` as distinct recovery fields.

### ⬜ Task 10.4 - Add lifecycle and finalization tests

Subtasks:

- Add contract tests for lifecycle vocabulary and run-attribution payloads.
- Add API/service tests proving runs remain draining while run-scoped work is queued, processing, retrying, missing required notifications, or pending persistence reconciliation.
- Add API startup-reconciliation tests for interrupted `starting`/`active` runs, closed sale eligibility, summary creation, and continued recovery of `draining` runs.
- Add API/load-orchestrator tests proving starts and reset are blocked while a run is `starting`, `active`, or `draining`, and allowed after terminal states.
- Add persistence/API tests proving duplicate finalization attempts do not create duplicate artifacts or overwrite existing final artifacts.
- Add load-orchestrator tests proving k6 success is reported as traffic `succeeded` and does not emit API-owned terminal benchmark state.
- Add finalization tests for traffic delivery quality, major under-delivery failure, sold-out aggregate preservation, and worker run-identity propagation.

---

## ⬜ Phase 11 - Hosted Deployment Readiness and Infrastructure Tuning

### Goal

Prepare the containerized system to run in a more realistic hosted environment and document the tuning decisions that support high concurrency.

### ⬜ Task 11.1 - Add hosted deployment assets

Subtasks:

- Add or refine deployment packaging for each service.
- Document how Redis, PostgreSQL, the dashboard, API, workers, mock ERP, and load services are composed outside local development.
- Capture environment expectations for staging or showcase deployments.
- Identify when the load generator should run from a separate VM, region, or managed k6 environment for credible benchmark isolation.

### ⬜ Task 11.2 - Add reverse-proxy and connection handling configuration

Subtasks:

- Add load-balancer or reverse-proxy configuration for exposed services.
- Capture buffer, timeout, keep-alive, and SSE routing settings that matter during bursts.
- Make these settings visible in documentation so they are part of the system story, not hidden setup.

### ⬜ Task 11.3 - Document operating-system and runtime tuning

Subtasks:

- Record file-descriptor and TCP-related tuning required for high concurrency.
- Document Redis, PostgreSQL, Node runtime, worker concurrency, and connection-pool assumptions relevant to performance.
- Make clear which tuning choices are essential for public benchmark runs versus optional local improvements.

### ⬜ Task 11.4 - Run deployment smoke checks and operational validation

Subtasks:

- Verify boot order, health checks, and service readiness in the deployed shape.
- Confirm the dashboard and load simulator still work through deployed entrypoints.
- Write rollback and recovery notes for common failure situations.

### ⬜ Task 11.5 - Add automated tests for deployment readiness and infrastructure tuning

Subtasks:

- Add smoke checks for containerized service startup, dependency readiness, and health endpoints in the deployment shape.
- Add configuration-validation tests for reverse-proxy routing, timeout assumptions, and connection-handling settings.
- Add deployment-path integration tests proving dashboard, API, worker, mock ERP, and load orchestrator interoperate through deployed entrypoints.
- Add repeatable verification scripts or CI jobs for operational validation and rollback/recovery exercises.

### Phase 11 checkpoint

At the end of this phase, the project can be demonstrated in a more production-like hosted environment and the infrastructure story is documented as part of the portfolio value.

---

## ⬜ Phase 12 - Optional Go Benchmark Track

### Goal

Add a parallel backend implementation in Go to create a credible side-by-side systems comparison without disturbing the original Node.js track.

### ⬜ Task 12.1 - Capture the Node.js benchmark baseline

Subtasks:

- Record the preset run shapes, traffic modes, metrics, and dashboard views the Go comparison must match.
- Capture representative Node.js benchmark artifacts once the Node path is stable enough for meaningful comparison.
- Document the invariants the Go implementation must preserve.

### ⬜ Task 12.2 - Scaffold the Go API gateway

Subtasks:

- Stand up the Go service with the same public contract as the Node gateway.
- Mirror request/response semantics so dashboard and load tests do not need separate flows.
- Keep the implementation isolated from the Node service rather than sharing runtime concerns.

### ⬜ Task 12.3 - Port the Redis reservation hot path to Go

Subtasks:

- Recreate the same inventory-reservation behavior with a separate Redis namespace.
- Preserve sold-out, idempotency, pending-persistence, and reservation semantics.
- Validate that the comparison remains fair and contract-compatible.

### ⬜ Task 12.4 - Port the asynchronous worker flow to Go

Subtasks:

- Recreate queue-consumer behavior for the Go path.
- Preserve ERP interaction logic, retry behavior, circuit-breaker rules, and order-state semantics.
- Keep observability aligned so both implementations are comparable in the same dashboard.

### ⬜ Task 12.5 - Isolate both backends for fair comparison

Subtasks:

- Separate inventory namespaces, queue names, database attribution, and benchmark identifiers.
- Ensure the same preset traffic snapshots can target either backend without accidental cross-talk.
- Add a clean reset strategy for repeated comparison runs.

### ⬜ Task 12.6 - Extend the dashboard for side-by-side comparison

Subtasks:

- Add paired metric views for latency, throughput, memory, queue behavior, inventory behavior, and consistency lag.
- Make it easy to compare both implementations under identical synthetic load.
- Keep the comparison readable rather than adding too many charts at once.

### ⬜ Task 12.7 - Run and document comparative benchmark sessions

Subtasks:

- Execute the same preset traffic shapes against both implementations.
- Capture results in a way that highlights tradeoffs rather than only declaring a winner.
- Record observations about latency, resource usage, implementation complexity, operational behavior, and developer experience.

### ⬜ Task 12.8 - Add automated tests for the Go comparison track

Subtasks:

- Add contract-compatibility tests proving the Go API gateway matches Node request and response semantics.
- Add Redis, queue, and worker-behavior tests proving the Go path preserves sold-out, idempotency, retry, and lifecycle semantics under isolated namespaces.
- Add cross-implementation benchmark harness tests verifying preset selection, run metadata, artifact capture, and attribution.
- Add dashboard and comparison-view tests proving side-by-side metrics remain attributable to the correct backend.

### Phase 12 checkpoint

At the end of this phase, the project demonstrates not only distributed-systems design skill, but also the ability to compare backend implementation strategies empirically and repeatably.

---

## Suggested Commit Discipline

- One task equals one commit whenever possible.
- If a task becomes too broad, split it by behavior boundary, not by file type.
- Land shared contracts before parallelizing dependent service work.
- Keep temporary stubs explicit and short-lived so they can be replaced cleanly in the next task.
- Do not combine infrastructure setup, business logic, and UI polish in the same commit unless the change is truly inseparable.
- When a task updates a seeded reference document, the same commit should make clear whether the update records delivered behavior, resolves a contradiction, or adds genuinely new scope.

## Suggested Milestones

0. Milestone 0: Seeded decision baseline present. Result: agents start from a complete target specification rather than a blank discovery phase.
1. Milestone A: Phases 1 to 2 complete. Result: the monorepo exists and a basic end-to-end purchase flow is runnable.
2. Milestone B: Phases 3 to 5 complete. Result: Redis reservation, queue processing, and ERP bottleneck behavior are real.
3. Milestone C: Phases 6 to 7 complete. Result: live dashboard and realistic load simulation prove system behavior visually.
4. Milestone D: Phases 8 to 9 complete. Result: the project is portfolio-ready locally with an architecture-realistic containerized runtime.
5. Milestone E: Phase 10 complete. Result: run lifecycle and benchmark finalization semantics are complete.
6. Milestone F: Phase 11 complete. Result: hosted deployment and infrastructure tuning story is complete.
7. Milestone G: Phase 12 complete. Result: optional Node-versus-Go comparison is available.
