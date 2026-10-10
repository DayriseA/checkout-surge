# 23 — Guard Relocation on a Full Host

**Design:** sections 2.6, 6 · **Depends on:** none

## Goal

A deploy that cannot update the guard Machine because its host is full replaces the guard on another host, so the guard keeps running the deployed version and the deploy succeeds.

## Context

- **Incident** (2026-10-10, deploy of `d44dfc67`):
  - the runner, the core and the gate were updated;
  - the guard Machine update (`POST /machines/8d40d9fee36ee8`) failed with 409 "could not reserve resource for machine: insufficient memory available to fulfill request on the current host";
  - Fly reverted it, so the guard stayed on `b8ffc28c` and the deploy job failed.
- The deploy script already handles a full host for the runner (HD-55: relocation) and for the core (HD-56: recreation mark). The guard is the only Machine without such handling.
- **The guard is stateless.** It is a scheduled Machine in the gate app (`infra/fly/gate/guard-machine.json`), with no volume and no lease shared with the API. Replacing it loses nothing but its event history.

## Scope

Owner decision, 2026-10-10.

- **When the guard's update is refused for host capacity** (classified as such, as for the runner): create a new guard Machine from the deployed guard config, then destroy the old one.
  - Same app, same schedule, same env and metadata.
  - Never two guards left running, and never none left behind if the creation fails: say which order is safe.
  - **Amended by the owner, 2026-10-10, after review:** destroy the old guard first, then create the new one. No order satisfies both "never two" and "never none" across an interruption. Two guards can take contradictory core decisions when their probes disagree, and block every later gate deploy until one is removed by hand; a missing guard fails the deploy loudly, a re-run creates one, and the cost alerts are the net meanwhile (the same accepted risk as a refused hourly start).
  - The deploy then succeeds.
- **Other errors** still fail the deploy as today.
- **Docs:** the operations doc (guard section) and the decision log. Correct an existing guard entry in place, or add one only if it passes the inclusion test.
- **Tests:** `infra/fly/deploy.mjs` has no test harness. Cover the decision logic where it can be tested without Fly (for example a pure function choosing relocate vs fail), or state how it is verified live.

## Out of Scope

- A guard whose hourly start is refused between deploys. Accepted (owner decision, 2026-10-10): the cost alerts remain the safety net.
- The runner, core and gate update paths.

## Done When

- A capacity refusal on the guard's update replaces the guard on another host and the deploy succeeds, verified live on the next deploy where it occurs, or by a documented manual check.

## Open Points

- None.

## Working Notes

- **Implemented** (2026-10-10): `updateOrRelocateGuard` in `infra/fly/deploy.mjs`. A capacity refusal of the guard update (`isCapacityRefusal`, moved to `infra/fly/capacity-refusal.mjs` so it can be tested) force-destroys the old guard, then creates a new one from the deployed config, without `skip_launch`; other errors fail as before. Recorded as HD-62.
- **Order:** destroy first, create second (owner amendment above; the first implementation created first). A failed destroy keeps the old guard and fails the deploy; a failed create, or an interruption in between, leaves no guard and fails the deploy, and a re-run creates it. Two guards never coexist.
- **Not covered:** a reverted guard update (no wait for `stopped` on the guard), accepted in HD-62.
- **Tests:** `infra/fly/capacity-refusal.test.mjs` (incident message relocates; a lease conflict, a 500 and a network error fail), added to `test:scripts`. The destroy-then-create path is verified live: on the next deploy where the guard's host is full, the log shows `The guard's host refused the update: …` then `Relocated the guard: destroyed guard Machine …, then created guard Machine … on a host with room.`, the deploy succeeds, and `flyctl machine list -a checkout-surge-gate` shows exactly one `role=guard` Machine.
- **Live expectation:** on 2026-10-10 the guard's hourly start was also refused after the failed update (no start since 20:47 Paris), so its host is still full and the next deploy is expected to exercise the relocation live.
