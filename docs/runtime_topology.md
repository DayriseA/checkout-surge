# Runtime Topology - Decisions & Rationale

This document defines the delivered local reference runtime topology, the Dev Container and GitHub Codespaces expectations, and the boundary between the local runtime and hosted deployment packaging.

The goal is to make the architecture-realistic topology easy to run locally without turning every development workspace startup into a full demo environment.

The reference runtime uses Linux containers. Windows contributors run it through Docker Desktop or through Docker-in-Docker inside the Dev Container; see the [support boundary](scope_and_caveats.md#intentional-non-goals).

---

## Confirmed Decisions

| Decision Area | Choice | Rationale |
| :-- | :-- | :-- |
| Reference local topology | API, worker, mock ERP, web, load orchestrator, PostgreSQL, and Redis run as separate services | The local reference runtime demonstrates the service boundaries described by the architecture. |
| Application instance contract | Run one API process as the sole maintenance authority, one worker runtime, one Next.js web process, and one load-orchestrator process with one journal | The supported local topology has one application authority for each responsibility; it does not claim generic production scalability. |
| Dashboard ingress | Keep one Caddy dashboard-proxy/dashboard-edge path in front of the API SSE route and the web application | Caddy is a routing boundary, not another web application process or application authority. |
| Load orchestrator runtime | The load-orchestrator container owns the k6 binary | k6 is part of the load-generation service runtime, not a host-machine prerequisite for the reference path. |
| Load-generator network namespace | Widen only the load-orchestrator ephemeral port range to `10240 65535` and set `tcp_tw_reuse=1` by default | Repeated 10k cold-connection runs need generator port headroom and outbound TIME_WAIT reuse without changing the API namespace or hiding server-side connection-establishment pressure. |
| Root compose ownership | The root compose topology is the stable full local reference/demo runtime | `docker compose up` and `pnpm runtime:up` represent the complete local system, not only shared infrastructure. |
| Dev Container compose ownership | The `.devcontainer` compose layer extends the root topology under a separate branch-specific Dev Container project for the editor workspace | The editor container lifecycle must not be coupled to `pnpm runtime:up` / `pnpm runtime:down`, which own the reference runtime project. |
| Dev Container Docker strategy | Dev Container and GitHub Codespaces use Docker-in-Docker | The seed workspace provides this controlled environment, works naturally in Codespaces, and isolates compose state from host Docker state. |
| Dev Container startup | Dev Container and Codespaces startup should not automatically start the full application topology | Developers should explicitly choose test infrastructure, infra-only services, or the full runtime depending on their current loop. |
| Host-native workflow | Keep `pnpm dev:*` commands as a focused development convenience | Host-native app processes are useful for fast edits, but they are not the reference proof of service separation. |
| Infra-only workflow | Preserve an explicit infra-only command that targets PostgreSQL and Redis | Developers often need only data services for host-native app work or focused debugging. |
| Test workflow | Keep isolated test infrastructure separate through `docker-compose.test.yml` | Automated tests should not depend on normal development or demo state. |
| Environment defaults | `.env.example` remains host-native | Host-native defaults should keep working for `pnpm dev:*`. |
| Compose internal URLs | Compose supplies container-network URL overrides for service-to-service calls | Containers should use Compose DNS names such as `postgres`, `redis`, `api`, `mock-erp`, and `load-orchestrator`. |
| Browser-facing dashboard URL | The containerized reference runtime uses the single-origin proxy on port `8080` | Public demo, live watch, admin controls, HTTP reads, and the public SSE stream at `/dashboard/events` should share one public origin; direct service ports are debug surfaces. |
| Runtime setup | Runtime startup should not hide database mutations | `runtime:up` starts containers; an explicit setup command runs migrations and demo seed data. |
| Routine runtime verification | `runtime:smoke` includes service readiness, dashboard reachability/recovery/SSE, one bounded load, terminal evidence, and exact cleanup | One routine command should prove the local reference runtime at its public and business boundaries. |
| Hosted deployment boundary | Hosted deployment assets must coexist with the local topology | Production images or platform configs should be added separately or via separate Dockerfile targets, not by replacing local Dev Container/Codespaces behavior. |
| Production image boundary | Each application and DB setup service has an independently buildable Node 22 Bookworm-slim production artifact and runs as the image's non-root `node` user | Runtime images contain only the selected deploy/standalone closure; build tools and unrelated workspace output stay in builder images. |
| Operational tooling boundary | Repository operational scripts use a profile-gated `runtime-tools` service when API is running and host-local Node otherwise | Production API packaging does not carry repository scripts or development dependencies, and normal `runtime:up` does not start tooling. |

---

## Reference Local Topology

The full local reference runtime includes exactly one of each application runtime:

- one `apps/web` Next.js process with public demo, live watch, admin console, and run history routes
- one `apps/api` process that owns the API gateway, SSE fan-out, API maintenance workflows, and the sole deadline-bounded per-sale pending-persistence recovery scheduler plus its bounded exact-replay admission for run scopes
- one `apps/worker` runtime for order-processing and notification workers plus autonomous dispatch, ERP-result, and notification recovery scanners; its per-run order admission and protection state are process-local, beneath the order-process queue's native rate limit and global concurrency, which the API configures from the accepted run snapshot's declared ERP capacity
- `apps/mock-erp` simulated downstream ERP
- one `apps/load-orchestrator` process with one file journal, one bounded k6 child-process supervisor, one completion-delivery coordinator, and a metric streamer
- PostgreSQL
- Redis
- one Caddy `dashboard-proxy`/`dashboard-edge` ingress path

The application runtimes remain separate containers. Caddy only routes the single dashboard origin: it is not an additional web application process, a maintenance owner, or a second application authority. The load orchestrator is part of the demonstrated system and runs in its own container with k6 installed inside that runtime image.

Compose sets `net.ipv4.ip_local_port_range` and `net.ipv4.tcp_tw_reuse` only in the load-orchestrator network namespace, defaulting through `LOAD_ORCHESTRATOR_PORT_RANGE` and `LOAD_ORCHESTRATOR_TCP_TW_REUSE` to `10240 65535` and `1`. The lower range bound stays above the service's listener on port 4200. The API and every other service retain their own values. A tightly back-to-back measured `surge-10k` pair left 19,960 sockets in TIME_WAIT, 70.7% of the original 28,232-port range, which justifies outbound reuse on the generator; the setting is not used to tune away k6 `blocked` or `connecting` signals. Platforms that reject container sysctls can use `docker-compose.no-sysctls.yml`; its `!reset` entries for both affected services were verified with Docker Compose v2.40.3. Such rejection happens at container startup, so changing the environment values cannot provide the escape hatch. See [Reference Runtime Measurements](reference_runtime_measurements.md#reference-runtime-network-namespace).

Its one-execution journal is mounted on the named `checkout-surge-load-orchestrator-data` volume. Container restarts therefore preserve the strict current states `accepted`, `executing`, `completion_pending`, and `completed`, including the one immutable report retained until API acknowledgement. Journal reads validate that current shape directly and identify the mounted journal path when malformed. `runtime:wipe` removes that volume together with the database and Redis volumes, which is the supported response to an incompatible pre-release journal.

Within that single orchestrator process, the child supervisor alone owns k6 identity, stdout/stderr, close/error observation, exact-run stop, bounded escalation, reap confirmation, and work-directory cleanup. Its execution lifecycle is separate from the durable journal and API completion-delivery state. The completion-delivery coordinator alone persists a produced report as `completion_pending`, serializes normal and startup delivery, and requests `completed` only after a matching acknowledgement. The execution store serializes both report publication and that conditional acknowledged transition with all other local journal mutations, so a concurrent conflicting report or changed slot wins visibly instead of being overwritten. The supervisor removes a natural or preparation-failure work directory only after persistence succeeds. If that first persistence call fails, there is no memory fallback, API send, or work-directory cleanup, even when the atomic rename installed the report before a later directory-open/fsync error. A subsequent restart may therefore read either the prior `accepted`/`executing` fence and emit the generic interrupted-orchestrator failure, or the already-materialized canonical `completion_pending` report and deliver it. Startup does not reconstruct or clean the retained work directory in either outcome. `COMPLETION_DELIVERY_RETRY_INTERVAL_MS` is one fixed bounded retry interval, defaults to 5,000 ms, and is capped at 60,000 ms; each HTTP attempt retains its separate five-second deadline. `K6_CANCELLATION_TIMEOUT_MS` bounds accepted cancellation through observed child exit, defaults to 10,000 ms, and is validated at no more than 15,000 ms so it remains mechanically below the API's 20-second abort request deadline. A shutdown-initiated interruption of an executing run persists a `failed` `load_orchestrator_shutdown_before_k6_completion` report as `completion_pending`, then waits for supervisor disposition and one bounded delivery attempt. Operator abort still releases the journal without a report, and ordinary abort acknowledgement does not join that delivery attempt. For an already-natural exit, disposition follows durable completion publication and shutdown joins the coordinator's existing bounded API attempt.

This single-instance layout is the supported local contract, not a claim that the services are generically horizontally scalable. Compose's general `--scale` capability is not disabled, but scaled application services are outside this repository's accepted topology and verification. Worker admission intentionally coordinates only within this one process and makes no cross-process fairness or concurrency guarantee. The order-process queue's declared-capacity rate limit and global concurrency live in shared Redis queue metadata, so extra worker processes would still draw from that same queue quota; what would not be coordinated between them is the worker's own protection layer, whose per-scope and worker-wide in-flight ceilings, latency windows and outage probes are per process. The worker's recovery claim leases protect durable order recovery; PostgreSQL advisory locks protect explicit single-writer and terminal/publication fences. Neither mechanism advertises replica scaling, and no separate replica-coordination or edge-attestation mode remains.

---

## Workflow Taxonomy

### Full Reference Runtime

Use this for demos, manual end-to-end verification, and dashboard-triggered load runs.

Expected command contract:

- `pnpm runtime:up` starts the full containerized topology.
- `pnpm runtime:down` stops the full containerized topology and preserves its named volumes.
- `pnpm runtime:setup` applies the single reviewed database baseline and seeds the demo product, durable presets and the intrinsically validated mutable public runtime policy on first bootstrap. API-owned `DEMO_MAX_*` ceilings are not setup inputs and are not persisted. The running API combines the mutable row with its current deployment caps, validates the effective policy before listening, and uses it for responses and run enforcement. Rerunning setup is a semantic no-op for valid current policies and preserves admin edits. An incompatible pre-release shape requires the [intentional wipe-and-rebuild workflow](local_development.md#intentional-pre-release-wipe-and-rebuild), not legacy-data hydration.
- `pnpm runtime:smoke` verifies the already-started and seeded runtime, including backend service readiness, the dashboard, one bounded load, and exact cleanup.

`runtime:up` does not run migrations or seed demo data.

The reference containers run with `NODE_ENV=production`. Before startup, `.env` must provide private values for the control token, admin passphrase/session secret, and public visitor-cookie secret described in `docs/local_development.md`; blank example values intentionally fail startup validation.

### Host-Native Convenience Runtime

Use this for focused development when running app processes directly with `pnpm dev:*`.

Expected command contract:

- `pnpm infra:up` starts only PostgreSQL and Redis with loopback-only host bindings from `docker-compose.dev.yml`.
- `pnpm runtime:up` publishes only the dashboard proxy on port 8080. Use `pnpm runtime:up:debug` when host-native checks need direct service ports; its bindings are explicit and loopback-only.
- `pnpm infra:down` stops the infra-only services as documented.
- `pnpm dev:api`, `pnpm dev:worker`, `pnpm dev:mock-erp`, `pnpm dev:load-orchestrator`, and `pnpm dev:dashboard` are provided for focused service work.

This path is convenient, but it is not the reference proof that the application services are separated.

### Automated Test Infrastructure

Use this for test loops.

Expected command contract:

- `pnpm test:infra:up` starts isolated PostgreSQL and Redis from `docker-compose.test.yml`. Per-package test databases are created and rebuilt from migrations on demand by the tests themselves.
- `pnpm test:db:migrate` destructively rebuilds only the approved `@checkout-surge/db` package-isolated test database from the reviewed baseline (verification aid, not a test prerequisite).
- `pnpm test:infra:down` stops and removes isolated test infrastructure.

Tests should continue to avoid normal development and demo state.

---

## Compose File Ownership

The root compose file describes the reusable local service topology. It is the reference path for demos and local runtime verification.

Dev Container and GitHub Codespaces-specific compose configuration belongs under `.devcontainer` when it only exists for the development environment. Examples include:

- workspace bind mounts,
- dependency-volume isolation,
- Docker-in-Docker compatibility details,
- editor-friendly startup behavior,
- development-only command overrides.

The root, Dev Container, and test Compose files use branch-specific default project names so separate Git worktrees do not share project runtime containers, networks, or persistent PostgreSQL/Redis state by accident. On this branch the defaults are:

- root runtime: `checkout-surge-gpt-55`, override with `COMPOSE_PROJECT_NAME`
- Dev Container: `checkout-surge-gpt-55-devcontainer`, override with `DEVCONTAINER_COMPOSE_PROJECT_NAME`
- test infrastructure: `checkout-surge-gpt-55-test`, override with `TEST_COMPOSE_PROJECT_NAME`

The Dev Container compose override extends shared service definitions for bind mounts, dev-mode commands, forwarded ports, and dependency-volume isolation. It keeps its own Compose project name so the editor workspace container attaches to the Dev Container project network, not the reference runtime network.

Follow the Dev Containers and Docker Compose base-plus-override convention: use shared compose files for common topology, and layer development-environment-specific overrides where the Dev Container configuration lives.

The dependency cache volumes used by the Dev Container are Compose-scoped so branch worktrees can carry different dependency graphs without sharing installed packages. The Codex, Claude, and Kilo Code config/state volumes intentionally keep explicit global volume names so developer-tool identity/config remains shared across worktrees.

---

## Dev Container and Codespaces Expectations

Dev Container and GitHub Codespaces use Docker-in-Docker as the reference Docker access strategy.

Startup should prepare the workspace and verify Docker availability, but it should not automatically start the full application topology. A developer opening a Codespace may only want to edit docs, run unit tests, or start isolated test infrastructure. Full runtime startup should be an explicit opt-in.

The Dev Container and Codespaces path must preserve dependency isolation:

- Linux `node_modules` should not be written into host-native dependency folders.
- pnpm store data should remain in the configured container volume.
- generated container artifacts should not conflict with host-native installs.

The dashboard proxy port is the normal launch target. API, mock ERP, load orchestrator, direct web, worker health, PostgreSQL, Redis, test PostgreSQL, and test Redis ports remain forwarded for local verification and debugging.

---

## Environment Rules

`.env.example` remains optimized for host-native development:

- `DATABASE_URL` points at `localhost:5432`.
- `REDIS_URL` points at `localhost:6379`.
- server-side service URLs point at localhost ports.
- `WEB_ORIGIN` points at the host-native dashboard origin by default.

The containerized runtime should override internal service-to-service URLs in compose:

- PostgreSQL should use the `postgres` service name.
- Redis should use the `redis` service name.
- API, mock ERP, and load orchestrator service-to-service calls should use their Compose service names.
- API realtime CORS should allow the dashboard proxy origin, `http://localhost:8080`.

Browser-facing dashboard traffic should not depend on `NEXT_PUBLIC_*` backend service URLs. The browser uses the public dashboard origin. `apps/web` uses server-side `API_BASE_URL`; `apps/api` uses server-side `LOAD_ORCHESTRATOR_BASE_URL` for accepted traffic execution.

The browser EventSource endpoint is invariant at same-origin `/dashboard/events`. Caddy routes that exact path directly to `apps/api` in the reference topology. When `apps/web` is used directly without Caddy, its Next.js streaming route proxies the same path to the server-only `API_BASE_URL`; browser-readable backend overrides are neither required nor supported.

---

## Health and Readiness

`pnpm runtime:smoke` represents routine full local demo readiness and behavior.

It should verify:

- API readiness,
- worker readiness,
- mock ERP readiness,
- load orchestrator readiness,
- load orchestrator k6 executable readiness,
- dashboard reachability.

PostgreSQL and Redis may be verified through compose healthchecks and through dependent service readiness.

API readiness is single-flight per API process: concurrent callers share one active operation, and the next request starts a fresh operation only after the active one settles. Each operation starts its PostgreSQL, Redis, and BullMQ checks concurrently and applies one `API_READINESS_TIMEOUT_MS` deadline, 2000ms by default. A dependency that rejects or misses that deadline produces a stable dependency-specific unavailable check without exposing connection URLs, credentials, or driver errors, and the route returns HTTP 503 within the Compose healthcheck's 3-second budget. PostgreSQL statements are cancelled whether active or still queued for a pool checkout; readiness-owned Redis and BullMQ connections are disconnected before a timed-out result settles. API shutdown aborts and drains the same readiness owner before Fastify drains requests, so probe resources cannot outlive the process lifecycle. Readiness therefore contributes at most one transient PostgreSQL connection per API process.

Mock ERP liveness remains a cheap process/listener check. Its readiness response reports `confirmation_endpoint_ready` as a static listener assertion: it does not probe PostgreSQL and has no separate readiness timeout. The service does own a PostgreSQL terminal confirmation ledger, so Compose waits for PostgreSQL before creating it. Because that ledger is durable, successful confirmation replay and `GET /confirmations/:idempotencyKey` survive a Mock ERP restart; the worker's durable `erp_attempts` and dispatch-call records are separate evidence and do not by themselves prove an external effect.

For initial container creation, Mock ERP waits for PostgreSQL (its confirmation ledger) and starts independently of Redis, while Compose waits for Mock ERP readiness before creating the worker. Compose also waits for API, Mock ERP, and load orchestrator to be healthy before creating the web service, then waits for API and web to be healthy before creating the dashboard proxy. The direct API-to-proxy gate is retained because Caddy routes dashboard SSE traffic to API rather than through web. These gates prevent the worker and browser origin from becoming reachable before their initial dependencies are ready; they do not make Compose stop, restart, or recreate already-running services when a dependency becomes unhealthy later. The web healthcheck calls the cheap web-owned `/health` route directly on port 3000, while the proxy healthcheck calls the same route through Caddy on port 8080. This verifies the intended direct-web and proxy-to-web paths without rendering `/`, reading product data, or calling dashboard recovery. These healthchecks establish reachability, not continuous aggregate backend or SSE readiness.

---

## Containerized Load-Run Validation

The reference runtime should validate load execution through the dashboard path, not only by calling the load orchestrator directly. The dashboard is the operator control surface, and its server-side proxy is responsible for attaching trusted control headers to load-run requests.

The expected smoke workflow is:

1. Start the full runtime with `pnpm runtime:up`.
2. Seed the demo baseline with `pnpm runtime:setup`.
3. Open or call the dashboard through the proxy at `http://localhost:8080`; use `/demo` for public starts and `/admin` for operator controls.
4. Start a public preset or an editable admin preset through the dashboard. The normal start path calls the same-origin dashboard control route, starts an API-owned demo run from the accepted preset snapshot, and moves browser observation to `/watch`.
5. Confirm `GET http://localhost:8080/api/dashboard/recovery` shows the API-owned demo run moving through `starting`, `active`, and `draining` after traffic completion. The load orchestrator's local traffic execution ends as `succeeded` or `failed`; this recovery read is the browser source of truth after reconnects.

Public dashboard capacity is protected at the sole API boundary. SSE connection caps are process-local (80 total and 6 per normalized network source by default). One process-local recovery admission boundary allows three concurrent builds by default and applies global and per-visitor fixed-window request budgets of 60 and 12 per 60 seconds. It stores counts only for admitted sources, bounding its source map by the global budget, and clears the map when the window advances. Admission and projection assembly share one `DASHBOARD_RECOVERY_TIMEOUT_MS` end-to-end deadline, 5000ms by default. Deadline expiry returns HTTP 503 with `dashboard_recovery_unavailable` and `details.reason = timed_out`; local concurrent-capacity exhaustion uses the same code with `at_capacity`, while fixed-window budget exhaustion returns HTTP 429 `dashboard_recovery_rate_limited`. A caller disconnect aborts the work without attempting a response. Both paths release an acquired permit exactly once. A dashboard-recovery runtime factory owns the short-lived PostgreSQL pool, Redis client, BullMQ inspector, abort wiring, and idempotent aggregate cleanup; PostgreSQL cancellation removes queued statements or cancels active statements and terminates the pool, while Redis and BullMQ disconnect, so abandoned reads do not continue consuming control-plane capacity. Individual ordinary aggregate failures retain the existing contract-valid degraded fields, but revision allocation has no process-local fallback. `DashboardProjectionService` serializes coherent builds in the accepted one-API topology and then allocates the projection's scoped revision with Redis `INCR`; generated-run cleanup removes its `demo-run:<runId>:dashboard-projection-revision` key, while the single global idle counter remains. The Next recovery proxy forwards only the existing server-issued HMAC visitor credential; direct API debugging falls back to the proxy-aware network source. Compose pins Caddy to `172.30.0.2` on an internal edge network and routes SSE to the API's `api-dashboard-edge` alias on that network; `API_TRUSTED_PROXY_CIDRS` trusts that exact Caddy address plus host-native loopback only, so unrelated private-network/direct callers cannot forge `X-Forwarded-For`.
6. Confirm the recovery response includes recent k6 metric samples and the resulting inventory, queue, ERP, and run-outcome changes. After business-boundary finalization settles, terminal benchmark summaries appear in Run History.

For operator recovery, `pnpm runtime:reset` calls the protected API reset with a correlation ID. API success means exact-run traffic termination and bounded queue cleanup completed, one immutable failed summary exists, and internal PostgreSQL and Redis state was discarded while history identity and the closed offer remain.

The seeded public presets are `preview-1k`, `surge-5k`, `surge-10k`, `slow-erp-5k`, `laggy-erp-5k`, `idempotency-check-200`, and `public-custom`. The surge presets are sized for public burst demonstrations: `preview-1k`, `surge-5k`, and `surge-10k` use buyer-spike traffic and each create a generated run sale offer with isolated inventory. Routine validation uses only one deterministic, zero-chaos `public-custom` scenario: an admin-authorized burst of 32 simultaneous buyers against stock 32. Admin authorization avoids consuming visitor/global public start budgets during repeat maintenance runs. `pnpm runtime:smoke` first calls the protected API demo-reset endpoint; that call can terminalize an existing recoverable run and clear its live projection, and the operational reset client uses the same API-owned endpoint. The smoke establishes same-origin SSE first, starts the burst, requires a run-scoped nonterminal and completed projection plus a contract-valid timestamped heartbeat, waits for the immutable completed Run History summary, asserts exact transport delivery, 32 confirmed orders, 32 notifications, zero asynchronous blockers, and the Redis-backed stock drain, then performs protected exact-run teardown. If the start response is lost after acceptance, only a coherent projection with the smoke's unique correlation lineage can recover the exact run/sale identity for cleanup; a foreign or absent identity never authorizes reset or teardown. The teardown removes only that generated run's durable graph, Redis namespaces, and attributed BullMQ jobs.

Local laptop, Dev Container, and Codespaces runs are not hosted benchmark runs. They share CPU, memory, and Docker daemon capacity with the development workspace. If the environment is constrained, lower admin preset `buyerCount` for buyer-spike checks or `ratePerSecond` for constant-arrival checks, lengthen constant-arrival `durationSeconds` when useful, and treat dashboard behavior, queue pressure, and k6 metric streaming as the local verification target. Lower local validation parameters are a developer-workstation compromise, not a change to the public demo target. Hosted benchmark isolation, horizontal scaling, reverse-proxy settings, and infrastructure tuning belong to hosted deployment.

Natural k6 completion persists a once-per-second, scalar-only `generatorUtilisation` observation in the load-run diagnostics. Use its quota-normalized CPU percentages, swap peak, and memory-pressure counters to identify generator saturation on the actual host; compare a benchmark run with an independent `docker stats load-orchestrator` observation when validating the sampler itself.

This evidence limitation is listed in [Scope and Caveats](scope_and_caveats.md#current-caveats); this section remains authoritative for the local validation workflow.

Public, watch, and admin server rendering intentionally does not call dashboard recovery. It bootstraps authoritative run availability as pending, and the mounted browser converges through the same-origin `/api/dashboard/recovery` BFF. That BFF mints or reuses the HttpOnly signed visitor cookie and forwards only the verified credential, so separate visitors receive separate API per-source budget identities rather than sharing the web container's network identity. Caller-supplied visitor headers are ignored.

The live watch page uses the API-owned SSE stream at `/dashboard/events` for best-effort complete dashboard projections. This complete schema and its scoped revision are the only browser realtime protocol and are also returned by HTTP recovery. The initial stream open, first disconnect error in an outage, and later reconnect open each request one API-owned current projection through the shared single-flight path; repeated native errors during the same disconnected period do not create more reads. When a run/offer scope is known, the request includes both IDs so one read can discover a current newer run or recover the exact missed terminal. Live and HTTP candidates use the same atomic comparison rules, so a racing response is never buffered or replayed. Public and admin use the same recovery controller without subscribing to additional streams. Watch keeps its last successful complete projection visible after a transient refresh failure and labels the transport problem as last-known-good; initial Watch recovery and public/admin recovery remain unavailable without claiming a last-known-good view, and public/admin Start stays blocked without current authoritative state. Automatic failures use delays of 1, 2, 4, 8, 16, then 30 seconds, never retry sooner than a valid delta-seconds `Retry-After`, and stop after six automatic attempts until the visible manual retry action resets that browser-local budget. While the stream remains disconnected, a successful recovery that returns a nonterminal projection schedules the next authoritative read after a fixed 2-second delay, so an outage cannot strand a stale nonterminal view; this disconnected reconciliation stops on terminal convergence, stream reopen, or page unmount, and successful reads reset the failure backoff so only consecutive failed recoveries exhaust it. There is no active-run polling loop while realtime is healthy, and no incremental reducer, replay, or per-order stream; bounded live publication, immediate lifecycle/terminal publication, and connection-triggered repair provide convergence. The watch route is current-run focused; arbitrary completed-run detail remains owned by Run History. The live stream and recovery read remain public demo observability surfaces; admin sign-in gates privileged controls only. Run History is HTTP-only and does not subscribe to the live stream.

The Dev Container compose configuration can be validated with Docker Compose config checks. A full Dev Container or Codespaces rebuild is required to prove editor startup, port forwarding, Docker-in-Docker initialization, and named dependency volumes after `.devcontainer` changes.

---

## Runtime Verification Checklist

Use this checklist when implementing or changing the local runtime topology:

- After the root runtime compose file exists, validate the root topology with `docker compose config`.
- Validate the test topology with `docker compose -f docker-compose.test.yml config`.
- Validate the Dev Container merged topology with `docker compose -f docker-compose.yml -f docker-compose.dev.yml -f .devcontainer/docker-compose.yml config`. Confirm the merged project name defaults to `checkout-surge-gpt-55-devcontainer` unless `DEVCONTAINER_COMPOSE_PROJECT_NAME` is set, and confirm the direct development bindings remain loopback-only.
- Start services with `pnpm runtime:up`.
- Apply migrations and seed demo data with `pnpm runtime:setup`.
- Run `pnpm runtime:smoke` for routine verification. It checks each service's required readiness entries (including the load orchestrator's k6 executable), dashboard health/page/recovery through the public origin, complete same-origin SSE connection and heartbeat control frames, one bounded 32-buyer load, nonterminal and completed run projections, terminal Run History business/inventory/notification evidence, and exact generated-run cleanup. HTTP requests are bounded at 10 seconds; SSE connection, heartbeat, and close waits are 5, 20, and 5 seconds. One absolute run-evidence deadline is shared by the start/lifecycle, terminal Run History, and completed-projection stages and defaults to 330 seconds under the default 5-second traffic, 300-second drain, and 5-second finalization cadence. `RUNTIME_SMOKE_RUN_TIMEOUT_MS` is the positive override forwarded to runtime-tools. Ambiguous start identity recovery has a separate 5-second correlated-SSE bound, and exact cleanup has one fresh 30-second absolute budget. Failures identify the named stage and endpoint or run.
- On an idle runtime, run `pnpm runtime:soak:recovery` for the dedicated recovery regression. It probes direct web and proxy-to-web `/health` every five seconds for 125 seconds by default (more than two 60-second recovery budget windows), verifies `/demo` remains reachable, then requires two fresh BFF sessions to receive distinct signed visitor cookies and authoritative idle recovery. Runtime-tools forwards `DASHBOARD_RECOVERY_WINDOW_SECONDS`, `RUNTIME_RECOVERY_SOAK_SECONDS`, and `RUNTIME_RECOVERY_SOAK_PROBE_INTERVAL_MS`; the command fails before probing unless the selected soak is strictly longer than two deployed windows. This fetch-only live soak proves health-path stability, public HTTP reachability, BFF identity separation, and idle API recovery. Static Compose plus health-route tests prove the configured probes cannot call dashboard recovery, while the deterministic `PublicDemoEntry` component test proves an unavailable/429 bootstrap converges to enabled Start controls after hydration without a reload. This opt-in multi-minute check is intentionally outside ordinary unit lanes.
- For manual old-run cleanup, run `pnpm maintenance:cleanup-runs`. Selection applies by default only to terminal generated runs whose `demo_runs.created_at` is at least seven days old and whose run row, generated sale context, and generated sale offer agree. The latest 15 runs across the full run population, active runs, and ownership-inconsistent rows remain intact. Each candidate uses the strict exact teardown: queue and Redis cleanup complete before transactional durable deletion, and a failure stops selection with the candidate's durable retry identity intact. Use `-- --older-than-days <days>` and/or `-- --keep-latest <count>` to override the defaults.
- Rebuild or reopen the Dev Container after `.devcontainer` changes and confirm: Docker readiness is checked on post-start without auto-starting the full runtime, `pnpm install` uses the named dependency volumes, and `pnpm infra:up`, `pnpm test:infra:up`, and `pnpm runtime:up` remain explicit opt-in commands.
- Rebuild or reopen GitHub Codespaces after `.devcontainer` changes and confirm: Docker-in-Docker starts, required dashboard/API/mock ERP/load-orchestrator/worker health/PostgreSQL/Redis ports are forwarded once those services exist, and `pnpm runtime:smoke` can verify the seeded runtime after `pnpm runtime:up`.

---

## Hosted Deployment Boundary

This document covers the local development and demo topology only; it does not define hosted deployment packaging.

Hosted deployment assets (production images, platform configuration, hosted-style deployment files) must coexist with the local topology. If Dockerfiles are shared between local and hosted paths, use separate build targets or separate deployment configuration instead of removing the local Dev Container/Codespaces path.

---

## External References

These decisions align with the Dev Containers and Docker Compose guidance that development-specific compose configuration can extend a shared compose file:

- VS Code Dev Containers Docker Compose guidance: `https://code.visualstudio.com/docs/devcontainers/create-dev-container`
- GitHub Codespaces Dev Container guidance: `https://docs.github.com/en/codespaces/setting-up-your-project-for-codespaces/adding-a-dev-container-configuration/introduction-to-dev-containers`
- Docker Compose multiple-file merge guidance: `https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/`
