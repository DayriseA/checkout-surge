# Hosted Deployment Design

**Status:** design decided on 2026-10-02, not implemented. The work is split into the tasks listed in [README.md](README.md). Once the deployment exists, the parts that describe implemented behavior move into `docs/`.

**Platform facts:** the Fly.io facts cited here were checked against official documentation, Fly's own client source code, community reports and one live header test between 2026-09-30 and 2026-10-02. Facts marked *unverified* must be confirmed during the feasibility test.

---

## Goals and Constraints

- **Usage.** The demo runs a few hours per month at most, and some months not at all. Idle cost must be near zero, and waking must be fast.
- **Credibility.** The deployed demo must be technically credible to a recruiter. Hosting limits are presented as deliberate choices, not unknown ceilings.
- **Isolation.** The load generator (load-orchestrator plus k6) never shares CPU or memory with the system under test. This is a design principle, not a hosting optimization.
- **Hosted first.** The hosted deployment is the product's real runtime, and its needs take priority. The local Compose topology is a development convenience: it keeps working, but it adapts whenever the hosted runtime requires it.
- **Data.** Run history and admin edits are cosmetic for this demo. Losing them is acceptable.
- **Cost.** The order of magnitude (a few euros per month) is validated. No further estimation work is planned.

## Topology

```text
Visitor ── portfolio link ──▶ https://<gate-app>.fly.dev   (only public address)
                                   │
                ┌──────────────────▼──────────────────┐
  gate app      │ Gate Machine (small, Fly Proxy       │      Guard Machine (scheduled hourly,
                │ autostart/autostop)                  │      same image, one-shot entrypoint)
                │ - start/booting/error pages          │
                │ - wakes the core (Machines API)      │
                │ - relays all traffic once ready      │
                └──────────────────┬──────────────────┘
                                   │ 6PN (IPv6), to the authoritative core Machine ID
                ┌──────────────────▼──────────────────┐
  core app      │ Core Machine (multi-container,       │
                │ performance 4 vCPU / 8 GB, volume)   │
                │ Caddy ─▶ web (Next.js), API (SSE)    │
                │ API, worker, Mock ERP, Redis,        │
                │ PostgreSQL, setup (migrate + seed)   │
                └──────────────────▲──────────────────┘
                   10k burst,      │ start / shutdown / status / abort
                   metrics,        │ (API → runner, 6PN)
                   completion      │
                ┌──────────────────┴──────────────────┐
  runner app    │ Runner Machine (fixed, no volume,    │
                │ performance 4 vCPU / 8 GB)           │
                │ load-orchestrator + k6 child process │
                └──────────────────────────────────────┘
```

| App | Machines | Public address | Volume | Autostart |
| :-- | :-- | :-- | :-- | :-- |
| gate | gate (HTTP server), guard (scheduled hourly) | yes, `<gate-app>.fly.dev` | no | gate: yes, through Fly Proxy |
| core | one authoritative core | no | yes | no |
| runner | one fixed runner | no | no | no |

## Decision Summary

| Area | Decision | Rationale |
| :-- | :-- | :-- |
| Provider | Fly.io, region `cdg` | Fast start of stopped Machines, per-second billing, private networking. AWS EC2 stop/start was rejected: slower to start and not cheaper. |
| Isolation | Separate core and runner Machines | The generator must never compete with the system under test. |
| Sizes | Both Machines start at dedicated 4 vCPU / 8 GB | Shared CPUs are throttled past their baseline quota, which would distort a 10k burst. Sizes are adjusted after measurement. |
| Run limits | `DEMO_MAX_*` deployment caps | The existing mechanism. `surge-10k` is the reference scenario. |
| Entry point | The gate is the only public address and relays all traffic | Bots cannot wake the core. Any URL shows our own page while the core is not ready. |
| Core wake | Only the gate starts the core, after a deliberate visitor action | No wake quota, so legitimate visitors are never refused. |
| Core stop | The API stops its own Machine after 10 minutes of inactivity, with no nonterminal run | Fly Proxy autostop only sees HTTP traffic and would cut a run still settling orders. |
| Core packaging | Fly multi-container Machine, with a `supervisord` single image as fallback | Reuses the per-service images and expresses readiness dependencies natively. |
| Core storage | Volume, disposable on failure | Disk performance in normal operation. Recovery recreates a fresh core instead of restoring data. |
| Runner | One fixed Machine, no volume, started and stopped by the API for each run | Fast start, less host-pinning risk, and a fresh kernel socket state for every run. |
| Runner loss | Boot-ID fencing and an immediate `load_generator_lost` failure | Traffic is never relaunched silently, and missing evidence is never shown as zeros. |
| Provider capacity | Detected, retried, relocated within Europe, and explained to the visitor | Responsibility stays clear: the demo is not "broken". |
| Versions | One commit per deployment, plus a core/runner version handshake | A partial deployment refuses runs instead of producing wrong evidence. |
| Deployment | Local script first, GitHub Actions near the end | Fast iteration during the build-out. |

---

## 1. Platform, Sizing and Limits

### 1.1 Machine sizes

- Both Machines use dedicated (performance) CPUs and start at 4 vCPU / 8 GB.
- Sizes are configuration, kept separate from run limits.
- **Runner.**
  - CPU kind, vCPU count and RAM come from API environment variables.
  - Before each start, the API compares the runner Machine's size with these values and updates only the size if they differ. That is safe because the runner has no volume. The image version is owned by deployments (section 8).
  - The same values are used when the runner is recreated after a capacity failure.
  - Changing the variables takes effect on the next run, with no commit.
- **Core.**
  - Resized manually with flyctl from the owner's workstation (`fly machine update --vm-size ...`), keeping the Machine stopped.
  - This is not automated, because resizing a volume-pinned Machine can fail on a full host, and changes are rare.

### 1.2 Run limits

- Hosted run limits come from the existing deployment caps (`DEMO_MAX_*`).
- `PUBLIC_CUSTOM_*` only bootstraps the public runtime policy on first seed. After that, the policy is edited from the admin UI, and the seed keeps the existing row.
- The API refuses to start when the persisted public policy exceeds the deployment caps. Lower the policy before lowering the caps.
- The UI explains that a limit was chosen for hosting reasons, inviting the user to run the project locally or on more ambitious infrastructure. It shows this message only for deployment-cap rejections (`*_exceeds_deployment_cap`), never for invalid input.
- `surge-10k` is the reference scenario. Caps, including those for constant-arrival runs, are tuned after measuring on the deployed infrastructure.

### 1.3 Hosted-only behavior and the local topology

- **Selected by configuration.** Each service picks its implementation at its composition root. The code has no scattered hosted-or-local checks.
- **Runner host.** The API drives the runner through one interface with two implementations:
  - Fly: it starts, stops, updates and recreates the runner Machine;
  - local: the runner is always on. Starting it only checks that it is ready, and stopping it does nothing.
- **Off unless configured:** the runner's self-exit timers, the per-run shutdown, and the core's idle stop. The local topology leaves them off, and the countdown widget is not shown.
- **Active everywhere:** the boot ID and its checks, the `load_generator_lost` failure on a boot-ID change, and the version handshake.
- **Accepted cost.** Local tests never start or stop a Machine. Unit tests cover that path with a fake runner host, and the rest is verified on Fly.

---

## 2. Gate

### 2.1 Single entry point and relay

- **One public address.** The gate's `<gate-app>.fly.dev` is the only public address, with automatic HTTPS. A custom domain is out of scope for this project: it is cosmetic and can be added later with a DNS record and `fly certs add`. The portfolio site links to the `fly.dev` address.
- **What the gate relays.** It relays all visitor traffic (pages, API, SSE) to the core's Caddy over Fly's private network. It relays bytes only: the core's web app still renders the demo.
- **Relay target.** The gate targets the Machine ID of the authoritative core (section 3.6), never `<core-app>.internal`.
- **No public core.** The core has no public address, so bots can neither reach it nor wake it directly.
- **Not on the load path.** The k6 burst goes from the runner straight to the core's API, so it never crosses the gate.
- **Gate lifetime.** The gate stays awake while visitors are connected and sleeps through Fly Proxy autostop. Autostop fits the gate because all its traffic goes through the proxy.
- **Implementation.** One TypeScript program in the monorepo (`apps/gate`) serves the pages, calls the Machines API and relays traffic through a proven proxy library.
- **Rejected implementations.**
  - Caddy plus a separate program: two processes to supervise, and to keep in sync on the core's state and address.
  - `fly-replay`, where Fly Proxy routes to the core itself: its interaction with a no-autostart core and with SSE is undocumented, and visitors would see Fly's error pages instead of ours.

### 2.2 Waking the core

- The core has no autostart, neither public nor private.
- Only the gate starts the core through the Machines API, after a deliberate visitor action: a button that sends a POST.
- There is no wake quota.
- Before starting or recovering the core, the gate takes a Fly lease on the core Machine (section 3.6).

### 2.3 Gate pages

For any URL, including bookmarks and browser history, the gate serves its own page whenever the core is not ready:

- **Stopped:** a button to start the demo.
- **Booting:** "starting the infrastructure".
- **Updating:** "update in progress, retry shortly". This is shown when a deployment holds the lease.
- **Relocating:** "provider capacity issue, relocating the demo, please wait".
- **No capacity in Europe:** a provider message linking to https://status.flyio.net/ and inviting the visitor to come back later.
- **Setup failure:** a clear error when migrations or seed fail.

### 2.4 Visitor IP propagation

- **What depends on the visitor IP.** Only two things:
  - the per-source SSE cap (6 connections per normalized network source);
  - the dashboard recovery fallback used when no visitor credential is presented.

  Public run budgets rely on the signed visitor cookie, not on the IP.
- **Trust chain.** Each hop trusts only the previous one:
  1. Fly Proxy sets `Fly-Client-IP`.
  2. The gate uses `Fly-Client-IP` only. It overwrites any client-supplied forwarding headers and forwards that single value.
  3. The core's Caddy trusts only the gate's private address.
  4. The API trusts only the core's Caddy, over loopback. `API_TRUSTED_PROXY_CIDRS` changes from the Compose-pinned Caddy address to loopback.
- **Verified on 2026-10-02** with a live test against debug.fly.dev:
  - Fly Proxy overwrites a client-supplied `Fly-Client-IP`.
  - Fly Proxy appends to `X-Forwarded-For`, so that header can carry forged values.

### 2.5 Bot handling

- **Bots cannot wake the core.** Once a visitor has woken it, though, the gate relays bot requests too. Those requests can extend the awake time up to the guard's 3-hour cap. Public run budgets already bound what such traffic can trigger. This is an accepted risk for now.
- **End-of-project task, conditional on evidence.** After a few days of real traffic, check the gate logs and Fly metrics. If bots do reach the awake core, add a signed session cookie set by the wake button: the gate then relays only requests that carry it and shows its own page to everything else. Further protection (for example Turnstile) is added only if metrics show a need.

---

## 3. Core

### 3.1 Packaging

- **Choice.** A Fly multi-container Machine that reuses the existing per-service images, with a dedicated Fly config. Images are built and pushed separately and referenced by version. The Compose-to-Fly conversion path is not used.
- **Fallback.** A single image with `supervisord`, if multi-container needs heavy workarounds for the volume, the startup dependencies or the shutdown.
- **Rejected.**
  - Machine `config.processes`: it still needs a shared image and has no readiness dependencies.
  - `fly.toml` `[processes]` groups: each group gets its own Machines.
  - Docker Compose inside a Machine.

### 3.2 Boot sequence

- **Every boot runs the same sequence:**
  1. PostgreSQL and Redis become healthy.
  2. The setup container runs migrations (`db:migrate`) then the seed, and exits successfully.
  3. The API, worker and Mock ERP start. All three use the database.

  This is expressed with `depends_on` conditions (`healthy`, `exited_successfully`) and reapplied on every Machine start. It is the same sequence as `runtime:setup`, so a first install needs no manual step.
- **Prerequisite.** The catalog (out-of-run) purchase mode is removed before deployment. That is a separate task.
- **After that removal, the seed is idempotent** on an existing database:
  - the product is rewritten identically;
  - public, non-editable presets are realigned with their code definition, so changing one means a commit plus a deploy;
  - editable admin presets keep operator edits;
  - the public runtime policy is inserted only when missing.

  Accepted runs are unaffected, because they use a frozen configuration snapshot.
- **Setup failure.** If migrations or the seed fail, the API, worker and Mock ERP do not start. The API port stays closed, including on 6PN, and the gate shows a setup-failure page.
- **Incompatible pre-release changes** recreate a fresh core through the recovery path (section 3.5), triggered deliberately by the deploy command (section 8).

### 3.3 Storage

- **Volume.** PostgreSQL and Redis data live on one Fly volume, in separate subdirectories (for example `/persistent/postgres` and `/persistent/redis`).
- **Why not rootfs.** A performance-4x volume gets up to 16,000 IOPS and 64 MiB/s, while rootfs is capped at 2,000 IOPS and 8 MiB/s. These are documented maxima, not guarantees.
- **Persistence.** History and admin edits survive between sessions, but nothing depends on them.
- **No restore path.** There is no volume fork and no snapshot restore. Fly's default daily snapshots stay enabled, but nothing relies on them.

### 3.4 Idle stop and countdown

- **Who stops the core.** The API stops its own Machine through the Machines API.
- **Stop condition:** no nonterminal run, and no counted activity for 10 minutes.
  - **Counted:** any HTTP request to the core, on any page, and the "stay awake" button.
  - **Not counted:** healthchecks, the countdown widget's status polling, the gate's readiness probes, and open SSE connections.
- **Countdown widget, shown on every page.**
  - It says the system is awake and will sleep after mm:ss without activity.
  - A "stay awake" button resets the deadline.
  - The deadline is owned by the API, and the widget only displays it. Several visitors share one core, and anyone's activity extends the deadline for all of them.
  - It polls a lightweight status endpoint, for example every 30 s.
  - While a run is nonterminal, it shows "run in progress, the system stays awake" instead of the countdown.
  - It shows a visual alert during the last 2 minutes.
- **Stopped core.** A page left open on a stopped core shows "Demo paused", with a link back to the gate.

### 3.5 Automatic recovery

The gate owns recovery, because the owner will not be around to repair manually.

1. **Retry.** Retry `start` 2-3 times with back-off.
2. **Recreate.** On a capacity or dead-host classification (section 6):
   - create a fresh, empty volume, with the `compute` hint matching the core's current size so it lands on a host that can run the core;
   - create a new core Machine on it, reusing the old Machine's configuration (size and image versions), with region list `cdg,eu`;
   - retire the old Machine and volume. The old core is destroyed once the new one is healthy, or force-destroyed if its host is dead.
   - A volume left without a Machine after a failed creation is cleaned up.
3. **Fresh install.** The new core boots with migrations and seed, so it comes back as a fresh install.

Live failure detection cannot be tested without a real Fly capacity incident. The recovery path can be tested by triggering it deliberately.

### 3.6 Authoritative core and coordination

- **One authoritative core.** It is the one started, healthy Machine with `role=core` metadata in the core app.
  - The gate, the guard, the API and the deploy script find it through the app name plus that metadata, never through a hardcoded Machine ID or IP.
  - Two cores are never started at the same time.
- **Lease coordination.** The gate (start, recovery) and the deploy script (update) coordinate through a Fly lease on the core Machine.
  - Whoever finds the lease held waits: the gate shows "updating", and the script retries.
  - The lease TTL is not documented, so we set it explicitly and renew it.
  - Leases are advisory, not a security boundary. They work between our own cooperating clients: a start without the nonce is rejected (verified 2026-10-02).

### 3.7 Kernel limits and networking

- **`nofile` must be raised inside the API's own container,** because rlimits are not inherited across containers. That needs a small Fly variant of the API image: a root entrypoint raises the limit, then drops to `node`. Fly's historical default hard limit is 10,240, right at a 10k burst.
- **`somaxconn`** is set for the Machine's shared network namespace before the API listens.
- **IPv6 listening.** The API and the core's Caddy listen on IPv6 (`::`) as well as IPv4, so the runner and the gate can reach them over 6PN.
- **No dependency on the load-orchestrator.** Unlike Compose, the core's web container does not depend on the load-orchestrator, which runs on another Machine.
- **`apiBaseUrl`.** The API derives the `apiBaseUrl` it gives the runner from its own 6PN address at runtime, never `localhost`.

---

## 4. Runner

### 4.1 Lifetime and start

- **One fixed Machine with no volume, stopped between runs.**
  - Without a volume, the runner is not pinned to a host: it can be re-placed or recreated if a host lacks capacity.
  - The accepted cost is that a runner crash mid-run can lose the final k6 report (section 4.3).
- **The API starts the runner** explicitly through the Machines API when a run starts. The runner has no autostart, neither public nor Flycast, which lets our code see and classify capacity errors.
- **Every run starts from a stopped runner, with a fresh boot.**
  - If the runner is still running, it is shut down first, the API waits for `stopped`, then starts it.
  - A fresh boot clears kernel socket state between runs: a `surge-10k` run leaves 10,000-20,000 sockets in TIME_WAIT.
- **Before each start, the API sets:**
  - the runner's size (section 1.1);
  - the runner's `API_BASE_URL`, which is the core's current 6PN address for metrics and completion. That address is fixed at runner boot, independently of the `apiBaseUrl` k6 targets, and it changes when the core is recreated.
- **Noted option, not decided: runner pre-start.** If the runner boot hurts the experience, the API can start the runner as soon as a visitor opens the run launch screen. The change is local to the start trigger.

### 4.2 Operations owner and stop

- **One owner, one operation at a time.** A single owner in the API runs every runner operation: start, shutdown, Fly stop and update.
  - In-process serialization is enough under the single-API-process contract.
  - The owner holds a Fly lease during each operation, to coordinate with the deploy script.
- **Primary stop.** The owner shuts the runner down as soon as the run reaches any terminal state: finalization, failure, admin reset or automatic reset.
- **Fenced shutdown.** A normal shutdown goes through the runner itself: `shutdown(runId, bootId)`.
  - The runner exits only if the request matches its current boot, and ignores it otherwise. Its restart policy is `no`, so the Machine stops.
  - A late stop for run N therefore cannot kill the runner of run N+1. Fly's `stop` has no fencing parameter (verified 2026-10-02).
- **Fly `stop` is only a fallback** for an unreachable runner. It is issued by the same owner, so it always runs before any later start.
- **Self-stop fallback.** The runner enforces it itself, so it still works when the API is down:
  - it exits after 3 minutes with no execution and no completion report awaiting acknowledgement (an arbitrary starting value);
  - its maximum lifetime is the automatic-reset deadline plus a small margin, read from the shared `automaticRunResetDeadlineSeconds` constant (900 s), never duplicated.
- **Abort on a stopped runner.**
  - Admin and automatic resets call `abortCurrent` for every run they terminate. Today that call fails when the load-orchestrator is unreachable.
  - A stopped runner cannot emit traffic, so the abort path checks the Machine state first and treats a stopped runner as a confirmed abort.
- **Finalization does not need the runner.** The API persists the completion report before acknowledging it.

### 4.3 Boot identity and runner loss

- **No automatic restart.** The runner uses restart policy `no`, so a crash leaves the Machine stopped.
- **Boot identity.**
  - The runner generates a boot ID at process start. Fly provides no per-boot identifier.
  - Before sending `start`, the API reads the boot ID and persists it with the run.
  - Every start or replay carries the expected boot ID, and the runner rejects a mismatch. A rebooted runner can never relaunch traffic for a run.
- **Fast detection.**
  - While a run is active, the API monitors its runner.
  - The runner is declared lost if its Machine is stopped, or its boot ID changed, before a completion report was persisted.
  - The API then closes admission, treats the abort as confirmed, and terminalizes the run immediately as failed with reason `load_generator_lost`, without waiting for the 900 s automatic reset.
  - If the runner is merely unreachable while its Machine is started, the state is uncertain. After about 60 s, the API stops it through Fly, then applies the same rule.
- **Report already persisted.** If the run is draining, finalization continues normally.
- **Missing evidence is unavailable, never zero.**
  - Traffic counters without a k6 report are explicitly unknown, across contracts, persistence and UI.
  - This also applies to an admin or automatic reset during traffic. Today `syntheticFailedTrafficSummary` (`apps/api/src/services/traffic-delivery-plan.ts`) writes `startedRequests: 0` even when traffic happened.

### 4.4 Capacity failures and region

- **Recovery.**
  1. Retry `start` 2-3 times with back-off.
  2. Recreate a fresh, volume-less runner with region list "the core's current region, then `eu`" (`cdg,eu` while the core is in cdg).
  3. Retire the old runner.
- **The runner follows the core** if the core is relocated.
- **Region evidence.** The run records the runner's actual region, and the UI shows it, because a runner outside the core's region adds latency between k6 and the API. Measure it rather than assume it.
- **UX.**
  - While relocating, show "provider capacity issue, relocating the load generator, please wait".
  - If Europe has no capacity, show the provider message linking to https://status.flyio.net/, invite the user to come back later, and start no traffic.

### 4.5 Kernel limits and networking

- **Image.** A Fly variant of the load-orchestrator image uses a root entrypoint. It recreates what Compose configures today, then drops to `node`:
  - raise the `nofile` hard limit, which k6 inherits through Node;
  - set `net.ipv4.ip_local_port_range` (`10240 65535`) and `net.ipv4.tcp_tw_reuse` (`1`).
- **IPv6 listening.** The load-orchestrator listens on IPv6 (`::`), so the API can reach it over 6PN.

---

## 5. Guard

- **Scheduling.** A scheduled Fly Machine in the gate app runs hourly. It uses the gate image with a one-shot entrypoint and shares the Machines API client and config. A crash of the gate server does not affect it.
- **Stopping the core.** It stops the core if either of these holds:
  - the core stays unreachable across several probes a few minutes apart, after a startup grace period. Several probes keep a core saturated by a 10k burst from being mistaken for a dead one;
  - the core has been awake for more than 3 hours. That only happens on a bug, and the core can always be restarted through the gate.
- **Stopping the runner.** It stops a runner that has been started for longer than its maximum lifetime, in case the runner's own timer is stuck.
- **Unexpected Machines.**
  - It destroys unexpected Machines in the core and runner apps.
  - Expected Machines carry a role tag in metadata, set by our code.
  - A Machine without a known role, or beyond the expected count and older than a short grace period, is destroyed. The grace period keeps legitimate recovery and replacement Machines safe.
  - This is cleanup of accidental leftovers, not protection against an attacker, who could set the same metadata.
- **Tokens.** It needs tokens for both the core and runner apps.

---

## 6. Fly Error Classification

There is no official error contract. The classifier is best-effort and maintained over time. It lives with the Machines API client in one shared package, `packages/fly-machines`, used by the API, the gate, the guard and the deploy script. That package holds the Fly calls, their types, the leases and the classifier, and no business rule: the runner and core recovery sequences stay with their owners.

| Signal | Classification |
| :-- | :-- |
| Create returns `status: insufficient_capacity` (422) or `volume_placement_capacity` (412) | Provider capacity |
| Start returns a bare 409 with a known phrase: "insufficient CPUs/memory/IPs available", "insufficient resources available", "could not reserve resource for machine", "governor policy blocked start", "deploys to this host are temporarily disabled", or text ending in "no capacity" | Provider capacity |
| 408, or `host_status: "unreachable"` | Dead or unreachable host |
| 429 and 5xx | Transient, retried |
| 409 without a capacity phrase (lease or version conflict) | Conflict. Never triggers a recreation |
| Anything else from Fly | Unclassified provider error, shown as such |
| Any other 4xx, or a non-zero exit after start | Our own error |

---

## 7. Tokens, Secrets and Accepted Risk

### 7.1 Secrets

Application secrets are stored as Fly secrets, per app:

- **Core:**
  - `CONTROL_SERVICE_TOKEN`;
  - `ADMIN_DASHBOARD_PASSPHRASE`;
  - `ADMIN_SESSION_SECRET`;
  - `PUBLIC_CLIENT_COOKIE_SECRET`;
  - generated PostgreSQL and Redis passwords.

  Per-container secret selection (for example, Mock ERP without the admin secrets) is a nice-to-have.
- **Runner:** only `CONTROL_SERVICE_TOKEN`. It authenticates both directions: the API's control calls, and the runner's metrics and completion.

### 7.2 Machines API tokens

Machines API tokens are app-scoped deploy tokens:

| Holder | App | Use |
| :-- | :-- | :-- |
| API (core) | runner | start, shutdown fallback, update, recreate the runner |
| API (core) | core | stop its own Machine |
| Gate and guard | core | start, recover, stop the core, clean unexpected Machines |
| Guard | runner | stop an overdue runner, clean unexpected Machines |

- **Narrower tokens.** Attenuate tokens to specific actions if Fly makes that simple. This is not required, because the caveat schema is undocumented.
- **No broad tokens.** No personal or org-wide token ever goes into a Machine.
- **Rotation.** The procedure is documented. `CONTROL_SERVICE_TOKEN` changes on the core and the runner together.

### 7.3 Accepted risk

- **Deploy access can read secrets.** Deploy access can run code that reads secrets, as Fly's secrets documentation states.
- **Blast radius.** The gate is the only always-exposed component. A compromised gate means full control of the core app, including its secrets. Through the runner-app token held by the core, it also means control of the runner app.
- **Impact.** No sensitive data is involved, so the exposure is financial.
- **Mitigations:**
  - a minimal gate surface;
  - the guard's cleanup;
  - billing controls configured in the Fly dashboard.

---

## 8. Deployment and Versioning

- **One version is one commit.** Every image (core services, runner, gate) is built, tagged with the same commit SHA and pushed to the Fly registry.
- **Stopped Machines** are updated through the Machines API without being started (`skip_launch`). Updates take a freshly read full config. Migrations apply on the next core start.
- **Awake core.** Deployment waits until the core goes to sleep. With `--force`, it interrupts the session and updates immediately, and an in-progress run ends failed. The deploy script holds the core lease during the update (section 3.6).
- **Version handshake.**
  - Before starting a run, the API compares its own commit with the runner's and refuses the run with a clear message if they differ. A partial deployment therefore leaves the demo refusing runs, rather than producing wrong evidence, until a redeploy.
  - The deploy script verifies both versions at the end.
- **Incompatible changes** use the recovery path (section 3.5) to recreate a fresh, empty core. The same command deliberately tests that path. It replaces the manual wipe-and-rebuild procedure for the hosted runtime.
- **Where deployments run.**
  - During the build-out: a local script (for example `pnpm deploy:fly`), run from the owner's workstation with flyctl.
  - Near the end of the project: GitHub Actions, calling the same script.

---

## 9. Repository Impact

This section lists the changes implied by the decisions above, grouped by owner. It is not a task breakdown: tasks are listed in [README.md](README.md).

- **Prerequisite (separate task):** remove the catalog (out-of-run) purchase mode.
- **`apps/api`:**
  - a runner operations owner, which holds the Machines API client, serialization and leases. It is responsible for:
    - size and `API_BASE_URL` updates;
    - boot-ID persistence and checks;
    - the fenced shutdown and the Fly stop fallback;
    - monitoring active runs and failing them with `load_generator_lost`;
    - capacity classification and recovery, and recording the runner's region;
    - the version handshake;
  - an abort path that treats a stopped runner as confirmed;
  - an idle-shutdown owner that tracks counted activity, serves the countdown status and "stay awake" endpoints, and stops its own Machine;
  - IPv6 listening;
  - the `apiBaseUrl` derived from the 6PN address;
  - hosted `API_TRUSTED_PROXY_CIDRS`;
  - unavailable traffic evidence for runner loss and for resets during traffic;
  - a Fly variant of the API image (`nofile`).
- **`apps/load-orchestrator`:**
  - boot ID generation and checks;
  - the fenced `shutdown` endpoint;
  - the 3-minute idle and maximum-lifetime self-exit;
  - exposing its commit SHA;
  - IPv6 listening;
  - a Fly image variant (`nofile`, port range, `tcp_tw_reuse`).
- **`packages/contracts`:**
  - the `load_generator_lost` failure reason;
  - unknown traffic counters;
  - runner region evidence;
  - boot ID and version fields in the runner control contracts;
  - the countdown status schema.
- **`packages/db`:**
  - per-run runner identity: Machine, boot ID and region;
  - unknown counters in persisted summaries.
- **`apps/web`:**
  - the countdown widget and the "Demo paused" state;
  - the deployment-cap message;
  - runner relocation and provider-capacity messages;
  - a version-mismatch message;
  - unavailable evidence display;
  - runner region display.
- **New `packages/fly-machines`:** the Machines API client, its types, the leases and the error classifier.
- **New gate app (`apps/gate`):** the gate server (relay, pages, wake, recovery, lease) and the guard entrypoint.
- **Infrastructure:**
  - everything Fly-specific lives under `infra/fly/`, with one subfolder per Fly app (`core/`, `runner/`, `gate/`): Machine config JSON files, entrypoint scripts, and the gate's `fly.toml`. No `fly.toml` sits at an app root. Every flyctl command passes `-a` and an explicit config path, never relying on current-directory discovery;
  - the Fly image variants of the API and the load-orchestrator are extra `runtime-fly` targets built on top of the existing `runtime` targets, so nothing is duplicated and a refused kernel setting fails the start loudly;
  - a hosted Caddy variant (IPv6, trusting only the gate), kept with the other Caddyfiles in `infra/caddy/`;
  - the deploy script.
- **Documentation:** once the design is implemented, update the hosted-deployment boundary in `docs/runtime_topology.md` and the caveats in `docs/scope_and_caveats.md`.

---

## 10. Feasibility Test Checklist

Run this before the full implementation. Every item is unverified until tested on the target Fly organization.

- **Access.** Multi-container Machines are available to the organization. The access requirement was lifted in April 2025, but the API model still mentions an organization restriction.
- **Startup gate.** The `depends_on` barrier is reapplied on every start. A deliberately failing migration or seed leaves the API port closed, including on 6PN.
- **Shared volume.** UID/GID ownership works for both PostgreSQL and Redis subdirectories. No entrypoint recursively re-owns the other service's data.
- **Limits.**
  - Measure `nofile` (soft and hard) in `/proc/<pid>/limits` for the API process and for k6.
  - Check that `somaxconn`, `ip_local_port_range` and `tcp_tw_reuse` take effect.
- **Graceful stop.** Fly's default `kill_timeout` is 5 s and best-effort. Application containers must drain before PostgreSQL and Redis stop. PostgreSQL and the Redis AOF must recover after a stop under activity.
- **Crashes.** Kill the API, worker, PostgreSQL and Redis in turn, and observe restarts and dependency state.
- **Leases.** Check the status code returned by start, stop and destroy without the nonce, and the behavior of an expired lease.
- **Timing.**
  - Measure the time from `start` to core ready, and from runner `start` to load-orchestrator ready.
  - Run the 10k IPv6 connection burst from the runner.
- **Recovery.** Trigger core and runner recreation deliberately.

---

## Out of Scope

- Recordings or screenshots of a run on the portfolio site.
- A custom domain for the gate.
- Managed third-party data services: PostgreSQL and Redis stay inside the core.
- Per-run sizing of the generator. The runner has one configured size at a time.
