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
- The UI explains that a limit was chosen for hosting reasons, inviting the user to run the project locally or on larger infrastructure. It shows this message for run rejections with `deployment_*_exceeded` codes and with the public load-size codes (buyers, duration, max VUs, preallocated VUs, request rate, total requests, start delay); never for ERP limits, starting stock, or invalid input. On a rejected custom run, the form still flags the offending field and shows the message alongside. The custom run form also carries a fixed hint line stating that its limits were chosen for the demo's infrastructure, with the same invitation. `*_exceeds_deployment_cap` codes are admin policy-edit rejections and keep the ordinary validation message.
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
- **Implemented in task 09.**
  - A Fastify server relaying with `@fastify/reply-from` (undici). Request bodies pass through as raw streams; the library's default retries (GET answers 503 replayed up to 10 times) are turned off, so the core's own errors reach the visitor once. The relay target is `http://[<private_ip>]:8080`, the 6PN address the Machines API reports for the authoritative core, so no internal DNS is involved.
  - The core status is read from the Machines API (3 s request timeout for these reads; the wake keeps the client's 30 s) plus a readiness probe of Caddy's `/health` (2 s timeout), and cached: 10 s while ready, 2 s otherwise. A failed relay (refused, reset, or the 3 s connect timeout, which is what a stopped Machine's 6PN address gives: it does not refuse, it stays silent) drops the cache and answers with the page for a fresh status.
  - **The Machines API is not on the relay path of a ready core (owner decision, 2026-10-05, HD-28).** The API has no SLA on standard plans and roughly monthly outages, while running Machines and 6PN usually keep working. While the last status is ready, a failed or timed-out Fly read, or a probe with no answer at all, keeps that status and the read is retried on the next cycle; a probe that answers non-OK still means booting. During a Machines API outage, a stopped core cannot be woken.
  - The gate is a `shared-cpu-1x` 256 MB Machine (`role=gate`) with a Fly Proxy service: ports 80 (forced HTTPS) and 443, `autostart`, `autostop: stop`, `min_machines_running: 0`, request concurrency 200 soft / 250 hard. Measured: the Node process uses about 93 MB (peak 102 MB) of 212 MB; a request on a stopped gate is answered in 4.3 to 4.9 s (Machine start 1.4 s, Node listening 2.5 s later), and Fly Proxy autostopped the gate about 5.5 minutes after its last request.

### 2.2 Waking the core

- The core has no autostart, neither public nor private.
- Only the gate starts the core through the Machines API, after a deliberate visitor action: a button that sends a POST.
- There is no wake quota.
- Before starting or recovering the core, the gate takes a Fly lease on the core Machine (section 3.6).
- **Implemented in task 09.** The button posts to the gate-owned path `/__gate/start?return=<path>`; every other path belongs to the core. Wakes are joined in-process, so visitors pressing together send one start. Under a lease whose 180 s TTL covers the worst case of the wake's own calls at the client's timeouts (task 10 review; it was 60 s), the gate reads the Machine again, waits up to 30 s for a core still `stopping` (its own idle stop), sends `start`, releases the lease, then answers 303 to the return path, which must be a same-site path (anything else returns to `/`). A held lease (409, `conflict`) shows the updating page. A failed start shows the unavailable page. Measured: the POST answers in 1.5 s, and the demo page is relayed 12.1 s after it.
- **Retries and recovery (task 10).** Under that lease, `start` is tried 3 times, with 1 s then 3 s back-off on capacity, dead-host and transient errors. Capacity and dead-host failures, or a core marked `recreate=requested`, start the recovery (section 3.5) in the background; the POST then answers 303 like a start, and every URL shows the relocating page until the recovery ends. A core whose `host_status` is not `ok` is recreated at once **without taking its lease**: Fly's own tooling skips leasing such Machines (flyctl `internal/machine/lease.go`: "Skip leasing for unreachable machines"). When the listing answers with no `role=core` Machine at all (a dead core whose partial config lost its metadata, or a core deleted by hand), the wake creates a core the same way, with no old Machine: no lease, nothing destroyed or deleted (owner decision, 2026-10-05). Without the deployed core config file in the gate, a recovery cannot start and the unavailable page shows; a failed listing also shows it. Any other failure shows the unavailable page.

### 2.3 Gate pages

For any URL, including bookmarks and browser history, the gate serves its own page whenever the core is not ready:

- **Stopped:** a button to start the demo.
- **Booting:** "starting the infrastructure".
- **Updating:** "update in progress, retry shortly". This is shown when a deployment holds the lease.
- **Relocating:** "provider capacity issue, relocating the demo, please wait".
- **No capacity in Europe:** a provider message linking to https://status.flyio.net/ and inviting the visitor to come back later.
- **Setup failure:** a clear error when migrations or seed fail. The Machine stays `started` in that case, so the gate detects the failure through `containers[].state` in the Machines API (the setup container `stopped` with a non-zero exit, its dependents never started).

**Implemented in task 09**, relocating and no capacity in task 10. Every gate page answers 503 with `Cache-Control: no-store`, for any method and URL, and never starts the core.

| Page | When |
| :-- | :-- |
| Stopped (start button) | The core Machine is `stopped` or `stopping`, or its `host_status` is not `ok`, or no `role=core` Machine is listed (the button then recreates it) |
| Booting (reloads every 3 s) | `starting`, or `started` while Caddy's `/health` does not answer |
| Updating (retry button) | `created` or `replacing` (a deploy is writing its config), or the wake found the lease held |
| Relocating (reloads every 5 s) | A recovery runs in the gate (task 10), whatever the core's state |
| Fresh install (reloads every 5 s) | The recovery runs because the core carries the `recreate=requested` mark (task 12, owner decision 2026-10-06): the same recovery, without the provider-capacity wording |
| No capacity (retry button, link to the Fly.io status page) | The last recovery was refused for capacity; held until the next wake |
| Setup failure | `started`, and the `setup` container has an `exited` event with a non-zero `exit_code` no older than the Machine's latest `start` event |
| Unavailable (try again) | Another state, a Machines API failure, a failed start, or a recovery without the deployed core config |

The setup check reads container events rather than `containers[].state`, because `setup` is `stopped` after a successful run too. An open demo tab on a stopped core gets the gate page as the answer to its polling, which the countdown widget reads as "Demo paused".

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
- **Implemented in task 09.**
  - The gate drops `Forwarded`, `X-Forwarded-For`, `-Host`, `-Port`, `-Proto`, `-Ssl`, `X-Real-IP` and `Fly-Client-IP`, then sends `X-Forwarded-For: <Fly-Client-IP>` and `X-Forwarded-Proto: https`, and keeps the visitor's `Host`.
  - **Step 3, settled (owner decision, 2026-10-05): the core's Caddy trusts the whole 6PN range (`fdaa::/16`), not the gate's address** (HD-32). A Machine's 6PN address is derived from its host (Fly documents that it can change when a Machine moves), and 6PN addresses carry no app prefix: the gate, core and runner all sit in the organization's `fdaa:ce:227b:a7b::/64`. 6PN is isolated per organization, and the trusted address feeds only the per-source SSE cap and the dashboard-recovery source key, so trusting the range gives nothing to an attacker who does not already hold an organization Machine. Caddy then sends the API `X-Forwarded-For: {client_ip}` (the visitor alone), because by default it would append the gate's address, and the API, trusting only loopback, would see the gate for every visitor.
  - **Verified on Fly (2026-10-05):** SSE through the gate, plain and with forged `X-Forwarded-For`, `Fly-Client-IP`, `X-Real-IP`, `Forwarded` and `True-Client-IP`, reached the API with the same source, the visitor's real public IPv4 address.
  - The core's `WEB_ORIGIN` (web and API) is the gate's public URL, `https://checkout-surge-gate.fly.dev`: the admin origin check compares it with the browser's `Origin`. The resulting operator limitation is in task 13.

### 2.5 Bot handling

- **Bots cannot wake the core.** Once a visitor has woken it, though, the gate relays bot requests too. Those requests can extend the awake time up to the guard's 3-hour cap. Public run budgets already bound what such traffic can trigger. This is an accepted risk for now.
- **End-of-project task, conditional on evidence.** After a few days of real traffic, check the gate logs and Fly metrics. If bots do reach the awake core, add a signed session cookie set by the wake button: the gate then relays only requests that carry it and shows its own page to everything else. Further protection (for example Turnstile) is added only if metrics show a need.

---

## 3. Core

### 3.1 Packaging

- **Choice, verified in task 01.** A Fly multi-container Machine that reuses the existing per-service images, with a dedicated Fly config (`infra/fly/core/machine.json`). Images are built and pushed separately and referenced by version. The Compose-to-Fly conversion path is not used. PostgreSQL, Redis and Caddy use the same Docker Hub images as Compose.
- **Workarounds it needs**, each a few lines and verified on Fly:
  - **Delayed database stop.** Fly signals every container at once on stop, so PostgreSQL and Redis would stop before the applications and the Machine would hang until its stop timeout. A wrapper delays their shutdown by 10 s; the Machine then stops cleanly in about 11 s.
  - **Image `ENV` wins over a container's `env`.** Keys an image already sets (`PGDATA`, the web image's `HOSTNAME`) are set in the container command instead.
  - **Explicit secrets per container.** A container without a `secrets` list gets no app secret, so each container lists the secrets it needs.
- **Fallback, not needed.** A single image with `supervisord` stays the answer if a future Fly change breaks multi-container.
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
- **Setup failure.** If migrations or the seed fail, the API, worker and Mock ERP do not start. The API port stays closed, including on 6PN, and the gate shows a setup-failure page. Verified in task 01: the barrier is reapplied on every start, and the Machine itself stays `started` (section 2.3).
- **Incompatible pre-release changes** recreate a fresh core through the recovery path (section 3.5), triggered deliberately by the deploy command (section 8).

### 3.3 Storage

- **Volume.** PostgreSQL and Redis data live on one Fly volume mounted at `/persistent`, in `/persistent/postgres` and `/persistent/redis`. Fly mounts the volume into every container of the Machine; each database owns its own subdirectory (uid 70 and uid 999, mode 700), and neither entrypoint touches the other's data.
- **Why not rootfs.** A performance-4x volume gets up to 16,000 IOPS and 64 MiB/s, while rootfs is capped at 2,000 IOPS and 8 MiB/s. These are documented maxima, not guarantees.
- **Persistence.** History and admin edits survive between sessions, but nothing depends on them.
- **No restore path.** There is no volume fork and no snapshot restore. Fly's default daily snapshots stay enabled, but nothing relies on them.

### 3.4 Idle stop and countdown

- **Who stops the core.** The API stops its own Machine through the Machines API.
- **Stop condition:** no nonterminal run, and no counted activity for 10 minutes.
  - **Counted:** any HTTP request to the core, on any page, and the "stay awake" button. The end of a nonterminal run also counts, so the countdown restarts at 10 minutes when a run finishes.
  - **Not counted:** healthchecks, the countdown widget's status polling, the demo page's recovery polling, the gate's readiness probes, and open SSE connections.
- **Countdown widget, shown on every page.**
  - It says the system is awake and will sleep after mm:ss without activity.
  - A "stay awake" button resets the deadline.
  - The deadline is owned by the API, and the widget only displays it. Several visitors share one core, and anyone's activity extends the deadline for all of them.
  - It polls a lightweight status endpoint, for example every 30 s.
  - While a run is nonterminal, it shows "run in progress, the system stays awake" instead of the countdown.
  - It shows a visual alert during the last 2 minutes.
- **Stopped core.** A page left open on a stopped core shows "Demo paused", with a link back to the gate.
- **Implemented in task 07.**
  - The owner keeps the last activity in memory and checks on the API's 5 s poll; it stops its own Machine by `FLY_APP_NAME` and `FLY_MACHINE_ID`, which Fly sets in every container. `CORE_IDLE_STOP_ENABLED=true` turns it on (off by default, so the local topology has neither the stop nor the widget).
  - Counting happens in the web server, which receives every visitor request except SSE, including pages that never call the API: a Next.js Proxy reports each request to the API's `POST /core/activity`, except health checks, the widget's status polling and SSE. Requests made straight to the API (runner traffic, operator calls) never count. The gate's readiness probes must therefore use `/health` or the API's `/health/ready` (task 09). Verified in task 09: with a demo tab open through the gate, which probed Caddy's `/health` about every 15 s, the core stopped 602 s after the last counted request.
  - Endpoints: `GET /core/idle-status` (in memory, never counted) and `POST /core/activity` ("stay awake"). The widget sits under the header of every page and shows "Demo paused" when a status read fails after it has seen the core awake.
  - Measured on Fly: the stop request followed the last counted request by 600.7 s, and the Machine was `stopped` 11 s later. An open page with SSE, polling and Fly healthchecks left the deadline unchanged, and a run that spanned the deadline kept the core up.

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

**Implemented in task 10** (`apps/gate/src/core-recovery.ts`, HD-34, HD-35).

- **Config source (owner decision, 2026-10-05).** The new core is built from the core config the deploy script last sent, never from the old Machine: Fly returns only a partial config for a Machine whose host is not ok (fly-go `machine_types.go`: `GetConfig` "returns IncompleteConfig if Config is unset which happens when HostStatus isn't ok"). `deploy.mjs core` writes that full versioned config, with its volume's name and size, into the gate Machine as a file (`files` entry, `CORE_MACHINE_CONFIG_FILE`) through a full-config update of the gate; `deploy.mjs gate` carries the file over from the gate's current config. The gate logs at startup whether the file is present; if it is missing, no recovery starts. The Machines client reads `incomplete_config` when `config` is unset, like `GetConfig`, so the core lookup still sees a dead core's metadata when Fly reports it.
- **Under the lease.** The wake's lease on the old core is extended to 600 s with its nonce (Fly refreshes a lease when the nonce is sent; verified) and held until the recovery ends, then released (404 once the Machine is destroyed). On a host that is not ok, no lease is taken.
- **Volume.** Same name and size as the old mount, `compute` set to the old guest, region `cdg,eu`. The volumes API takes a prioritized region list like Machines (verified: `cdg,eu` placed the volume in cdg, `eu` alone in ams, and an unknown first entry is refused with "target region … not found"). Fly placed the new volume in another zone (host) than the old one.
- **Machine.** The deployed config (images, size, container files included), on the new volume, without a `recreate` mark, created and launched in the volume's region (a volume pins its Machine's region).
- **Healthy.** Polled every 3 s for up to 300 s: `started`, setup not failed since the start, and Caddy's `/health` answering over 6PN. Then the old Machine is force-destroyed, with the nonce when a lease is held and without one otherwise (a 404 counts as done, as in flyctl's blue-green deploys), and the deletion of its volume is started without waiting: a volume can be deleted right after its Machine's destroy (verified), but on a host that is down Fly keeps it `pending_destroy` until the host returns (Fly staff, 2025: no way to force-delete it meanwhile); the guard cleans up. If the new core is not healthy, it is destroyed, then its volume deleted (kept attached when the destroy fails, for the guard), and the old core kept.
- **Capacity.** A volume create refused with `volume_placement_capacity`, or a Machine create refused with `insufficient_capacity`, keeps the old core and shows the no-capacity page until the next wake. A failed Machine create deletes the new volume (verified live: the volume went to `pending_destroy`).
- **Deliberate trigger (owner decision, 2026-10-05, HD-35).** Metadata `recreate=requested` on the core Machine, set through `POST /v1/apps/<core-app>/machines/<id>/metadata/recreate` with `{"value":"requested"}` (204, no new Machine version). The next visitor wake recreates instead of starting. The deploy command for incompatible changes (section 8) sets the same mark. Visitors then see the fresh-install page rather than the relocating page, whose wording blames a provider capacity issue (task 12, owner decision 2026-10-06; a core on a host that is not ok, or with none listed, keeps the relocating page).
- **Measured (2026-10-05).** Wake POST to recovery start 0.1 s; new Machine created 7 s later; image pulls and launch 12.7 s; fresh install (initdb, migrations, seed) 6 s; old core retired and the recovery logged 36 s after the POST; demo relayed 0.8 s later. The visitor saw the relocating page throughout.

### 3.6 Authoritative core and coordination

- **One authoritative core.** It is the one started, healthy Machine with `role=core` metadata in the core app.
  - The gate, the guard, the API and the deploy script find it through the app name plus that metadata, never through a hardcoded Machine ID or IP.
  - Two cores are never started at the same time.
- **Lease coordination.** The gate (start, recovery) and the deploy script (update) coordinate through a Fly lease on the core Machine.
  - Whoever finds the lease held waits: the gate shows "updating", and the script retries.
  - The lease TTL is not documented, so we set it explicitly and renew it.
  - Leases are advisory, not a security boundary. They work between our own cooperating clients.
  - **Gate lookup (task 09, refined in task 10).** The gate never touches a Machine it does not recognize as the core (no `role=core`); when none is listed, a wake creates one from the deployed config. Among the `role=core` Machines that can serve, the gate takes the `started` one, else the newest by `created_at` (the one to start). A core whose `host_status` is not `ok`, or with a failed setup, cannot serve; when no core can, all of them are considered, so a single dead or failed core still shows its own page. Several exist only during a recovery, or after one whose cleanup failed; the guard removes the extra ones.
  - **Deploy side (task 12, HD-45).** After its builds, the deploy script waits for an awake core to sleep (or stops it with `--force`), takes the core lease (600 s TTL, description `deploy`), reads the core again under it, refuses any state but `stopped` or `created`, and sends the update with the nonce. It holds the lease through the wait for `stopped` and the write of the core config into the gate, and releases it in a `finally` (404 counts as released). A held lease (409) fails the script, to be re-run. Verified on Fly: the lease survives the update (same nonce, same expiry; another lease request and a start without the nonce still get 409).
  - **Measured behavior (task 01).** Without the nonce, `start`, `update` and a second lease request get a 409 immediately. `stop` and `destroy` are not refused: they block until the lease expires, then succeed. Callers of stop or destroy (guard, recovery) therefore use short client timeouts or check the lease first. An expired lease frees the Machine.

### 3.7 Kernel limits and networking

- **`nofile` is raised inside the API's own container,** because rlimits are not inherited across containers. A small Fly variant of the API image (`runtime-fly` target) has a root entrypoint that raises the limit to 1,048,576, then drops to `node`. Measured in task 01: Fly's default is 102,400, not the historical 10,240, but the entrypoint stays because it pins an explicit value and is needed for `somaxconn` anyway.
- **`somaxconn`** is set for the Machine's shared network namespace before the API listens (8192 measured; Fly's default is 4096). The entrypoint reads each setting back and fails the start if it was refused.
- **IPv6 listening.** The API and the core's Caddy listen on IPv6 (`::`) as well as IPv4, so the runner and the gate can reach them over 6PN.
- **No dependency on the load-orchestrator.** Unlike Compose, the core's web container does not depend on the load-orchestrator, which runs on another Machine.
- **`apiBaseUrl`.** The API derives the `apiBaseUrl` it gives the runner from its own 6PN address at runtime, never `localhost`: it reads `FLY_PRIVATE_IP`, which Fly sets in every container of a multi-container Machine. An explicit `API_BASE_URL` still wins (task 02).

---

## 4. Runner

### 4.1 Lifetime and start

- **One fixed Machine with no volume, stopped between runs.**
  - Without a volume, the runner is not pinned to a host: it can be re-placed or recreated if a host lacks capacity.
  - The accepted cost is that a runner crash mid-run can lose the final k6 report (section 4.3).
- **The API starts the runner** explicitly through the Machines API when a run starts. The runner has no autostart, neither public nor Flycast, which lets our code see and classify capacity errors.
- **Every run starts from a stopped runner, with a fresh boot.**
  - If the runner is still running, it is shut down first, the API waits for `stopped`, then starts it.
  - A fresh boot clears kernel socket state between runs: a `surge-10k` run leaves about 10,000 sockets in TIME_WAIT (measured on Fly in task 02; 10,000-20,000 locally for back-to-back runs).
  - **Measured in task 02:** `start` to load-orchestrator ready takes 3.4 to 7.4 s. Node listens after about 3 s; the runner's first readiness probe to the API sometimes times out at its 2 s limit before the next one succeeds. Recreating a runner from the old config takes about 7 s to reach `stopped`.
- **Before each start, the API sets:**
  - the runner's size (section 1.1);
  - the runner's `API_BASE_URL`, which is the core's current 6PN address for metrics and completion. That address is fixed at runner boot, independently of the `apiBaseUrl` k6 targets, and it changes when the core is recreated.
- **Noted option, not decided: runner pre-start.** If the runner boot hurts the experience, the API can start the runner as soon as a visitor opens the run launch screen. The change is local to the start trigger.
- **Implemented in task 05.** Inside the maintenance authority, right before dispatch, the API reads the runner's readiness (`/health/ready`, which also probes the API over 6PN) before reading its identity. Measured on Fly: a run starts 3.4 to 3.9 s later than with an always-on runner (8.1 s on the first run after a deploy, which also updates the runner config).

### 4.2 Operations owner and stop

- **One owner, one operation at a time.** A single owner in the API runs every runner operation: start, shutdown, Fly stop and update.
  - In-process serialization is enough under the single-API-process contract.
  - The owner holds a Fly lease during each operation, to coordinate with the deploy script.
- **Primary stop.** The owner shuts the runner down as soon as the run reaches any terminal state: finalization, failure, admin reset or automatic reset.
- **Fenced shutdown.** A normal shutdown goes through the runner itself: `shutdown(runId, bootId)`.
  - The runner exits only if the request matches its current boot, and ignores it otherwise. Its restart policy is `no`, so the Machine stops.
  - A late stop for run N therefore cannot kill the runner of run N+1. Fly's `stop` has no fencing parameter (verified 2026-10-02).
  - **Implemented in task 04.** `POST /traffic/shutdown` with `{runId, bootId}` and the control token always answers 202 with an `outcome`:
    - `ignored_boot_mismatch` or `ignored_run_mismatch`: nothing happens;
    - `deferred_busy`: a start is being admitted, k6 is running, or a completion report is still awaiting acknowledgement; the caller retries;
    - `shutdown_requested`: the runner refuses new starts (`runner_stopping`, 409), then exits gracefully once the reply is sent. A report the API has already rejected (`completion_rejected`) does not block it.
- **Fly `stop` is only a fallback** for an unreachable runner. It is issued by the same owner, so it always runs before any later start.
- **Self-stop fallback.** The runner enforces it itself, so it still works when the API is down:
  - it exits after 3 minutes with no execution and no completion report awaiting acknowledgement (an arbitrary starting value);
  - its maximum lifetime is the automatic-reset deadline plus a small margin, read from the shared `automaticRunResetDeadlineSeconds` constant (900 s), never duplicated.
  - **Implemented in task 04.** The margin is 30 s and the lifetime counts from process boot, not from run start, so a runner pre-start (section 4.1) would eat into the margin. At that point the runner shuts down gracefully even mid-run or with an unacknowledged report. That report is lost with the volume-less Machine (section 4.1); no persistent storage is added (owner decision, 2026-10-03).
- **Off unless configured.** `RUNNER_LIFECYCLE_ENABLED=true` enables the shutdown endpoint and both self-exit timers together. They are off by default, so the local topology keeps a long-lived load-orchestrator (section 1.3). `infra/fly/runner/machine.json` sets it.
- **Abort on a stopped runner.**
  - Admin and automatic resets call `abortCurrent` for every run they terminate. Today that call fails when the load-orchestrator is unreachable.
  - A stopped runner cannot emit traffic, so the abort path checks the Machine state first and treats a stopped runner as a confirmed abort.
- **Finalization does not need the runner.** The API persists the completion report before acknowledging it.
- **Stop details (task 05).** `deferred_busy` is retried for 30 s; `shutdown_requested` must be confirmed by `stopped` within 30 s; an `ignored_*` outcome leaves the runner running; otherwise the owner falls back to Fly `stop`. A runner found running when a run starts is always stopped first (fenced shutdown, then Fly `stop`). Measured: shutdown request to `stopped` in 1.3 to 2.0 s.
- **Stop at the terminal state, not at `draining` (owner decision, 2026-10-03).** The runner stays up while a run drains (about 30 s for `surge-10k`). Stopping at `draining` would save that time, about 0.15 cents per run, at the cost of a second stop trigger to maintain and test.
- **A Fly `stop` is not a silent loss.** Fly `stop` sends SIGINT: the runner publishes an interrupted completion report and the run finalizes as a failed shortfall. Loss detection (section 4.3) only sees hard losses: crash, SIGKILL, host loss.

### 4.3 Boot identity and runner loss

- **No automatic restart.** The runner uses restart policy `no`, so a crash leaves the Machine stopped.
- **Boot identity.**
  - The runner generates a boot ID at process start. Fly provides no per-boot identifier.
  - Before sending `start`, the API reads the boot ID and persists it with the run.
  - Every start or replay carries the expected boot ID, and the runner rejects a mismatch. A rebooted runner can never relaunch traffic for a run.
  - **Implemented in task 04.** `GET /traffic/control` (control token) returns `{bootId, version}`, and every traffic status response carries the same two fields. A start request carries `expectedBootId`; a mismatch answers 409 `runner_boot_mismatch` before any traffic. The field stays optional until task 05 makes the API send it, then becomes mandatory.
- **Fast detection.**
  - While a run is active, the API monitors its runner.
  - The runner is declared lost if its Machine is stopped, or its boot ID changed, before a completion report was persisted.
  - The API then closes admission, treats the abort as confirmed, and terminalizes the run immediately as failed with reason `load_generator_lost`, without waiting for the 900 s automatic reset.
  - If the runner is merely unreachable while its Machine is started, the state is uncertain. After about 60 s, the API stops it through Fly, then applies the same rule.
  - **Implemented in task 06.** The check runs on the API's 5 s poll, for the run that is `starting` or `active` with a recorded boot. That set is exactly "no report persisted": the report and the move to `draining` are written in one transaction. A runner Machine whose `host_status` is `unreachable` also counts as lost (owner decision, 2026-10-04); the API does not try to stop it, and the next start recreates the runner (section 4.4). Measured on Fly: SIGKILL to a terminal `load_generator_lost` run in 3.4 s, 1.3 s after Fly marks the Machine stopped.
- **Report already persisted.** If the run is draining, finalization continues normally.
- **Missing evidence is unavailable, never zero.**
  - Traffic counters without a k6 report are explicitly unknown, across contracts, persistence and UI.
  - This also applies to an admin or automatic reset during traffic.
  - **Implemented in task 14.** The k6 script adds a zero sample to every counter the load orchestrator reads, so a clean run's export lists each counter and an absent counter stays unknown (HD-43). Without a usable export, each counter is known only from its streamed sum, so a completion report can carry unknown fields. On Fly's cgroup v1, the memory `high` event probe is reported as not applicable rather than as a warning (HD-44). Verified on Fly: a public surge-10k with zero generator warnings and every terminal counter from the summary export.
  - **Implemented in task 03.** `syntheticFailedTrafficSummary` (`apps/api/src/services/traffic-delivery-plan.ts`) writes zeros only when no traffic can have started: setup failed before the start was dispatched, or the load orchestrator answered the start with a definitive 4xx rejection (`TrafficStartRejectedError` in the traffic execution gateway). Every other case, including any reset without a persisted completion report, writes unknown (`null`) counters. Starts and starting-run reconciliation share the maintenance authority with resets, so no replay can race a start being set up; this relies on the single-API-process contract. The web hides the delivery verdict when counts are unknown.
- **Starting run without a recorded boot.** Such a run was never dispatched. Starting-run reconciliation fails it within one poll as `load_orchestrator_unavailable` with zero counters, and stops any runner booted for it through Fly (task 06). This covers a failed write of the boot: reading the database settles an ambiguous commit, and a run whose boot was in fact recorded is replayed as a normal starting run.

### 4.4 Capacity failures and region

- **Recovery.**
  1. Retry `start` 2-3 times with back-off.
  2. Recreate a fresh, volume-less runner with region list "the core's current region, then `eu`" (`cdg,eu` while the core is in cdg).
  3. Retire the old runner.
- **Implemented in task 06.**
  - `start` is tried 3 times in place, with 1 s then 3 s back-off. Transient errors are retried but never recreate the runner; capacity and dead-host errors recreate it after the retries (owner decision, 2026-10-04). A runner already on a host that is not `ok` is recreated at once (task 12; it was `unreachable` only).
  - The new runner is built from the deployed runner config (task 12, HD-47), with the size from section 1.1 and the current `API_BASE_URL`, and is created with region `"<core region>,eu"`, which the Machines API accepts as a prioritized list (verified). The core region is `FLY_REGION`. The old runner is force-destroyed only once the new one has started; otherwise the old one is kept.
  - **Deployed runner config (task 12, HD-47).** Fly returns only a partial config for a Machine whose host is not ok, so the runner, like the core, is recreated from a copy: every core deploy reads the runner Machine's full config and writes it into the core's API container as a file (`files` entry at `RUNNER_MACHINE_CONFIG_FILE`, `/fly/runner-machine.json`). The API reads it at each recreation; a missing file fails the recreation, and the run, before traffic. On a runner whose `host_status` is not `ok`, the API takes no lease (flyctl skips leasing such Machines): a start recreates it at once, a stop does nothing, and the old runner is force-destroyed without a nonce, a 404 counting as done.
  - A create refused for capacity answers 503 `runner_capacity_unavailable`: the run fails with zero counters (`load_orchestrator_unavailable`), and the UI shows the provider message.
  - While relocating, the run carries a flag (`runner_relocating`), so the dashboard projection shows the message during the start request.
  - Measured: a recreation takes about 14 s, including stopping the new runner (create to `started` in 5 s).
  - When several runners exist (a failed retirement or a lost create response), the API uses the newest, and the guard removes the others (section 5).
- **The runner follows the core** if the core is relocated. **Implemented in task 10 (HD-36):** at run start, a runner whose region differs from the core's `FLY_REGION` is recreated like a capacity failure (relocation flag, region `"<core region>,eu"`). While the core's region has no room for the runner, this repeats at every run. Its `API_BASE_URL` already follows the core's 6PN address at every start (section 4.1).
- **Region evidence.** The run records the runner's actual region, and the UI shows it, because a runner outside the core's region adds latency between k6 and the API. Measure it rather than assume it.
- **UX.**
  - While relocating, show "provider capacity issue, relocating the load generator, please wait".
  - If Europe has no capacity, show the provider message linking to https://status.flyio.net/, invite the user to come back later, and start no traffic.

### 4.5 Kernel limits and networking

- **Image.** A Fly variant of the load-orchestrator image uses a root entrypoint. It recreates what Compose configures today, then drops to `node`:
  - raise the `nofile` hard limit, which k6 inherits through Node;
  - set `net.ipv4.ip_local_port_range` (`10240 65535`) and `net.ipv4.tcp_tw_reuse` (`1`);
  - set `HOME=/home/node`, because `setpriv` keeps root's `HOME` and k6 refuses to start when it cannot stat `$HOME/.config/k6`.

  Measured in task 02: k6 runs with `nofile` 1,048,576 soft and hard, and both sysctls take effect.
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
  - In the runner app, the newest `role=runner` Machine is the expected one (task 06).
  - This is cleanup of accidental leftovers, not protection against an attacker, who could set the same metadata.
- **Tokens.** It needs tokens for both the core and runner apps.
- **Implemented in task 11** (`apps/gate/src/guard.ts`, entrypoint `guard-main.ts`).
  - **Machine.** `infra/fly/gate/guard-machine.json`: `shared-cpu-1x` 256 MB, `role=guard`, `schedule: hourly`, restart policy `no`, `init.cmd` `node dist/guard-main.js` on the gate image. `deploy.mjs gate` builds the image once, then updates the gate and creates or updates the guard (any state, like the gate), **without `skip_launch`** (HD-41): verified on Fly, a scheduled Machine created or updated with `skip_launch` is never started by the scheduler, while one created launched, or updated without it (even while stopped, which leaves it stopped), runs about once an hour. A pass with nothing to do takes under 0.5 s; the Machine is `stopped` again about 3 s after its start.
  - **Core stop rules,** for a `started` core on an `ok` host: setup failed since the latest start (first run, no grace); silent on 3 readiness probes of Caddy's `/health` (the gate's probe, 2 s timeout) 2 minutes apart, for a core started more than 10 minutes ago; awake for more than 3 hours since its latest `start` event. A core on a host that is not `ok` is never stopped (the stop could hang); the gate's wake recreates it.
  - **Which core is kept (HD-39).** The gate's own rule (`selectCore`: among the cores that can serve, the `started` one, else the newest), where a core silent on every probe cannot serve either. Every other `role=core` Machine older than 15 minutes is destroyed, then its volume deleted: a recovery's leftover with a failed setup, a silent one, or one on a dead host, never "the newest" blindly.
  - **Runner.** The newest `role=runner` Machine is kept (HD-18); older ones are destroyed after 15 minutes. A runner started more than 20 minutes ago (the 900 s automatic-reset deadline plus 5 minutes, which covers the runner's own 30 s margin, its boot and its exit) is stopped.
  - **Unknown Machines.** A Machine without the app's role, on an `ok` host and older than 15 minutes, is destroyed. One on a host that is not `ok` is left alone and logged: its partial config may have lost the role of a real Machine (open point for the owner, task 11).
  - **Detached volumes.** A core-app volume in state `created`, attached to no listed Machine and older than 15 minutes, is deleted. A volume Fly already accepted to delete (`pending_destroy`) is left to Fly.
  - **Lease (HD-37).** Every stop and destroy runs under the Machine's lease (60 s TTL); a held lease (409) skips that Machine until the next run, so the guard never acts on a Machine that a wake, a recovery, a deploy or a runner operation is working on. Under the lease, the Machine is read again and acted on only if its state, host status and latest start are unchanged since the plan (task 11 review), since a plan can be minutes old after the probes. On a host that is not `ok`, the destroy takes no lease (the re-read happens just before it) and a 404 counts as done, as in the gate's recovery.
  - **Tokens (HD-40).** The core-app token is the gate's `CORE_FLY_API_TOKEN`; the runner-app token is the gate-app secret `RUNNER_FLY_API_TOKEN` (`flyctl tokens create deploy -a checkout-surge-runner -n guard-runner`, piped into `flyctl secrets import --stage`, no local copy).
  - **Operator switches** in the Machine env, for demonstrations only: `GUARD_DRY_RUN=true` logs the plan without acting; `GUARD_CORE_MAX_AWAKE_SECONDS`, `GUARD_CORE_STARTUP_GRACE_SECONDS`, `GUARD_RUNNER_MAX_STARTED_SECONDS` and `GUARD_LEFTOVER_GRACE_SECONDS` override the thresholds.
  - **Verified on Fly (2026-10-05):** each rule once, deliberately (task 11 working notes). A core saturated by a `surge-10k` burst missed the first probe (no answer within 2 s, mid-burst) and answered the second in 18 ms: it was not stopped.

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

  Each container lists only the secrets it needs, because Fly gives a container no app secret without an explicit list (task 01).
- **Runner:** only `CONTROL_SERVICE_TOKEN`. It authenticates both directions: the API's control calls, and the runner's metrics and completion. The runner is a single-image Machine, so it gets the app secrets without a per-container list.

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
- **Rotation.** The procedure is documented below (task 12). `CONTROL_SERVICE_TOKEN` changes on the core and the runner together. The API's runner-app deploy token is the core secret `RUNNER_FLY_API_TOKEN`, given only to the API container (task 05). Its core-app deploy token is the core secret `CORE_FLY_API_TOKEN`, also given only to the API container (task 07). The gate's core-app deploy token (`flyctl tokens create deploy -a checkout-surge-core -n gate-core-wake`) is the gate secret `CORE_FLY_API_TOKEN`, staged straight from the command output with no local copy; a lost token is simply replaced (task 09). The guard shares it, and holds a runner-app deploy token as the gate secret `RUNNER_FLY_API_TOKEN` (task 11); as an app secret, the gate Machine receives it too (HD-40).

#### Rotation procedure (task 12)

Machines read their app secrets when they start (task 01), so a staged secret takes effect at each holder's next start, and nothing is redeployed. The operator's own flyctl session does the work; no token or secret value is ever printed, written to a file, or committed.

| Secret | Holder app (Machines) | Token for | Token name |
| :-- | :-- | :-- | :-- |
| `RUNNER_FLY_API_TOKEN` | core (API container) | runner app | `core api runner operations` |
| `CORE_FLY_API_TOKEN` | core (API container) | core app | `core-idle-stop` |
| `CORE_FLY_API_TOKEN` | gate (gate and guard) | core app | `gate-core-wake` |
| `RUNNER_FLY_API_TOKEN` | gate (gate and guard) | runner app | `guard-runner` |
| `CONTROL_SERVICE_TOKEN` | core and runner | (shared secret) | none |

**A Machines API token**, one at a time:

1. Pick a moment when the holder sleeps: the core stopped (the gate's start page shows), for a core secret; any moment for a gate secret.
2. Create a new deploy token with a dated name, and stage it straight from the command output, for example for the guard's runner token:
   `printf 'RUNNER_FLY_API_TOKEN=%s
' "$(flyctl tokens create deploy -a checkout-surge-runner -n guard-runner-<date>)" | flyctl secrets import --stage -a checkout-surge-gate`
   (as the tokens of tasks 09 and 11 were staged; the old token stays valid until step 5).
3. Let every holder Machine restart: the core at its next wake; for the gate, stop the gate Machine (`flyctl machine stop <gate id> -a checkout-surge-gate`), which Fly Proxy starts again on the next request; the guard at its next hourly run.
4. Check the holder with the new token: a wake through the gate and the core's idle stop (core-app tokens), a run (the API's runner token), a guard run without errors in its logs (`component: guard`).
5. Revoke the old token: `flyctl tokens list -a <token app>`, then `flyctl tokens revoke <id>` for the old name. A holder still running with it then fails its Machines API calls until it restarts, which is why step 3 comes first.

**`CONTROL_SERVICE_TOKEN`**, on the core and the runner together, since it authenticates both directions:

1. Make sure both sleep: the core and the runner `stopped` (wait for the idle stop, or stop the core with `flyctl machine stop`; the runner stops at the end of each run).
2. Generate the value in a shell variable and stage it on both apps, then drop it:
   `t=$(openssl rand -hex 32); printf 'CONTROL_SERVICE_TOKEN=%s
' "$t" | flyctl secrets import --stage -a checkout-surge-core; printf 'CONTROL_SERVICE_TOKEN=%s
' "$t" | flyctl secrets import --stage -a checkout-surge-runner; unset t`
3. The next wake starts the core with the new value, and the next run starts the runner with it. If one app was started in between with the other value, every run fails until both have restarted: stop both and try again.
4. Update the owner's local copy in the gitignored `infra/fly/core/core-secrets.env` the same way, without printing it, or drop that entry: nothing reads it on Fly.

Rotating the remaining core secrets (admin and cookie secrets, PostgreSQL and Redis passwords with their URLs) before go-live is task 13 (HD-33).

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
- **Remote builds by default.** Images are built by Fly's remote builder (Depot), not by the local Docker engine, both from the workstation and later from GitHub Actions. The deploy script builds and pushes without deploying (`fly deploy -a <app> --build-only --push --image-label <commit-sha> --dockerfile <path> --build-target <target>`, run from the repository root). An explicit option falls back to a local `docker build` plus `docker push`; `--depot=false` (Fly's previous builder) is the other fallback during a Depot incident.
  - Why: local builds exhausted the owner's workstation memory, and remote builds always produce linux/amd64 with a build cache kept at Fly.
  - Cost: 300 free build minutes per month, then $0.05 per minute (announced; effective billing unconfirmed). Expected cost for this project: zero.
  - To verify on first use: the image really is in the registry after `--build-only --push` (a 2025 Depot bug skipped the push), `.dockerignore` is honored by the upload, and the Next.js build fits in the builder's memory (the builder can be resized from the dashboard's Builders page).
- **Stopped Machines** are updated through the Machines API without being started (`skip_launch`). Updates take a freshly read full config. Migrations apply on the next core start.
  - The deploy script sends the full Machine config through the Machines API, not `flyctl machine update`, which merges the JSON into the old config and would keep removed keys.
  - After a create or an update, it waits for `stopped`: Fly refuses a start for about 9 s after a create (images being prepared) and about 3.5 s after an update.
  - An update sent right after a remote build can be refused with `MANIFEST_UNKNOWN` although the registry already serves the tag (observed in task 12 on an existing repository, not only after the first push to a new one): the script retries that refusal up to 5 times, 10 s apart.
  - `flyctl deploy --build-only` needs a minimal `-c` config (`infra/fly/core/build.toml`) while the app has no Machine.
  - One registry repository holds several images, so image labels are `<service>-<commit-sha>`, with a `-dirty` suffix and a UTC build timestamp when the work tree has uncommitted changes (the Machines API keeps a Machine's image when the reference string is unchanged, so repeated dirty deploys on one commit need distinct labels).
- **Awake core.** Deployment waits until the core goes to sleep. With `--force`, it interrupts the session and updates immediately, and an in-progress run ends failed. The deploy script holds the core lease during the update (section 3.6).
  - **Implemented in task 12 (HD-45).** The script reads no Machine state before its builds, except to refuse two Machines of one role. After them, it polls the core every 15 s until it is `stopped` (or `created`), then takes the lease and reads it again (section 3.6). With `--force`, it skips the wait and stops a `started` or `starting` core under the lease, with the nonce, then waits for `stopped`. A wake during the builds is therefore never interrupted, and a wake while the lease is held shows the updating page.
  - The runner gets the same treatment under its own lease (300 s TTL, covering the waits and the `MANIFEST_UNKNOWN` retry budget): read again, refused unless `stopped` or `created`, or stopped with `--force`; a held lease fails the script.
- **Version handshake.**
  - Before starting a run, the API compares its own commit with the runner's and refuses the run with a clear message if they differ. A partial deployment therefore leaves the demo refusing runs, rather than producing wrong evidence, until a redeploy.
  - The deploy script verifies both versions at the end: it reads the `COMMIT_SHA` of the core's API container and of the runner from their Machine configs, in every case, even after a failed step, and exits 1 with "Partial deployment: …" when they differ (HD-46).
  - The runner reads its version from `COMMIT_SHA`, which the deploy script sets in the runner Machine env to the commit version, `<commit-sha>` or `<commit-sha>-dirty` (the image label without its service prefix and build timestamp). Without it, the version is `unknown`; on Fly, `unknown` never counts as a match.
- **Incompatible changes** use the recovery path (section 3.5) to recreate a fresh, empty core. The same command deliberately tests that path. It replaces the manual wipe-and-rebuild procedure for the hosted runtime. The trigger is the `recreate=requested` mark on the core Machine (task 10, HD-35): the deploy sets it with the update, and the next visitor wake recreates the core.
  - **Implemented in task 12 (HD-48).** `--fresh-core` on a deploy that includes the core sets the mark in the config it sends, under the core lease. A later deploy carries an existing mark over, so only a wake clears it. The gate's copy of the core config carries the mark too, and the recovery drops it from the new core (`freshConfig`). A mark set by mistake is removed with `DELETE /v1/apps/checkout-surge-core/machines/<id>/metadata/recreate`.
- **Core config copy in the gate (task 10, HD-34).** Every core deploy also updates the gate Machine with a file holding the core config it sent; every gate deploy keeps that file. The gate recreates the core only from it.
- **Deploy script.** `infra/fly/deploy.mjs <all|core|runner|gate> [--force] [--fresh-core] [--no-depot | --local-build]`. Each app's images live in its own registry repository.
  - **`all` (task 12, HD-46)** builds every image (runner, the five core images, gate), then, under the core lease, updates the runner (under its own lease), the core and the gate's core config copy, releases the core lease, then updates the gate and the guard. Single-app targets remain; a runner-only or core-only deploy of a new commit ends with the partial-deployment report.
  - A core deploy also embeds the runner Machine's current full config in the core (section 4.4, HD-47), so the runner must exist first; in `all`, it is the config just deployed.
  - A deploy killed while it holds a lease leaves it until its TTL expires; `flyctl machine leases clear <id> -a <app>` frees it at once.
- **Gate deploy (task 09).** The gate image is the shared `docker/Dockerfile.node-service` (`SERVICE_NAME=gate`, `runtime` target), and its Machine is managed like the others, from `infra/fly/gate/machine.json` through the Machines API, rather than with a `fly.toml` and `fly deploy`. The gate is stateless, so the script updates it in any state. One-time app setup, outside the script: `flyctl apps create checkout-surge-gate`, the token above, `flyctl ips allocate-v4 --shared` and `flyctl ips allocate-v6`. `.dockerignore` now excludes `**/*.env`: before, the gitignored `infra/fly/core/core-secrets.env` was part of every remote build context. A Machine create right after the first push to a new repository can fail with `MANIFEST_UNKNOWN`; re-running the script succeeds.
- **Where deployments run.**
  - During the build-out: a local script (for example `pnpm deploy:fly`), run from the owner's workstation with flyctl.
  - Near the end of the project: GitHub Actions, calling the same script.
- **Version mismatch outcome (task 05).** Besides the UI message, the refused run ends failed (`load_orchestrator_unavailable`) with zero counters, since no traffic was dispatched.
- **Deploy and runner lease (task 05, changed in task 12).** The deploy script takes the runner lease for its update; a 409, while the API holds it during a run operation or the guard during a stop, fails the script, which is simply re-run. A runner-only deploy while the core is awake can conversely make a run start fail on the held lease; `all` avoids it, since the core sleeps under the deploy's lease.
- **Runner recreation trigger (task 06).** `POST /admin/demo/runner/recreate` (control token) recreates the runner as a capacity failure would. It is refused with 409 while the runner Machine is not stopped, and leaves the new runner stopped (owner decision, 2026-10-04). It deliberately tests the runner path, and the deploy command can call it.

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
  - per-run runner identity: Machine, boot ID and region, plus a relocation flag while the run starts;
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
  - everything Fly-specific lives under `infra/fly/`, with one subfolder per Fly app (`core/`, `runner/`, `gate/`): Machine config JSON files, entrypoint scripts, and each app's minimal `build.toml` for remote builds (the gate has no `fly.toml`, task 09). No `fly.toml` sits at an app root. Every flyctl command passes `-a` and an explicit config path, never relying on current-directory discovery;
  - the Fly image variants of the API and the load-orchestrator are extra `runtime-fly` targets built on top of the existing `runtime` targets, so nothing is duplicated and a refused kernel setting fails the start loudly;
  - a hosted Caddy variant (IPv6, trusting only the gate), kept with the other Caddyfiles in `infra/caddy/`;
  - the deploy script.
- **Documentation:** once the design is implemented, update the hosted-deployment boundary in `docs/runtime_topology.md` and the caveats in `docs/decisions/scope_and_caveats.md`.

---

## 10. Feasibility Test Checklist

Run this before the full implementation. Every item is unverified until tested on the target Fly organization. Core-side results (task 01, 2026-10-03): every item passed except the runner items, which belong to task 02; details are in `01_core_on_fly.md`.

**Verdict (task 02, 2026-10-03): the topology is confirmed.** A runner on its own performance-4x Machine ran `surge-10k` across hosts over 6PN IPv6 twice, including once on a recreated runner: 10,000 requests, 500 accepted and confirmed, 9,500 sold out, zero transport failures, and connection establishment under 0.6 s at p95. Transport and business behavior match the local reference. Points to revisit, none blocking: the generator saturates its 4 vCPU while creating VUs and dispatching (measured again in task 13), and two hosted evidence gaps fixed in task 02 (`processMaxOpenFiles` read from the wrong process, CPU utilisation unavailable without a cgroup quota). Details are in `02_runner_on_fly.md`.

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
