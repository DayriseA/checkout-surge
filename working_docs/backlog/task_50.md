# Task 50: Health-gate the upper compose graph (web and proxy must wait on healthy dependencies)

## Execution context

- **Execution order:** This is task 50 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P2
- **Area:** deployment / compose
- **Source:** comparison (worse)
- **Standalone implementation context:** inlined below. No donor checkout, branch switch, or reference-project access is required.
- **Locations:** `docker-compose.yml` under `services.web.depends_on` and `services.dashboard-proxy.depends_on` (healthy gates exist for the lower services; web/proxy use started-only conditions)

PostgreSQL/Redis gating is solid, but the web service waits only for API/mock-ERP/orchestrator to be *started* and the dashboard proxy waits only for API and web to be *started* — the browser origin can become reachable before the demo path is ready, pushing first-run failures onto users and smoke scripts.

## Standalone implementation context

### Current target topology and exact gap

The only implementation file in scope is the root `docker-compose.yml`. Its lower graph already uses readiness gates:

- `api` depends on `postgres` and `redis` with `condition: service_healthy`.
- `worker` depends on `postgres`, `redis`, and `mock-erp` with `condition: service_healthy`.
- `load-orchestrator` depends on `api` with `condition: service_healthy`.
- `runtime-setup` is profile-gated and depends on `postgres` and `redis` with `condition: service_healthy`.

The browser-facing upper graph is inconsistent with those edges. Change these five existing conditions, and no others:

```yaml
web:
  depends_on:
    api:
      condition: service_healthy
    mock-erp:
      condition: service_healthy
    load-orchestrator:
      condition: service_healthy

dashboard-proxy:
  depends_on:
    api:
      condition: service_healthy
    web:
      condition: service_healthy
```

Today all five conditions above are `service_started`. Do not merely add new healthchecks: all five depended-on services already have them. The resulting initial creation graph must be:

```text
postgres healthy ----\
                      +--> api healthy --> load-orchestrator healthy --\
redis healthy -------/                                            +----+--> web healthy --\
mock-erp healthy --------------------------------------------------/                       +--> dashboard-proxy
api healthy -----------------------------------------------------------------------------/
```

The explicit edges are deliberate even where a transitive path exists. `web` makes server-side calls to API, mock ERP, and load orchestrator, so it gates all three directly. `infra/caddy/Caddyfile` sends ordinary paths to `web:3000`, but sends the browser's same-origin `/dashboard/events` SSE request directly to `api:4000`; therefore `dashboard-proxy` must gate API directly as well as web. Do not remove the direct API edge as “redundant” through web or load orchestrator.

`worker` remains outside this upper graph. It consumes the processing path and already has lower dependency gates, but the target web service does not use a worker health URL and Caddy does not route to it. Adding `worker` to `web.depends_on` or `dashboard-proxy.depends_on` would broaden startup policy beyond the reported browser-origin race. Likewise, do not change the Caddy route match, service names, ports, environment, build targets, or profile behavior in this task.

### Existing target probes to retain

`service_healthy` uses the depended-on container's existing Docker health status, so preserve these exact target probes and their current cadence:

| Service | Probe command | What it establishes | Timing |
| --- | --- | --- | --- |
| `postgres` | `pg_isready -U postgres -d checkout_surge` | PostgreSQL accepts connections for the configured database. | `interval: 5s`, `timeout: 3s`, `retries: 20`; no `start_period`. |
| `redis` | `redis-cli ping` | Redis answers `PING`. | `interval: 5s`, `timeout: 3s`, `retries: 20`; no `start_period`. |
| `api` | `node -e "fetch('http://127.0.0.1:4000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"` | API readiness responds with a successful HTTP status. In this checkout, `/health/ready` checks PostgreSQL, Redis, and order-process queue connectivity; `/health/live` would prove only that the process can answer and is not the correct gate. | `interval: 5s`, `timeout: 3s`, `retries: 30`; no `start_period`. |
| `mock-erp` | `node -e "fetch('http://127.0.0.1:4100/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"` | Mock ERP readiness reports its confirmation endpoint ready. | `interval: 5s`, `timeout: 3s`, `retries: 30`; no `start_period`. |
| `load-orchestrator` | `node -e "fetch('http://127.0.0.1:4200/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"` | Orchestrator readiness verifies API readiness, preset-start availability, and the configured k6 executable. | `interval: 5s`, `timeout: 3s`, `retries: 30`; no `start_period`. |
| `web` | `node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"` | The Next.js root route is reachable. This is a reachability/liveness-style probe, not a fresh aggregate check of all backends. | `interval: 5s`, `timeout: 5s`, `retries: 30`; no `start_period`. |
| `dashboard-proxy` | `wget -q -O /dev/null http://127.0.0.1:8080/` | Caddy can serve the root path end-to-end through web. It does not exercise the direct API/SSE route. | `interval: 5s`, `timeout: 5s`, `retries: 30`; no `start_period`. |

Do not copy probe commands mechanically from another image. The target application runtime images already use Node's built-in `fetch`; the Caddy image uses `wget`. Do not add `curl`, a package installation, or a new health endpoint. Do not introduce a shared timing anchor or donor `start_period` values as part of this focused dependency-condition fix.

The target Compose services do not override application startup commands. Their existing `Dockerfile` targets supply `node apps/api/dist/index.js`, `node apps/mock-erp/dist/index.js`, `node apps/load-orchestrator/dist/index.js`, and `pnpm --filter web start`; Caddy uses the image default command. Retain that arrangement. It differs from the reference Compose file, which explicitly sets `pnpm --filter api start`, `pnpm --filter mock-erp start`, `pnpm --filter load-orchestrator start`, and `pnpm --filter web start`. Those command differences are image-layout details and are not part of the health-gating behavior to transplant.

### Reference behavior incorporated

The `checkout-forge` reference implements the same full upper graph:

- `web.depends_on` gates `api`, `mock-erp`, and `load-orchestrator` with `service_healthy`.
- `proxy.depends_on` gates `api` and `web` with `service_healthy`.
- API, mock ERP, load orchestrator, and web use five-second intervals, five-second timeouts, twelve retries, and no explicit `start_period`; their commands use `wget -qO-` against `/health/ready` for backend services and `/` for web.
- The reference proxy probes `/` with `wget`, also at five seconds/five seconds/twelve retries and with no explicit `start_period`.

That evidence establishes the dependency conditions, not a requirement to make this checkout's probe commands or retry budgets identical. Preserve the target's Node-based probes, `dashboard-proxy` name, `Dockerfile` targets, 30-retry application budget, and Caddy configuration.

There are also useful limits in the reference design that this task must state rather than “fix”:

- Compose `depends_on: condition: service_healthy` is an initial creation-order gate. If API or web becomes unhealthy later, Compose does not automatically stop or recreate already-running web/Caddy containers.
- The target has `restart: on-failure` only on `api`; `web` and `dashboard-proxy` have no restart policy. A Docker healthcheck marking a still-running container unhealthy does not itself restart it, and changing restart policy is outside scope.
- Docker decides health from probe exit status. The Node probes treat any `response.ok` status as healthy. The shared readiness aggregation returns HTTP 503 only for `unavailable`; a hypothetical `degraded` response remains HTTP 200 and therefore Docker-healthy. This is intentional existing semantics, especially relevant to the orchestrator's readiness vocabulary; do not redefine degraded handling here.
- Web's root probe and Caddy's root probe establish reachability, not continued readiness of API/mock ERP/orchestrator and not SSE frame delivery. The initial dependency gates close the startup race only. Deeper proxy/SSE smoke behavior belongs to the following smoke-tooling task.

## Implementation boundaries and non-goals

- Edit only the five `condition` values in root `docker-compose.yml`, plus focused compose/static assertions if this repository has an established test location for them. Keep the change deployment-only.
- Do not change application routes, readiness implementations, contracts, Dockerfiles, Caddyfile routing, service commands, healthcheck commands/timing, restart policies, profiles, or runtime setup behavior.
- Do not add worker gates, one-shot setup completion gates, automatic migration/seed behavior, runtime retries, custom wait scripts, or health-driven restart automation.
- Do not treat readiness as liveness: retain `/health/ready` for API, mock ERP, and load orchestrator. Do not replace those probes with `/health/live`.
- Preserve the direct Caddy-to-API gate for realtime/SSE and the direct web-to-API gate; transitive readiness is not a substitute for an explicit consumer dependency.

## Focused verification

After implementation, verification should remain compose-focused:

1. Run `docker compose config` and confirm the root file is valid after interpolation.
2. Inspect the rendered `services.web.depends_on` mapping and assert that its exact keys are `api`, `mock-erp`, and `load-orchestrator`, each with `condition: service_healthy`.
3. Inspect rendered `services.dashboard-proxy.depends_on` and assert that its exact keys are `api` and `web`, each with `condition: service_healthy`.
4. Confirm no `service_started` condition remains on either upper service, while the existing lower `service_healthy` conditions remain intact.
5. Confirm rendered healthcheck `test`, `interval`, `timeout`, `retries`, and absence of `start_period` are unchanged for API, mock ERP, load orchestrator, web, and dashboard proxy. Also confirm service commands, restart policies, Caddy mount/ports, and profiles are unchanged.
6. Run `docker compose -f docker-compose.yml -f .devcontainer/docker-compose.yml config` because the repository documents that merged topology as a supported static validation surface; verify the override does not weaken the two upper dependency maps.

A focused automated regression may parse `docker compose config --format json` (when supported by the installed Compose version) and assert those mappings without starting containers. Do not require `docker compose up`, build images, start an app, wait for live health transitions, or mutate databases to complete this task. If runtime validation is performed voluntarily in a suitable environment, report it separately from the required static checks.

## Implementation record

- **Status:** Complete.
- **Scope:** Changed the five existing upper-graph dependency conditions in root `docker-compose.yml` from `service_started` to `service_healthy`. Added a focused explanation of initial healthy creation gates and their limits to `docs/runtime_topology.md`.
- **Decision / deviation:** Task 20 added a direct `web` dependency on Redis for the production Redis-backed admin-login limiter after this task was written. That `redis: service_healthy` edge is preserved, so the rendered `web.depends_on` keys are now exactly `api`, `load-orchestrator`, `mock-erp`, and `redis`, all healthy-gated. Removing or weakening the Redis edge would regress the current runtime requirement; the task's older three-key assertion is therefore superseded by the current topology.
- **Verification:** Root and root-plus-Dev-Container Compose configurations rendered successfully with safe dummy secrets. Focused JSON assertions confirmed the exact upper dependency keys and `service_healthy` conditions, no `service_started` condition on either upper service, unchanged target healthchecks (including timing and no `start_period`), and unchanged service commands, restart policies, Caddy mount/ports, and profiles. A normalized before/after rendered-config comparison showed only the five requested condition changes. `git diff --check` passed.
- **Skipped / not applicable:** No Compose-static test convention exists in the repository, so no new test infrastructure was added. TypeScript type checks, application lint, image builds, container startup, and runtime smoke suites are not relevant to this deployment-only YAML/documentation change. The prohibited slow composition and characterization suites were not run.
- **Remaining issues:** None.
