# 19 — Runner Start While the Previous Runner Stops

**Design:** section 4.1 · **Depends on:** 17

## Goal

A run started right after another one never fails because the runner Machine is still stopping.

## Context

- Found during the Fly measurement for 15a (2026-10-08, see its working notes).
- A run started 1 s after the previous run's teardown failed with `load_orchestrator_unavailable`.
  - Fly answered 412 "machine still active" to the runner start, and the API does not retry.
  - The run slot is released at the previous run's terminal status, before the runner Machine has stopped.
- Two visitors starting runs back to back can hit it.

## Scope

- Find where the start is refused (the pre-start update and start in `apps/api/src/services/fly-runner-host.ts`, the classifier in `packages/fly-machines`), and how the runner stops after a run.
- When the runner is still stopping, wait for it to stop, then start it, within the existing boot deadline. Prefer Fly's wait endpoint to polling if it fits.
- The visitor and the owner see the normal starting state meanwhile, with no new message.
- **Owner decision (2026-10-08):** deployed together with 18.

## Out of Scope

- Capacity relocation (HD-55), which stays unchanged.

## Done When

- A run started right after another one starts normally, with tests through the public API where reachable.

## Open Points

- None.

## Working Notes

### Root cause (2026-10-08)

- **Fly's answer.** The core logs of the 15a measurement show `POST /machines/<runner>/start failed with 412: {"error":"failed_precondition: machine still active, refusing to start"}`, about 0.4 s after the previous run's teardown.
- **Classification.** `classifyFlyError` mapped the 412 to `own_error` (any other 4xx). `FlyRunnerHost.startInPlace` retries only capacity, dead-host and transient failures, so it threw at once; `RunnerOperations.boot` stopped the runner and threw `RunnerBootError` (HTTP 503 `load_orchestrator_unavailable`, the code the script reported); the run was recorded as failed with `load_generator_not_started`.
- **Stop after a run.** Finalization writes the terminal status (which frees the run slot), then calls `releaseAfterRun` in the background: the fenced shutdown, then a wait for `stopped` (Fly `stop` only as the fallback). `RunnerOperations` serializes that stop before the next boot, so the API's own stop had finished. No "Stopping the runner Machine through Fly." warning preceded the 412, so the Machine read under the start's lease was already `stopped`: Fly refused the start while the previous boot was still finishing, although it reported the Machine stopped.

### Fix (after the cloud verification, review and arbitration, 2026-10-08)

- **Classifier.** A 412 whose message contains "machine still active" is a new class, `still_active`. Its other callers (gate wake, guard, core recovery) treat it as they treated `own_error`: the gate still throws at once.
- **Still-active refusal.** Every in-place start runs on a Machine Fly reports `stopped`, so a wait for `stopped` would return at once; the first pass's wait was removed. `startInPlace` handles `still_active` before the attempt budget: a 1 s pause, then the start again, until the boot deadline (`requireTimeLeft`, then `sleep`), without using up the three attempts kept for capacity and transient failures. It is not in `retriedStartFailures` and never relocates. The retry keeps the start's lease and nonce. A runner still refused at the deadline fails as "did not start before its deadline" (`RunnerBootError`, `load_generator_not_started`), with no relocation and no recreation. Nothing new is shown: the start just takes longer.
- **Runner found `stopping` under the lease.** Waited for (`requireState(..., "stopped", attempt)`, within the deadline), as the gate does for the core, instead of a fenced shutdown and a Fly `stop`. The stale-runner stop stays for a `started` runner.
- **Not changed.** HD-55 relocation, the deadline, and the post-run release.
- **Decision log.** No entry: the comment beside the retry prevents its removal as well as an entry would.

### Fly docs

- Machines API reference, "Wait for a Machine to reach a specified state" (https://docs.fly.io/machines/api/machines-resource): states `started`, `stopped`, `suspended`, `destroyed`; timeout default 60 s; `instance_id` documented as "Required when waiting for Machine to be in `stopped` state". fly-go's `Wait` (`flaps/flaps_machines_wait.go`) clamps the timeout to 1 to 60 s and sends no instance ID, only an optional `version`; flyctl's `WaitForStartOrStop` waits for `stopped` without one. The API's existing stop waits also send none and work (task 05 timings), and the wait for a `stopping` runner follows them.
- The reference documents no 412 for `start` and nothing on starting a stopping Machine. Machine states (https://docs.fly.io/machines/machine-states): `stopping` is the transient state from `started` to `stopped`. Community threads report PM07 "machine still active" refusals that persist, so only the boot deadline bounds the retry.

### Checks

- `pnpm --filter @checkout-surge/fly-machines test:unit` (33 pass), `pnpm --filter api test:unit` (328 pass), `pnpm --filter gate test:unit` (65 pass), `pnpm type-check`, Biome on the touched files.
- Not run: the API tests (Docker daemon not running on the workstation).

### Open points

- **Retry budget.** Closed: still-active refusals are retried every second until the boot deadline, outside the three attempts.
- **Manual verification on Fly (after deploy, with 18).**
  1. Start a run within about 1 s of the previous run's terminal state.
  2. Expect one or more "The runner Machine did not start." warnings with `failure: "still_active"`, then a normal start. Record how many 1 s retries it took.
  3. Confirm that the 412 wording still contains "machine still active", that the 1 s retries draw no 429, and that no "Stopping the runner Machine through Fly." warning appears.

### Live verification (2026-10-08)

- Fly at `e0895f10`, fresh core `8d14e1bed94708`. Two back-to-back pairs through the measurement script (constant arrival 50/s for 5 s, stock 1, 100 VUs, fastest ERP): all four runs completed, delivery `complete`, 250/250 completed.
- **No refusal happened, so the retry was not exercised.** The script's 5 s detail poll put each second start 3 to 4.5 s after the runner's exit (exit 02:53:30.35, start 02:53:34.72; exit 02:55:09.97, start 02:55:13.18). The API logged no warning at all: no `still_active`, no 429, no "Stopping the runner Machine through Fly.". The 15a refusal followed a 10,000-VU run, whose runner exit may take longer than these small runs'.
- Second session: the planned retest (a 50/s run started within 0.5 s of a 10,000-VU run's terminal state) was not run, for the same refused start (see task 18's notes). The retry is still unexercised on Fly.

**Third session (2026-10-08, 10:20 UTC, run by the owner with Codex).** A small run started 2.8 s after the heavy run's finalization; the runner Machine started 3 s after the previous runner exited. No 412, no "The runner Machine did not start." warning, no 429, no stop warning. The race was not reproduced in three tries.

**Closure (owner decision, 2026-10-08):** done. The live retry path stays unobserved; 13d reads the logs for `still_active` warnings.
