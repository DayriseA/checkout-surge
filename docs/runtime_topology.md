# Runtime Topology - Decisions & Rationale

This document defines the target local reference runtime topology, the Dev Container and GitHub Codespaces expectations, and the boundary between the local runtime and hosted deployment packaging. To start with, `.devcontainer` is intentionally a neutral workspace shell; application compose services are added later as the monorepo is scaffolded.

The goal is to make the architecture-realistic topology easy to run locally without turning every development workspace startup into a full demo environment.

---

## Confirmed Decisions

| Decision Area | Choice | Rationale |
| :-- | :-- | :-- |
| Reference local topology | API, worker, mock ERP, web, load orchestrator, PostgreSQL, and Redis run as separate services | The local reference runtime should demonstrate the same service boundaries the project claims architecturally. |
| Load orchestrator runtime | The load-orchestrator container owns the k6 binary | k6 is part of the load-generation service runtime, not a host-machine prerequisite for the reference path. |
| Root compose ownership | The future root compose topology is the stable full local reference/demo runtime | `docker compose up` and `pnpm runtime:up` should represent the complete local system, not only shared infrastructure. |
| Dev Container compose ownership | The seed `.devcontainer` compose uses a separate `checkout-surge-devcontainer` project for the editor workspace; later implementation may extend shared service definitions after they exist | The editor container lifecycle must not be coupled to `pnpm runtime:up` / `pnpm runtime:down`, which own the reference runtime project. |
| Dev Container Docker strategy | Dev Container and GitHub Codespaces use Docker-in-Docker | The seed workspace provides this controlled environment, works naturally in Codespaces, and isolates compose state from host Docker state. |
| Dev Container startup | Dev Container and Codespaces startup should not automatically start the full application topology | Developers should explicitly choose test infrastructure, infra-only services, or the full runtime depending on their current loop. |
| Host-native workflow | Keep `pnpm dev:*` commands as a focused development convenience | Host-native app processes are useful for fast edits, but they are not the reference proof of service separation. |
| Infra-only workflow | Preserve an explicit infra-only command that targets PostgreSQL and Redis | Developers often need only data services for host-native app work or focused debugging. |
| Test workflow | Keep isolated test infrastructure separate through `docker-compose.test.yml` | Automated tests should not depend on normal development or demo state. |
| Environment defaults | `.env.example` remains host-native | Host-native defaults should keep working for `pnpm dev:*`. |
| Compose internal URLs | Compose supplies container-network URL overrides for service-to-service calls | Containers should use Compose DNS names such as `postgres`, `redis`, `api`, `mock-erp`, and `load-orchestrator`. |
| Browser-facing dashboard URL | The containerized reference runtime uses the single-origin proxy on port `8080` | Public demo, live watch, admin controls, HTTP reads, and the public SSE stream at `/dashboard/events` should share one public origin; direct service ports are debug surfaces. |
| Runtime setup | Runtime startup should not hide database mutations | `runtime:up` starts containers; an explicit setup command runs migrations and demo seed data. |
| Demo readiness | The planned `health:check` command should include dashboard reachability | The full local demo is not ready if the dashboard is unreachable, even when backend services are healthy. |
| Hosted deployment boundary | Hosted deployment assets must coexist with the local topology | Production images or platform configs should be added separately or via separate Dockerfile targets, not by replacing local Dev Container/Codespaces behavior. |

---

## Reference Local Topology

The full local reference runtime includes:

- `apps/web` dashboard with public demo, live watch, admin console, and run history routes
- `apps/api` API gateway and SSE fan-out owner
- `apps/worker` order-processing and notification workers
- `apps/mock-erp` simulated downstream ERP
- `apps/load-orchestrator` k6 wrapper and metric streamer
- PostgreSQL
- Redis

The load orchestrator is part of the demonstrated system. The reference runtime must therefore run it in its own container with k6 installed inside that runtime image.

---

## Workflow Taxonomy

### Full Reference Runtime

Use this for demos, manual end-to-end verification, and dashboard-triggered load runs.

Expected command contract:

- `pnpm runtime:up` starts the full containerized topology.
- `pnpm runtime:down` stops the full containerized topology.
- `pnpm runtime:setup` explicitly runs migrations and seeds the demo product, baseline sale offer, durable presets, and Redis inventory for first-time or refreshed local use.
- `pnpm health:check` verifies full demo readiness, including the dashboard and backend service readiness.

`runtime:up` should not automatically run migrations or seed demo data.

### Host-Native Convenience Runtime

Use this for focused development when running app processes directly with `pnpm dev:*`.

Expected command contract:

- `pnpm infra:up` starts only PostgreSQL and Redis.
- `pnpm infra:down` stops the infra-only services as documented.
- `pnpm dev:api`, `pnpm dev:worker`, `pnpm dev:mock-erp`, `pnpm dev:load-orchestrator`, and `pnpm dev:dashboard` are provided for focused service work.

This path is convenient, but it is not the reference proof that the application services are separated.

### Automated Test Infrastructure

Use this for test loops.

Expected command contract:

- `pnpm test:infra:up` starts isolated PostgreSQL and Redis from `docker-compose.test.yml`. Per-package test databases are created and migrated on demand by the tests themselves.
- `pnpm test:db:migrate` rehearses incremental `drizzle-kit` migration against the isolated test database (migration-authoring aid, not a test prerequisite).
- `pnpm test:infra:down` stops and removes isolated test infrastructure.

Tests should continue to avoid normal development and demo state.

---

## Compose File Ownership

The future root compose file should describe the reusable local service topology. It should be stable enough for demos and local reference verification.

Dev Container and GitHub Codespaces-specific compose configuration belongs under `.devcontainer` when it only exists for the development environment. Examples include:

- workspace bind mounts,
- dependency-volume isolation,
- Docker-in-Docker compatibility details,
- editor-friendly startup behavior,
- development-only command overrides.

The seed Dev Container compose file is intentionally standalone because the application topology does not exist yet. After the root runtime topology is introduced, a Dev Container override may extend shared service definitions for bind mounts, dev-mode commands, forwarded ports, and dependency-volume isolation. It should keep its own Compose project name so the editor workspace container attaches to `checkout-surge-devcontainer_default`, not the reference runtime network `checkout-surge_default`.

Once shared compose files exist, follow the Dev Containers and Docker Compose base-plus-override convention: use shared compose files for common topology, and layer development-environment-specific overrides where the Dev Container configuration lives.

The dependency cache volumes used by the Dev Container should keep explicit volume names. This preserves cache continuity across Compose project-name changes and keeps Linux `node_modules` out of the host-visible workspace.

---

## Dev Container and Codespaces Expectations

Dev Container and GitHub Codespaces use Docker-in-Docker as the reference Docker access strategy.

Startup should prepare the workspace and verify Docker availability, but it should not automatically start the full application topology. A developer opening a Codespace may only want to edit docs, run unit tests, or start isolated test infrastructure. Full runtime startup should be an explicit opt-in.

The Dev Container and Codespaces path must preserve dependency isolation:

- Linux `node_modules` should not be written into host-native dependency folders.
- pnpm store data should remain in the configured container volume.
- generated container artifacts should not conflict with host-native installs.

The dashboard proxy port should be the normal launch target. API, mock ERP, load orchestrator, direct web, worker health, PostgreSQL, Redis, test PostgreSQL, and test Redis ports may remain forwarded as needed for local verification and debugging.

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

Browser-facing dashboard traffic should not depend on `NEXT_PUBLIC_*` backend service URLs. The browser uses the public dashboard origin, while `apps/web` uses server-side `API_BASE_URL`, `MOCK_ERP_BASE_URL`, and `LOAD_ORCHESTRATOR_BASE_URL` values for internal calls.

---

## Health and Readiness

`pnpm health:check` should represent full local demo readiness.

It should verify:

- API readiness,
- worker readiness,
- mock ERP readiness,
- load orchestrator readiness,
- load orchestrator k6 executable readiness,
- dashboard reachability.

PostgreSQL and Redis may be verified through compose healthchecks and through dependent service readiness.

---

## Containerized Load-Run Validation

The reference runtime should validate load execution through the dashboard path, not only by calling the load orchestrator directly. The dashboard is the operator control surface, and its server-side proxy is responsible for attaching trusted control headers to load-run requests.

The expected smoke workflow is:

1. Start the full runtime with `pnpm runtime:up`.
2. Seed the demo baseline with `pnpm runtime:setup`.
3. Open or call the dashboard through the proxy at `http://localhost:8080`; use `/` for public starts and `/admin` for operator controls.
4. Authenticate as an admin when a small custom smoke run is preferred over the larger public presets.
5. Start a public preset or an editable admin preset through the dashboard. The normal start path calls the same-origin dashboard control route, saves editable admin configuration when needed, starts an API-owned demo run from the accepted preset snapshot, and moves browser observation to `/watch`.
6. Confirm `GET http://localhost:8080/api/dashboard/recovery` shows the API-owned demo run moving through `starting`, `active`, `draining`, and then a terminal `completed` or `failed` state. The load orchestrator's local traffic execution ends as `succeeded` or `failed`; this recovery read is the browser source of truth after reconnects.
7. Confirm `GET http://localhost:8080/api/dashboard/snapshot` shows the resulting inventory, queue, ERP, and run-outcome changes without historical run summaries.
8. Confirm `GET http://localhost:8080/api/dashboard/run-summaries` lists finalized historical run summaries separately from the live dashboard.

The seeded public presets are `preview-1k`, `surge-5k`, `surge-10k`, `idempotency-check-200`, and `public-custom`. The surge presets are sized for public burst demonstrations: `preview-1k`, `surge-5k`, and `surge-10k` use buyer-spike traffic and each create a generated run sale offer with isolated Redis inventory. `idempotency-check-200` is a light duplicate-attempt correctness run, and `public-custom` is the read-only base preset for bounded run-scoped public custom starts. The public `surge-10k` preset is the intended showcase target: approximately 10,000 synthetic buyers attempting to buy at once through k6/API traffic. For smoke validation, use an authenticated admin steady-arrival run with a low `ratePerSecond` value and short `durationSeconds`; repeated public/admin starts do not require resetting the seeded active sale offer. `pnpm runtime:setup` rebuilds the setup image before seeding so local seed-data changes are reflected in the running PostgreSQL and Redis state. The setup image uses a DB-only Docker target, so seed changes do not rebuild the web, API, worker, mock ERP, or load-orchestrator application bundles.

Local laptop, Dev Container, and Codespaces runs are not hosted benchmark runs. They share CPU, memory, and Docker daemon capacity with the development workspace. If the environment is constrained, lower admin preset `buyerCount` for buyer-spike checks or `ratePerSecond` for steady-arrival checks, lengthen steady-arrival `durationSeconds` when useful, and treat dashboard behavior, queue pressure, and k6 metric streaming as the local verification target. Lower local validation parameters are a developer-workstation compromise, not a change to the public demo target. Hosted benchmark isolation, horizontal scaling, reverse-proxy settings, and infrastructure tuning belong to hosted deployment.

The live watch page uses the API-owned SSE stream at `/dashboard/events` only for best-effort feedback. Browser refresh, reconnect, start, and reset flows recover through the API-owned dashboard recovery read, and the browser performs a follow-up recovery when events are dropped during a recovery window. The watch route is current-run focused; arbitrary completed-run detail remains owned by Run History. The live stream and recovery read remain public demo observability surfaces; admin sign-in gates privileged controls only. Run History is HTTP-only and does not subscribe to the live stream; terminal run summaries appear there after page load, explicit refresh, pagination, or admin deletion refreshes the list.

The seed Dev Container compose configuration can be validated with Docker Compose config checks. After application services and forwarded ports are added, a full Dev Container or Codespaces rebuild is required to prove editor startup, port forwarding, Docker-in-Docker initialization, and named dependency volumes.

---

## Runtime Verification Checklist

Use this checklist when implementing or changing the local runtime topology:

- Validate the seed Dev Container shell with `docker compose -f .devcontainer/docker-compose.yml config`.
- After the root runtime compose file exists, validate the root topology with `docker compose config`.
- If a Dev Container override is added later, validate the merged topology with `docker compose -f docker-compose.yml -f .devcontainer/docker-compose.yml config`. Confirm the merged project name is `checkout-surge-devcontainer` and the merged default network is `checkout-surge-devcontainer_default`.
- Start services with `pnpm runtime:up`.
- Apply migrations and seed demo data with `pnpm runtime:setup`.
- Check service readiness and dashboard reachability with `pnpm health:check`.
- Check compose service health and the in-container k6 binary with `pnpm runtime:smoke`.
- For the mutating dashboard-to-load-run path, run `pnpm runtime:smoke:load`. This resets demo data through the API before starting a small dashboard-proxied admin load run. Set `RUNTIME_SMOKE_LOAD_RUN_TIMEOUT_MS` when a slower environment needs a longer finalization window.
- For manual old-run cleanup, run `pnpm maintenance:cleanup-runs`. The command deletes old generated run state and related records while preserving active runs and the latest 15 runs by default. Use `-- --keep-latest <count>` to choose a different retention count.
- Rebuild or reopen the Dev Container after `.devcontainer` changes and confirm: Docker readiness is checked on post-start without auto-starting the full runtime, `pnpm install` uses the named dependency volumes, and `pnpm infra:up`, `pnpm test:infra:up`, and `pnpm runtime:up` remain explicit opt-in commands.
- Rebuild or reopen GitHub Codespaces after `.devcontainer` changes and confirm: Docker-in-Docker starts, required dashboard/API/mock ERP/load-orchestrator/worker health/PostgreSQL/Redis ports are forwarded once those services exist, and `pnpm runtime:smoke` can see healthy compose services after `pnpm runtime:up`.

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
