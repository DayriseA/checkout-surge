# 05 — Runner Lifecycle

**Design:** sections 1.1, 1.3, 4.1, 4.2, 7.2, 8 · **Depends on:** 02, 04

## Goal

The API starts a freshly booted runner for every run and stops it when the run reaches a terminal state, with no manual step.

## Scope

- **New shared package `packages/fly-machines`,** with the Machines API client for the operations the API needs: read, start, stop, update and lease. It holds no business rule.
- **Runner host interface** with two implementations chosen by configuration: Fly, and local (runner always on, design section 1.3).
- **Runner operations owner:** one operation at a time, holding a Fly lease.
- **Start of a run:**
  1. Make sure the runner is stopped.
  2. Update its size from the API environment variables, and its `API_BASE_URL`.
  3. Start it.
  4. Read its boot ID and persist it with the run, together with the Machine identity.
- **Boot ID on every start or replay,** including the startup reconciliation path.
- **Stop:** fenced shutdown as soon as the run is terminal, with Fly `stop` as the fallback for an unreachable runner.
- **Abort:** a stopped runner counts as a confirmed abort.
- **Version handshake:** the API refuses a run when its commit differs from the runner's, and the UI shows a clear message.
- **Token:** the API's Machines API token for the runner app.

## Out of Scope

- Loss detection, capacity classification and runner recreation (task 06).
- Runner pre-start. It is a noted option, not a decision.

## Done When

- On Fly, launching `surge-10k` from the UI starts the runner, completes, and leaves the runner stopped.
- Two consecutive runs each get a fresh boot.
- An admin reset succeeds while the runner is stopped.
- A version mismatch refuses the run with the expected message.

## Open Points

- None.

## Inputs from Task 04

- Read the boot ID from `GET /traffic/control` before start and send it as `expectedBootId` on every start and replay, including startup reconciliation. Then make the field mandatory in the contract.
- Compare `status.bootId` with the persisted boot ID in the ambiguous-start recovery (`HttpTrafficExecutionGateway.recoverAmbiguousStart`).
- Map the 409 codes `runner_boot_mismatch` and `runner_stopping` explicitly. Today every 4xx start rejection becomes a generic 502 `load_orchestrator_unavailable`.
- Shutdown always answers 202 with an outcome. Retry `deferred_busy` within a bound (the runner may still be recording the acknowledgement of a report the API has just persisted), then fall back to Fly `stop`.
- Confirm a shutdown by waiting for the Machine to reach `stopped`: the connection may drop once the runner exits.
- Version handshake: never treat `unknown` as a match on Fly. The runner gets `COMMIT_SHA` from the deploy script; the API needs its own commit the same way (core Machine env set by the deploy script), which task 04 did not add.

## Inputs from Task 03

- `startRun` and starting-run reconciliation run inside the API maintenance authority. A runner boot inside `startRun` (3.4 to 7.4 s measured) lengthens that hold; resets, teardown and retention wait behind it.
- After dispatch, only a definitive start rejection proves that no traffic started: the gateway's `TrafficStartRejectedError` (4xx from the load orchestrator) makes `failRun` write zeros; any other dispatch failure writes unknown counters. Classify Fly Machines API 4xx errors separately and never raise them as `TrafficStartRejectedError`: a Fly failure before the start is dispatched is a setup failure (zeros), decided at its own call site.

## Working Notes

Work done on 2026-10-03, flyctl v0.4.111, org `personal`, region `cdg`, on branch `hosted/05-runner-lifecycle`. Nothing is committed.

### What was built

- **`packages/fly-machines` (new).** `FlyMachinesClient` for one app: list, get, update (full config, always `skip_launch`), start, stop, wait for a state (408 resolves `false`), acquire and release a lease. Errors are `FlyMachinesApiError` with status and body. No business rule, no classifier (task 06).
- **Runner host (`apps/api/src/services/runner-host.ts`, `fly-runner-host.ts`).** One `RunnerHost` interface (`start`, `stop`, `isStopped`), chosen in `apps/api/src/index.ts`:
  - `alwaysOnRunnerHost` (local): start has no Machine to start, stop does nothing, never stopped.
  - `FlyRunnerHost`: finds the runner by `role=runner` metadata, holds the Machine lease (TTL 300 s, not renewed; every operation stays below it) for each operation.
    - start: if the Machine is not stopped, fenced shutdown with the boot read from `GET /traffic/control`, then Fly `stop` whatever the outcome (no other run can be in flight); update the config only when size or `API_BASE_URL` differ (freshly read full config, wait for `stopped` on the new `instance_id`); start; wait for `started`.
    - stop: nothing if stopped; fenced shutdown; `deferred_busy` retried every second for up to 30 s; `shutdown_requested` confirmed by waiting up to 30 s for `stopped`; `ignored_*` leaves the runner running (it serves another boot or run); unreachable, still busy, or not stopped in time falls back to Fly `stop` with the lease nonce, then waits for `stopped`.
- **Operations owner (`apps/api/src/services/runner-operations.ts`).** `RunnerOperations` serializes every runner operation in-process (single API process contract): `bootForRun`, `releaseAfterRun` (background, failures logged), `abortCurrent`.
  - boot: host start, poll the runner's `/health/ready` (every 250 ms, 30 s bound), read `{bootId, version}`, version handshake. Any failure stops the runner again inside the same serialized operation and raises an `ApiHttpError`: `runner_version_mismatch` (503) or `load_orchestrator_unavailable` (503, "The load generator could not be started.").
  - abort: a stopped runner (Machine state) is a confirmed abort (`no_current_run`) without a call; otherwise the gateway abort as before.
- **Run start (`demo-run-service.ts`).** Boot happens right before dispatch (after inventory setup), inside the maintenance authority. A boot failure is a setup failure: `failRun(..., "load_orchestrator_unavailable", "no_traffic_started")` writes zeros. The boot is persisted on `demo_runs` (`runner_machine_id`, `runner_boot_id`), then the start carries `expectedBootId`.
- **Stops.** `releaseAfterRun` is called when a run with a recorded boot becomes terminal: `failRun`, finalization (only when this call wrote the summary), and admin and automatic resets (after the abort of each fenced run).
- **Startup reconciliation** replays with the persisted `expectedBootId`; a starting run without a recorded boot is skipped with a warning (its start was never dispatched) and waits for the automatic reset.
- **Gateway (`traffic-execution-gateway.ts`).** New `isReady`, `readIdentity`, `shutdown` (answer must match the run and boot). The ambiguous-start recovery returns "not recovered" when `status.bootId` differs from `expectedBootId`. 409 `runner_boot_mismatch` and `runner_stopping` keep `TrafficStartRejectedError` (zeros) but surface their own code with a 503.
- **Contracts.** `expectedBootId` is mandatory; new error code `runner_version_mismatch`. The load-orchestrator check no longer tolerates a missing field.
- **Persistence.** `demo_runs.runner_machine_id` (text, null without a Machine) and `runner_boot_id` (uuid), edited into the reviewed baseline and its snapshot (repository policy: one baseline, no upgrade path).
- **Web.** `runner_version_mismatch` shows "The demo is being updated" (warning, "Check again") on public start and admin surfaces.
- **Config (API).** `COMMIT_SHA` (default `unknown`); `RUNNER_FLY_APP` selects the Fly host and then requires `RUNNER_FLY_API_TOKEN`; `RUNNER_CPU_KIND` (`performance`), `RUNNER_CPUS` (4), `RUNNER_MEMORY_MB` (8192).
- **Infra.** Core `machine.json`: the API gets `RUNNER_FLY_APP=checkout-surge-runner` and the `RUNNER_FLY_API_TOKEN` secret. Runner `machine.json`: `API_BASE_URL` removed (the API sets it before each start). `deploy.mjs` sets `COMMIT_SHA` on the core's API container too. All five Dockerfiles copy the new package manifest; `build:shared` builds it.

### Minor choices

- **Version mismatch leaves a failed run.** The run row exists before the runner can be asked its version (the runner must not be touched before the single-run admission), so a mismatch fails the run with `load_orchestrator_unavailable` and zero counters, and the start answers 503 `runner_version_mismatch` for the UI message. No new failure reason.
- **`unknown` versions.** The owner takes `acceptUnknownVersion`, set at the composition root to true only for the local host, so local Compose (no `COMMIT_SHA`) keeps starting runs.
- **A runner found running at start** is shut down with the new run's ID: an empty journal answers `shutdown_requested`, an older run's journal answers `ignored_run_mismatch`, and then Fly `stop` is used. It is stale by construction (one non-terminal run).
- **Readiness = the runner's `/health/ready`** (it also probes the API over 6PN), then `GET /traffic/control`. The same path serves the local host.
- **The deploy script takes no runner lease.** While the API holds it, the script's update gets a 409 and fails loudly; leasing in the script is left to task 12.
- **Local data.** The baseline edit and the mandatory `expectedBootId` (stored in the load journal) need `pnpm runtime:wipe` and `pnpm runtime:setup` on an existing local Compose project.

### Fly state

- Secret `RUNNER_FLY_API_TOKEN` (deploy token for `checkout-surge-runner`, created with `flyctl tokens create deploy`) staged on `checkout-surge-core`; local copy appended to the gitignored `infra/fly/core/core-secrets.env`. Probed with the token: list, lease (201, nonce in `data.nonce`), a second lease and a start without nonce get 409, `GET /lease` returns the holder and nonce, release 200; `Authorization: Bearer <token>` works for the `FlyV1` deploy token.
- Both apps deployed from this tree (version `8cdd03c5…-dirty`): runner Machine `853de7f4462758` and core Machine `8d14e3aee13038` updated and left `stopped` by the deploy script.
- The core's volume held the schema of the previous baseline (Drizzle does not re-apply an edited baseline). The wipe was refused to this agent by the permission classifier; with the owner's approval (option A) the supervisor recreated the `checkout_surge` database, flushed Redis and restarted the core at about 16:46 UTC.
- At the end: both Machines `stopped`, no new resource besides the secret, the `fly proxy` tunnels closed.

### Done-when checks on Fly (2026-10-03, 16:46 to 16:51 UTC)

All runs on runner Machine `853de7f4462758`, through `fly proxy` to the core. Seven runs in total, one `surge-10k`.

| # | Run | Launched from | Outcome | Boot ID |
| :-- | :-- | :-- | :-- | :-- |
| 1 | preview-1k | API (admin) | completed, 1,000 / 1,000, 0 transport failures | `88ea7928…` |
| 2 | preview-1k | API (admin) | completed, 1,000 / 1,000, 0 transport failures | `a325b535…` |
| 3 | preview-1k, runner `COMMIT_SHA=deliberate-mismatch` | API | refused: 503 `runner_version_mismatch` | not recorded |
| 4 | preview-1k, same mismatch | demo UI | refused; UI shows "The demo is being updated" | not recorded |
| 5 | preview-1k at 5 req/s for 120 s, runner stopped with `fly machine stop` | API | failed `traffic_delivery_major_shortfall` (see below) | `aa9fc952…` |
| 6 | same, runner killed with `--signal SIGKILL` | API | admin reset with the runner stopped: 200 in 398 ms, run `admin_reset`, unknown counters | `93a5ce25…` |
| 7 | **surge-10k** | **demo UI** (public) | **completed: 10,000 / 10,000, 500 accepted, 0 transport failures; runner stopped afterwards** | `577f7319…` |

- **Fresh boot per run: pass.** Every run that reached the runner recorded a different boot ID and the Machine ID; the Machine events show one `start` and one `exit` per run.
- **Runner stopped after each run: pass.** Each stop was the fenced shutdown (one `POST /traffic/shutdown`, Machine `exit` code 0); no Fly `stop` fallback was needed. After a mismatch the runner was also stopped by its fenced shutdown (exit 0).
- **Version mismatch: pass**, then `COMMIT_SHA` restored to `8cdd03c5…-dirty`. The two refused attempts appear in history as failed runs with zero counters (see Minor choices).
- **Admin reset with the runner stopped: pass** (run 6). Run 5 shows why SIGKILL was needed: a plain Fly `stop` sends SIGINT, the load-orchestrator shuts down gracefully, publishes an interrupted completion report, and the API finalizes the run before any reset, so nothing was left to abort.

### Measurements

- **Runner start to ready inside a run** (Fly `start` request to the API dispatching `/traffic/start`): 3.0 s for `surge-10k` (start 16:50:21.68, Machine `started` 23.19, Node listening 24.25, `/traffic/start` 24.71). Runs 1 and 2: Node listening 2.8 to 3.0 s after the start request. No first readiness probe timed out (the runner now reaches the API by IP, not `.internal`).
- **Added latency to run start** (API `POST /demo/runs/start` duration seen by the client through `fly proxy`): 3.4 to 3.9 s with a matching config; 8.1 s on the first run after a deploy, which also updated the runner config (`API_BASE_URL` and the wait for `stopped` after the update, about 2 s, plus the Fly start).
- **Shutdown to `stopped`:** 1.3 s (run 1: shutdown request 16:47:35.69, `exit` 16:47:36.97) and 2.0 s (`surge-10k`: 16:51:00.68 to 16:51:02.64). The shutdown request follows finalization by 0.2 s.
- **Runner time per `surge-10k` run:** about 41 s from start to `stopped` (traffic plus the 36 s drain before finalization).

### Validation (workstation)

- `pnpm exec biome check --write` on every touched file: clean.
- Type-check: `fly-machines`, `contracts`, `db`, `api`, `load-orchestrator`, `web` pass; `pnpm type-check:test` only reports the 3 known `mock-erp` errors.
- Unit tests: `fly-machines` 3/3, `api` unit 284/284 (new `runner-operations`, `fly-runner-host`, gateway and config tests), `contracts` 160/160, web `error-presentation` 52/52, load-orchestrator `runner-control`, `correlation-boundary`, `k6-summary`, `completion-delivery-coordinator` pass; `load-orchestrator-boundaries` has 1 failure ("classifies a real executable probe", a real process-spawn probe, Windows environment, unrelated).
- Not run here (need Docker PostgreSQL/Redis): the edited DB-backed API tests (`demo-run-service`, `demo-maintenance-workflows`, `demo-run-finalization-service`, `demo-run-startup-reconciliation-service`, `traffic-completion-service`), the worker integration test, and the `db` unit and integration suites (the `db` unit run was refused by the permission classifier).

### External review (2026-10-03)

An external adversarial review was checked against the code; the owner approved this triage.

1. **Stale release could stop a newer runner** (finalization is outside the maintenance authority, so a boot for run N+1 can enter the queue before N's release; an unreachable control call then led to Fly `stop`). Plausible, **fixed**: `RunnerOperations` remembers the run of its latest boot and skips a release for any other run (each boot already stops stale runners). Before any boot in the process, releases still proceed.
2. **Startup replay skips the version handshake.** Plausible, **accepted** (needs an API crash in the gap before dispatch plus a deploy within 3 minutes); recorded in task 06.
3. **The Machine config was read before the lease**, so a deploy landing in between could be overwritten by the stale full config on the update branch (now taken on the first start after every runner deploy). Plausible, **fixed**: the Machine is read again under the lease (`getMachine` on the leased ID).
4. **A failed `recordRunnerBoot` after a boot leaves the run `starting` without a boot.** Confirmed, rare, **deferred to task 06** (inputs added there).
5. **A post-commit read failure skipped the runner stop.** Confirmed, **fixed**: `failRun` and finalization enqueue the release before their post-commit reads.
6. **The lease comment was wrong** (start's per-call bounds add up to about 380 s, above the 300 s TTL). Plausible, **comment fixed**; no code change.

Still missing: the deploy script's end-of-deploy version check (design section 8), left to task 12.

### Proposed design updates

- **4.1** The API reads the runner's readiness (`/health/ready`, which also probes the API over 6PN) before reading its identity; the boot runs right before dispatch, inside the maintenance authority.
- **4.2** Stop details: `deferred_busy` retried for 30 s, `shutdown_requested` confirmed by `stopped` within 30 s, `ignored_*` leaves the runner running, Fly `stop` otherwise. A runner found running at the start of a run is always stopped (fenced first, then Fly `stop`). The runner stays up while a run drains (about 30 s for `surge-10k`), because the stop follows the terminal state; stopping at `draining` would save that time and is safe since finalization does not need the runner.
- **4.2/4.3** A Fly `stop` (SIGINT) mid-run is not a silent loss: the runner publishes an interrupted completion report and the run finalizes as a failed shortfall. Task 06's loss detection only sees hard losses (crash, SIGKILL, host loss); its done-when check should kill the runner with SIGKILL.
- **4.3** A starting run without a recorded boot was never dispatched; reconciliation skips it until the automatic reset (task 06 could fail it with zeros instead).
- **7.2** Rotation: `RUNNER_FLY_API_TOKEN` is the core secret holding the runner-app deploy token.
- **8** A version mismatch leaves a failed run (`load_orchestrator_unavailable`, zero counters) besides the UI message. The deploy script does not take the runner lease; it fails with 409 while the API holds it.
- **docs/local_development.md** Rebuild local Compose data after this change (`runtime:wipe`, `runtime:setup`).

### Integration (2026-10-03)

- **Owner decisions:** the hosted core database was recreated (option A) by the supervisor with the owner's approval, because the single baseline migration changed. The runner keeps stopping at the terminal state, not at `draining`. The proposed design updates above are recorded in `design.md` (4.1, 4.2, 4.3, 7.2, 8) and in task 06's inputs.
- **Local Compose:** after this change, rebuild local data with `pnpm runtime:wipe` then `pnpm runtime:setup` (repo pre-release policy for baseline changes).

### Cloud verification (2026-10-03)

With the review fixes, the full default suite passed on Linux: `pnpm type-check`, `pnpm lint`, `pnpm test:unit` (1,578 tests), `pnpm test:api` (340 tests) and `pnpm test:integration` (192 tests). An earlier snapshot also passed `docker compose build`, `runtime:wipe`, `runtime:setup`, `runtime:smoke` and the runtime image contract test.
