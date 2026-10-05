# 11 — Guard

**Design:** sections 5, 7.2 · **Depends on:** 05, 09

## Goal

An hourly safety net bounds the cost of a bug: nothing stays awake or left over by accident.

## Scope

- **Scheduled Machine** in the gate app, hourly, using the gate image with a one-shot entrypoint.
- **Core stop rules:**
  - unreachable across several probes, after a startup grace period;
  - awake for more than 3 hours.
- **Runner stop rule:** started for longer than its maximum lifetime.
- **Unexpected Machines** in the core and runner apps are destroyed, after a grace period.
- **Tokens** for both the core and runner apps.

## Out of Scope

- Billing controls. The owner configures them in the Fly dashboard.

## Done When

- Each rule is demonstrated once, deliberately, with a lowered threshold where needed.
- A core saturated by a 10k burst is not stopped.

## Open Points

- None.

## Inputs from Task 06

- The guard keeps the newest `role=runner` Machine (by `created_at`) and treats older ones as surplus, destroyed after the grace period.
- The API itself tolerates several runners by using the newest. They appear only after a failed retirement of a recreated runner or a lost create response.

## Inputs from Task 09

- **Failed-setup core (owner decision, 2026-10-05).** When migrations or the seed fail, the core Machine stays `started` but the API never starts, so the idle stop never runs and the core would stay up until the 3-hour cap. The guard stops such a core on its first run. It is detectable through the Machines API: the `setup` container has an `exited` event with a non-zero `exit_code` no older than the Machine's latest `start` event (`setupFailed` in `apps/gate/src/core-machine.ts`, reusable since the guard shares the gate image).
- The gate app already holds the core-app deploy token as the secret `CORE_FLY_API_TOKEN`.

## Inputs from Task 10

- Leftovers a recovery can leave: a core-app volume without a Machine (a gate stopped mid-recovery, or a failed deletion), and a second `role=core` Machine (a failed retirement or a gate stopped mid-recovery). The gate uses, among the cores that can serve (`host_status` `ok`, no failed setup), the `started` one, else the newest. A volume made by a recovery in progress has no Machine for a few seconds, so detached volumes need a grace period too.
- **Never keep "the newest" core blindly (task 10 review).** Unlike the runner app, the guard destroys a recovery's leftover core that has failed setup, is unhealthy, or sits on a host that is not `ok`, then deletes its volume, and keeps the core that can serve.
- **No lease on a host that is not ok.** Fly grants no usable lease there and returns only a partial config (flyctl skips leasing such Machines; fly-go `GetConfig`). The gate's core recovery follows that rule; the guard should too, destroying with force and no nonce, 404 counting as done. A volume on a host that is down stays `pending_destroy` until the host returns, so its deletion is retried on later runs rather than awaited.
- **A core-app Machine without the `role` label on a down host** (a dead core whose partial config lost its metadata). The gate ignores it and creates a new core on the next wake. Decide the guard's rule here: do not destroy unknown Machines blindly.

## Working Notes

Work done on 2026-10-05, flyctl v0.4.111, org `personal`, region `cdg`, on branch `hosted/11-guard` (from `dev` at `755e001c`). Nothing is committed.

### What was built

- **`packages/fly-machines`:** `listVolumes()`; `FlyVolume` gains `state`, `attached_machine_id` and `created_at` (as Fly returns them).
- **Gate, core selection (`core-machine.ts`):** the rule of `findCoreMachine` is extracted as `selectCore(machines, canServe)` with `coreCanServe`, so the guard keeps the core the gate would use. The gate's behavior is unchanged.
- **Guard (`apps/gate/src/guard.ts`):** one pass per app (core, then runner), each planned from a listing then executed; a failure in one app does not skip the other, and the process exits 1 when a listing or an action failed. Rules, thresholds and lease use are in design section 5 ("Implemented in task 11"). Each action is logged (`The guard acted.`, with app, action, reason, Machine or volume), each probe too (answer and duration), and each app's pass (`The guard checked the app.`, with the action count).
- **Entrypoint (`guard-main.ts`) and config (`loadGuardConfig` in `config.ts`):** `CORE_FLY_APP`, `CORE_FLY_API_TOKEN`, `RUNNER_FLY_APP`, `RUNNER_FLY_API_TOKEN`, plus the dry-run and threshold switches used for the demonstrations. Logs carry `service: gate`, `component: guard`.
- The gate now depends on `@checkout-surge/contracts` for `automaticRunResetDeadlineSeconds` (the runner's own lifetime is derived from it). `pnpm-lock.yaml` was updated with `--lockfile-only`: a plain `pnpm install` on the workstation wanted to purge `node_modules` without a TTY, so the local link was made by hand.
- **Infra:** `infra/fly/gate/guard-machine.json`; `deploy.mjs gate` creates or updates the guard after the gate, from the same image refs (`machineConfig` takes the file name), without `skip_launch` (see "Schedule observed"). The core config file logic is unchanged, and the gate still carried `/fly/core-machine.json` after both gate deploys of this task.

### Fly state

- Secret `RUNNER_FLY_API_TOKEN` on `checkout-surge-gate`: `flyctl tokens create deploy -a checkout-surge-runner -n guard-runner`, piped into `flyctl secrets import --stage`, never printed or stored.
- Guard Machine `8d40d9fee36ee8` (gate app, `role=guard`, `schedule: hourly`), image `gate-755e001c…-dirty-20261005T171127` (review fix redeploy), the same as the gate Machine `873325c069dd38`.
- Throwaways created and removed in this task: core-app Machines `8d14e6cee26238` (C), `830d19b773d278` (D), `1850353b060208` (U1), volumes `vol_vgn96qjnnddyl5z4` (D's) and `vol_v3gkd8jlgq1x2jo4` (V); runner-app Machine `817400c9963118` (U2); app `checkout-surge-guard-sandbox` (destroyed); four schedule probe Machines in the gate app (destroyed). The real core `85e760f4434ed8`, its volume `vol_458pypynmkd7w694`, the runner `8d3327ce259918` and the gate were never targeted.

### Done-when checks on Fly (2026-10-05, UTC)

Demonstrations ran as one-off Machines in the gate app (`flyctl machine run <gate image> node dist/guard-main.js --rm --restart no`, same secrets as the guard), with env overrides. Runs that could only stop used `GUARD_LEFTOVER_GRACE_SECONDS=1000000000`, so no destructive rule could fire. The run with destructive rules was dry-run first, with leases held by hand on the real core and runner as a backstop. The scheduled guard was switched to dry run while throwaway `role=core` Machines existed (a usable throwaway newer than the real core would have made the real core the surplus), then restored by the final `deploy.mjs gate`.

| Run | Setup | Result |
| :-- | :-- | :-- |
| Clean state, dry run then the scheduled Machine started by hand | production thresholds | 0 actions in both apps; a pass took 0.4 s, the Machine was `stopped` 3 s after its start, exit 0 |
| 1. Awake cap, runner lifetime | real core and runner started by hand at 09:50:26 / 09:50:28; caps lowered to 60 s | 09:51:44 core stopped (`awake_too_long`, `stopped` 11 s later), runner stopped (`overdue`) |
| 2. Failed setup, unreachable | C: `role=core`, a `setup` container exiting 1; D: `role=core`, alpine sleeping, nothing listening; startup grace 0 | D: no answer at 09:53:09 (2 s timeout), 09:55:09, 09:57:09, then stopped (`unreachable`); C stopped (`setup_failed`); real core (stopped) untouched |
| 3. Leftovers | C and D started again; U1 (core app) and U2 (runner app) without a role; V a detached 1 GB volume; leftover grace 60 s, startup grace 0 | Dry run planned exactly: destroy D and C (`surplus`), U1 and U2 (`unknown`), delete V (`orphan`). The real run did it (10:07:41 to 10:07:47); D's volume was deleted after D. The real core was kept although both throwaways were newer: never the newest blindly |
| 4. Saturated core | see below | not stopped |
| 5. Surplus runner | sandbox app with two `role=runner` throwaways created 5 s apart; run from the workstation (same build, `node apps/gate/dist/guard-main.js`), the sandbox as the runner app, grace 30 s | dry run then real: the older destroyed (`surplus`), the newest kept |

- **Why run 5 used a sandbox.** In the real runner app, any throwaway runner is newer than `8d3327ce259918`, so the newest-wins rule would target the real runner. The guard's runner token is scoped to the real runner app, so the sandbox run used the workstation's flyctl token, passed inline and never printed. The sandbox app was destroyed afterwards.
- **A saturated core is not stopped (run 4).** The core was woken through the gate (POST at 10:08:41, demo relayed at 10:08:55), a public `surge-10k` run was started through the gate at 10:09:00.9, and a guard with production probes (3, 2 minutes apart, 2 s timeout) and startup grace 0 was launched 4 s later. Traffic ran 10:09:04.9 to 10:09:21.8 (first request 10:09:07.8, peak 7,300 requests/s, HTTP p95 11.4 s, waiting p95 11.35 s); the runner could not forward its k6 metrics to the saturated API at 10:09:14.0 and 10:09:19.0. The guard's first probe, sent at 10:09:18.9, got **no answer within 2 s**; the second, at 10:11:20.9, answered `ready` in 18 ms; no action. The run completed normally (10,000 / 10,000, 500 confirmed, runner in cdg). A single probe would have stopped this core: the Caddy-to-web `/health` path does not touch the API, yet the whole Machine was saturated.
- **Probe timings.** Against a started Machine with nothing listening, the first probe hits the 2 s timeout and later ones are refused in 3 to 22 ms; a silent core makes a run last about 4 minutes.
- **Leases.** A second lease request on a leased Machine answered 409 immediately, as in task 01; `GET …/lease` returns the nonce, which released both protection leases (200).

### Schedule observed

- **First deploy: the schedule never fired.** The guard was created with `skip_launch` (09:47:27), started by hand (09:48:54), updated with `flyctl machine update --skip-start` (09:49:20, the dry-run switch) and by `deploy.mjs gate` (10:14:52, `skip_launch`): no scheduled start in the 72 minutes that followed.
- **Probe Machines (alpine `echo`, `schedule: hourly`, gate app, removed afterwards).** Created launched by flyctl's `--schedule` (11:23:25, restart `on-failure`) and through the Machines API (11:26:23, restart `no`): both ran by schedule at 12:23:00 and 12:26:00. Created with `skip_launch` (11:26:21), or created launched then updated with `skip_launch` (11:26:48): no start in 61 minutes. The restart policy plays no part.
- **The guard after an update without `skip_launch`** (its own config, 11:26:52; the Machine stayed `stopped`): scheduled start at 11:47:00. **Fix:** `deploy.mjs` now sends the guard without `skip_launch` (HD-41). After the fixed redeploy (12:07:26): scheduled start at **12:47:00**, exactly one hour after the 11:47 run, so the phase (minute :47) survives updates and follows the guard's creation time, not the update. Both scheduled runs: production thresholds, 0 actions in both apps, exit 0, `stopped` 5 s after the start.

### Validation (workstation)

- `pnpm exec biome check --write` on every touched file, `biome lint` on `gate` and `fly-machines`: clean.
- Type-check: `gate`, `fly-machines` and `api` pass; `pnpm type-check:test` reports only the 3 known `mock-erp` errors (it caught the recovery test's volume fake, updated).
- Unit tests: `gate` 63/63 (16 new in `guard.test.ts`), `fly-machines` 31/31, `test:scripts` 60/60.
- Not run here: API and integration tests (Docker); nothing in this task touches a Docker-backed test. The local Compose topology has no guard and no gate.

### Minor choices

- **Thresholds.** Startup grace 10 minutes (a recovery waits up to 5 minutes for its new core); probes 3, 2 minutes apart; leftover grace 15 minutes (a recovery holds the old core's lease up to 10 minutes); runner overdue after 20 minutes.
- **Stop rules apply to any started `role=core` Machine** on an `ok` host that is not destroyed in the same run, kept or not, so nothing stays awake whichever core is kept.
- **A destroyed Machine's volume is deleted in the same run;** a volume left over otherwise waits for the detached-volume rule.
- **No dedicated alerting:** a failed run logs errors and exits 1, visible in the gate app's logs.

### Open point for the owner

**A Machine without a known role on a host that is not `ok`** (in practice, a dead core whose partial config lost its `role`). Owner decision (2026-10-05): left alone, with a warning on every run (HD-42). The owner also kept the runner token on the gate app (HD-40) and confirmed the thresholds.

1. **Leave it alone (implemented).** Pros: never destroys something it cannot identify; when the host returns, the Machine shows its role again and the normal rules handle it (a surplus core is destroyed). Cons: if the host never returns, a Machine and its volume (3 GB, about $0.45 per month) linger, with a warning every hour.
2. **Destroy it after the grace period, like any unknown Machine.** Pros: no lingering leftover; the gate already creates a new core when none is listed. Cons: it may be the only real core on a host that will come back, so its data is lost (accepted by HD-05) and nothing could tell a foreign Machine apart.
3. **Destroy it only once the app holds a usable `role` Machine, and after a longer grace (for example 24 hours).** Pros: cleans up only when the leftover has clearly been replaced. Cons: the most code, for a case not yet seen on Fly.

Recommendation: option 1. The cost is negligible, it is the only option that never destroys an unidentified Machine, and Fly cannot act on a dead host anyway (its volume stays `pending_destroy` until the host returns).

### External review (2026-10-05), arbitrated with the owner

- **Acting on a stale plan: confirmed, fixed.** `execute` stopped or destroyed the Machine as listed at planning time, without reading it again, and the listing is re-read after the probes only when a core stays silent, so after a missed-then-answered probe every other rule acted on a listing 2 to 4 minutes old; `destroy` also chose "no lease" from the planned `host_status`, so a host back since the plan meant a force-destroy of an ok-host Machine without its lease (contrary to HD-37). Now every stop and destroy reads the Machine again (`getMachine`) under its lease, or just before the destroy on a host that is not ok, and acts only if its state, host status and latest start are unchanged; a 404 counts as changed (a recovery may just have destroyed it), and the skip is logged "Leased or changed since the plan". HD-37 and HD-38 amended in place. Tests: a core restarted between the listing and the lease is not stopped; a leftover core whose host came back is not destroyed.
- **`deploy.mjs` failed after a successful guard deploy: confirmed, fixed.** `deployGuard` waited for `stopped` with a 60 s timeout, but a created guard runs its first pass, which takes over 4 minutes with a silent core: Fly answers 408 and the script exited 1. The wait is removed (an update leaves a stopped guard stopped; on a create it only waited for the first pass). Redeployed with `deploy.mjs gate` (17:11 to 17:12 UTC): exit 0, the gate kept `/fly/core-machine.json`, the guard took the new image and stays `hourly` (it had run by schedule at 16:47), core and runner stopped.

### Inputs for later tasks

- **Task 12.** `deploy.mjs gate` also creates or updates the guard (any state), without `skip_launch`: keep it that way when completing the script, and never touch the guard with `flyctl machine update --skip-start`, or the schedule silently stops (HD-41). A deploy that lands during a guard run interrupts it, harmlessly. The guard takes 60 s leases on the core and the runner while it stops or destroys them, so a deploy can meet a 409 there and is re-run. The rotation procedure must include the gate secret `RUNNER_FLY_API_TOKEN` (token `guard-runner`).
- **Task 13.** The guard's logs (`component: guard`) and its exit code are the only signal of a failed run; check them during the bot review.

### Cloud verification (2026-10-05)

- A cloud agent ran the full suite on a clean install of the validation branch, before the review fixes: the frozen install accepted the lockfile updated with `--lockfile-only`; type-check, lint (584 files), unit tests (gate 63, fly-machines 31, all other packages unchanged), `test:scripts` (60/60), API tests (345) and integration tests all pass. The local Compose topology, which has no gate or guard, behaved as before.
- The review fixes touch only the guard, its unit tests (65/65) and the deploy script, which the gate redeploy exercised, so no second cloud pass was run.
