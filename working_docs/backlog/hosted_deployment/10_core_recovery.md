# 10 — Core Recovery

**Design:** sections 2.3, 3.5, 6 · **Depends on:** 06, 09

## Goal

The gate repairs a core that cannot start, without the owner.

## Scope

- **Retry** `start` with back-off.
- **Recreate** on a capacity or dead-host classification:
  1. Create a fresh volume, with the `compute` hint.
  2. Create a new core Machine with the old configuration and the region list `cdg,eu`.
  3. Retire the old Machine and volume once the new core is healthy.
- **Cleanup** of a volume left without a Machine after a failed creation.
- **Pages:** relocating, and no capacity in Europe.
- **Deliberate trigger,** so the path can be tested, and reused by the deploy script (task 12).

## Out of Scope

- Detecting a real capacity incident, which cannot be tested on demand.

## Done When

- A deliberately triggered recovery produces a healthy, freshly installed core, and the visitor sees the relocating page meanwhile.
- The old Machine and volume are gone.
- The next run's runner follows the core's region.

## Open Points

- None.

## Working Notes

Work done on 2026-10-05, flyctl v0.4.111, org `personal`, region `cdg`, on branch `hosted/10-core-recovery` (from `dev` at `d5383051`). Nothing is committed.

### What was built

- **`packages/fly-machines`:** `createVolume` (name, region list, size, `compute`), `deleteVolume`, `refreshLease` (a lease request carrying the held nonce, which Fly treats as a refresh), and the `FlyMachineMount` and `FlyVolume` types.
- **Gate, start retries (`core-wake.ts`).** Under the wake lease, `start` is tried 3 times with 1 s then 3 s back-off on capacity, dead-host and transient errors, as for the runner. Capacity or dead-host failures after the retries, a core already on an `unreachable` host, or a core marked `recreate=requested` start a recovery in the background; the POST answers 303 like a start. Conflicts and our own errors are never retried. While a recovery runs, a new wake joins it (`relocating`).
- **Gate, recovery (`core-recovery.ts`).** (As first built; the dead-host pass below changed the config source and the lease.) Extends the lease to 600 s, creates a volume (old mount's name and size, `compute` = old guest, region `cdg,eu`), creates a Machine from the old config on it in the volume's region without the mark, polls every 3 s for up to 300 s until it is `started`, its setup has not failed and Caddy's `/health` answers over 6PN, then force-destroys the old Machine with the nonce and deletes the old volume. A new core that is not healthy is destroyed with its volume and the old core kept. A capacity refusal of the volume or the Machine returns `no_capacity` (the new volume, if any, is deleted). The lease is released when the recovery ends.
- **Gate, pages (`pages.ts`, `server.ts`).** While a recovery runs, every URL answers the relocating page (reloads every 5 s) without reading Fly. After a capacity refusal, every URL answers the no-capacity page (Retry button, Fly.io status link) until the next wake. A core on an `unreachable` host maps to the stopped page, so the start button can recreate it (`core-machine.ts`).
- **Deliberate trigger.** Metadata `recreate=requested` on the core Machine (`recreationRequested` in `core-machine.ts`); the next visitor wake recreates instead of starting. Set it with `POST https://api.machines.dev/v1/apps/checkout-surge-core/machines/<id>/metadata/recreate` and body `{"value":"requested"}`.
- **API, runner follows the core (`fly-runner-host.ts`).** At run start, a runner whose region differs from `FLY_REGION` is recreated through the existing capacity path (relocation flag, region `<core region>,eu`).

### Decisions settled with the owner (2026-10-05)

1. **Deliberate trigger: a metadata mark acted on by the next visitor wake** (HD-35). Rejected: an authenticated recovery endpoint on the gate (new secret, admin surface on the only public component), and a recovery command run from a workstation or CI (no 6PN for the health probe, no relocating page).
2. **The runner is recreated at each run start while it sits outside the core's region** (HD-36), even when the core's region has no room for it.
3. **Minor choices.** A recovery that fails for a non-capacity reason sends visitors back to the start page with the old core kept, with no dedicated error page. The relocating text mentions a provider capacity issue, which is not accurate for a fresh core requested by a deploy; task 12 rewords it.

### Minor choices

- **Recovery state in gate memory.** The relocating and no-capacity pages come from the gate process, not from Fly state. A gate stopped mid-recovery (Fly Proxy stops it after about 5.5 minutes without traffic, and the relocating page reloads every 5 s, so every visitor must have left) can leave a volume without a Machine, or two core Machines. Accepted in HD-34; cleanup is the guard's.
- **The healthy wait stops at the first failed Machines API read**, which removes the new core and keeps the old one. A retry is one more click.
- **Volume size and name** come from the old Machine's mount, which the Machines API reports with `size_gb` and `name`, so no volume read is needed.
- **No sweep of detached volumes.** Only the volume a failed creation made is deleted. Leftovers from a gate crash or a failed deletion belong to the guard.

### Fly checks before the destructive step (on probe resources created and removed in this task)

- **Region list for volumes:** `cdg,eu` placed the volume in cdg, `eu` alone in ams, and `zzz,ams` was refused with 400 "target region zzz not found", so the field is parsed as a list.
- **Volume deletion after a Machine destroy:** a `DELETE /volumes/<id>` right after a force destroy answered 200 (`destroyed`).
- **Lease refresh:** a lease request with the held nonce answered 201 with the same nonce and a later expiry.
- **Metadata endpoint:** `POST /machines/<id>/metadata/recreate` answered 204 and changed neither the version nor `instance_id`; the key appears in `config.metadata`.
- **A failed creation leaves no volume:** the real `CoreRecovery` (gate build, run from the workstation) against a throwaway Machine whose config named a missing image. The Machine create failed with 400 (manifest not found, `own_error`), the recovery threw, and its new volume went to `waiting_for_detach` then `pending_destroy`; `flyctl volumes list` showed only the core's volume afterwards.
- **Config copy:** the Machines API returns the core's container files with their `raw_value`, so the old config recreates the Caddyfile and the delayed-stop script.

### Deploys

The gate, core and runner were redeployed from this tree (version `d5383051…-dirty`). Each redeploy switched the Machine's image digest: gate `8032d8e3…` to `7c55b5c3…`, the core's `api` container `a52bca0a…` to `97c6c58f…` (the other core images were byte-identical under new labels), runner updated at the same version.

### Done-when checks on Fly (2026-10-05, UTC)

The owner approved destroying core `8d14e3aee13038` and volume `vol_vwnk7q676mlo5emv`. The supervisor set the mark on the core with the owner's approval (204). Then, in the desktop browser pane, "Start the demo" on https://checkout-surge-gate.fly.dev/demo, with a curl poll every 2.5 s and the gate and core logs streamed.

| Time | Event |
| :-- | :-- |
| 06:20:43.81 | Start POST reaches the gate |
| 06:20:43.93 | Gate logs "Recreating the core Machine." |
| 06:20:46.0 | First poll showing the relocating page (the one at 06:20:43.6 still showed the stopped page) |
| 06:20:51 | New Machine `82723db7762458` created in cdg, on new volume `vol_vp27qwpq5y8gx8e4` (cdg, another zone than the old volume) |
| 06:21:04 | Images pulled and Machine started ("created and started in 12.663s") |
| 06:21:06 to 06:21:10 | `initdb`, "Database migrations applied.", "Seeded product, demo presets, and public runtime policy.", setup exits 0 |
| 06:21:19.80 | Gate logs "Recreated the core Machine." (old one destroyed, old volume deleted) |
| 06:21:20.59 | First poll relayed to the new core (200) |

- **Healthy, freshly installed core, relocating page meanwhile: pass.** 36.8 s from the click to the first relayed page. Every poll in between showed "Relocating the demo"; the browser tab reloaded on its own into the demo page. Run history read "No runs yet", and the presets were seeded.
- **Old Machine and volume gone: pass.** `GET /machines/8d14e3aee13038` answers `destroyed`; `vol_vwnk7q676mlo5emv` is `pending_destroy`; the core app lists one Machine and one volume. The new Machine's metadata is `{"role":"core"}` (mark not copied).
- **The next run's runner follows the core: pass,** in the case available live. The core stayed in cdg, so the runner was started in place, not recreated. A Preview 1k run from `/demo` through the gate (`3b705a7f…`) completed: 500 / 500 confirmed, converged in 27.7 s, and the public report shows "Load generator region: cdg". The runner Machine's `API_BASE_URL` became the new core's 6PN address (`fdaa:ce:227b:a7b:5b0:1775:b4fd:2`). The runner stopped at 06:22:43. The cross-region case (core outside cdg) is covered by a unit test only.
- **A failed creation leaves no orphan volume: pass** (probe check above, plus unit tests).

**Left in place:** core `82723db7762458` (cdg, volume `vol_vp27qwpq5y8gx8e4`) stopped by hand at 06:23; runner `8d3327ce259918` stopped; the gate autostops on its own. The previous core's run history and admin edits are gone, as approved.

### Not verified on Fly

- A real capacity or dead-host failure, the no-capacity page under a real refusal, and placement outside cdg (unit tests only).
- A new core that never becomes healthy (unit tests only).

### Validation (workstation)

- `pnpm exec biome check --write` on every touched file: clean.
- Type-check: `fly-machines`, `gate` and `api` pass; `pnpm type-check:test` reports only the 3 known `mock-erp` errors.
- Unit tests: `gate` 38/38, `fly-machines` 30/30, `api` `fly-runner-host.test.ts` 22/22. After the review fixes: `gate` 40/40, `api` unit 314/314. After the dead-host pass: `gate` 43/43, `fly-machines` 31/31, `api` unit 314/314.
- No Docker-backed test is touched.

### External review (2026-10-05), arbitrated with the owner

All findings were fixed in one pass; the owner approved the arbitration.

1. **The wake lease could expire during slow retries.** The wake's own calls at the client's timeouts (read 30 s, wait for a stopping core 40 s, three starts 90 s, back-off 4 s, about 164 s) exceeded the 60 s lease. **Fixed:** the wake lease TTL is 180 s. Per-attempt timeouts were not shortened (a client abort is not a Fly answer, so it is unclassified and neither retried nor recreated), and the lease is not refreshed per retry. HD-29 gained the consequence (a gate dying mid-wake keeps "updating" up to that TTL).
2. **Cleanup order after a failed recovery.** The new volume was deleted even when destroying the new Machine had failed. **Fixed:** destroy then delete in one step, keeping the volume when the destroy fails, like the old core's retirement. Unit test in `core-recovery.test.ts`.
3. **Core selection with leftovers (plus a defect the review missed, reproduced in unit tests).** The gate took the `started` core, else the newest: a failed-setup new core whose removal failed hid the preserved old core (visitors stuck on the setup-failure page, wakes doing nothing), and after a dead-host recovery whose retirement failed, Fly kept reporting the dead Machine `started`, so once the new core idle-stopped the dead one was selected and every later wake ran a new recovery. **Fixed:** `findCoreMachine` skips cores on an `unreachable` host or with a failed setup when several exist, falls back to all cores when none can serve, then takes the started one, else the newest. Unit test in `core-status.test.ts`. HD-34 amended in place, with the remaining gap (a started new core that never becomes healthy without a setup failure, whose removal also fails, can be selected until the guard removes it); task 11's inputs say the guard must not keep the newest core blindly.
4. **The region follow skipped the stop of a live runner.** The API reaches the runner through `checkout-surge-runner.internal`, where any started runner can answer, and the new region branch bypassed "stop a running runner first" (HD-07). HD-12's boot fencing made a mix-up a clean failure, but it was **fixed**: the stale-runner stop moved from `startInPlace` into `start`, before the region check and still behind the dead-host shortcut. Unit test in `fly-runner-host.test.ts`.

**Unverified assumption (resolved by the dead-host pass below):** both the core and the runner dead-host paths acquired the Machine's lease first, assuming Fly grants a lease on a Machine whose host is unreachable.

### Dead-host pass (2026-10-05), owner decisions

Research by the supervisor (web and Fly's own sources) showed the dead-host recovery as first built would fail:

- fly-go `machine_types.go`: `GetConfig` "returns IncompleteConfig if Config is unset which happens when HostStatus isn't ok", so the old core's full config cannot be copied.
- flyctl `internal/machine/lease.go`: "Skip leasing for unreachable machines" (`if m.HostStatus != fly.HostStatusOk`), so the old core's lease probably cannot be acquired.
- flyctl's blue-green deploy destroys Machines on a non-ok host with force and no nonce, retries transient errors, and treats 404 as done.
- Fly staff (community forum, 2025): a volume cannot be force-deleted while its host is down; it waits in `pending_destroy`.

Changes:

1. **Config source: a copy written by the deploy script.** `deploy.mjs core` writes the full versioned core config it just sent (volume name and size added to the mount, no `recreate` mark) into the gate Machine as a file at `CORE_MACHINE_CONFIG_FILE` (`/fly/core-machine.json`, set in `infra/fly/gate/machine.json`), through a full-config update of the gate (HD-24); `deploy.mjs gate` carries the file over from the gate's current config. The recovery always builds the new core from that file, for capacity and dead host alike. When the file is missing, the wake logs it and shows the unavailable page, with no fallback to the old Machine. The gate logs at startup whether the file is present.
2. **No lease on a host that is not ok.** A core whose `host_status` is not `ok` (the gate's `hostDown`, used for the page, the core selection and the wake) is recreated without a lease; the old Machine is destroyed with force and no nonce, 404 counting as done. The Machines client now reads `incomplete_config` when `config` is unset (like `GetConfig`), so a dead core's partial config cannot crash the lookup. Unverified: whether that partial config carries the `role` metadata; if not, a dead core is invisible to the gate, which then shows the unavailable page (or relays to another core).
3. **The old volume's deletion is started, not awaited,** and never fails the recovery; a volume left `pending_destroy`, or whose ID the partial config does not give, is the guard's.
4. **Runner: not fixed here.** The API's runner recreation has the same problem. Recorded as an accepted risk in HD-17 and as an input in task 12.

Tests: the recovery builds the new core from the provided config (not the old Machine's); a core on a non-ok host is replaced without a lease, a 404 destroy counting as done; the old volume's deletion is not awaited; a missing file starts no recovery (unavailable, lease released); the client reads a partial config. `deploy.mjs` has no unit test.

**Fly checks (2026-10-05, 08:39 to 08:43 UTC).**

- `deploy.mjs gate` first (new image and `CORE_MACHINE_CONFIG_FILE`): the gate started on a GET and logged "No deployed core config; the core cannot be recreated until the core is deployed.", and answered the stopped page.
- `deploy.mjs core` (core stopped): the core Machine `82723db7762458` was updated and stayed `stopped`, then the script updated the gate ("gate Machine 873325c069dd38 now holds the core config for recovery."). The gate's config holds `/fly/core-machine.json`: mount `core_data`, 3 GB, on the current volume, metadata `{"role":"core"}`, `COMMIT_SHA` `d5383051…-dirty`, and container images identical to the core Machine's. The gate logged "Deployed core config found." on its next start. A GET still showed "The demo is asleep" (503).
- `deploy.mjs gate` again: the file survived (same content), and the gate logged "Deployed core config found." after the restart. The core and runner stayed stopped.
- No recovery was triggered in these checks.

**Second live recovery, from the deployed config (2026-10-05, UTC).** The owner approved destroying core `82723db7762458` and volume `vol_vp27qwpq5y8gx8e4`; the supervisor set the mark (204). "Start the demo" in the browser pane on https://checkout-surge-gate.fly.dev/demo, with a curl poll every 2.4 s and both apps' logs streamed.

| Time | Event |
| :-- | :-- |
| 08:46:12.46 | Start POST reaches the gate |
| 08:46:12.56 | Gate logs "Recreating the core Machine." |
| 08:46:14.1 | First poll showing the relocating page (08:46:11.7 still showed the stopped page) |
| 08:46:22 | New Machine `85e760f4434ed8` created in cdg on new volume `vol_458pypynmkd7w694` (zone `78be`) |
| 08:46:34 | Images pulled and Machine started ("created and started in 11.36s") |
| 08:46:39 to 08:46:40 | Migrations applied, seed done, setup exits 0 |
| 08:46:51.02 | Gate logs "Recreated the core Machine." |
| 08:46:52.49 | First poll relayed to the new core (200) |

- **Relocating page, then the demo: pass.** 40.0 s from the click to the first relayed page; every poll in between showed "Relocating the demo", and the browser tab reloaded on its own into the demo.
- **Built from the gate's deployed config file: pass.** The new core's container images, `guest`, and every container's environment match `/fly/core-machine.json` in the gate's config (`COMMIT_SHA` `d5383051…-dirty`); its mount is the new volume (3 GB, `core_data`), and its metadata is `{"role":"core"}` (mark not copied).
- **Old core retired: pass.** `82723db7762458` is `destroyed`; `vol_vp27qwpq5y8gx8e4` is `pending_destroy`; the core app lists one Machine and one volume.
- **Fresh install: pass.** Run history read "No runs yet"; the seed log shows the presets.
- **The next run's runner follows the core: pass** (same region again). A Preview 1k run from `/demo` through the gate (`a8d015ac…`) completed: 500 / 500 confirmed, converged in 30.4 s; the public report shows "Load generator region: cdg"; the runner (started 08:47:32, stopped 08:48:13) had `API_BASE_URL` set to the new core's 6PN address (`fdaa:ce:227b:a7b:10a:1ab0:12bf:2`).
- **Left in place:** core `85e760f4434ed8` (cdg, volume `vol_458pypynmkd7w694`) stopped by hand after the run; runner `8d3327ce259918` stopped; the gate autostops on its own. The gate's config file still names the volume of the core that was deployed; a recovery always creates a new volume, so that ID is never used.

**No core listed (owner decision, 2026-10-05).** The role-less candidate idea was rejected: it could treat an unknown Machine as the core and destroy it. Instead, when the Machines API answers with no `role=core` Machine (a dead core whose partial config lost its metadata, or a core deleted by hand), the stopped page shows and a visitor's wake creates a core from the deployed config, exactly like a dead-host recovery but with no old Machine: no lease, nothing destroyed or deleted (`recreate(undefined, config, undefined)`). Concurrent wakes join it. A missing deployed file still shows the unavailable page, and a failed listing too. Accepted risk in HD-34 (a wrongly empty listing creates a duplicate core, served by the selection rule and removed by the guard). Tests: no core listed with the file (recreation without lease or retirement, two wakes joined), without the file (unavailable), a failed listing (no recreation), and the recovery with no old core. Gate unit tests 47/47. Redeployed the gate only; a GET still shows the stopped page (the core exists).

### Inputs for later tasks

- **Task 11 (guard).** Leftovers a recovery can leave: a core-app volume without a Machine (a gate stopped mid-recovery, or a failed deletion), and a second `role=core` Machine (a failed retirement or a gate stopped mid-recovery). The gate uses the `started` core, else the newest. A volume made by a recovery in progress has no Machine for a few seconds, so detached volumes need a grace period too.
- **Task 12 (deploy).** The fresh-core command sets the mark (`metadata.recreate = "requested"`) in the full config it sends, or through the metadata endpoint under the core lease; the next wake recreates the core. `deploy.mjs` still refuses two `role=core` Machines, which happens only mid-recovery or after a failed retirement. Reword the relocating page for the deliberate case if needed.

### Cloud verification (2026-10-05)

- A cloud agent ran the full suite on a clean install of the validation branch, before the review and dead-host passes: type-check, lint (580 files), unit tests (gate 38, fly-machines 30, api 313, all other packages unchanged), API tests (345) and integration tests all pass. One mock-erp integration test failed once and passed on three reruns; task 10 does not touch mock-erp, and the flake is tracked separately. The local Compose topology behaved as before.
- The later passes touch only the gate, the API's runner host, the Fly client and the deploy script, all covered by unit tests (gate 47, fly-machines 31, api runner host 23), so no second cloud pass was run.
