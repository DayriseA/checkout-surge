# 17 — Runner Capacity on Update

**Design:** section 6 (Fly error classification, runner recreation) · **Depends on:** 06, 12

## Goal

A full host never fails a run start or a deploy because of the runner: when the runner's host refuses or reverts the update that gives the stopped runner its new config, the runner is recreated on a host with room, in the core's region (the home region for the deploy) or else elsewhere in Europe, as a refused start already does (HD-17).

## Context

Diagnosed in production on 2026-10-07:

- **API (go-live blocker).** `FlyRunnerHost.start()` updates the stopped runner before starting it whenever its config lacks the run's size or the API's own 6PN address (`API_BASE_URL`). The deployed runner config has no `API_BASE_URL`, and the core's 6PN address changes when the core is recreated, so this update happens often. On a full host, Fly either accepted the update and reverted it about 130 ms later (events `update replacing source=user`, then `revert stopped source=flyd`), or refused it at once (`409 {"error":"aborted: could not reserve resource for machine: insufficient CPUs available to fulfill request on the current host"}`, once "insufficient memory"). Only `startMachine` was inside the classifying try/catch, so the error escaped `start()` without recreating the runner, and the visitor got a 503 `load_orchestrator_unavailable`.
- **Deploy script.** `deploy.mjs` updating the stopped runner got the same 409 twice (memory, then CPU) and failed cleanly. CI deploys every push to `main`, so a full runner host fails CI.

## Scope

- **API.** A capacity or dead-host refusal of the pre-start update, either form (a 409 with a capacity phrase, or an accepted update that Fly reverts, seen when the wait for `stopped` fails), relocates the runner through `replace()`: relocation flag on the run, new runner in `<core region>,eu`, old one destroyed only once the new one has started. Transient and other errors fail the run as before, without a recreation.
- **Classifier.** `classifyFlyMachine` maps a Machine whose newest event is `revert` to `provider_capacity`.
- **Deploy script.** On a capacity refusal updating the stopped runner (a 409 with a capacity phrase, or an update that did not stick after the wait), create a new runner from the target config in `cdg,eu`, then destroy the old one under its lease. Leave the runner untouched when it already holds the target config (a deploy of the same commit).
- **Deploy script, core on a full host** (owner decision, 2026-10-07). A capacity refusal or revert of the core update sets the recreation mark on the core under its lease and writes the target config into the gate as usual; the version check counts a marked core at the version of the gate's copy (HD-56).
- **UI messages** (owner decision, 2026-10-07): relocation shown in the admin start dialog and Current run panel; public page polls every 6 s during its own pending start and no longer calls its own starting run "already in progress"; a plain start-failure message for `load_orchestrator_unavailable`; dedicated failure reasons `runner_capacity_unavailable` and `load_generator_not_started` with public categories `provider_capacity` and `not_started`; neutral relocation copy.
- **Docs.** `docs/hosted_runtime.md`, `docs/hosted_operations.md`, HD-55, HD-56, HD-14 (stale reason name).

## Out of Scope

- A non-capacity failure of the core update after the runner update (transient, own error): still a partial deployment, reported by the version check and fixed by deploying again (HD-56).
- A longer timeout on the web proxy and gate relay: replaced by a boot deadline (owner decision).
- Retrying the pre-start update in place (see Open Points).

## Done When

- Unit tests: an update refused for capacity recreates the runner; an update reverted after a failed wait, or found not to have stuck after a successful wait, recreates it; a transient update error never recreates it. The classifier test covers the revert signal.
- `deploy.mjs` passes `node --check`, and its helpers were checked against the live runner config.
- The manual verification on Fly (Working Notes) passes, after the batched post-go-live push.
- HD-55 and HD-56 are in `docs/decisions/hosted_deployment.md`.
- Web and contracts unit tests cover the new presentation and categories; the API service test covers the capacity reason (needs the Docker test infrastructure).

## Open Points

- **What the wait observes after a revert is unverified.** The API waits for `stopped` on the updated instance ID; after a revert it may time out (60 s, then the relocation) or fail at once. If it succeeds, the Machine is read back and a config without the run's settings relocates the runner (owner decision, 2026-10-07). Note the form observed in the manual verification.
- **The deploy's capacity check** matches only the observed phrases (`could not reserve resource`, `insufficient … available`), since the script has no dependencies and cannot import the shared classifier. Another capacity wording still fails the deploy, as before.
- **Boot deadline, not proxy timeouts** (owner decision): the runner boot ends within 90 s (see Third round). Not bounded by it: the stop of a stale running runner at the start of the sequence (rare: the runner exits on its own and the guard stops it) and the cleanup stop after a failed boot; each Fly call keeps its own 30 s timeout.
- **Old failed runs keep their reason.** Runs failed before this change with `load_orchestrator_unavailable` before traffic still read as traffic failures.
- **A capacity-triggered core recreation shows the fresh-install page** (the requested-recovery page of HD-35), not the relocating page.
- **No public-page component test** for the hidden "already in progress" notice during the visitor's own start: the change is one condition, and the page has no unit harness for a pending start.
- **A failed destroy of the old runner** after a deploy relocation fails the deploy and leaves two runners: the API uses the newest (HD-18), and the next deploy refuses to run until the guard removes the older one.

## Working Notes

### Behavior change

- **API, `FlyRunnerHost.start` / `startInPlace` / new `applyRunSettings`.** The pre-start update is classified: a 409 capacity body or a dead host returns "relocate" without trying the start; if the post-update wait fails, the Machine is read again (one GET, which carries its events) and `classifyFlyMachine` decides (`revert` → `provider_capacity`, unreachable host → `host_unreachable`); if the wait succeeds, the Machine is read back and a config without the run's settings also relocates. Relocation goes through the existing `hooks.onRelocating()` then `replace()`, so the run carries the same relocation flag as a refused start. Other update or wait errors are thrown unchanged (the run fails before traffic, no recreation). The start retry loop is unchanged.
- **Regions tried.** API: `<core region>,eu` (Fly tries the core's current region on any host with room, then any European region), as every runner recreation. Deploy: `cdg,eu`. A deploy-relocated runner outside the core's region is recreated toward it at the next run start (HD-36), with the recorded runner region showing the cross-region latency in between (HD-17 consequence unchanged).
- **Deploy, `deployRunner`.** Under the runner lease: config already included in the Machine's config → untouched, even mid-run; otherwise `requireStopped`, then `updateInPlace` (update and wait; a capacity 409 or an update that did not stick returns false), then `relocateRunner` (`createMachine(..., "cdg,eu")` with `skip_launch`, wait for `stopped`, then `DELETE ?force=true` with the old lease nonce). `includesConfig` ignores keys Fly or the API add (`init`, `API_BASE_URL`); a key removed from `machine.json` comes with a new commit, so with a new image label and `COMMIT_SHA`. The no-op skip is runner-only: the live core and gate configs never match their targets exactly (the core's mount `name`, the gate's `autostop`). The core's refusal path is in the second round below.

### Dry checks (2026-10-07, read-only)

- `node --check infra/fly/deploy.mjs`: pass.
- `includesConfig` on the live runner (`807244c6672338`, created by the API's recreation, with `API_BASE_URL`) against the target of commit `d81384b2`: true (no-op); with another `COMMIT_SHA` or another guest: false.
- `isCapacityRefusal`: true for the observed CPU and memory 409 bodies; false for a lease 409 and a 503.

### Manual verification on Fly (after the batched push)

1. **No-op deploy.** Re-run the deploy workflow on the same commit of `main`: the log shows `runner Machine already has the config of version …; left untouched.`, and `flyctl machine status <runner> -a checkout-surge-runner -d` shows no new `update` event.
2. **API path.** After a deploy (the runner has no `API_BASE_URL`), start a public run: either it starts in place (`update replacing`, then `start`), or, on a full host, the API logs `The runner's host refused the run's settings.` or `… reverted the run's settings.`, the dashboard shows the relocation message, a new runner is listed (`flyctl machine list -a checkout-surge-runner`) and the old one is destroyed. When it happens, note which form the wait took after a revert (time between the update and the relocation in the API logs).
3. **Deploy path.** Not triggerable on demand; when CI next meets a full runner host, its log shows `The runner's host refused the update: …` or `… reverted the update.`, then `Recreating the runner on another host (cdg, then eu).` and `Destroyed the old runner Machine …`, and the version check passes.

### Decision entry

Added to the log as HD-55 (2026-10-07, owner-approved): a refused or reverted update relocates at once, without the in-place retries of HD-17.

### Second round (owner decisions, 2026-10-07)

- **API, run settings read back.** After a successful wait following the run-settings update, the Machine is read again; a config without the run's settings relocates the runner (test: "recreates the runner when the wait succeeds but the update did not stick").
- **Deploy, shared helper.** `updateInPlace` serves the runner and the core: false on a capacity 409, or when the Machine read after the wait has a newest `revert` event or other images than the target (each container's for the core, whose live config also carries a top-level image). Checked against the live core: images equal for the deployed commit.
- **Deploy, core.** `markCoreForRecreation` posts `recreate=requested` to the core's metadata with the lease nonce; `nextCoreVersion` reads the API container's `COMMIT_SHA` from the gate's core config copy for a marked core. Checked against the live gate copy: decodes to the deployed commit.
- **Failure reasons.** Boot failure (any but capacity), version mismatch, a definitive start rejection and an undispatched run: `load_generator_not_started` (public `not_started`). No host with capacity: `runner_capacity_unavailable` (public `provider_capacity`). A non-definitive traffic start failure keeps `load_orchestrator_unavailable` (public `traffic`), since traffic may have started. `failure_reason` is a text column without a constraint: no migration.
- **What a visitor sees.**
  - Relocating: "The load generator is moving to another host (for example, when its host is full), so this start takes a little longer. Please wait." on the public page (polled every 6 s while the visitor's own start is pending), the watch page and the admin Current run panel and start dialog.
  - No capacity anywhere: the start answers "Our hosting provider has no capacity right now" (unchanged); the report, history and watch say "The hosting provider had no capacity for the load generator, so no traffic was sent." and the conclusion sentence "The run failed because the hosting provider had no capacity for the load generator; no traffic was sent."
  - Other boot failure: the start answers "The load generator could not be started" / "No traffic was started. Try again shortly." on the public page and in the admin dialog; the saved run says "The load generator could not be started, so no traffic was sent."

### Third round: boot deadline (owner decision, 2026-10-07)

- **Deadline.** `RunnerOperations.boot` gives the whole boot one deadline (`startDeadlineMs`, 90 s): `FlyRunnerHost.start` checks it before each step (the in-place start, each back-off, the relocation, the create) and caps every Fly wait to the time left; the readiness wait ends at it too.
- **Why 90 s.** The web's proxy fetch and the gate's relay (`@fastify/reply-from`) both use undici's default 300 s headers timeout. Past the deadline, the request can still take one Fly call in flight (30 s client timeout), the failed boot's cleanup stop (a few calls and up to a 60 s wait) and the run's failure: under 300 s even then. A measured relocation is about 14 s and readiness a few seconds, so 90 s leaves room for the in-place retries.
- **Outcome.** Past the deadline: `RunnerCapacityUnavailableError` (reason `runner_capacity_unavailable`, the capacity message) when the start met a full host (a refused or reverted update, or a capacity start failure), otherwise a plain error that becomes `RunnerBootError` (reason `load_generator_not_started`, "The load generator could not be started").
- **Consistency.** No call is abandoned: the checks are cooperative, so an in-flight create or start completes. A recreated runner whose capped wait fails is destroyed (existing path); a runner started in place whose wait fails is stopped by `stopAfterFailedBoot`. The lease is released in `withLease`'s `finally`, and its TTL covers the deadline plus one call.
- **Tests.** FlyRunnerHost: a deadline during capacity back-off fails as capacity without a third attempt or a recreation; a recreation's wait capped at the deadline destroys the new runner and keeps the old; a passed deadline starts nothing. RunnerOperations: the readiness wait ends at the boot deadline, and the host receives the deadline.

### Cloud verification and review (2026-10-07)

A cloud test run, an adversarial review and an arbitration by the owner led to this fix pass:

- **Fixed.**
  - F1/R4: a Fly wait cut by the start's deadline now fails as the deadline does (`requireState` calls `requireTimeLeft` before its generic error), so a relocation cut short after a capacity shortage reports `runner_capacity_unavailable`. Test: update refused for capacity, then the recreation's wait is cut by the deadline: capacity failure, new runner destroyed.
  - R3a: `startInPlace` checks the deadline after the run-settings update, before the start loop. Test: an update that uses up the deadline starts nothing.
  - R1: `deploy.mjs` `createMachine` force-destroys a just-created Machine whose wait for `stopped` fails (best effort), so a failed replacement never leaves two runners.
  - F3: HD-14's consequences no longer claim that no failure reason was added.
  - F2: the public page polls every 6 s, not 2.5 s, during its own pending start, within the per-visitor budget of dashboard recovery reads.
  - O2: the exact image comparison stays; the "reverted" log line now prints both image lists, and HD-56 records the accepted risk (a change in how Fly reports image references would mark the core at every deploy) and the rejected alternative of failing the deploy on a mismatch without a revert event.
- **Accepted without change.**
  - The deploy's wait failing with a 408 or 503 after an update: a reverted Machine returns to `stopped`, so its wait returns; a failed wait means slowness or a transient error, and a re-run heals it.
  - A boot whose runner is ready a few seconds past the deadline is accepted: the readiness check is left as is.
- **Pre-existing, not fixed.** O3: `nextCoreVersion` (formerly the inline read in `verifyVersions`) throws a TypeError when the core's config is partial (a core on a host that is not ok, without `containers`); the version check then fails with that error instead of a clear message.
