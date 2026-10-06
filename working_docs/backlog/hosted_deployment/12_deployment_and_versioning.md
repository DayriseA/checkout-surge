# 12 — Deployment and Versioning

**Design:** sections 3.6, 7.2, 8 · **Depends on:** 09, 10

## Goal

One command safely deploys one commit to the three apps.

## Scope

- **Complete the deploy script** started in tasks 01, 02 and 09:
  - update stopped Machines without starting them, from a freshly read full config;
  - hold the core lease during the update;
  - wait for an awake core to sleep, or interrupt it with `--force`;
  - verify the core and runner versions at the end.
- **Fresh-core command** for incompatible changes, through the recovery path.
- **Rotation procedure** for the Machines API tokens and for `CONTROL_SERVICE_TOKEN`, documented.

## Out of Scope

- GitHub Actions (task 13).

## Done When

- Deploying on a stopped core updates everything and starts nothing.
- Deploying on an awake core waits, and `--force` interrupts the session.
- The gate shows the updating page while the script holds the lease.
- A partial deployment is reported by the script and refused by the version handshake.

## Open Points

- None.

## Inputs from Task 09

- **Core lease around the update (deploy race found in the task 09 review).** `infra/fly/deploy.mjs` reads the core's state before the builds and updates from that read, with no lease and no re-read, so a visitor wake through the gate during the builds can be interrupted by the update. Fix:
  - after the builds, acquire the core lease; a 409 fails the script, to be re-run (same policy as the runner lease);
  - re-read the Machine under the lease and refuse anything other than `stopped` or `created`;
  - send the update with the `fly-machine-lease-nonce` header;
  - keep the lease through the wait for `stopped`, so a wake right after the update shows "updating", not "unavailable"; the TTL must cover the update plus that wait. Verify live that the lease survives the update;
  - release it in a `finally` (404 means already gone).
  - Verify live that a wake during the builds is refused or shows "updating".
- **Same stale read for the runner.** A run started during a runner deploy's build window would be updated mid-run (pre-existing, reachable while the core is awake). Same fix with the runner lease.
- **A redeploy under the same image label kept the old image (found and fixed in task 09).** Two deploys of a dirty tree on one commit pushed a new image under the same `<service>-<commit-sha>-dirty` tag, and the Machines API update with the unchanged image string kept the previous digest. `deploy.mjs` now appends a UTC build timestamp to the label of dirty builds only; clean commits keep `<service>-<commit-sha>`, and `COMMIT_SHA` is unchanged.
- `deploy.mjs` has no tests; add one only if this task extracts the deploy sequence anyway.
- HD-29's context and consequences say the deploy side of the lease is not implemented yet; update them when it is.

## Inputs from Task 10

- The fresh-core command sets the mark (`metadata.recreate = "requested"`) in the full config it sends, or through the metadata endpoint under the core lease; the next wake recreates the core. `deploy.mjs` still refuses two `role=core` Machines, which happens only mid-recovery or after a failed retirement. Reword the relocating page for the deliberate case if needed.
- **The core config copy in the gate.** `deploy.mjs core` writes the full versioned core config it sent into the gate Machine as a file (`CORE_MACHINE_CONFIG_FILE`), with its volume's name and size, and `deploy.mjs gate` carries that file over; the gate recreates the core only from it (HD-34). Keep both when completing the script.
- **Runner recreation on a dead host does not work yet (HD-17).** The API's runner recreation copies the old runner's config and takes its lease, but Fly returns only a partial config for a Machine whose host is not ok (fly-go `GetConfig`), and flyctl skips leasing such Machines. The runner needs the same approach as the core: a deploy-provided copy of its full versioned config (for example in the core, to be designed with the version handshake), plus no lease on a host that is not ok (force destroy without a nonce, 404 counting as done).

## Inputs from Task 11

- `deploy.mjs gate` also creates or updates the guard (any state), without `skip_launch`: keep it that way when completing the script, and never touch the guard with `flyctl machine update --skip-start`, or the schedule silently stops (HD-41). A deploy that lands during a guard run interrupts it, harmlessly. The guard takes 60 s leases on the core and the runner while it stops or destroys them, so a deploy can meet a 409 there and is re-run. The rotation procedure must include the gate secret `RUNNER_FLY_API_TOKEN` (token `guard-runner`).

## Working Notes

### Implementation (2026-10-06)

- **`infra/fly/deploy.mjs <all|core|runner|gate> [--force] [--fresh-core]`.** `all` builds every image, then updates the runner, the core and the gate's core config copy under the core lease, then the gate and the guard. Before the builds, the script only refuses two Machines of one role. After them:
  - core: waits for an awake core to sleep (polls every 15 s) unless `--force`; takes the core lease (600 s TTL, description `deploy`; a 409 fails the script); reads the core again under it; refuses anything but `stopped` or `created`, or with `--force` stops it under the lease and waits for `stopped`; updates with the nonce; waits for `stopped`; writes the core config into the gate; releases the lease in a `finally` (404 is fine) (HD-45);
  - runner: the same under its own lease (300 s TTL after the review; 180 s left out the retry budget), with no wait: a running runner is refused unless `--force`;
  - gate: read only when its turn comes, so it carries over the core config file the core deploy just wrote; the guard is still sent without `skip_launch` (HD-41);
  - at the end, in every case (even after a failed step): compares the `COMMIT_SHA` of the core's API container and of the runner from their Machine configs, and exits 1 with "Partial deployment: …" when they differ (HD-46).
- **`--fresh-core`** sets `metadata.recreate = "requested"` in the core config the deploy sends; a later deploy carries an existing mark over, so only a wake clears it (HD-48).
- **Runner config copy (HD-47, closes the accepted risk of HD-17).** A core deploy reads the runner Machine's full config (after the runner update in `all`) and writes it into the API container as a file at `RUNNER_MACHINE_CONFIG_FILE` (`/fly/runner-machine.json`, set in `infra/fly/core/machine.json`). `FlyRunnerHost.replace` builds the new runner from that file (plus the run's size and `API_BASE_URL`), never from the old Machine. On a runner whose `host_status` is not `ok`, `withLease` takes no lease and passes no nonce: a start goes straight to the recreation, a stop does nothing, and the old runner is force-destroyed without a nonce, a 404 counting as done. The API requires `RUNNER_MACHINE_CONFIG_FILE` whenever `RUNNER_FLY_APP` is set; the file itself is read at each recreation.
- **`MANIFEST_UNKNOWN` retry.** The first runner-only deploy failed: the update right after the remote build was refused with `MANIFEST_UNKNOWN` while the registry already answered 200 for the tag a few seconds later (existing repository, so not only the first-push case of task 09). Config sends refused that way are retried up to 5 times, 10 s apart.
- `deploy.mjs` still has no tests: the sequence is Fly calls end to end, and nothing was extracted that a unit test would cover meaningfully. Unit tests cover the API side (`fly-runner-host.test.ts`, `runtime-config.test.ts`).

### Verification on Fly (2026-10-06)

- **Lease across an update** (throwaway Machine in the runner app, then destroyed): lease 201; update with the nonce 200 in 2.5 s; `GET /lease` afterwards returns the same nonce and expiry; a second lease request and a start without the nonce get 409; the wait for `stopped` returned in 0.6 s with the lease still held; release 200.
- **Partial deployment** (`deploy.mjs runner` on HEAD while the core ran the previous commit): the script printed "Partial deployment: the core runs version 7078a8b…-dirty and the runner 810fa78…-dirty" and exited 1. A public `preview-1k` start through the gate then answered 503 `runner_version_mismatch` with both versions, in 9.7 s (the API starts the runner before it reads its version).
- **`deploy.mjs all` with a wake during the builds.** Core stopped before the script started; builds 03:05:11 to 03:08:31 (seven images, 3 min 20 s, Depot cache warm); a gate wake at 03:05:33 started the core under the gate's own lease (`gate wake`). After the builds, the script printed that the core was started and waited. The API's idle stop stopped the core at 03:15:42 (stopped 03:15:54); the script took the lease at 03:16:05.
  - A gate wake sent as soon as the deploy lease appeared answered 503 "Update in progress" (4.3 s, the gate itself was asleep).
  - Under the lease: runner updated and stopped by 03:16:13; the core update request took about 18 s (`replacing` at 03:16:32), `stopped` at 03:16:46; gate copy written 03:16:55; lease released 03:16:56. The lease was held 51 s and survived the core update. Gate and guard updated by 03:17:11; "The core and the runner both run version 810fa78…-dirty"; exit 0; total 8 min 2 s, 7 min 34 s of it waiting.
  - Nothing was started by the deploy: the core, runner, gate and guard events after it show only `launch` and `update`, all `stopped`. The core's API container holds `/fly/runner-machine.json`; the gate holds `/fly/core-machine.json`; the guard keeps `schedule: hourly`.
- **`deploy.mjs core --force` on an awake core with a run starting.** The core was woken (wake POST to demo relayed: 20 s, first boot of the new images). A public `surge-5k` start was sent at 03:19:33 while the last image built; the API updated and started the runner (started 03:19:38). The deploy took the lease at 03:19:38 and stopped the core at once (`stopping` 03:19:39): the visitor's start request ended after 70 s with the gate's asleep page. The core VM shut down at 03:20:08, at its 30 s stop timeout rather than the usual 11 s: an app process kept retrying Redis after Redis had stopped (log lines before 03:19:58 were no longer available). Core updated by 03:20:44, gate copy written, versions match, exit 0, total 1 min 36 s.
  - On the next wake (03:23:31, demo relayed after 20 s), the API failed the interrupted run at startup ("Failing a starting run that was never dispatched", run `c5584747…`), and the dashboard showed no current run.
  - A forced core-only deploy does not stop the runner: the runner started for the interrupted run stayed up and exited on its own idle timer at 03:22:41 (3 min after boot). `all --force` stops it under its lease.
- **Fresh core through the recovery path (`deploy.mjs all --fresh-core`, owner go 2026-10-06).** Core asleep. Builds 03:30:11 to 03:31:31 (warm cache, 1 min 20 s); core lease 03:31:32 to 03:32:07 (35 s): runner updated, core updated with `recreate=requested` ("The next wake recreates the core fresh and empty"), gate copy written; gate and guard updated; versions match; exit 0; total 2 min 12 s. The core then listed `{"recreate":"requested","role":"core"}`.
  - Wake through the gate at 03:32:36: the POST answered 303 in 5.2 s (the gate was cold after its update); every page then showed "Installing a fresh demo" (the new fresh-install page, owner decision 2026-10-06) until the demo was relayed 46.1 s after the click. Gate logs: recovery started 03:32:40, new core `8d4070aed50068` created 03:32:48 (cdg, new volume `vol_vxm90yyzz8ojwyn4`), "Recreated the core Machine" 03:33:20.
  - The old core `85e760f4434ed8` and its volume `vol_458pypynmkd7w694` are gone (hosted history and admin edits lost, as approved). The new core carries no mark, runs `810fa78…-dirty` like the runner, and its API container holds `/fly/runner-machine.json`, whose config matches the live runner (same image, size, role, restart policy and version; `API_BASE_URL` is added by the API at recreation). From the API container, `RUNNER_MACHINE_CONFIG_FILE` is set and the file parses (read as root through `flyctl machine exec`).
- **Runner recreation from the deployed copy.** The supervisor made the call with the user's explicit authorization (the control token was never read by the implementer): `POST /admin/demo/runner/recreate` from inside the new core's API container, through `flyctl machine exec … --container api`, with the token taken from the container's environment, at about 03:35:15 to 03:35:34. It answered `200 {"machineId":"d8d3976b666498","region":"cdg"}` in about 19 s. The new runner `d8d3976b666498` (created 03:35:17, started 03:35:29, stopped 03:35:32) has `role=runner`, performance 4 vCPU / 8192 MB, the image of the copy (`…load-orchestrator-810fa78…-dirty-20261006T033011`), `COMMIT_SHA 810fa78…-dirty`, and `API_BASE_URL http://[fdaa:ce:227b:a7b:45e:b43:30bb:2]:4000`, the new core's 6PN address. The old runner `8d3327ce259918` is gone. So the API process (user `node`) reads the copy written by the deploy.
- **Guard after the full deploys.** The guard, updated without `skip_launch` by both `all` deploys (last at 03:32:22), was started by Fly's scheduler at 03:47:01, logged "The guard checked the app" with 0 actions for the core and the runner, and stopped at 03:47:04.
- **Rotation procedure:** documented in `design.md` section 7.2; not exercised live (not requested).


### Cloud verification and review (2026-10-06)

- A cloud agent ran the full suite on a clean install of the validation branch: type-check, lint (584 files), `node --check infra/fly/deploy.mjs`, unit tests (api 314, gate 65, all other packages passing; the `demo-duration-estimator` timeout seen once locally under parallel load did not recur), API tests (346) and integration tests (192) all pass. The local Compose topology starts without `RUNNER_MACHINE_CONFIG_FILE` and a "Duplicate-click storm" run completed.
- An external review was verified against the code and arbitrated:
  - leases could expire before the work they cover: partially confirmed for the runner (about 205 s in the worst case with `--force` and the full `MANIFEST_UNKNOWN` budget, against 180 s); the runner TTL is now 300 s, the TTL comments name the retry budget, and HD-45 records that a request hanging beyond the TTL is not covered (no client deadline, since aborting a mutating call does not cancel it at Fly). The core's 600 s already covers its work;
  - the guard's config send skipped the `MANIFEST_UNKNOWN` retries: practically unreachable (the gate update just accepted the same image reference), but now sent through `sendConfig` for consistency, still without `skip_launch` (HD-41);
  - no test for an unreadable runner config file: rejected, as the state is not reachable (the file and its variable come from the same core config, and the API read it live) and the behavior is correct by construction.
- These fixes touch only constants, one call and comments in `deploy.mjs`, so no second cloud pass or redeploy was run; the next deploy uses them.
