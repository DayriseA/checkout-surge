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

## Working Notes

_None yet._
