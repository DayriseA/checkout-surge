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

- **Implemented** (2026-10-10): `updateOrRelocateGuard` in `infra/fly/deploy.mjs`. A capacity refusal of the guard update (`isCapacityRefusal`, moved to `infra/fly/capacity-refusal.mjs` so it can be tested) creates a new guard from the deployed config, without `skip_launch`, then force-destroys the old one; other errors fail as before. Recorded as HD-62.
- **Order:** create first, destroy second. A failed create keeps the old guard; an interruption in between leaves two guards, safe side by side (HD-37), and the next gate deploy fails on them until the old one is destroyed by hand (operations doc, guard section).
- **Not covered:** a reverted guard update (no wait for `stopped` on the guard), accepted in HD-62.
- **Tests:** `infra/fly/capacity-refusal.test.mjs` (incident message relocates; a lease conflict, a 500 and a network error fail), added to `test:scripts`. The create-then-destroy path is verified live: on the next deploy where the guard's host is full, the log shows `The guard's host refused the update: …` then `Relocated the guard: …`, the deploy succeeds, and `flyctl machine list -a checkout-surge-gate` shows one `role=guard` Machine with the new `COMMIT_SHA`.
