# Phase 1-10 Final Review

Suggested slice scopes to divide the final review and avoid an overwhelming monolithic review.

Use this as a review guide, not as an implementation freeze. Different agents may reasonably shape code, names, and UI details differently; anchor the review on documented product invariants, ownership boundaries, and observable behavior rather than exact internal structure unless a document states it explicitly.

### 1. API Reservation Hot Path

Focus on `apps/api` and the Redis inventory code.

Look for bugs around:

- overselling under concurrent buy requests
- non-atomic stock checks or split Redis operations
- duplicate accepted requests consuming extra stock
- idempotency conflicts being accepted or replayed incorrectly
- sold-out requests accidentally writing per-request PostgreSQL rows
- missing or mismatched `runId` / `saleOfferId` acceptance
- `x-load-run-id` disagreeing with the request body
- successful Redis reservations being lost when PostgreSQL persistence fails
- pending-persistence responses pretending an order exists
- queue jobs published before durable reservation/order state is safe
- final confirmation leaking into the synchronous buy response
- run sale eligibility accepting stale, closed, catalog, or wrong-run generated sale offers
- public one-second spike behavior being weakened by slow losing paths, unnecessary PostgreSQL reads, or listener/backlog configuration drift
- route handlers doing business workflow or infrastructure work directly

Useful tests:

- concurrent no-oversell test
- idempotent replay and idempotency-conflict tests
- sold-out cheap-path test
- Redis-success/PostgreSQL-failure test
- run-attribution mismatch test
- stale or wrong-run sale eligibility tests

### 2. Persistence, Domain State, And Seeds

Focus on `packages/db`, migrations, seed/reset helpers, and persistence adapters.

Look for bugs around:

- missing or weak relationships between products, sale offers, reservations, orders, ERP attempts, order events, demo runs, summaries, and generated run sale offers
- generated run sale offers being reusable across runs
- run-owned rows pointing at the wrong generated sale offer
- confirmed orders without secured reservations
- ERP attempts without complete timing, status, attempt number, or error data
- order events using inconsistent event names or unstructured payloads
- sold-out accounting disappearing before run summary capture
- duplicate final summaries for the same run
- mutable run summaries that should be immutable
- missing durable demo presets, public custom base, admin custom/scratch behavior, or active public runtime policy
- public read-only presets becoming mutable, or editable admin presets mutating public defaults
- documented public preset coverage drifting from the demo contract, especially `preview-1k`, `surge-5k`, `surge-10k`, `idempotency-check-200`, and `public-custom`
- public runtime policy not being persisted, seeded, or validated against deployment hard caps
- seed data that supports only the happy path
- reset helpers that can wipe the wrong database, Redis DB, queues, or historical summaries
- maintenance cleanup deleting active runs, recent run history, or rows outside generated-run ownership
- tests relying on development data instead of isolated test fixtures

Useful tests:

- migration/schema integrity tests
- generated run sale-offer ownership tests
- finalization uniqueness tests
- seed-data sanity tests
- preset/public-runtime-policy tests
- reset safety tests
- maintenance cleanup ownership tests

### 3. Worker, Queue, Mock ERP, And Notifications

Focus on `apps/worker`, `apps/mock-erp`, queue adapters, ERP clients, and notification code.

Look for bugs around:

- the API calling the mock ERP directly
- worker jobs missing `runId`, `saleOfferId`, `orderId`, or `correlationId`
- orders skipping `queued -> processing -> confirmed | failed`
- state transitions not being persisted before side effects
- retries creating duplicate ERP attempts or duplicate confirmations
- exponential backoff not actually backing off
- circuit breaker never opening, never recovering, or hammering the ERP while open
- worker concurrency, timeout, ERP behavior, or backpressure policy ignoring the accepted run snapshot
- run-scoped ERP/backpressure settings being ignored
- global ERP chaos settings leaking between runs unexpectedly
- notification records being created before confirmation
- notification work blocking order processing when it should be background/simulated
- queue health reporting success while workers are not consuming

Useful tests:

- worker state-transition tests
- ERP success/throttle/error/outage tests
- retry and circuit-breaker tests
- duplicate-job handling tests
- notification-after-confirmation tests

### 4. Run Lifecycle, Load Orchestration, And Finalization

Focus on `apps/load-orchestrator`, API run lifecycle services, metric ingestion, recovery state, and summary creation.

Look for bugs around:

- load orchestrator owning business lifecycle instead of only traffic execution
- k6 success being treated as benchmark completion
- traffic metrics being mixed with asynchronous business outcomes
- generated k6 input using unsafe shell interpolation or stale run data
- buy attempts missing generated `runId`, `saleOfferId`, quantity, or idempotency keys
- buyer-spike and steady-arrival traffic modes being translated in a way that changes the accepted snapshot semantics
- starts allowed while a run is `starting`, `active`, or `draining`
- resets allowed while work is still active without recording a terminal run
- finalization happening while orders are queued, processing, retrying, missing notifications, or pending persistence
- duplicate finalization overwriting or duplicating summaries
- startup recovery mishandling stale `starting`, `active`, or `draining` runs
- `trafficEndedAt` and `finalizedAt` being conflated
- traffic delivery quality missing or conflated with terminal run status (`complete`, `warning`, `degraded`, `failed`)
- major traffic under-delivery not becoming an explainable terminal failure after drainable business work settles
- clean sold-out-only runs, including zero-starting-stock demonstrations, being treated as k6 failures when responses were expected
- terminal inventory snapshots missing sold-out aggregates, pending persistence, or Redis source metadata
- duplicate buyer-spike responses inflating unique accepted reservation counts

Useful tests:

- start/overlap prevention tests
- traffic-completion ingestion tests
- finalization wait-condition tests
- startup recovery tests
- duplicate-finalization tests
- traffic-delivery quality tests
- clean all-sold-out traffic tests
- k6 parser/metric adapter tests

### 5. Dashboard, Realtime, Admin, And Run History

Focus on `apps/web`, dashboard API routes, admin/session code, realtime client code, and public-safe DTOs.

Look for bugs around:

- browser code calling internal services directly instead of same-origin routes
- admin-only actions reachable without an admin session and service-token proxy
- public users starting admin presets, unsafe custom runs, ERP outages, resets, queue cleanup, or history deletion
- public custom changes mutating saved presets or future defaults
- public run budgets trusting browser-supplied identity, bypassing visitor/global windows, or failing open
- admin privilege being inferred from browser request bodies instead of a trusted server-side session/proxy boundary
- admin preset save/duplicate/copy-to-custom flows mutating read-only public presets or skipping server-side caps
- service tokens, passphrases, internal URLs, reservation tokens, idempotency keys, or raw private payloads exposed to the browser
- UI disabled states disagreeing with server-side lifecycle rules
- SSE events treated as durable truth instead of hints
- stale live events overwriting fresh recovery snapshots
- reconnect/manual refresh/start/reset flows not recovering from backend truth
- current-run recovery and historical run summaries being mixed together
- run history exposing unsafe detail fields
- run-history deletion missing admin protection, selected/all confirmation behavior, or public-safe refresh behavior
- documented public surfaces missing or blurred together: public picker, live watch, admin console, run history, and static explainer
- completed arbitrary run detail being handled as live/current-run dashboard state instead of run-history state
- dashboard metrics showing optimistic UI state instead of backend-derived state

Useful tests:

- public/admin route authorization tests
- protected proxy tests
- secret-exposure checks
- public custom non-persistence tests
- public run-budget tests using the shared/injected store
- admin preset mutation tests
- recovery/realtime client tests
- public-safe run-history DTO tests
- route-surface smoke tests for public, watch, admin, history, and explainer pages

### 6. Shared Contracts, Logging, And Cross-Service Vocabulary

Focus on `packages/contracts`, `packages/logger`, shared types, schemas, and service boundary payloads.

Look for bugs around:

- local duplicate schemas drifting from shared contracts
- reservation and order terms being used interchangeably
- lifecycle values differing between contracts, database, services, and UI
- dashboard event names or metric names changing by service
- missing `correlationId` in responses, logs, queue jobs, ERP requests, rows, or events
- timestamps without timezone clarity
- error responses without stable machine-readable codes
- API responses not matching schemas used by k6 or the dashboard
- public runtime policy, preset/run-control, traffic-delivery, and run-history DTO schemas drifting from implementation
- health/readiness vocabulary hiding unavailable dependencies, worker loops, or k6 readiness behind generic success
- private test helpers leaking through public package exports

Useful tests:

- contract parse tests
- lifecycle vocabulary tests
- error-shape tests
- correlation propagation tests
- health/readiness shape tests
- preset/policy/run-history DTO parse tests

### 7. Runtime, Configuration, And Operations

Focus on compose files, Dockerfiles, Caddy config, scripts, env examples, health checks, smoke checks, and test infrastructure.

Look for bugs around:

- the reference runtime not actually running services as separate processes
- k6 missing from the load-orchestrator container
- browser traffic bypassing the dashboard proxy model
- `/dashboard/events` routed to the wrong service
- compose services using host URLs where service DNS is required
- the documented public surge target being quietly lowered instead of preserving the `surge-10k` demo contract and documenting local host limits separately
- required runtime caps, secrets, public budget settings, pool sizes, listener backlog, or service URLs missing from env examples/startup validation
- `runtime:up` mutating data unexpectedly
- `runtime:setup` not running migrations or seeds deterministically
- `runtime:reset` deleting history or unrelated generated data
- `maintenance:cleanup-runs` deleting active runs, recent history, or non-generated baseline data
- smoke-load cleanup deleting rows or Redis keys it does not own
- readiness checks passing when critical dependencies or worker loops are down
- missing or invalid startup validation for secrets, caps, and URLs
- root command contracts missing or stale: build, type-check, lint, format, test, infra, runtime, smoke, and service dev commands
- Turborepo/pnpm workspace ordering failing to build shared packages before dependent services
- README/local docs still describing future-tense or host-only behavior after the containerized runtime exists
- integration tests using development PostgreSQL/Redis
- Redis tests using broad destructive commands outside dedicated reset tooling

Useful checks:

- compose config validation
- health check and runtime smoke commands
- test-infrastructure isolation checks
- startup config validation tests
- command-contract checks for root and package scripts
- smoke cleanup ownership tests
- public/runtime docs sanity check

### 8. Test Suite Quality

Focus across all tests.

Look for bugs around:

- high-risk behavior covered only by mocks
- tests asserting implementation details but not business outcomes
- unit tests requiring Docker or network services
- integration tests depending on test order
- API tests using real startup clients instead of injected dependencies
- missing regression tests for bugs found during the review
- concurrency, idempotency, finalization, security, public budget, preset policy, and recovery paths lacking coverage
- tests passing even when the relevant worker, queue, Redis, PostgreSQL, or SSE behavior is disabled
- skipped tests that hide unfinished work
- tests locking onto incidental implementation structure while missing documented product behavior
- k6/load tests being treated as correctness substitutes instead of benchmark artifacts plus focused assertions

Useful checks:

- run the narrow test near each fix
- run broader unit/API/integration suites when practical
- run build/type-check/lint where changes touch shared contracts, runtime scripts, or cross-package APIs
- note skipped runtime checks clearly

## Report Format

Publish one consolidated markdown report. How you organize your working notes is up to you, but the published findings must follow this shape so reports stay comparable across agents and machine-readable by the results tooling on the `ai/results` branch:

- **One `###` heading per finding:** `### F{n} — {Title} ({Severity})`
  - Number findings `F1 … Fn` sequentially in document order. Never skip or reuse a code; codes are permanent once published.
  - `{Severity}` is exactly one of `High`, `Medium`, or `Low`. No hybrid grades (`Low–Medium`), no qualifiers inside the parentheses (`Low / latent`), no priority tiers (`P1`). If a finding sits between two grades, pick the one that matches its real impact and argue the nuance in the body.
- **First line under each heading:** `**Slices:** {n[, m]}` — the review-slice number(s) from this guide the finding belongs to.
- **Body is free-form**, but cover: what happens, evidence as `path:line` references, impact, a suggested fix, and the test gap if one exists.
- **Lower-confidence observations** that don't meet the finding bar go in their own section as `### N{n} — {Title}` entries (same `**Slices:**` line, no severity grade). They are notes, not findings — keep them out of finding totals.
- **Grouping is free** — by severity or by review slice, whichever reads better; the codes and `**Slices:**` lines carry the semantics either way.
- **Recommended:** an index table (`| Code | Finding | Severity | Slices |`) near the top, and a closing `## Appendix — Checked and found sound` section listing areas examined and judged correct, so the absence of a finding is distinguishable from the absence of review.
- **Cross-references** to other findings use their codes (`see F7`), never prose numbering ("Finding 7").

## Final Pass Questions

- Can stock be oversold?
- Can a duplicate request create extra business state?
- Can a secured Redis hold disappear?
- Can a public user trigger unsafe controls?
- Can a run finish before its business work finishes?
- Can the dashboard show stale or optimistic state as truth?
- Can final summaries be duplicated, overwritten, or missing key accounting?
- Can runtime or test commands mutate the wrong environment?
- Can secrets or unsafe internal fields reach the browser?
- Can the documented public demo surfaces and preset/policy controls still support the intended run flow?
- Can public visitors exceed run budgets or mutate shared presets/defaults?
- Can traffic delivery quality explain under-delivery without hiding business invariant failures?
- Can cleanup/reset commands erase history or generated state outside their ownership?
- Are docs and command contracts accurate enough for a reviewer to run the local demo path?
- Are the most important failure paths covered by tests?
