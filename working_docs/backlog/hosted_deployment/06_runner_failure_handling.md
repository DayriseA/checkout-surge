# 06 — Runner Failure Handling

**Design:** sections 4.3, 4.4, 6 · **Depends on:** 03, 05

## Goal

A lost runner fails its run immediately, with honest evidence. A provider capacity problem is retried, relocated and explained to the visitor.

## Scope

- **Loss detection.**
  - The API monitors the runner while a run is active.
  - A stopped Machine or a changed boot ID, before a completion report is persisted, terminalizes the run as failed with `load_generator_lost`.
  - An unreachable runner on a started Machine is stopped through Fly after about 60 s, then the same rule applies.
- **Fly error classifier** in `packages/fly-machines`, following the table in design section 6.
- **Capacity recovery:** retry `start` with back-off, then recreate the runner with the region list "core's region, then `eu`", and retire the old one.
- **Region evidence:** the run records the runner's actual region, and the UI shows it.
- **Web:** the relocation and no-capacity messages.
- **Contracts and persistence:** the `load_generator_lost` reason and the runner region.

## Out of Scope

- Core recovery (task 10), which reuses the classifier.

## Done When

- Killing the runner Machine mid-run terminalizes the run as `load_generator_lost` without waiting for the automatic reset, with unavailable counters.
- A deliberately triggered recreation yields a working runner.
- Unit tests cover the classifier on every documented signal.
- The run report shows the runner's region.

## Open Points

- None.

## Inputs from Task 03

- Terminalize a lost runner with `syntheticFailedTrafficSummary(…, "unavailable")`, inside the API maintenance authority so it cannot interleave with resets, starts or starting-run reconciliation. Keep a persisted completion report when one exists.
- When counts are unknown, the web already hides the delivery verdict (pill and "Delivery failed" caveat) and shows the shared unavailable-evidence text (`apps/web/src/app/lib/presentation/traffic-evidence.ts`). The API still classifies the delivery status as `failed`.

## Inputs from Task 05

- Kill the runner with SIGKILL for the loss check. A Fly `stop` (SIGINT) makes the runner publish an interrupted completion report, so the run finalizes as a failed shortfall instead of a loss.
- A starting run without a recorded boot was never dispatched; reconciliation currently skips it until the automatic reset. Failing it immediately with zeros is an option here.
- The Fly `stop` fallback path was never needed on Fly in task 05; only unit tests cover it.
- If `recordRunnerBoot` (`apps/api/src/services/demo-run-service.ts`) throws after a successful boot, the run stays `starting` without a recorded boot: admission is blocked until the 900 s automatic reset, and the runner self-exits within 3 minutes. Failing a starting run without a recorded boot immediately must cover this case, and account for an ambiguous DB commit (the boot may in fact be recorded).
- Startup replay of a starting run does not re-run the version handshake. It only matters if the API crashes in the milliseconds between recording the boot and dispatching, then a deploy lands within the runner's 3-minute idle window. Accepted.

## Working Notes

Work done on 2026-10-03, flyctl v0.4.111, org `personal`, on branch `hosted/06-runner-failure-handling`. Nothing is committed.

### What was built

- **Classifier (`packages/fly-machines/src/classifier.ts`).** `classifyFlyError(error)` follows design section 6 row by row: a body `status` of `insufficient_capacity` or `volume_placement_capacity`, or a 409 whose message contains a known phrase or ends in "no capacity", is `provider_capacity`; 408 or a body `host_status: "unreachable"` is `host_unreachable`; 429 and 5xx are `transient`; any other 409 is `conflict`; any other 4xx is `own_error`; anything else (another status, or a failure that is not a Fly answer, such as a network error) is `unclassified_provider_error`. `classifyFlyMachine(machine)` covers the two Machine-level signals: `host_status: "unreachable"`, and a latest `exit` event with a non-zero `exit_code` that nobody requested (`own_error`). Fly omits a zero `exit_code`, and a `fly machine stop` shows `requested_stop: true` (checked on the runner's event log). No business rule. The client gained `createMachine(config, region)` and `destroyMachine(id, nonce?)` (force), and `stopMachine` takes an optional nonce.
- **Capacity recovery (`fly-runner-host.ts`).** Under the runner lease, `start` tries the Machine in place up to 3 times with 1 s then 3 s back-off on `provider_capacity`, `host_unreachable` or `transient`; a conflict, our own error or an unclassified error fails at once. When the last failure is capacity or a dead host (or the leased Machine already shows `host_status: "unreachable"`), the host calls the `onRelocating` hook, creates a fresh Machine from the current config (size and `API_BASE_URL` applied, same image) with region `<core region>,eu`, waits for `started`, then force-destroys the old Machine with the lease nonce. A create refused for capacity raises `RunnerCapacityUnavailableError` (503 `runner_capacity_unavailable`) and keeps the old runner; a new Machine that does not start is destroyed and the old one kept. The core region is `FLY_REGION` (required when `RUNNER_FLY_APP` is set).
- **Deliberate recreation trigger.** `POST /admin/demo/runner/recreate` (control token) runs `RunnerOperations.recreate()`: the same replacement, refused with 409 while the runner Machine is not stopped, and the new runner is stopped afterwards. Answer: `{machineId, region, correlationId}`. The local host answers 409. Task 10's deploy command can call it the same way.
- **Loss detection.** `RunnerLossMonitor` (`runner-loss-monitor.ts`) runs on the existing 5 s finalization poll. It reads the run that is `starting` or `active` with a recorded boot (so no completion report is persisted: the report insert and the move to `draining` share one transaction) and asks `RunnerOperations.checkRunner`: a stopped Machine or another boot ID is `lost`, a failed identity read is `unreachable`. `lost` calls `DemoRunLifecycleService.failLostRun`, which takes the maintenance authority and reuses `failRun`: `load_generator_lost`, `syntheticFailedTrafficSummary(…, "unavailable")`, terminal claim limited to `starting`/`active` (a run that reached `draining` keeps its persisted report and finalizes normally), sale eligibility closed, no abort call, runner released. An unreachable runner is stopped through the owner (`stopUnreachable`, fenced shutdown then Fly `stop`) once it has been unreachable for 60 s, then checked again. The check is active everywhere (the local runner is never stopped, but a boot change is still a loss).
- **Starting run without a recorded boot.** Starting-run reconciliation (already inside the maintenance authority, which excludes a start in progress) now calls `failUndispatchedRun` instead of waiting for the automatic reset: `load_orchestrator_unavailable` with zero counters, then a release with an unknown boot (Fly `stop` of any runner booted for it). This covers `recordRunnerBoot` throwing after a boot: the run stays `starting` and the next poll (≤ 5 s) reads the database. An ambiguous commit is resolved by that read: when the boot was recorded, the run is a normal starting run and is replayed against its boot (the runner is left running for that reason).
- **Region evidence.** `demo_runs.runner_region` (text) and `runner_relocating` (boolean, default false), edited into the baseline and its snapshot. The boot records the region with the boot ID; the run snapshot carries `runnerRegion`, and `runnerRelocating: true` only while the run is `starting`; the public run history run carries `runnerRegion`.
- **Web.** Starting run with `runnerRelocating`: presentation state "relocating the load generator", with "Provider capacity issue, relocating the load generator, please wait." on the public start gate and on the watch page's starting sentence. `runner_capacity_unavailable`: "Our hosting provider has no capacity right now", no traffic started, come back later, link to https://status.flyio.net/ (allowed on the public start surface). The admin run report lists "Load generator region" under Lifecycle; the public report shows "Load generator region: cdg" under Delivery and measurements. Both only when a region is recorded.
- **Contracts.** Failure reason `load_generator_lost` (public category `traffic`), error code `runner_capacity_unavailable`, `runnerRegion` and `runnerRelocating` on snapshots, the recreate path and response.

### Minor choices

- **Relocation flag persisted on the run.** The relocation happens inside the synchronous start request; the only channel to the visitor during it is the dashboard projection, which is built from the run row. One boolean column is the simplest carrier. Setting it is best effort (logged).
- **Retry classes.** Transient errors are retried but never relocate (recreation would hit the same API trouble); capacity and dead host relocate. This is my reading of 4.4, which says "retry, then recreate" without naming classes.
- **Fly `stop` after an unknown boot.** A starting run without a recorded boot releases its runner with an unknown boot, which skips the fenced shutdown and uses Fly `stop`. Safe: it is the only non-terminal run.
- **Detection cadence.** The monitor shares the 5 s finalization poll instead of a new interval and configuration value.
- **Region list.** The Machines API `region` field takes a prioritized list (`cdg,eu`) per Fly's placement guide; checked live below.

### Fly state

- Both apps deployed from this tree (version `cdf6efa3…-dirty`). Because the baseline gained two columns, the supervisor recreated the hosted `checkout_surge` database and flushed Redis with the owner's approval (2026-10-04) before the checks.
- Runner Machine **`8d3327ce259918`** (cdg, performance-4x, 8 GB, `role=runner`), created by the deliberate recreation; the previous runner `853de7f4462758` is destroyed. Core Machine `8d14e3aee13038` with volume `vol_vwnk7q676mlo5emv`.
- At the end: both Machines `stopped`, one runner and one core Machine, the runner app has no volume, no `fly proxy` left open. `FLY_REGION` is present in the API container (the API starts with it required).

### Done-when checks on Fly (2026-10-03, 22:14 to 22:16 UTC)

Runs launched through the API (admin operator mode, control token) over `fly proxy`.

| # | Run | Outcome |
| :-- | :-- | :-- |
| 1 | `7932097f…`, preview-1k at 5 req/s for 120 s, runner killed with `fly machine stop --signal SIGKILL` 8 s into traffic | failed `load_generator_lost`, all transport and HTTP counters `null` (planned 600 known), `runnerRegion` cdg |
| 2 | `64514a9f…`, preview-1k on the recreated runner | completed: 1,000 / 1,000, 500 accepted, 0 transport failures, `runnerRegion` cdg; runner stopped afterwards |

- **Loss without the automatic reset: pass.** Timeline of run 1: SIGKILL requested 22:14:39.96; the process exited 22:14:40.753 (exit 137); Fly recorded the Machine `stopped` at 22:14:42.044; the API logged "The runner was lost before its completion report." and finalized the run at 22:14:43.387. **Detection delay: 2.6 s from the process exit, 1.3 s after Fly marked the Machine stopped, 3.4 s from the kill request** (bounded by the 5 s poll plus one Machines API read). The run report shows the unavailable-evidence text, not zeros.
- **Deliberate recreation yields a working runner: pass.** `POST /admin/demo/runner/recreate`: 14.1 s end to end (request 22:14:57.0, create accepted and launching at 22:15:00.06, `started` 22:15:05.2, old runner destroyed and the recreation logged at 22:15:08.6, new runner `stopped` at 22:15:09.96, answer 22:15:11.2). The new Machine kept the image, the size (performance, 4 vCPU, 8,192 MB), `role=runner` and `API_BASE_URL`. Run 2 then booted it normally (start request answered in 4.5 s) and completed.
- **Region list accepted live: pass.** The create body `region: "cdg,eu"` was accepted and placed the runner in cdg (the first entry). The fallback to another European region was not exercised (it needs a real cdg capacity shortage).
- **Region on the run report: pass.** The admin run detail returns `run.runnerRegion: "cdg"` for both runs, and the public report page served by the core (`/run-history/<id>` through `fly proxy 8080`) renders "Load generator region: cdg" for both.
- **Classifier unit tests on every documented signal: pass** (`packages/fly-machines/test/classifier.test.ts`).

### Validation (workstation)

- `pnpm exec biome check` on every touched file: clean. Type-check: `fly-machines`, `contracts`, `db`, `api`, `web` pass; `pnpm type-check:test` reports only the 3 known `mock-erp` errors.
- Unit tests: `fly-machines` 29/29, `api` unit 305/305, `contracts` 160/160, `db` unit 47/47, `web` 736/736. The 4 database-free tests of `demo-run-startup-reconciliation-service.test.ts` pass, including the new undispatched-run case.
- Not run here (need the Docker PostgreSQL/Redis): the new and edited cases in `demo-run-service.test.ts` (relocation flag then region, lost run with unknown counters and a draining run left alone, undispatched run with zeros), the reconciliation file's database case, and the recreate route in `api.test.ts`. Cloud commands: `pnpm test:infra:up`, then `pnpm --filter api test:api` and `pnpm test:integration`.

### Not verified on Fly

- The 60 s unreachable path (Fly `stop` of a started but silent runner) and the undispatched starting run: unit and database tests only.
- The capacity retry, the relocation message and the no-capacity message under a real provider shortage, and placement in another European region.
- A dead host during a run (handled since the integration below; unit tests only).

### Proposed design updates

- **4.3** Implemented in task 06: the monitor runs on the API's 5 s poll and covers `starting` and `active` runs with a recorded boot (the completion report and `draining` are written in one transaction, so that set is exactly "no report persisted"). Measured on Fly: SIGKILL to terminal `load_generator_lost` in 3.4 s, 1.3 s after Fly marks the Machine stopped. A starting run without a recorded boot is failed by starting-run reconciliation with zero counters (`load_orchestrator_unavailable`) within one poll; a failed boot record is resolved by reading the database (recorded: replayed as a normal starting run; not recorded: failed, its runner stopped through Fly).
- **4.4** Start is tried 3 times in place (back-off 1 s then 3 s). Transient errors are retried but never recreate; capacity and dead-host errors recreate after the retries (owner decision, 2026-10-04). The new runner is created and started before the old one is force-destroyed; when no new runner starts, the old one is kept. A create refused for capacity answers 503 `runner_capacity_unavailable` and fails the run with zero counters. The Machines API accepts `region: "cdg,eu"` (verified). The relocation flag is persisted on the run (`runner_relocating`) so the dashboard projection can show the message during the start request. Measured: a recreation takes about 14 s including stopping the new runner (create to `started` 5 s).
- **4.4 / 8** Deliberate trigger: `POST /admin/demo/runner/recreate` (control token), refused with 409 while the runner Machine is not stopped, leaves the new runner stopped (owner decision, 2026-10-04). Task 10's deploy command can call it.
- **9** `packages/db`: the run's runner identity is Machine, boot ID, region, plus the relocation flag.

### Integration (2026-10-04)

- **Owner decisions:**
  - Retry classes: transient errors are retried without recreation; capacity and dead-host errors recreate the runner after the retries.
  - Deliberate trigger: the control-token operator route `POST /admin/demo/runner/recreate`, refused while the runner runs, leaving the new runner stopped.
  - Dead host as loss: a runner Machine whose `host_status` is `unreachable` during an active run is lost (`load_generator_lost`, unavailable counters), without waiting for a Fly stop.
- **Dead-host change.** `RunnerHost.isLost()` (Fly: Machine `stopped` or `classifyFlyMachine` = `host_unreachable`; local: never) replaces `isStopped()` in `RunnerOperations.checkRunner`; the abort path keeps `isStopped()`. `FlyRunnerHost.stop` skips a runner on an unreachable host (a stop could hang there), so the release after the loss does not delay the next boot behind it, and the next start recreates the runner at once (the leased Machine shows `host_status: "unreachable"`, section 4.4 path). Unit test: `fly-runner-host.test.ts` "counts a runner on an unreachable host as lost and does not try to stop it".
- **Design.** The proposed updates are recorded in `design.md` (4.3, 4.4, 8, 9), with the dead-host rule in 4.3.

### External review (2026-10-04)

An external adversarial review was verified and arbitrated by another agent; the owner approved this arbitration.

1. **A late unreachable stop could hit the next run's runner** (a monitor probe of run N outliving N and N+1's boot queues `stopUnreachable(N)` behind the boot; a failed shutdown then leads to a Fly `stop`). Plausible, **fixed**: `stopUnreachable` skips a run other than the latest boot, like `releaseAfterRun`. Unit test in `runner-operations.test.ts`.
2. **Two `role=runner` Machines wedged every runner operation** (a failed destroy after a recreation, or an orphan from a lost create response, made `findRunnerMachine` throw on every call). Confirmed, rare, **fixed**: the newest runner by `created_at` wins, with a warning; `FlyMachine` carries `created_at`. Unit test in `fly-runner-host.test.ts`. `infra/fly/deploy.mjs` still refuses two runners (operator-run, visible). The guard removes the older ones (`11_guard.md` inputs).
3. **Errors during the post-start wait are outside the retry loop.** Confirmed, **accepted**: the run fails cleanly before traffic and the next start heals it. Recorded in task 13's scope.
4. **A lost create response leaves an orphan.** Plausible, **covered by 2**: the orphan is the newest and is used; the guard removes the older one.

The reviewer's heavier fixes were rejected for simplicity.

### Cloud verification (2026-10-04)

Before the external review fixes, the full default suite passed on Linux: `pnpm type-check`, `pnpm lint`, `pnpm test:unit` (1,630 tests), `pnpm test:api` (345 tests) and `pnpm test:integration` (192 tests). The two review fixes touch only unit-tested code (`runner-operations.ts`, `fly-runner-host.ts`, `packages/fly-machines` types); their unit tests pass on the workstation.
