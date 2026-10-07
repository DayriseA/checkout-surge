# Hosted Runtime

This document describes how the hosted demo behaves on Fly.io. The reasons behind each choice are in the [hosted deployment decision log](decisions/hosted_deployment.md), and the operating procedures are in [Hosted Operations](hosted_operations.md). The local Compose topology is described in [Runtime Topology](runtime_topology.md).

The hosted runtime is the product's real runtime. It runs the same production images and contracts as the local topology, plus Fly-specific configuration under `infra/fly/`. The demo runs a few hours per month at most, so every Machine sleeps when unused and wakes on demand.

---

## Topology

```text
Visitor ──▶ https://checkout-surge-gate.fly.dev   (the only public address)
                          │
  gate app    ┌───────────▼───────────┐     guard Machine: hourly, one-shot,
              │ gate Machine          │     same image as the gate
              │ pages, core wake,     │
              │ relay once ready      │
              └───────────┬───────────┘
                          │ 6PN (Fly private IPv6)
  core app    ┌───────────▼───────────┐
              │ core Machine + volume │
              │ Caddy, web, API,      │
              │ worker, Mock ERP,     │
              │ PostgreSQL, Redis,    │
              │ setup                 │
              └───────────▲───────────┘
     k6 burst, metrics,   │   start, shutdown, status, abort
     completion report    │   (API to runner)
  runner app  ┌───────────┴───────────┐
              │ runner Machine        │
              │ load-orchestrator, k6 │
              └───────────────────────┘
```

| App | Machines | Public address | Volume | Started by |
| :-- | :-- | :-- | :-- | :-- |
| `checkout-surge-gate` | gate; guard (scheduled) | yes | no | Fly Proxy on a request (gate); Fly's scheduler (guard) |
| `checkout-surge-core` | one authoritative core | no | yes | the gate, after a visitor presses its start button |
| `checkout-surge-runner` | one runner | no | no | the API, for each run |

- The three apps sit in one Fly organization, in region `cdg`. A recovered core or runner can land elsewhere in Europe.
- The load generator runs on its own Machine and never shares CPU or memory with the system under test ([HD-01](decisions/hosted_deployment.md#hd-01-flyio-with-the-load-generator-on-its-own-machine)).
- Hosted-only behavior is selected by configuration and is off in the local topology ([HD-06](decisions/hosted_deployment.md#hd-06-hosted-only-behavior-is-selected-by-configuration)).

### Where sizes and limits are configured

Every deploy sends the Machine configs under `infra/fly/` in full, so a change made on Fly by hand is reverted by the next deploy.

| Setting | Where |
| :-- | :-- |
| Core Machine size | `guest` in `infra/fly/core/machine.json` |
| Runner Machine size | API variables `RUNNER_CPU_KIND`, `RUNNER_CPUS` and `RUNNER_MEMORY_MB` (API container in `infra/fly/core/machine.json`, defaults in `apps/api/src/runtime/config.ts`). The API applies them before each runner start; `guest` in `infra/fly/runner/machine.json` is the size a deploy sends. |
| Run limits | `DEMO_MAX_*` deployment caps, in the same API container (defaults in the [configuration reference](local_development.md#configuration-reference)). The public runtime policy is edited from the admin console and cannot exceed them. |
| Public limits and run budget | `PUBLIC_CUSTOM_*` and `PUBLIC_RUN_BUDGET_*` in the `setup` container of `infra/fly/core/machine.json`. The seed writes them into the public runtime policy only on a fresh core (a recovery or `--fresh-core`); admin console edits apply to the running core, and the next recovery replaces them with the file's values. |
| Gate and guard | `infra/fly/gate/machine.json`, `infra/fly/gate/guard-machine.json`; the guard's thresholds are `defaultGuardThresholds` in `apps/gate/src/guard.ts` |
| Hosted-only switches | `CORE_IDLE_STOP_ENABLED` and `RUNNER_FLY_APP` in the core's API container, `RUNNER_LIFECYCLE_ENABLED` in the runner |

A run rejected by a deployment cap shows a message that presents the limit as a hosting choice ([HD-25](decisions/hosted_deployment.md#hd-25-the-infrastructure-limit-message-uses-an-explicit-code-allowlist)).

---

## Gate

The gate (`apps/gate`) is a Fastify server and the only public entry point ([HD-02](decisions/hosted_deployment.md#hd-02-the-gate-is-the-only-public-address-and-the-only-waker)).

- **Relay.** While the core is ready, the gate relays every request (pages, API, SSE) as raw bytes to the core's Caddy, at the 6PN address of the authoritative core, with retries off ([HD-27](decisions/hosted_deployment.md#hd-27-the-gate-relays-with-fastifyreply-from-retries-off)). The k6 burst goes from the runner straight to the core and never crosses the gate.
- **Core status.** The gate reads the core's state from the Machines API and probes Caddy's `/health`, which the core never counts as activity, then caches the result briefly. Once the core is ready, a failed Fly read or an unanswered probe keeps it ready; a failed relay drops the cache ([HD-28](decisions/hosted_deployment.md#hd-28-the-gate-checks-the-cores-state-before-relaying-but-a-fly-api-failure-does-not-block-a-ready-core)).
- **Sleep.** Fly Proxy starts the gate Machine on a request and stops it once traffic is gone, so the first request to a sleeping gate waits a few seconds ([HD-31](decisions/hosted_deployment.md#hd-31-the-gate-sleeps-and-a-visit-wakes-it)).

### Pages

While the core is not ready, the gate answers every method and URL with its own HTML page, status 503 and `Cache-Control: no-store` ([HD-30](decisions/hosted_deployment.md#hd-30-gate-pages-answer-any-request-with-html-503)). No page starts the core.

| Page | When |
| :-- | :-- |
| Stopped (start button) | The core is `stopped` or `stopping`, its host is not `ok`, or no core is listed (the button then creates one) |
| Booting (reloads itself) | The core is `starting`, or `started` while Caddy's `/health` does not answer |
| Updating (retry button) | The core is `created` or `replacing` (a deploy is writing its config), or a wake found its lease held |
| Relocating (reloads itself) | A recovery runs in the gate after a capacity or dead-host failure, or because no core is listed |
| Fresh install (reloads itself) | A recovery runs because the core carries the `recreate=requested` mark |
| No capacity (retry button, link to the Fly.io status page) | The last recovery was refused for provider capacity; held until the next wake |
| Setup failure | The core is `started` and its `setup` container exited non-zero since the latest start |
| Unavailable (try again) | Any other state, a Machines API failure, a failed start, or a recovery without the deployed core config |

An open demo tab on a stopped core gets the gate page as the answer to its polling, which the countdown widget shows as "Demo paused".

### Waking the core

- The start button posts to `/__gate/start?return=<path>`, the only path the gate owns. The return path must be a same-site path; anything else returns to `/`. Visitors pressing together share one start. There is no wake quota.
- Under the core Machine's lease, the gate reads the core again, waits for a core still `stopping`, starts it (retrying capacity, dead-host and transient errors with back-off), releases the lease, then redirects to the return path. A held lease shows the updating page ([HD-29](decisions/hosted_deployment.md#hd-29-the-gates-lease-covers-only-the-start-command)).
- A start that keeps failing for capacity or a dead host, a core on a host that is not `ok`, a core marked `recreate=requested`, or no core at all starts the [core recovery](#recovery) instead.

### Visitor address

The per-source SSE cap and the dashboard-recovery source key depend on the visitor's address; run budgets use the signed visitor cookie. Each hop trusts only the previous one:

1. Fly Proxy sets `Fly-Client-IP`.
2. The gate drops every client-supplied forwarding header, then sends `X-Forwarded-For` with the `Fly-Client-IP` value, `X-Forwarded-Proto: https`, and the visitor's `Host`.
3. The core's Caddy (`infra/caddy/Caddyfile.fly`) trusts forwarding headers from the organization's private network and passes the visitor address alone to the API ([HD-32](decisions/hosted_deployment.md#hd-32-accepted-risk-the-cores-caddy-trusts-the-whole-private-network-for-visitor-addresses)).
4. The API trusts only loopback (`API_TRUSTED_PROXY_CIDRS`), that is, the core's own Caddy.

The core's `WEB_ORIGIN` (web and API) is the gate's public URL, so the admin origin check accepts only the gate. See [admin access](hosted_operations.md#admin-access) for the operator consequence.

---

## Core

### Packaging and boot

The core is one Fly multi-container Machine that reuses the per-service images ([HD-04](decisions/hosted_deployment.md#hd-04-the-core-is-one-fly-multi-container-machine)). Its config is `infra/fly/core/machine.json`.

- **Every start runs the same sequence,** reapplied by Fly from `depends_on` conditions:
  1. PostgreSQL becomes healthy.
  2. The `setup` container runs the migrations, then the seed, and exits successfully.
  3. The Mock ERP starts; the API and the worker also wait for Redis to be healthy, and the worker for the Mock ERP; then the web starts, and Caddy last.
- **The seed is idempotent** on an existing database: the product is rewritten identically, public presets are realigned with their code definition (changing one takes a commit and a deploy), editable admin presets keep operator edits, and the public runtime policy is inserted only when missing. Accepted runs keep their frozen configuration snapshot.
- **Setup failure.** If the migrations or the seed fail, the applications never start and the API port stays closed, while the Machine stays `started`. The gate reads the `setup` container's exit event and shows the setup-failure page; the guard stops such a core.
- **Network.** Only Caddy and the API listen on the 6PN address; the other services bind loopback.
- **Kernel limits.** The API's `runtime-fly` image target raises the open-file limit inside the API container and sets `somaxconn` to `API_LISTEN_BACKLOG` for the Machine, and fails the start if a setting is refused (`infra/fly/core/api-entrypoint.sh`).
- **Address given to k6.** The API derives the base URL it hands the runner from its own 6PN address (`FLY_PRIVATE_IP`); an explicit `API_BASE_URL` still wins.

### Storage

PostgreSQL and Redis keep their data on one Fly volume mounted at `/persistent`, each in its own subdirectory. The data is disposable: a recovery or an incompatible change starts a fresh, empty core, and nothing restores the volume ([HD-05](decisions/hosted_deployment.md#hd-05-core-data-is-disposable-with-no-restore-path)).

### Idle stop and countdown

The API stops its own Machine once there is no nonterminal run and no counted activity for the idle period ([HD-20](decisions/hosted_deployment.md#hd-20-the-api-stops-its-own-idle-core)). `CORE_IDLE_STOP_ENABLED=true` turns it on.

- **Counted:** every visitor request through the web server (a Next.js Proxy reports it to `POST /core/activity`), the "stay awake" button, and the end of a run, so the countdown restarts when a run finishes.
- **Not counted:** health checks, the widget's status polling (`GET /core/idle-status`), the demo page's recovery polling, open SSE connections, and requests sent straight to the API (runner traffic, operator calls).
- **Countdown widget.** Under the header of every page, it shows the API-owned deadline, which every visitor's activity extends, and a "stay awake" button. While a run is nonterminal it says the system stays awake, and it alerts near the end. When a status read fails after it has seen the core awake, it shows "Demo paused" with a link back to the gate.

Accepted limits: an idle stop can race a run start ([HD-21](decisions/hosted_deployment.md#hd-21-accepted-risk-idle-stop-races-a-run-start)), a short run started straight on the API is not counted ([HD-22](decisions/hosted_deployment.md#hd-22-known-limitation-short-operator-runs-are-not-counted)), and the countdown can briefly show an older deadline ([HD-23](decisions/hosted_deployment.md#hd-23-accepted-risk-stale-countdown-after-stay-awake)).

### Recovery

The gate owns core recovery, because nobody is around to repair the core by hand ([HD-34](decisions/hosted_deployment.md#hd-34-core-recovery-recreates-a-fresh-core-and-retires-the-old-one-only-once-the-new-one-is-healthy)).

1. A new empty volume and a new core Machine are created in the core's home region, or elsewhere in Europe, from the core config the deploy script last wrote into the gate Machine (`CORE_MACHINE_CONFIG_FILE`). Without that file, no recovery starts and visitors see the unavailable page.
2. The new core installs fresh: migrations and seed on an empty database. Hosted run history and admin edits are lost.
3. Once the new core is healthy (its setup succeeded and its readiness probe answers), the old Machine is destroyed and its volume deletion is started; on a host that is down, Fly keeps that deletion pending until the host returns. If the new core does not become healthy, it is removed and the old one is kept.

The gate holds the old core's lease for the whole recovery, except on a host that is not `ok`, where Fly grants no usable lease. Visitors see the relocating page, or the fresh-install page when the recovery was requested on purpose.

**Requested recovery.** Setting `recreate=requested` in the core Machine's metadata makes the next visitor wake recreate the core instead of starting it ([HD-35](decisions/hosted_deployment.md#hd-35-a-fresh-core-is-requested-by-a-mark-that-the-next-wake-acts-on)). The deploy script sets this mark with `--fresh-core` and carries an existing mark over, so only a wake clears it ([HD-48](decisions/hosted_deployment.md#hd-48-a-requested-fresh-core-stays-requested-until-a-wake-acts-on-it)).

### Authoritative core and leases

- The authoritative core is found through the app name and the `role=core` metadata, never through a hardcoded Machine ID or address. Among the cores that can serve, the gate takes the `started` one, else the newest; a core on a host that is not `ok`, or with a failed setup, cannot serve. Several cores exist only during a recovery or after a failed cleanup, which the guard removes.
- Coordination goes through Fly leases on the core and runner Machines. Leases are advisory between our own clients, not a security boundary ([HD-11](decisions/hosted_deployment.md#hd-11-runner-operations-and-run-starts-are-serialized-in-process)). Nobody takes a lease on a host that is not `ok`, as Fly's own tooling does.

| Lease holder (description) | Machine | Held | Another client meeting it |
| :-- | :-- | :-- | :-- |
| Gate wake (`gate wake`) | core | around the start, or the whole recovery | the deploy fails, to be re-run; the guard skips the core |
| Deploy script (`deploy`) | core, runner | from after the builds through the update | a wake shows the updating page; a run start fails |
| API runner operations (`runner start`, `runner stop`, `runner recreate`) | runner | each runner operation | the deploy fails, to be re-run; the guard skips the runner |
| Guard (`guard`) | core, runner | each stop or destroy | a wake shows the updating page; the deploy fails |

---

## Runner

### Lifecycle

The runner Machine is stopped between runs and started by the API for each run, always from a fresh boot ([HD-07](decisions/hosted_deployment.md#hd-07-the-api-starts-and-stops-the-runner-for-each-run)).

- **Start.** Right before dispatch, the API stops a runner found running, applies the configured size and the core's current 6PN address (`API_BASE_URL`), starts the runner, then waits for its readiness, which also probes the API over 6PN.
- **Stop.** When the run reaches a terminal state, the API asks the runner to exit through the fenced `POST /traffic/shutdown`; Fly `stop` is only the fallback ([HD-08](decisions/hosted_deployment.md#hd-08-the-runner-stops-at-the-terminal-state-not-at-draining), [HD-09](decisions/hosted_deployment.md#hd-09-fenced-shutdown-through-the-runner-fly-stop-only-as-a-fallback)).
- **Self-exit.** The runner also exits on its own when idle, and at a maximum lifetime tied to the automatic-reset deadline ([HD-10](decisions/hosted_deployment.md#hd-10-the-runner-exits-on-its-own-a-report-unacknowledged-at-maximum-lifetime-is-lost)). `RUNNER_LIFECYCLE_ENABLED=true` turns on the shutdown endpoint and both timers.
- **One owner.** One owner in the API runs every runner operation, one at a time, under the runner's lease ([HD-11](decisions/hosted_deployment.md#hd-11-runner-operations-and-run-starts-are-serialized-in-process)).
- **Kernel limits.** The load-orchestrator's `runtime-fly` image target raises the open-file limit k6 inherits, widens the ephemeral port range, enables `tcp_tw_reuse`, and sets `HOME` for k6 (`infra/fly/runner/load-orchestrator-entrypoint.sh`).

### Runner loss and missing evidence

- The runner generates a boot ID at process start. The API records it with the run, and every start or replay must match it ([HD-12](decisions/hosted_deployment.md#hd-12-boot-id-fencing-and-immediate-load_generator_lost)).
- On its poll, the API fails a `starting` or `active` run at once with `load_generator_lost` when its runner Machine stopped, booted again, or sits on an unreachable host. A runner that stays unreachable while its Machine is started is stopped through Fly after about a minute, then checked again.
- Counters without a k6 report are unknown, never zero ([HD-13](decisions/hosted_deployment.md#hd-13-missing-traffic-evidence-is-unknown-never-zero), [HD-43](decisions/hosted_deployment.md#hd-43-every-k6-counter-is-initialized-so-an-absent-counter-is-unknown)). On Fly's cgroup v1, the memory `high` probe reads "Not applicable" ([HD-44](decisions/hosted_deployment.md#hd-44-only-an-observed-platform-gap-is-not-applicable)).

### Version handshake

Before dispatch, the API compares its commit with the runner's (`COMMIT_SHA`, set by the deploy script). A mismatch refuses the run with a message that the demo is being updated, and the run ends failed with zero counters ([HD-14](decisions/hosted_deployment.md#hd-14-the-version-handshake-refuses-mismatched-runs), [HD-15](decisions/hosted_deployment.md#hd-15-accepted-risk-startup-replay-skips-the-version-handshake)).

### Capacity and region

- `start` is retried in place with back-off. Capacity and dead-host failures, after the retries, recreate the runner; a runner on a host that is not `ok`, or whose host refuses or reverts the update that applies the run's size and API address, is recreated at once ([HD-55](decisions/hosted_deployment.md#hd-55-a-host-that-refuses-the-runners-new-config-relocates-the-runner-at-once), [HD-17](decisions/hosted_deployment.md#hd-17-runner-capacity-failures-retry-in-place-then-recreate), [HD-19](decisions/hosted_deployment.md#hd-19-accepted-risk-post-start-wait-errors-are-not-retried)).
- The new runner is built from the runner config of the last core deploy, which the core's API container holds as a file (`RUNNER_MACHINE_CONFIG_FILE`), and is placed in the core's region first, then elsewhere in Europe ([HD-47](decisions/hosted_deployment.md#hd-47-the-runner-is-recreated-from-a-deployed-config-without-a-lease-on-a-host-that-is-not-ok)).
- While the runner is recreated, the run carries a relocation flag, and the public page, the watch page and the admin console say in plain words that the load generator is moving to another host. A create refused for capacity fails the run before traffic with a provider message, and the run is recorded as a provider capacity failure in which no traffic was sent.
- The whole runner boot (start, retries, recreation and readiness) has one deadline, kept well below the 300 s that the web's proxy and the gate's relay wait for response headers. Past it, no further step begins and Fly waits end: the run fails before traffic, as a provider capacity failure when the start met a full host, otherwise as a load generator that could not be started. A recreated runner that did not start is destroyed, and a runner started in place is stopped.
- A runner in another region than the core is recreated at run start ([HD-36](decisions/hosted_deployment.md#hd-36-the-runner-follows-the-cores-region-even-at-one-recreation-per-run)). Every run records the runner's region, and the UI shows it.
- When several runners exist, the newest is used, and the guard removes the others ([HD-18](decisions/hosted_deployment.md#hd-18-the-newest-runner-machine-wins)).

The Fly error classifier that drives these decisions is shared by the API and the gate in `packages/fly-machines` ([HD-16](decisions/hosted_deployment.md#hd-16-fly-error-classification-is-best-effort)).

---

## Guard

The guard is a scheduled Machine in the gate app (`infra/fly/gate/guard-machine.json`): Fly starts it hourly, it runs one pass with the gate image (`apps/gate/src/guard-main.ts`), then exits. It cleans accidental leftovers and bounds cost; it is not protection against an attacker.

- **Core.** It stops a started core whose setup failed, one that stays silent on several readiness probes past its startup grace ([HD-38](decisions/hosted_deployment.md#hd-38-the-guard-probes-a-core-several-times-within-one-run)), or one awake beyond the awake cap. It keeps the core the gate would use and destroys any other `role=core` Machine past the leftover grace, then deletes its volume ([HD-39](decisions/hosted_deployment.md#hd-39-the-guard-keeps-the-core-the-gate-would-use-not-the-newest)).
- **Runner.** It stops a runner started for longer than its maximum lifetime, keeps the newest `role=runner` Machine, and destroys older ones past the leftover grace.
- **Unknown Machines and volumes.** It destroys a Machine without its app's role on an `ok` host past the grace, and deletes a detached core volume. A role-less Machine on a host that is not `ok` is only logged ([HD-42](decisions/hosted_deployment.md#hd-42-the-guard-leaves-a-role-less-machine-on-a-down-host-alone)).
- **Leases.** Every stop and destroy runs under the Machine's lease, after reading the Machine again; a held lease or a changed Machine is skipped until the next run. On a host that is not `ok`, where Fly grants no usable lease, the guard only reads the Machine again before acting, without a lease ([HD-37](decisions/hosted_deployment.md#hd-37-the-guard-acts-only-under-a-machines-lease-and-skips-a-leased-one)). A core on a host that is not `ok` is never stopped.
- **Signal.** The guard has no alerting: its logs are the only signal of a failed run ([guard logs](hosted_operations.md#guard-logs-and-switches)).

---

## Deployment and Versioning

`infra/fly/deploy.mjs` deploys one commit to the three apps. It runs from the operator's workstation or from GitHub Actions. Its usage and failure messages are in [Hosted Operations](hosted_operations.md#deploying).

- **One version is one commit.** Every image is built, by default on Fly's remote builder, labelled `<service>-<commit-sha>` (plus `-dirty` and a build timestamp for an uncommitted tree), and pushed to its app's Fly registry ([HD-24](decisions/hosted_deployment.md#hd-24-deploys-build-remotely-and-replace-whole-machine-configs)).
- **Full configs, nothing started.** Machines are created and updated through the Machines API with their full config from `infra/fly/<app>/`, without being started. The script then waits until Fly has prepared them.
- **Sleeping core, under its lease.** After the builds, the script waits for an awake core to sleep (or stops it with `--force`), then updates the core and the runner under their leases ([HD-45](decisions/hosted_deployment.md#hd-45-the-deploy-updates-a-sleeping-core-under-its-lease-read-again-after-the-builds)). A wake during the builds is never interrupted, and a wake during the update shows the updating page.
- **Runner relocation.** A runner that already has the config to deploy is left untouched. When the runner's host has no room for the new config (a capacity refusal, or an update Fly reverts), the script creates a new runner from it on a host with room, in the home region or else elsewhere in Europe, then destroys the old one under its lease ([HD-55](decisions/hosted_deployment.md#hd-55-a-host-that-refuses-the-runners-new-config-relocates-the-runner-at-once)). The core cannot move this way, since its volume pins it to its host: on such a refusal the script marks it for recreation instead, so the next wake recreates it fresh and empty elsewhere, at the new version ([HD-56](decisions/hosted_deployment.md#hd-56-a-core-whose-host-refuses-the-deploy-is-marked-for-a-fresh-recreation)).
- **`all`** updates the runner, the core and the gate, the first two under the core lease, then compares the core's and the runner's versions and fails on a mismatch; a core marked for recreation counts at the version of the core config in the gate ([HD-46](decisions/hosted_deployment.md#hd-46-one-command-deploys-the-runner-and-the-core-together-and-a-version-mismatch-fails-the-deploy)).
- **Config copies for recovery.** A core deploy writes the runner's deployed config into the core's API container and the core's deployed config into the gate Machine; a gate deploy carries the latter over. A core deploy therefore needs the runner and the gate to exist.
- **Guard.** A gate deploy also creates or updates the guard, without `skip_launch`, which would stop Fly's scheduler from ever starting it ([HD-41](decisions/hosted_deployment.md#hd-41-the-guard-is-deployed-without-skip_launch)).
- **Continuous deployment.** GitHub Actions runs `deploy.mjs all` on every push to `main`, one deploy at a time ([HD-49](decisions/hosted_deployment.md#hd-49-github-actions-deploys-every-push-to-main-with-the-workstations-script)), with an organization deploy token ([HD-50](decisions/hosted_deployment.md#hd-50-the-ci-deploy-token-is-an-organization-deploy-token)).

---

## Secrets and Tokens

Machines read their app's secrets when they start. A multi-container Machine gives a container only the secrets its config lists, so each core container lists its own (`infra/fly/core/machine.json`).

| Where | Secret | Used by | Purpose |
| :-- | :-- | :-- | :-- |
| core app | `CONTROL_SERVICE_TOKEN` | API, web | Control calls between web, API and runner, in both directions with the runner |
| core app | `ADMIN_DASHBOARD_PASSPHRASE`, `ADMIN_SESSION_SECRET` | web | Admin sign-in and session |
| core app | `PUBLIC_CLIENT_COOKIE_SECRET` | API, web | Signed visitor cookie |
| core app | `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `DATABASE_URL`, `REDIS_URL` | databases, setup, API, worker, Mock ERP | Database access |
| core app | `RUNNER_FLY_API_TOKEN` | API | Runner-app deploy token: start, stop, update and recreate the runner |
| core app | `CORE_FLY_API_TOKEN` | API | Core-app deploy token: stop its own Machine |
| runner app | `CONTROL_SERVICE_TOKEN` | load orchestrator | Same value as the core's |
| gate app | `CORE_FLY_API_TOKEN` | gate, guard | Core-app deploy token: wake, recover, stop and clean the core |
| gate app | `RUNNER_FLY_API_TOKEN` | guard (the gate Machine receives it too) | Runner-app deploy token: stop and clean the runner ([HD-40](decisions/hosted_deployment.md#hd-40-accepted-risk-the-gate-machine-holds-the-guards-runner-token)) |
| GitHub repository | `FLY_API_TOKEN` | deploy workflow | Organization deploy token ([HD-50](decisions/hosted_deployment.md#hd-50-the-ci-deploy-token-is-an-organization-deploy-token)) |

Machines hold only app-scoped deploy tokens, never a personal or organization-wide token. Deploy access can read secrets, so a compromised gate means control of the core and runner apps; the exposure is financial ([HD-26](decisions/hosted_deployment.md#hd-26-accepted-risk-deploy-tokens-give-a-compromised-component-wide-control), [HD-33](decisions/hosted_deployment.md#hd-33-accepted-risk-core-secrets-reached-flys-build-cache)). Rotation is in [Hosted Operations](hosted_operations.md#rotating-secrets-and-tokens).

---

## Not Covered

- A custom domain for the gate. It can be added later with a DNS record and `flyctl certs add`.
- Managed data services: PostgreSQL and Redis stay inside the core.
- Per-run sizing of the generator: the runner has one configured size at a time.
- Starting the runner when a visitor opens the run launch screen, to hide its boot. This is a noted option, not implemented.
- Filtering bots once a visitor has woken the core: an accepted risk, revisited only on evidence from real traffic ([HD-03](decisions/hosted_deployment.md#hd-03-accepted-risk-bots-can-keep-an-awake-core-up)).
