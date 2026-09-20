# Local Development

This guide covers the day-to-day setup for running Checkout-Surge locally. The durable architecture rationale lives in `docs/architecture.md`; this file is the practical reference.

## Prerequisites

- Node.js 22 or newer with Corepack/pnpm 10 or newer
- Docker with Docker Compose (Linux containers)
- Caddy only for the host-native single-origin dashboard proxy workflow
- k6 CLI only for the alternate host-native load-orchestrator workflow

The reference local runtime runs the load orchestrator in its own container with k6 installed inside that image. Host-native load runs still work as a focused development convenience, but that alternate path requires a local k6 binary.

## Environment

Several control surfaces require shared secrets, so create a local environment file from the root template before starting services:

```bash
cp .env.example .env
```

Local `dev`, database migration, and seed commands should load `.env` automatically through `scripts/run-with-env.mjs`, so the setup works from Bash, PowerShell, cmd, Git Bash, and WSL. Real shell environment variables take precedence over file values. Optional `.env.local` files override `.env`, and app-specific `.env` / `.env.local` files can override root values for that service.

When loaded through `scripts/run-with-env.mjs`, environment files follow Node.js dotenv syntax. An unquoted `#` starts a comment, so quote values that contain `#`.

The root `.env.example` contains host-native shared infrastructure URLs and control secrets. Per-app `.env.example` files document service-specific defaults and optional knobs.

The checked-in secret values are intentionally blank. Before `pnpm runtime:up`, set private, distinct values for:

- `CONTROL_SERVICE_TOKEN`
- `ADMIN_DASHBOARD_PASSPHRASE`
- `ADMIN_SESSION_SECRET`
- `PUBLIC_CLIENT_COOKIE_SECRET`

The reference Compose services run with `NODE_ENV=production`; they reject missing/blank and known-placeholder required values. `PUBLIC_CLIENT_COOKIE_SECRET` alone has a general minimum-length rule: at least 16 UTF-8 bytes. It is shared only by the web issuer/verifier and API verifier and must differ from `ADMIN_SESSION_SECRET`. Private, deployment-specific values remain the operator recommendation for every listed secret, but the code does not apply one blanket strength or minimum-length rule to all of them.

## Runtime Modes

Application services and test suites run on Linux. Windows contributors run the containerized runtime through Docker Desktop and use the Dev Container for host-native development and tests. The reference runtime can also run inside the Dev Container's Docker-in-Docker environment; the two Docker engines keep separate images, containers, and volumes.

Checkout-Surge supports three local workflows:

- Containerized reference runtime: run the application services and infrastructure through Docker Compose, with the load orchestrator carrying its own k6 binary and the dashboard exposed through the single-origin proxy on port `8080`. Use this for demos, manual end-to-end checks, and dashboard-triggered load runs.
- Host-native development: run app services with `pnpm dev:*` and shared PostgreSQL/Redis through Docker Compose, from a Linux environment such as the Dev Container. Use this for focused code edits. Host-native load runs require `K6_BINARY` to resolve in that environment.
- Isolated automated test infrastructure: run PostgreSQL and Redis from `docker-compose.test.yml` so tests do not depend on normal demo state.

The containerized and host-native reference workflows each support one API process as the sole maintenance authority, one Next.js web process, one load-orchestrator process with one journal, and one worker runtime. Caddy provides one dashboard ingress path and does not count as another web application process or authority. Do not treat ad hoc `docker compose --scale` usage or duplicate host-native processes as a supported topology.

The normal dashboard network model uses one browser origin. Dashboard pages, HTTP reads, and control calls go to the web app origin. The web app then calls the owning services with server-side URLs:

```text
Browser -> http://localhost:8080/                  -> web
Browser -> http://localhost:8080/api/dashboard/*   -> web
Browser -> http://localhost:8080/api/control/*     -> web
Browser -> http://localhost:8080/dashboard/events  -> API through Caddy

web -> http://api:4000
web -> http://mock-erp:4100
web -> http://load-orchestrator:4200
```

The Caddy proxy owns the local edge route contract for dashboard realtime: `/dashboard/events` is routed directly to the API service, while the rest of the dashboard origin is routed to the web service. Dashboard observability remains public for the demo: `/demo` exposes curated public preset starts, `/watch` observes the current live run, `/run-history` lists terminal summaries, and recovery reads remain public-safe. Editable admin presets, reset, ERP diagnostics, run-history deletion, and other privileged controls live under `/admin` and still require admin sign-in. Accidental duplicate preset copies created through `/admin` can be soft-archived (removed from the active list while historical runs remain intact); public, `public-custom`, `Custom`, and seeded/system presets cannot be archived. The base Compose runtime publishes only the dashboard proxy; direct service ports are available only through the explicit loopback-only development override.

The web client always opens the live stream with same-origin `EventSource("/dashboard/events")`. Caddy routes that exact path directly to the API in the reference and host-native proxy workflows. When the web app is opened directly at `http://localhost:3000`, its Next.js route streams the same path from the private server-side `API_BASE_URL`; no browser-readable backend override or realtime CORS exception is needed.

## Reference Runtime Startup

These commands are the primary local demo path.

Create your local environment file:

```bash
cp .env.example .env
```

Start the full local runtime (only the dashboard proxy is published):

```bash
pnpm runtime:up
```

The reference Compose runtime widens only the load-orchestrator container's ephemeral port range to `10240 65535` and enables outbound TIME_WAIT reuse with `tcp_tw_reuse=1`; `LOAD_ORCHESTRATOR_PORT_RANGE` and `LOAD_ORCHESTRATOR_TCP_TW_REUSE` override those defaults. These are generator-capacity safeguards for repeated cold-connection surges, not changes to the API's backpressure behavior. Container platforms that reject service-level sysctls can use the verified no-sysctls override:

```bash
docker compose -f docker-compose.yml -f docker-compose.no-sysctls.yml up -d
```

The override uses Compose's `!reset` tag to clear both the API and load-orchestrator blocks and was verified with Docker Compose v2.40.3. If another Compose implementation does not support the tag, deploy from a copy of `docker-compose.yml` with the `sysctls:` blocks removed. See [Reference Runtime Measurements](reference_runtime_measurements.md#reference-runtime-network-namespace) for the measurement and portability rationale.

Run migrations and seed the demo product, baseline sale offer, durable demo presets, PostgreSQL records, and Redis inventory:

```bash
pnpm runtime:setup
```

`runtime:setup` uses `docker compose run` and auto-starts PostgreSQL and Redis as dependencies, so it can be run without a prior `runtime:up`. By itself it does not start the API, worker, mock ERP, load orchestrator, or dashboard services.

Setup strictly validates the environment-backed public-policy bootstrap before database mutations and inserts it only when `active` is absent. After applying the baseline, the migration runner also validates any existing active policy with the current shared schema and reports field-level diagnostics for malformed current data. Rerunning setup preserves the existing PostgreSQL policy, including admin edits, and a valid current policy is a semantic no-op. Use the intentional wipe below when the pre-release data shape is incompatible or a new environment bootstrap is intended.

### Intentional pre-release wipe and rebuild

Pre-release reference-runtime data is disposable. When a repository change is incompatible with existing local PostgreSQL, Redis, or load-journal state, confirm that `COMPOSE_PROJECT_NAME` selects the intended Compose project, then use this one rebuild workflow instead of translating the legacy state:

```bash
pnpm runtime:wipe
pnpm runtime:setup
pnpm runtime:up
```

`runtime:wipe` maps to `docker compose down --volumes --remove-orphans`. It stops and removes the selected Compose project's runtime containers and network, removes its orphan containers, and deletes that project's named PostgreSQL, Redis, and load-orchestrator journal volumes. It does not delete another Compose project's volumes or the host-native load-orchestrator journal, whose default path is `.checkout-surge/load-orchestrator`. `runtime:setup` then creates the current database/Redis shape and baseline data (auto-starting its PostgreSQL and Redis dependencies), and `runtime:up` starts the complete reference runtime.

Reset the running demo only when you need explicit admin recovery or a refreshed local baseline:

```bash
pnpm runtime:reset
```

`runtime:reset` executes inside the API container when the Compose runtime is running, so it works without publishing the API port. When no API container is running, it defaults to `http://localhost:4000` for the API and `http://localhost:4100` for Mock ERP. It requires `CONTROL_SERVICE_TOKEN`, generates one correlation ID, calls bodyless `POST /admin/demo/reset` first, and then attempts bodyless `POST /chaos/reset` even if the API call failed. Each complete request and response-body read has a finite positive timeout with a 30-second default, and both requests carry the same token and correlation headers. The CLI removes the exact token from bounded diagnostics and response-correlation output, reports each service outcome, and exits nonzero when either failed, so a partial result can be retried safely. The API-to-load-orchestrator abort uses its own 20-second default complete-response deadline; the orchestrator's `K6_CANCELLATION_TIMEOUT_MS` stop-and-reap bound defaults to 10 seconds and cannot exceed 15 seconds, and the existing 5-second traffic-start deadline is unchanged.

For a starting, active, or draining demo run, the API fences the durable run and Redis admission, confirms exact-run k6 termination, pauses the owned queues and removes only jobs attributed to the selected reset run IDs, writes the failed immutable summary, and clears only that run's recoverable traffic metrics. Other generated runs and catalog/unscoped jobs remain intact. Mock ERP then restores all four global chaos controls to configured startup defaults. It does not clear the terminal confirmation ledger; exact generated-run teardown may remove only that run's rows after unresolved work and interventions are gone, while catalog rows remain. Accepted arrivals in its process-local rolling one-second TPS limiter and already in-flight confirmations are not cancelled or rewritten; each accepted arrival continues to count until it is one second old. Normal public and admin starts create isolated generated sale offers, so reset does not delete historical runs, terminal summaries, catalog inventory, or unrelated Redis state.

Open the dashboard:

```text
http://localhost:8080
```

Use `/` for the project overview and static "how it works" explainer, `/demo` for the public demo picker, `/admin` for operator controls, `/watch` for the active live run after a start, and `/run-history` for finalized summaries. The live watch route follows the active/current run exposed by dashboard recovery; arbitrary completed-run detail remains owned by Run History.

In Dev Containers and GitHub Codespaces, launch the forwarded `8080` `dashboard-proxy` port. API, mock ERP, load-orchestrator, and direct web ports are forwarded as debugging surfaces, not as the normal dashboard URL. In Codespaces, set `WEB_ORIGIN` to the forwarded `8080` dashboard-proxy URL shown by the Ports panel, for example `https://<codespace>-8080.app.github.dev`. The private Codespaces port proxy rewrites its own same-origin `Origin` header to an HTTP(S) localhost tunnel target; when `CODESPACES=true`, the dashboard proxy restores the configured public origin only for an exact localhost tunnel origin accompanied by browser-controlled `Sec-Fetch-Site: same-origin` and `Sec-Fetch-Mode: cors` metadata. Cross-site requests and non-Codespaces runtimes remain subject to the web server's exact-origin check and secure-cookie policy.

Run the routine runtime verification (the command uses Compose-network checks for a running reference runtime and localhost checks for host-native services):

```bash
pnpm runtime:smoke
```

The smoke requires the already-started, seeded runtime and a valid `CONTROL_SERVICE_TOKEN`. It verifies every service's required readiness checks, including the load orchestrator's k6 executable; dashboard health and page reachability; a schema-valid same-origin recovery read; a complete SSE connection control frame and timestamped heartbeat; one nonterminal and one completed projection for the generated run; and the completed business, Redis inventory, and notification evidence for one zero-chaos 32-buyer accepted burst. It then performs protected exact-run teardown.

The smoke is intentionally mutating. Its preflight protected API reset can terminalize an existing recoverable run and clear that run's live projection, but it does not invoke the operational `runtime:reset` client's separate Mock ERP chaos reset. The smoke starts its bounded scenario as an authorized admin operation so routine reruns do not consume public visitor/global start budgets. HTTP requests have 10-second deadlines; SSE connection, heartbeat, and close waits are 5, 20, and 5 seconds. One absolute run-evidence deadline begins immediately before the start request and is shared by nonterminal projection, terminal Run History, and completed-projection waits. It defaults to 330 seconds (`5` seconds traffic + `300` seconds drain + three `5`-second finalization intervals + `10` seconds allowance), and `RUNTIME_SMOKE_RUN_TIMEOUT_MS` can override it positively. If the start response is ambiguous, the already-open stream has 5 seconds to recover only a projection carrying the smoke's unique correlation lineage. Exact cleanup then has its own fresh 30-second absolute budget, including terminality preparation, any exact reset, teardown retries, and retry delays. Every failure names its stage, such as `health/worker`, `sse/terminal_projection`, or `cleanup/delete_exact_run`.

The dedicated idle recovery regression remains a distinct opt-in multi-minute lane:

```bash
pnpm runtime:soak:recovery
```

It must cover more than two configured dashboard-recovery budget windows and requires an idle runtime; it is not part of the routine smoke.

For public limited-inventory surge validation, start the surge presets from the dashboard: `preview-1k`, `surge-5k`, then `surge-10k`. The seeded public preset set also includes `idempotency-check-200` for duplicate-attempt correctness and `public-custom` as the read-only base for bounded run-scoped public custom starts. Each start creates a fresh run sale offer and Redis inventory namespace. The reference runtime keeps the public 10k shape at roughly 10,000 synthetic buy attempts in 1 second. `API_LISTEN_BACKLOG` defaults to `8192` so the API listener can absorb the connection burst after the Redis-first losing path rejects sold-out traffic. If `surge-10k` still reports `connection reset by peer` on a smaller host, treat that as a host/container networking limit to document rather than lowering the public preset.

Stop the full runtime:

```bash
pnpm runtime:down
```

## Compose Project Names

Compose project names default to branch-specific values so separate Git worktrees do not share project runtime containers, networks, PostgreSQL/Redis state, or Dev Container dependency volumes by accident:

- root runtime: `checkout-surge-gpt-55`, override with `COMPOSE_PROJECT_NAME`
- Dev Container: `checkout-surge-gpt-55-devcontainer`, override with `DEVCONTAINER_COMPOSE_PROJECT_NAME`
- test infrastructure: `checkout-surge-gpt-55-test`, override with `TEST_COMPOSE_PROJECT_NAME`

Published ports stay unchanged, so this isolates project state without making parallel full runtimes on multiple branches work automatically. Codex, Claude, and Kilo Code config/state volumes remain intentionally shared across worktrees.

## Dev Container Startup

The Dev Container is an editor workspace with the default Compose project name `checkout-surge-gpt-55-devcontainer`. It extends the root Compose topology for app-service development, while `runServices` starts only the `workspace` service by default. It uses the universal devcontainer image, Docker-in-Docker, intentionally shared Codex/Claude/Kilo Code config and state volumes, and branch-scoped pnpm store and `node_modules` volumes so Linux dependencies stay out of the host-visible workspace and do not leak across worktrees.

Open or rebuild the Dev Container through VS Code. Startup prepares the workspace and checks Docker readiness, but it does not auto-start the full application runtime. The full runtime remains explicit:

```bash
pnpm runtime:up
```

Container creation also installs the latest stable npm releases of Playwright CLI and Playwright MCP, downloads the matching headless Chromium revisions for both tools, and verifies that each interface can control Chromium with the sandbox enabled. Playwright CLI gives any shell-capable coding agent a portable, token-efficient browser interface, while MCP provides richer integration for compatible agent harnesses. These are global agent tools rather than product dependencies, so they do not modify `package.json` or `pnpm-lock.yaml`. Set `CHECKOUT_SURGE_PLAYWRIGHT_CLI_VERSION` or `CHECKOUT_SURGE_PLAYWRIGHT_MCP_VERSION` before container creation only when an upstream regression requires a temporary version override.

The repository-scoped Playwright CLI and MCP browser configurations both use isolated, sandboxed headless Chromium contexts. Browser state is discarded when an isolated session closes. On first setup, post-create initializes an ignored `.codex/config.toml` with Playwright MCP disabled so its tools do not consume context in sessions that do not need browser automation. Existing local Codex configuration is never overwritten. Set `enabled = true` in `.codex/config.toml` and restart Codex when its richer core, visual, and developer-tools capabilities are needed. Playwright CLI remains available without enabling MCP, and developers can otherwise customize or replace their untracked agent configuration freely.

After changes to `.devcontainer` files, rebuild the Dev Container or Codespace to verify editor startup, Docker-in-Docker initialization, forwarded ports, and dependency-volume behavior under the new configuration.

## Host-Native Startup

This workflow runs on Linux. On Windows, use the [Dev Container](#dev-container-startup).

Install dependencies:

```bash
pnpm install
```

Start local infrastructure:

```bash
pnpm infra:up
```

Run database migrations and seed the demo product, baseline sale offer, durable presets, PostgreSQL records, and Redis inventory:

```bash
pnpm --filter @checkout-surge/db db:migrate
pnpm --filter @checkout-surge/db seed
```

Start services in separate terminals:

```bash
pnpm dev:mock-erp
pnpm dev:api
pnpm dev:worker
pnpm dev:load-orchestrator
pnpm dev:dashboard
caddy run --config infra/caddy/Caddyfile.host-native --adapter caddyfile
```

`pnpm dev:load-orchestrator` starts the project-owned wrapper service, then that service invokes the configured `K6_BINARY` when a dashboard or API request starts a load run. In the host-native workflow, `K6_BINARY` defaults to `k6` on the local PATH.

This host-native prerequisite is listed as a current caveat in [Scope and Caveats](scope_and_caveats.md#current-caveats); this section remains authoritative for the setup steps.

Caddy provides the same single-origin edge route used by the compose runtime: the exact `/dashboard/events` path goes to the API on `4000` with immediate streaming, while all other dashboard traffic goes to the web app on `3000`. Run Caddy from the same host or Dev Container network namespace as the app services so it can reach those local ports. When Caddy is bypassed by opening the web app on `3000`, Next.js proxies the same-origin stream through the server-only `API_BASE_URL`.

Open the host-native dashboard through the proxy:

```text
http://localhost:8080
```

## Verifying Your Setup

After the reference runtime or host-native services are running and seeded, run the complete routine verification from the repo root:

```bash
pnpm runtime:smoke
```

The command exits with code `0` only after service readiness, dashboard HTTP/recovery/SSE, bounded load, terminal evidence, and exact cleanup have all passed.

A healthy readiness response has this shape:

```json
{
  "service": "api",
  "status": "ok",
  "timestamp": "2026-04-25T17:45:00.000Z",
  "uptimeSeconds": 12,
  "checks": [
    { "name": "database_reachable", "status": "ok" },
    { "name": "redis_reachable", "status": "ok" },
    { "name": "order_process_queue_reachable", "status": "ok" }
  ]
}
```

Healthy readiness includes these checks:

| Service | Healthy checks |
| :-- | :-- |
| API gateway | `database_reachable=ok`, `redis_reachable=ok`, `order_process_queue_reachable=ok` |
| Worker | `database_reachable=ok`, `redis_reachable=ok`, `order_process_worker_running=ok`, `order_process_queue_reachable=ok`, `notification_record_worker_running=ok`, `notification_record_queue_reachable=ok` |
| Mock ERP | `confirmation_endpoint_ready=ok` |
| Load orchestrator | `api_readiness_reachable=ok`, `k6_binary_executable=ok` |

`status: "degraded"` means the process is reachable but one non-fatal readiness check is not ideal. The load orchestrator directly executes the configured `K6_BINARY` with `version`, including bare PATH commands such as `k6`; spawn failure, non-zero exit, signal exit, timeout, or excessive output makes readiness unavailable. `status: "unavailable"` means a required dependency or worker loop is not ready; the API, worker, and load orchestrator return HTTP 503 for unavailable readiness. Mock ERP readiness reflects only its running confirmation HTTP endpoint and has no dependency probe.

For the host-native infrastructure-only workflow, stop PostgreSQL and Redis when finished:

```bash
pnpm infra:down
```

## Local Ports

| Service | Port | Notes |
| :-- | :-- | :-- |
| Dashboard proxy | `8080` | Normal browser entry point for the containerized and host-native runtimes |
| Web app debug | `3000` | Direct Next.js app port in `apps/web`; `/dashboard/events` is streamed through the web-owned proxy |
| API gateway debug | `4000` | Fastify API and SSE stream owner; use for service health/debugging |
| Mock ERP debug | `4100` | ERP confirmation and chaos-control API; use for service health/debugging |
| Load orchestrator debug | `4200` | k6 scenario and run-control service; use for service health/debugging |
| Worker health | `4300` | Worker process health endpoint |
| PostgreSQL | `5432` | Development database |
| Redis | `6379` | Development Redis |
| Test PostgreSQL | `56432` | Isolated test database |
| Test Redis | `6380` | Isolated test Redis |

## Health Endpoints

| Service | Port | Liveness | Readiness |
| :-- | :-- | :-- | :-- |
| API gateway | `4000` | `http://localhost:4000/health/live` | `http://localhost:4000/health/ready` |
| Worker | `4300` | `http://localhost:4300/health/live` | `http://localhost:4300/health/ready` |
| Mock ERP | `4100` | `http://localhost:4100/health/live` | `http://localhost:4100/health/ready` |
| Load orchestrator | `4200` | `http://localhost:4200/health/live` | `http://localhost:4200/health/ready` |

The worker-facing Mock ERP confirmation contract is `POST http://localhost:4100/confirmations`. Its request and response payloads are defined by `@checkout-surge/contracts`.

## Root Commands

| Command | Description |
| :-- | :-- |
| `pnpm infra:up` | Start development PostgreSQL and Redis with the loopback-only `docker-compose.dev.yml` override |
| `pnpm infra:down` | Stop development PostgreSQL and Redis |
| `pnpm runtime:up` | Build and start the full local reference runtime |
| `pnpm runtime:up:debug` | Build and start the full runtime with loopback-only direct service ports for host-native debugging |
| `pnpm runtime:down` | Stop the full local reference runtime while preserving named-volume PostgreSQL, Redis, and load-orchestrator journal state |
| `pnpm runtime:setup` | Run migrations and seed demo baseline data, durable presets, and Redis inventory inside the compose network |
| `pnpm runtime:wipe` | Stop the selected Compose project and delete its named PostgreSQL, Redis, and load-orchestrator journal volumes plus its orphan containers; it does not delete the host-native journal |
| `pnpm runtime:reset` | Reset the running demo through the API and Mock ERP admin reset endpoints for recovery/local maintenance |
| `pnpm runtime:smoke` | Routine verification of service readiness, dashboard HTTP/recovery/SSE, one zero-chaos 32-buyer accepted burst, terminal business/inventory/notification/projection evidence, and exact generated-run cleanup; its preflight API reset may terminalize an existing recoverable run |
| `pnpm runtime:soak:recovery` | On an idle runtime, probe direct-web and proxy-to-web health for more than two recovery budget windows, verify `/demo` remains reachable, then verify two independently signed BFF recovery identities receive authoritative idle state; deterministic component tests separately prove Start controls become enabled after hydration; intentionally opt-in and multi-minute |
| `pnpm maintenance:cleanup-runs` | Select terminal generated demo runs whose `demo_runs.created_at` is at least seven days old by default, preserving active runs, catalog-backed runs, and the latest 15 runs across the full population; for each selection, perform strict exact queue/Redis cleanup before transactional durable deletion. Override with `-- --older-than-days <days>` and/or `-- --keep-latest <count>` |
| `pnpm dev` | Build shared packages, then run all app `dev` tasks through Turbo |
| `pnpm dev:dashboard` | Build shared packages, then start the Next.js operator dashboard |
| `pnpm dev:api` | Build and start the API gateway |
| `pnpm dev:worker` | Build and start the order-processing worker |
| `pnpm dev:mock-erp` | Build and start the mock ERP service |
| `pnpm dev:load-orchestrator` | Build and start the load orchestrator |
| `pnpm build` | Build all packages and apps through Turbo |
| `pnpm build:shared` | Build shared packages consumed by host-native app dev commands |
| `pnpm type-check` | Run fail-fast production TypeScript checks through Turbo, then strict root test-source compilation |
| `pnpm type-check:test` | Run the focused strict compiler check for test sources and Vitest configs |
| `pnpm lint` | Lint the whole workspace with Biome |
| `pnpm lint:fix` | Apply Biome's safe lint fixes across the workspace |
| `pnpm format` | Format the whole workspace with Biome and organize imports |
| `pnpm format:check` | Check Biome formatting and import organization without writing changes |
| `pnpm test` | Run the default unit, API, and integration test suite |
| `pnpm test:required` | Run the merge-required default suite and the pinned production-image k6 compatibility lane |
| `pnpm test:k6-compat` | Build `load-orchestrator-runtime`, inspect both generated script modes with its k6 2.0.0 binary, and parse a real tiny summary export |
| `pnpm test:composition` | Build and test the isolated deployed service topology; slow and opt-in |
| `pnpm test:characterization` | Run focused browser recovery plus the slow, opt-in deployed-topology characterization |
| `pnpm test:unit` | Run unit tests that do not require external infrastructure |
| `pnpm test:integration` | Run integration tests against isolated test PostgreSQL/Redis |
| `pnpm test:api` | Run API/service-boundary tests against isolated test PostgreSQL/Redis |
| `pnpm test:watch` | Start Vitest watch mode using the root unit-test config |
| `pnpm test:coverage` | Run all discovered unit, API, and integration coverage lanes with bounded Turbo concurrency; isolated test PostgreSQL and Redis must already be running |
| `pnpm test:coverage:unit` | Run only the infrastructure-free unit coverage lanes |
| `pnpm test:infra:up` | Start isolated test PostgreSQL and Redis from `docker-compose.test.yml` |
| `pnpm test:infra:down` | Stop isolated test services and remove their volumes |
| `pnpm test:infra:reset` | Remove isolated test volumes, recreate PostgreSQL and Redis, and wait for readiness |
| `pnpm test:db:migrate` | Destructively rebuild only the approved `@checkout-surge/db` package-isolated test database from the reviewed baseline; verification aid, not required before tests |

Useful package commands:

| Command | Description |
| :-- | :-- |
| `pnpm --filter @checkout-surge/db db:migrate` | Apply development database migrations |
| `pnpm --filter @checkout-surge/db seed` | Seed development PostgreSQL and Redis demo state |
| `pnpm --filter api test:api` | Run API package route/service-boundary tests |
| `pnpm --filter worker test:integration` | Run worker integration tests |
| `pnpm --filter mock-erp test:unit` | Run mock ERP unit tests |
| `pnpm --filter load-orchestrator test:focused:service` | Run the focused load orchestrator service tests |
| `pnpm --filter web test:focused:proxy` | Run the focused dashboard proxy and backend-read tests |

## Testing Workflow

The default development suite can be run with:

```bash
pnpm test
```

`pnpm test` intentionally excludes deployed-topology composition coverage so routine development and agent verification remain fast. It also keeps host-native orchestrator unit tests independent of a host k6 install. Merge automation uses `pnpm test:required`, whose dedicated `test:k6-compat` step builds a non-production test target with the same pinned k6 artifact as the production load image and fails rather than skipping when k6 is unavailable or incompatible. The final load image contains no pnpm, test dependencies, or test source. The opt-in `test:composition` command is slow by nature and requires a functioning Docker daemon. It creates a uniquely named Compose project, migrates and seeds isolated PostgreSQL and Redis volumes, starts the deployed API, worker, mock ERP, load orchestrator, web, and dashboard proxy topology, runs `scripts/composition-characterization.mjs`, and removes the project and volumes afterward. Its host ports default to the `53xxx`-`58xxx` range and can be overridden with the `COMPOSITION_*_PORT` environment variables when those ports are occupied.

Run the deployed topology only when its cross-service safety net is specifically needed, or when explicitly requested during agent-assisted work. Both commands use `scripts/composition-characterization.mjs`, which owns the 10,000-buyer scenario; `test:characterization` runs the focused browser recovery suite first:

```bash
pnpm test:composition
pnpm test:characterization
```

Set `COMPOSITION_KEEP_RUNTIME=true` to retain a failed composition project for inspection. The 10k characterization preserves the 10,000-buyer burst and requires the exact 1,000 accepted / 9,000 sold-out result when the host delivers every planned iteration. On constrained hosts it permits k6-dropped iterations but still requires complete request accounting, zero transport failures, zero unexpected application responses, consistent inventory, and every accepted reservation to traverse the worker, ERP, notification, and Run History boundaries.

For infrastructure-backed tests, start the isolated test services first — the package-isolated test databases are created and rebuilt from migrations on demand. Mock ERP integration tests use only this isolated PostgreSQL service and launch disposable entry-point child processes on ephemeral loopback ports to verify restart-safe replay, discarded-response recovery and pre-insert process termination:

```bash
pnpm test:infra:up
pnpm test
```

To verify the migration history against disposable infrastructure, run the command below. It destructively rebuilds only the approved `@checkout-surge/db` package-isolated test database from the checked-in migrations, discarding any data and schema drift in that database. Tests provision their own package-isolated databases, so this remains a focused verification aid rather than a prerequisite.

```bash
pnpm test:db:migrate
```

The checked-in `packages/db/drizzle` directory is part of the database package artifact and is resolved relative to that package in both TypeScript and compiled execution. It contains the reviewed `0000_baseline` plus ordered incremental SQL files, linked snapshots, and journal entries. Drizzle snapshots describe the declarative schema in `schema.ts`; the baseline SQL also retains the reviewed `pgcrypto` extension and single-nonterminal-run expression index. The baseline has no trigger functions or non-internal triggers.

For schema changes, generate one new incremental migration from the current `schema.ts`, review the SQL and linked snapshot/journal entry, and leave earlier migrations unchanged. The migration must apply to populated databases without erasing reference data. Then run the DB unit, migration, integration, and type-check commands.

Run at most one development/runtime `runtime-setup` or migration job at a time for each database; serialize that migration execution. A failed job can be retried after it exits, and already-applied entries remain no-ops. The pinned PostgreSQL migrator applies all pending entries in one transaction, but it does not provide an explicit deployment/advisory lock for competing migration processes. The isolated `test:db:migrate` rebuild is different: `resetTestDatabase` serializes it with the test database's administration-database advisory lock.

If `pnpm test:db:migrate` fails to start with missing or mismatched `@checkout-surge/contracts` exports/types, rebuild the shared contract declarations and db package first. The db package compiles against `packages/contracts/dist`, and the direct test-database rebuild command does not build workspace dependencies for you:

```bash
pnpm --filter @checkout-surge/contracts build
pnpm --filter @checkout-surge/db build
pnpm test:db:migrate
```

Run narrower scopes when needed:

```bash
pnpm test:unit
pnpm test:api
pnpm test:integration
```

Clean the test services and volumes:

```bash
pnpm test:infra:down
```

Integration and API tests are mapped to `TEST_DATABASE_URL` and `TEST_REDIS_URL` by `scripts/run-with-test-env.mjs`.

Web DOM component tests run in the unit-test lane with jsdom and React Testing Library. They do not require Docker, a browser, PostgreSQL, or Redis.

## Production and operational container boundaries

The root Compose application services build independent production images. API, worker, Mock ERP, and load orchestrator execute `node dist/index.js`; web executes the generated Next standalone server; DB setup executes the compiled migration and seed CLIs. These images use Node 22 Bookworm slim, run as the base image's `node` user (UID/GID 1000), and contain neither the full workspace nor development dependencies. The load image owns the pinned k6 2.0.0 binary and pre-owns its journal mount point so a fresh named volume is writable without root.

The Dev Container merge explicitly replaces all five application builds with the root `development-workspace` target before pairing them with `pnpm ... dev` commands. The universal editor image, Docker-in-Docker lifecycle, named dependency volumes, and opt-in application startup remain unchanged.

When API is running, `runtime:reset`, `runtime:smoke`, `runtime:soak:recovery`, and `maintenance:cleanup-runs` invoke the profile-gated `runtime-tools` service on the Compose network. If API is not running they retain their host-local Node fallback. `runtime:up` never starts `runtime-tools` or the profile-gated k6 compatibility service.

The tooling service receives only its internal API, worker, Mock ERP, load-orchestrator, direct-web, dashboard-proxy, and Redis URLs; the control credential used by operational requests; the drain/finalization/run timing overrides consumed by the smoke; and the recovery-budget-window and soak timing overrides consumed by the recovery soak. It does not receive PostgreSQL, admin-session, public-cookie, passphrase, origin, or unrelated application configuration.

## Configuration Reference

Most infrastructure URLs have local defaults, but every run/control service channel requires `CONTROL_SERVICE_TOKEN`, and the dashboard admin session requires `ADMIN_DASHBOARD_PASSPHRASE` and `ADMIN_SESSION_SECRET`. Signing anonymous public visitor cookies requires a dedicated `PUBLIC_CLIENT_COOKIE_SECRET`, kept distinct from `ADMIN_SESSION_SECRET`; the API independently verifies the complete signed credential before trusting public mode or reserving a budget. The visitor cookie is issued for one year, but the signed credential itself has no enforced expiry or secret-rotation support. Runtime services validate environment values on startup and fail fast when required values are missing or malformed.

| Variable | Default / Example | Used by |
| :-- | :-- | :-- |
| `NODE_ENV` | `development` host-native; `production` in reference Compose; `test` in test commands | Runtime mode and strict production-only security/storage requirements |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/checkout_surge` | API, worker, Mock ERP, db package |
| `MOCK_ERP_POSTGRES_POOL_MAX` | `5` | Mock ERP ledger PostgreSQL pool maximum |
| `REDIS_URL` | `redis://localhost:6379` | API, worker, db package |
| `CONTROL_SERVICE_TOKEN` | Required; generate a private deployment-specific value | API, web, mock ERP, load orchestrator |
| `ADMIN_DASHBOARD_PASSPHRASE` | Required; generate a private admin passphrase | Web admin session |
| `ADMIN_SESSION_SECRET` | Required; generate a private HMAC secret distinct from `PUBLIC_CLIENT_COOKIE_SECRET` | Web admin session cookies |
| `ADMIN_SESSION_MAX_AGE_SECONDS` | `28800` | Web admin session cookie lifetime |
| `ADMIN_LOGIN_CLIENT_ATTEMPTS` | `5` per window | Web admin login per-client token bucket |
| `ADMIN_LOGIN_GLOBAL_ATTEMPTS` | `20` per window | Web admin login global token bucket |
| `ADMIN_LOGIN_WINDOW_SECONDS` | `60` | Web admin login refill/window duration |
| `PUBLIC_CLIENT_COOKIE_SECRET` | Required; generate a private HMAC secret distinct from `ADMIN_SESSION_SECRET` | Web issuance/verification and API verification of anonymous public visitor credentials |
| `API_BASE_URL` | `http://localhost:4000` | Web, load orchestrator |
| `MOCK_ERP_BASE_URL` | `http://localhost:4100` | Web, worker |
| `LOAD_ORCHESTRATOR_BASE_URL` | `http://localhost:4200` | API traffic-execution gateway |
| `WORKER_HEALTH_BASE_URL` | `http://localhost:4300` | Web/local tooling |
| `WEB_BASE_URL` | `http://localhost:8080` | Routine runtime smoke and recovery-soak dashboard checks |
| `PORT` | service-specific | Web `3000`, API `4000`, mock ERP `4100`, load orchestrator `4200` |
| `HOST` | `0.0.0.0` | API, mock ERP, load orchestrator |
| `HEALTH_HOST` | `0.0.0.0` (falls back to `HOST`) | Worker health server bind address |
| `WEB_ORIGIN` | `http://localhost:8080` | Exact web admin Origin/cookie policy and API realtime/direct-debug CORS allowlist; comma-separated when set. In Codespaces, use the forwarded `8080` dashboard-proxy URL. |
| `RESERVATION_HOLD_MINUTES` | `15` | API reservation flow |
| `IDEMPOTENCY_TTL_SECONDS` | `1800` | API reservation flow |
| `PENDING_PERSISTENCE_RETRY_AFTER_SECONDS` | `30` | Public `Retry-After` hint for an accepted Redis hold awaiting durable persistence; this does not schedule recovery. |
| `PENDING_PERSISTENCE_RECOVERY_WINDOW_SECONDS` | `300` | Maximum time the API's sole pending-persistence recovery owner may retry a secured hold. |
| `PENDING_PERSISTENCE_RECOVERY_MAX_ATTEMPTS` | `6` | Maximum recovery attempts per secured hold. |
| `PENDING_PERSISTENCE_RECOVERY_INITIAL_BACKOFF_MS` / `PENDING_PERSISTENCE_RECOVERY_MAX_BACKOFF_MS` | `1000` / `30000` | Bounded exponential retry backoff. |
| `PENDING_PERSISTENCE_RECOVERY_POLL_INTERVAL_MS` | `1000` | Run-scoped recovery scan cadence; the owner uses a fixed bounded per-sale batch. |
| `PENDING_PERSISTENCE_RECOVERY_DISCOVERY_TIMEOUT_MS` | `2000` | Whole-discovery deadline for the sole recovery scheduler; aborts its operation-owned PostgreSQL scope and bounds discovery Redis commands. |
| `PENDING_PERSISTENCE_RECOVERY_MAX_CONCURRENT_DIRECT_ATTEMPTS` | `3` | Process-local cap for distinct request-replay recovery attempts; overload preserves the pending response and retryability. |
| `ORDER_PROCESS_MAX_ATTEMPTS` | `4` | Retired order-delivery setting retained until the coordinated configuration cleanup; order-process jobs use one BullMQ attempt. |
| `ORDER_PROCESS_BACKOFF_BASE_MS` | `500` | Retired order-delivery setting retained until the coordinated configuration cleanup; durable worker scheduling owns deferral timing. |
| `API_LISTEN_BACKLOG` | `8192` | API listener accept backlog for one-second public spike validation |
| `API_POSTGRES_POOL_MAX` | `10` | Long-lived API application/data-path PostgreSQL pool maximum; control-plane pools described below are separate |
| `API_READINESS_TIMEOUT_MS` | `2000` | End-to-end API readiness deadline in milliseconds; must remain below the Compose healthcheck's 3-second timeout. Readiness is single-flight per API process, can open at most one separate short-lived PostgreSQL connection, and closes its PostgreSQL/Redis/BullMQ probe resources on completion, deadline, or API shutdown. |
| `WORKER_POSTGRES_POOL_MAX` | `10` | Worker PostgreSQL connection pool maximum |
| `HEALTH_PORT` | `4300` | Worker health server |
| `ERP_REQUEST_TIMEOUT_MS` | `2000` | Temporary ERP client fallback until adaptive runtime wiring and configuration cleanup (tasks 09/12) |
| `ERP_CIRCUIT_FAILURE_THRESHOLD` | `5` | Worker catalog/missing-snapshot circuit-breaker fallback and seed default |
| `ERP_CIRCUIT_RESET_TIMEOUT_MS` | `10000` | Worker catalog/missing-snapshot circuit-breaker fallback and seed default |
| `ORDER_PROCESS_CONCURRENCY` | `10` | BullMQ's process-wide order-handler execution ceiling; must be at least the shared accepted-run hard cap of 10. Frozen per-run snapshots independently limit handlers through process-local admission in the single worker runtime. |
| `NOTIFICATION_RECORD_CONCURRENCY` | `5` | Worker notification-record consumer concurrency |
| `NOTIFICATION_RECOVERY_SCAN_INTERVAL_MS` / `NOTIFICATION_RECOVERY_BATCH_SIZE` | `1000` / `100` | Worker scan cadence and batch for confirmed orders missing notification records |
| `ORDER_DISPATCH_SCAN_INTERVAL_MS` / `ORDER_DISPATCH_BATCH_SIZE` | `1000` / `100` | Worker scan cadence and batch for committed queued orders whose immediate enqueue may have been lost |
| `ORDER_DISPATCH_MINIMUM_QUEUED_AGE_MS` | `1000` | Minimum queued age before dispatch recovery reasserts a deterministic job; `0` is allowed |
| `ORDER_RECOVERY_SCAN_INTERVAL_MS` / `ORDER_RECOVERY_BATCH_SIZE` | `1000` / `100` | Worker durable ERP/order-recovery scan cadence and batch |
| `ORDER_RECOVERY_LEASE_MS` | `30000` | Worker recovery claim lease; must cover the adaptive ERP maximum request deadline plus ownership headroom (currently 11000 ms) |
| `ORDER_RECOVERY_MAX_ATTEMPTS` | `100` | Worker recovery-attempt ceiling before escalation |
| `LATENCY_MS` | `0` | Mock ERP global fallback/diagnostic chaos behavior when no run-scoped ERP behavior is supplied |
| `MAX_TPS` | `100` | Mock ERP global fallback/diagnostic chaos behavior |
| `ERROR_RATE` | `0` | Mock ERP global fallback/diagnostic chaos behavior, from `0` to `1` |
| `FORCED_OUTAGE` | `false` | Mock ERP global fallback/diagnostic chaos behavior |
| `ADMIN_MAX_LATENCY_MS` | `5000` | Mock ERP admin chaos cap |
| `ADMIN_MIN_MAX_TPS` | `1` | Mock ERP admin chaos cap |
| `ADMIN_MAX_ERROR_RATE` | `1` | Mock ERP admin chaos cap |
| `ADMIN_ALLOW_FORCED_OUTAGE` | `true` | Mock ERP admin chaos cap |
| `DEMO_MAX_BUYERS` | `100000` | API safety cap for buyer-spike preset buyer count |
| `DEMO_MAX_TOTAL_REQUESTS` | `100000` | API safety cap for total emitted buy attempts |
| `DEMO_MAX_REQUESTS_PER_SECOND` | `10000` | API safety cap for constant-arrival preset request rate |
| `DEMO_MAX_TRAFFIC_DURATION_SECONDS` | `300` | API safety cap for constant-arrival duration and buyer-spike max duration |
| `DEMO_MAX_TRAFFIC_START_DELAY_SECONDS` | `30` | API safety cap for buyer-spike start delay |
| `DEMO_MAX_PRE_ALLOCATED_VUS` | `10000` | API hard cap for resolved constant-arrival preallocated VUs, whether automatic or explicit |
| `DEMO_MAX_VUS` | `10000` | API hard cap for resolved constant-arrival max VUs, whether automatic or explicit |
| `DEMO_RUN_DRAIN_TIMEOUT_SECONDS` | `300` | API timeout while waiting for a demo run to drain before finalization |
| `DEMO_RUN_FINALIZATION_POLL_INTERVAL_SECONDS` | `5` | API polling interval while waiting for demo run finalization |
| `PUBLIC_RUN_BUDGET_WINDOW_SECONDS` | `300` | `runtime-setup` first-seed public run-budget window |
| `PUBLIC_RUN_BUDGET_PER_VISITOR_MAX_STARTS` | `2` | `runtime-setup` first-seed public run-budget per-visitor cap |
| `DASHBOARD_MAX_SSE_CLIENTS` / `DASHBOARD_MAX_SSE_CLIENTS_PER_SOURCE` | `80` / `6` | Realtime connection caps for the single supported API process |
| `DASHBOARD_SSE_MAX_BUFFERED_FRAMES` / `DASHBOARD_SSE_MAX_BUFFERED_BYTES` | `32` / `262144` | Positive per-client limits for complete SSE frames queued after socket backpressure; projection frames replace an older pending frame for the same scope and are additionally fixed at eight pending scopes per client, while crossing any frame/scope/byte bound disconnects only that client so recovery can read the latest projection |
| `DASHBOARD_SSE_RETRY_AFTER_SECONDS` | `10` | Retry guidance for rejected realtime connections |
| `DASHBOARD_RECOVERY_MAX_CONCURRENT` | `3` | Per-process recovery builds. Each admitted build owns a short-lived PostgreSQL pool capped at one connection, separately from `API_POSTGRES_POOL_MAX`. |
| `DASHBOARD_RECOVERY_GLOBAL_MAX_REQUESTS` / `DASHBOARD_RECOVERY_PER_SOURCE_MAX_REQUESTS` | `60` / `12` per 60 seconds | Process-local global/per-source recovery budgets; admitted source entries are bounded by the global cap |
| `DASHBOARD_RECOVERY_WINDOW_SECONDS` / `DASHBOARD_RECOVERY_RETRY_AFTER_SECONDS` | `60` / `10` | Fixed-window duration and rejection retry guidance |
| `DASHBOARD_RECOVERY_TIMEOUT_MS` | `5000` | End-to-end HTTP recovery and per-attempt live projection build/publication deadline, including local admission and PostgreSQL, Redis, and BullMQ projection reads |
| `RUNTIME_RECOVERY_SOAK_SECONDS` | `2 * DASHBOARD_RECOVERY_WINDOW_SECONDS + 5` | Opt-in idle recovery soak duration; any explicit value must be strictly greater than two recovery budget windows |
| `RUNTIME_RECOVERY_SOAK_PROBE_INTERVAL_MS` | `5000` | Interval for the opt-in direct-web and proxy-to-web health soak |
| `RUNTIME_SMOKE_RUN_TIMEOUT_MS` | Derived as traffic duration + drain timeout + three finalization intervals + 10 seconds (330 seconds under defaults) | Positive optional override for the routine smoke's one shared lifecycle, Run History, and terminal-projection evidence deadline; exact cleanup has a separate fixed 30-second budget |
| `API_TRUSTED_PROXY_CIDRS` | loopback and Compose Caddy `172.30.0.2/32` | Exact Caddy proxy boundary used for Fastify client-IP derivation; replace with the deployed proxy address |
| `PUBLIC_RUN_BUDGET_GLOBAL_MAX_STARTS` | `6` | `runtime-setup` first-seed public run-budget global cap |
| `PUBLIC_CUSTOM_MAX_TOTAL_REQUESTS` | `10000` | `runtime-setup` first-seed public custom emitted-request cap |
| `PUBLIC_CUSTOM_MAX_BUYERS` | `10000` | `runtime-setup` first-seed public custom buyer cap |
| `PUBLIC_CUSTOM_MAX_REQUESTS_PER_SECOND` | `1000` | `runtime-setup` first-seed public custom request-rate cap |
| `PUBLIC_CUSTOM_MAX_TRAFFIC_DURATION_SECONDS` | `120` | `runtime-setup` first-seed public custom duration cap |
| `PUBLIC_CUSTOM_MAX_TRAFFIC_START_DELAY_SECONDS` | `10` | `runtime-setup` first-seed public custom start-delay cap |
| `PUBLIC_CUSTOM_MAX_PRE_ALLOCATED_VUS` | `1000` | `runtime-setup` first-seed public custom preallocated-VU cap |
| `PUBLIC_CUSTOM_MAX_VUS` | `1000` | `runtime-setup` first-seed public custom max-VU cap |
| `PUBLIC_CUSTOM_MAX_STARTING_STOCK` | `1000` | `runtime-setup` first-seed public custom starting-stock cap |
| `PUBLIC_CUSTOM_MAX_ERP_LATENCY_MS` | `2000` | `runtime-setup` first-seed public custom ERP-latency cap |
| `PUBLIC_CUSTOM_MIN_ERP_MAX_TPS` | `1` | `runtime-setup` first-seed public custom minimum ERP TPS |
| `PUBLIC_CUSTOM_MAX_ERP_MAX_TPS` | `100` | `runtime-setup` first-seed public custom maximum ERP TPS |
| `PUBLIC_CUSTOM_MAX_ERP_ERROR_RATE` | `0.25` | `runtime-setup` first-seed public custom ERP error-rate cap |
| `K6_BINARY` | `k6` host-native; `/usr/local/bin/k6` in compose | Load orchestrator |
| `K6_CANCELLATION_TIMEOUT_MS` | `10000` (maximum `15000`) | End-to-end load-orchestrator bound from accepted exact-run cancellation through observed k6 child exit/reap |
| `COMPLETION_DELIVERY_RETRY_INTERVAL_MS` | `5000` (maximum `60000`) | Fixed bounded interval between serialized retries of the one durable `completion_pending` report; each HTTP attempt retains its five-second deadline |
| `LOAD_ORCHESTRATOR_PORT_RANGE` | `10240 65535` in Compose | Load-orchestrator-only ephemeral port range for repeated cold-connection surges; host-native runs keep the host setting |
| `LOAD_ORCHESTRATOR_TCP_TW_REUSE` | `1` in Compose | Load-orchestrator-only outbound TIME_WAIT reuse for back-to-back runs; host-native runs keep the host setting |
| `LOAD_ORCHESTRATOR_STATE_DIR` | `.checkout-surge/load-orchestrator` host-native; named-volume path in Compose | Durable single-slot traffic execution journal |
| `LOG_LEVEL` | `info` | Shared logger |

`API_POSTGRES_POOL_MAX` governs only the main long-lived application/data-path pool. The API also owns a separate long-lived reset-workflow client capped at one connection, up to three concurrent dashboard-recovery pools capped at one connection each, and one max-one readiness pool. Pending-persistence recovery adds at most one discovery pool or one sequential scheduler attempt plus three direct attempt pools by default. At an exhaustion boundary each of those four attempts can briefly retain its attempt pool while opening one separately bounded max-one audit pool, so the conservative default PostgreSQL client ceiling is 23 per API process: 10 main + 1 reset + 3 dashboard recovery + 1 readiness + 8 pending-persistence attempt/audit. Readiness is single-flight, direct pending recovery is permit-bounded, scheduler attempts are sequential, and every transient pool is terminated when its operation completes or aborts.

`DEMO_MAX_*`, `DEMO_RUN_DRAIN_TIMEOUT_SECONDS`, and the finalization poll interval belong to the API process and take effect after an API restart. The API also validates that maximum traffic start delay plus traffic duration, drain timeout, the pending-persistence recovery window, and finalization cadence leave a full 24-hour safety margin inside the fixed seven-day Redis run-sale eligibility TTL; an unsafe or arithmetically unrepresentable combination prevents startup with the contributing variable names. `DEMO_MAX_*` values are not forwarded to `runtime-setup` and are not stored in PostgreSQL. Setup intrinsically validates and seeds only the mutable `PUBLIC_*` policy. The API combines that strict row with its current caps through the canonical effective-policy boundary and validates it before listening; tightening a cap below an admin-tuned public limit prevents startup instead of clamping it. `PUBLIC_RUN_BUDGET_*` and `PUBLIC_CUSTOM_*` belong only to `runtime-setup` and are used when the active row is first created. Once bootstrapped, PostgreSQL/admin updates are authoritative; changing setup values does not overwrite an existing policy. Use the protected admin policy controls, or wipe the database for a new bootstrap.

The notification and durable order-recovery variables above are read by the host-native worker and documented in `apps/worker/.env.example`. The current reference Compose file does not forward overrides for `NOTIFICATION_RECORD_CONCURRENCY`, `NOTIFICATION_RECOVERY_*`, or `ORDER_RECOVERY_*`, so its worker uses the built-in values shown in this table. Compose does forward the `ORDER_DISPATCH_*`, aggregate order concurrency, ERP fallback, and pool-size settings.

Dashboard SSE and recovery admission rejections advise a 10-second retry through `Retry-After`. Recovery requests proxied by Next carry the existing HMAC-verified public visitor credential; direct/debug requests fall back to the trusted network source. Arbitrary visitor headers and direct `X-Forwarded-For` values are not trusted. Recovery rate exhaustion returns `429 dashboard_recovery_rate_limited`; local concurrent-capacity exhaustion and deadline expiry return `503 dashboard_recovery_unavailable` with `at_capacity` or `timed_out` details.

## Design Decisions & Rationale

The setup above is shaped by a few deliberate decisions about the local development environment. They are recorded here so the reasoning survives even as the exact scripts and compose services evolve.

### Confirmed decisions

| Decision | Choice | Rationale |
| :-- | :-- | :-- |
| Supported development modes | Linux host-native, local Dev Container, GitHub Codespaces; Windows as a Docker Desktop host for the containerized runtime | These are the real workflows the project intends to support. Application services and tests run on Linux, so the Dev Container is the Windows development path. |
| Dev Container base image | `mcr.microsoft.com/devcontainers/universal:linux` | This image is used by the workspace and is compatible with the team's Codespaces cost and caching constraints. |
| Future dev-container customization rule | If a custom dev-container `Dockerfile` is introduced later, it must still use `mcr.microsoft.com/devcontainers/universal:linux` as the base image | Prevents toolchain drift between local Dev Containers and Codespaces. |
| Stateful local infrastructure | PostgreSQL and Redis are the mandatory baseline dependencies | They are required by the architecture and are the shared dependencies every contributor must be able to boot predictably. |
| Infrastructure orchestration strategy | Use `docker compose` for shared infrastructure and the reference application runtime | Compose gives one consistent startup path across host-native work, Dev Containers, and Codespaces while preserving explicit service boundaries. |
| App runtime strategy during active development | Support host-native `pnpm dev:*` commands as a convenience workflow, but make the containerized topology the reference runtime | Host-native processes keep iteration fast for focused edits. The containerized path is the architectural baseline because the project demonstrates service separation and load generation behavior. |
| Load orchestrator runtime | Run `apps/load-orchestrator` in its own reference container with k6 installed inside the image | The load generator is part of the system architecture, not a developer workstation prerequisite. This keeps Dev Containers, Codespaces, and hosted demos aligned. |
| Container dependency isolation | In containerized workflows, `node_modules` must use Docker named volumes rather than the workspace bind mount | Prevents Linux-installed dependencies inside the container from conflicting with Windows-installed dependencies on the host. |
| Container pnpm store isolation | In Dev Container and Codespaces workflows, pnpm's store must use a Docker named volume mounted at `/pnpm-store` | Prevents the Linux pnpm store from being written into the Windows-visible workspace and avoids host/container store conflicts. |
| Config style | Prefer URL-style connection variables such as `DATABASE_URL`, `REDIS_URL`, and service base URLs | Reduces duplicated configuration and makes cross-environment wiring simpler. |
| Environment-file layout | Use a root `.env.example` for shared values plus per-app `.env.example` files for service-specific variables | Keeps infrastructure defaults centralized while allowing each app to own its local configuration surface. |
| Root command contract | Standardize on root `pnpm` commands for infrastructure and per-service development entry points | Gives contributors one stable startup vocabulary across host-native work, Dev Containers, and Codespaces. |

### Dependency isolation across host and container

Because the source tree is shared across host-native, Dev Container, and Codespaces work, OS-specific dependency stores must stay out of the workspace to avoid Windows-host versus Linux-container conflicts:

- Dev Container and Codespaces setups mount `node_modules` as Docker named volumes at the relevant workspace paths, and mount pnpm's store as a named volume at `/pnpm-store`.
- The container sets `pnpm config set store-dir /pnpm-store --location user` during post-create setup.
- The repository must not commit a project `.npmrc` with `store-dir=.pnpm-store`, because that would also redirect Windows-side installs into the shared workspace.
- Host-native development stays free to install its own platform-compatible dependencies locally.

### Why the containerized runtime is the reference

- PostgreSQL and Redis benefit from predictable containerized setup, and the load orchestrator — the source of synthetic buyer traffic — should not depend on host-installed k6 when demonstrating the project.
- Keeping k6 inside the load-orchestrator image means Dev Containers and Codespaces can exercise dashboard-triggered load runs without separate manual k6 installation.
- Host-native `pnpm dev:*` stays useful for fast, focused debugging, but the containerized workflow is the honest local approximation of the deployed service topology.
