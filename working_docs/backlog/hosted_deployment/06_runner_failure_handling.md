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

## Working Notes

_None yet._
