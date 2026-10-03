# 01 — Core on Fly

**Design:** sections 3.1, 3.2, 3.3, 3.7, 7.1, 8, 10 · **Depends on:** none

## Goal

The core runs on one Fly multi-container Machine, started and stopped by hand, and the core-side feasibility checks pass. The task ends with the packaging verdict: multi-container, or the `supervisord` fallback.

## Scope

- **Fly app and Machine config** for the core: multi-container, performance 4 vCPU / 8 GB, `cdg`, one volume, `role=core` metadata, no public address, no autostart.
- **Boot sequence** with `depends_on` conditions: PostgreSQL and Redis healthy, then setup (migrate and seed), then API, worker and Mock ERP.
- **Volume layout** for PostgreSQL and Redis in separate subdirectories.
- **Fly variant of the API image:** a `runtime-fly` target on top of `runtime`. Its root entrypoint raises `nofile`, then drops to `node`. `somaxconn` is set before the API listens.
- **Networking:**
  - the API and a hosted Caddy variant listen on IPv6;
  - `API_TRUSTED_PROXY_CIDRS` is loopback;
  - the web container does not depend on the load-orchestrator.
- **Core secrets** stored as Fly secrets.
- **Deploy script, first version:** build the images, tag them with the commit SHA, push them, and create or update the core Machine.
- **Feasibility checks:**
  - access to multi-container Machines;
  - flyctl path resolution from `infra/fly/`: `--config` and `--dockerfile` relative to the working-directory argument, and the base of a `machine_config` path if one is used;
  - the startup gate, with a deliberately failing migration or seed;
  - shared-volume ownership;
  - limits of the API process;
  - graceful stop, and data recovery after a stop under activity;
  - crashes of each service;
  - leases;
  - time from `start` to core ready;
  - manual recreation of the core on a fresh volume.

## Out of Scope

- The gate. The core is reached through a private tunnel (`fly proxy` or WireGuard).
- The runner, idle stop, automated recovery, and lease coordination in the deploy script.

## Done When

- A stopped core started with `fly machine start` serves the demo UI through the private tunnel, with no manual step.
- Every feasibility check is recorded in the working notes, with its result and measurements.
- The packaging verdict and any corrected platform fact are written into `design.md`.

## Open Points

- None.

## Working Notes

Work done on 2026-10-03, flyctl v0.4.111, org `personal`, region `cdg`. Nothing is committed yet.

### Fly resources

- App `checkout-surge-core`: no public IP, no service, no autostart.
- Core Machine `8d14e3aee13038` (performance-4x, 8 GB, `role=core` metadata), **stopped**. It is the recreated core (see check 10).
- Volume `vol_vwnk7q676mlo5emv` (`core_data`, 3 GB, cdg), attached to the core. Probe Machines and volumes, and the first core Machine with its volume, are destroyed.
- Secrets (staged with `fly secrets import --stage`, read by Machines at start): `CONTROL_SERVICE_TOKEN`, `ADMIN_DASHBOARD_PASSPHRASE`, `ADMIN_SESSION_SECRET`, `PUBLIC_CLIENT_COOKIE_SECRET`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `DATABASE_URL`, `REDIS_URL` (the URLs embed the generated passwords). The local copy is the gitignored `infra/fly/core/core-secrets.env`.
- Registry `registry.fly.io/checkout-surge-core`: `<service>-<commit-sha>[-dirty]` images for `api`, `worker`, `mock-erp`, `web` and `setup`, plus one probe image `probe-setup`.

### What was built

- `infra/fly/core/machine.json`: the core Machine config (containers, healthchecks, `depends_on`, volume, secrets). Image fields for our services hold the container name; the deploy script replaces them.
- `infra/fly/core/deploy.mjs`: builds the five images with the Fly remote builder, tags them `<service>-<sha>` (`-dirty` suffix when the work tree is dirty), pushes them, then creates (volume plus Machine) or updates the core through the Machines API with `skip_launch`, and waits for `stopped`. It refuses to run while the core is not stopped. Options: `--no-depot`, `--local-build`. Run with `FLYCTL=<path>` when flyctl is not on PATH.
- `infra/fly/core/build.toml`: minimal app config. `flyctl deploy --build-only` on an app without Machines fails with "could not create a fly.toml from any machines", so the build passes `-c infra/fly/core/build.toml`.
- `infra/fly/core/api-entrypoint.sh` and the `runtime-fly` target of `docker/Dockerfile.node-service`: raise `nofile` to 1,048,576 (soft and hard, the kernel's `fs.nr_open`), write `net.core.somaxconn` = `API_LISTEN_BACKLOG`, then `setpriv` to `node`. `set -eu` plus a read-back fail the start if a setting is refused.
- `infra/fly/core/delayed-stop.sh`: wraps PostgreSQL and Redis so their shutdown starts 10 s after the stop signal (see check 6).
- `infra/caddy/Caddyfile.fly`: `:8080`, upstreams on `127.0.0.1`. Delivered as a container file; Caddy uses the stock `caddy:2-alpine` image.

### Minor choices

- **Machines API instead of `flyctl machine run/update --machine-config`.** flyctl unmarshals the JSON on top of the existing config (`internal/config/machine.go`), so env keys, fields or files removed from the JSON would survive an update. The Machines API replaces the whole config.
- **Docker Hub images** (`postgres:17-alpine`, `redis:7-alpine`, `caddy:2-alpine`, same tags as Compose) are referenced directly. Fly pulls them through `docker-hub-mirror.fly.io`.
- **Loopback binding.** PostgreSQL, Redis, Mock ERP, the worker health server and web bind `127.0.0.1`. Only the API (`::`, port 4000) and Caddy (port 8080) are reachable on the 6PN address (measured from inside the Machine: 4000 and 8080 open; 3000, 4100, 4300, 5432 and 6379 refused).
- **Explicit per-container secrets.** Each container lists only the secrets it needs.
- **`WEB_ORIGIN=http://localhost:8080`**, the tunnel origin (`fly proxy 8080:8080`). It changes with the gate (task 09).
- **Restart policy** `on-failure` for the long-running containers (Fly default: 3 retries), `no` for setup. Machine `stop_config.timeout` is 30 s.
- **Volume** 3 GB, mounted at `/persistent`; PostgreSQL in `/persistent/postgres`, Redis in `/persistent/redis`.

### Feasibility checks

1. **Multi-container access: pass.** A multi-container Machine was created in the `personal` org without any request.
2. **flyctl path resolution: pass** (live test plus flyctl source). `fly deploy <dir> --config conf/fly.toml --dockerfile docker/Dockerfile` resolved both paths inside `<dir>`: flyctl changes into the working-directory argument before it loads the config. `[build] dockerfile` in a fly.toml is resolved relative to the fly.toml directory. A `machine_config` path (fly.toml) and `local_path` entries are opened relative to the current directory, which is the working-directory argument. The core does not use `machine_config`.
3. **Startup gate: pass.** With a setup command that ran the migration then exited 1, setup stopped with code 1. The API, worker, Mock ERP, web and Caddy never started: ports 4000 and 8080 were closed on loopback and on 6PN, and `fly proxy` to 4000 got a connection reset. The Machine state stays `started`. The Machines API reports `containers[].state`: `setup: stopped`, the dependents `unknown`, PostgreSQL and Redis `healthy`. The barrier is reapplied on every start: setup ran and exited 0 before the API on every boot observed.
4. **Shared volume ownership: pass.** `/persistent/postgres` is owned by uid 70 (mode 700), `/persistent/redis` by uid 999 (mode 700), `lost+found` by root. The PostgreSQL entrypoint only chowns `$PGDATA`, and Redis only its working directory (`/persistent/redis`), so neither touches the other's data.
5. **Limits of the API process: pass.** `/proc/1/limits` of the API container: open files 1,048,576 soft and hard, also after a crash restart. `net.core.somaxconn` = 8192. The API listens on `[::]:4000`. Defaults measured without the entrypoint, in a root container on a probe Machine: `nofile` 102,400 soft and hard, `somaxconn` 4,096. A root container can write `somaxconn`.
6. **Graceful stop and data recovery: pass, after a fix.**
   - Without the fix: on `fly machine stop`, Fly sends SIGINT (the default) to every container at once. PostgreSQL and Redis exited within a second while the worker kept retrying them, and the Machine stopped only at the 30 s timeout.
   - With `delayed-stop.sh`: the application containers exit within a second with code 0; PostgreSQL logs a fast shutdown and Redis a normal shutdown 10 s later; the Machine is stopped 11 s after the request.
   - Stop under write activity (an insert loop and a Redis `INCR` loop): on restart PostgreSQL reported "database system was shut down" (no crash recovery), and the last committed row is from the stop request. Redis loaded its AOF without errors, and the counter persisted.
7. **Crashes of each service: pass.** SIGKILL from the Machine namespace (exec `--no-container`, process found by its `0::/default/<container>` cgroup):
   - API, worker, PostgreSQL, Redis: each exited 137 and was restarted by `on-failure` within 1 to 2 s (restart count 1/3). Other containers were not restarted.
   - PostgreSQL ran crash recovery (redo) in under a second; Redis reloaded its AOF. During the outage the API and worker logged query and connection errors. Afterwards the API, worker, Mock ERP and `/demo` through Caddy all answered 200.
   - Setup is not re-run after a crash. After 3 failed restarts a container stays down while the Machine stays `started`.
8. **Leases: measured** on a throwaway Machine with a 120 s lease:
   - without the nonce, `start` and `update` return 409 immediately ("lease currently held by …"), and so does a second lease request;
   - without the nonce, `stop` and `destroy?force=true` do not fail: they block until the lease expires, then succeed. With a 20 s lease a stop sent without the nonce returned 200 when the lease expired;
   - with the nonce, `stop` succeeds immediately; release returns 200;
   - once a lease expires, `GET /lease` returns 404 "lease not found" and a start without a nonce succeeds.
9. **Time from `start` to core ready** (Caddy healthy, 1 s log resolution; the worker is healthy within 1 s of Caddy):
   - first boot on an empty volume (initdb, migrations, seed): 14 to 15 s;
   - later boots: 12 s; from `fly machine start` to `/demo` 200 through `fly proxy`: 13 s, tunnel setup included;
   - `fly machine start` itself returns in 2.5 s.
   - Not part of start: after a create, the Machine stays `created` for about 9 s while its images are prepared, and after an update it is "getting replaced" for about 3.5 s. A start in that window is refused (`failed_precondition`), so the deploy script waits for `stopped`.
10. **Manual recreation on a fresh volume: pass.** Steps: create a volume (`compute` = the core's guest, 0.8 s), create a Machine with the old Machine's config pointing at the new volume (`skip_launch`, 7.6 s), wait for `stopped`, start (14 s to ready), check a fresh install (empty `demo_runs`, probe table gone, `/demo` 200), destroy the old Machine and its volume.

### First use of the remote builder

1. **Push really happens: pass.** After `--build-only --push`, `docker manifest inspect` (after `flyctl auth docker`) found `probe-setup`, and the core Machine pulled all five images.
2. **`.dockerignore` honored: pass.** The first upload sent 17.3 MB of context (the local `node_modules` alone is 647 MB). Later uploads sent 166 to 177 kB.
3. **Next.js build fits in the builder: pass.** The web build compiled with no memory error (whole step 25.6 s). Images are 68 to 77 MB.

### Other platform facts found

- **Image `ENV` wins over a container's `env`** when both set the same key. `PGDATA` and the web image's `HOSTNAME=0.0.0.0` were ignored. Both are now set in the container command (`sh -c`).
- **A container without a `secrets` list got no app secret.** PostgreSQL failed with "superuser password is not specified" until each container listed its secrets.
- **The volume is mounted into every container**; Fly cannot mount it into only some of them.
- **PostgreSQL trusts loopback connections** (`initdb` default `pg_hba.conf`), so its password only protects non-loopback access, which is closed anyway.
- Redis warns that `vm.overcommit_memory` is 0. That is a VM-wide sysctl, left for task 13.
- `fly auth token` prints a deprecation warning but still works; the deploy script uses it to call the Machines API. Once, a token read before the five builds (about 8 min) was refused with 403 on the update, while a fresh one worked. The script now reads the token for each call. The cause (token lifetime or a transient error) is unknown.
- The Machines API `wait` endpoint accepts a timeout of at most 60 s.
- When its only Machine is stopped, `flyctl apps list` shows the app as `suspended`.
- **Deploy script, end to end:** the update path ran twice (images rebuilt and pushed by Depot, config replaced, wait for `stopped`), the second time with the final script. The create path ran once, before the final wait step was added.

### Not verified

- ~~Local Compose build after the `Dockerfile.node-service` change.~~ Verified on 2026-10-03 by a cloud agent on a throwaway branch: `docker compose build api worker mock-erp` builds the `runtime` target only, then `runtime:up`, `runtime:setup` and `runtime:smoke` (17/17) pass, and `runtime-image-contract.test.mjs` passes (6/6).
- Container env inheritance from the Machine-level `env` was not tested; every container sets its own.

### Proposed design updates

- **3.1 Packaging verdict: multi-container, no `supervisord` fallback.** Three small workarounds are needed: container commands for keys the image already sets (`PGDATA`, `HOSTNAME`), an explicit secrets list per container, and a delayed stop for PostgreSQL and Redis.
- **3.3** The volume is mounted into every container.
- **3.6 Leases.** Without the nonce, `start` and `update` get a 409 immediately, but `stop` and `destroy` block until the lease expires. Callers of stop or destroy (guard, recovery) need short client timeouts or must check the lease first. Expired leases free the Machine.
- **3.7** The default `nofile` measured in a container is 102,400, not 10,240. Keep the `runtime-fly` entrypoint: it pins an explicit value and is still needed for `somaxconn`.
- **2.3, 3.2** The Machine stays `started` when setup fails. The gate can detect the failure through `containers[].state` in the Machines API.
- **8** The deploy creates and updates the core through the Machines API with the full config, not `flyctl machine update` (which merges). It waits for `stopped` before anyone may start the Machine. `--build-only` needs a minimal `-c` config while the app has no Machine. Image labels are `<service>-<sha>`, because one registry repository holds several images.
- **10** Record the results above. The 10k IPv6 burst and the runner timing are left to task 02.
