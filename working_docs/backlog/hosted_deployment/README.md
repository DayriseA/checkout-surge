# Hosted Deployment Backlog

Work breakdown for the hosted deployment on Fly.io.

- [design.md](design.md) is the source of truth for decisions. Tasks point to its sections instead of restating them.
- Each numbered file is one task and its working document.

## Rules

- **Order.** Tasks are handled in numeric order. A task whose dependencies are done can be pulled forward.
- **Notes stay in the task.** Findings, measurements and annotations go into the task's own "Working notes" section, never into another task or into `design.md`.
- **Decisions stay in the design.** When a task changes or refines a decision, update `design.md` in the same change.
- **Open points are not decided.** They are settled with the owner when the task starts.
- **Status lives here only,** in the table below: `todo`, `in progress` or `done`.

## Tasks

| # | Task | Depends on | Status |
| :-- | :-- | :-- | :-- |
| 01 | [Core on Fly](01_core_on_fly.md) | none | todo |
| 02 | [Runner on Fly](02_runner_on_fly.md) | 01 | todo |
| 03 | [Unavailable traffic evidence](03_unavailable_traffic_evidence.md) | none | todo |
| 04 | [Runner control contract](04_runner_control_contract.md) | none | todo |
| 05 | [Runner lifecycle](05_runner_lifecycle.md) | 02, 04 | todo |
| 06 | [Runner failure handling](06_runner_failure_handling.md) | 03, 05 | todo |
| 07 | [Core idle stop](07_core_idle_stop.md) | 01 | todo |
| 08 | [Deployment-cap message](08_deployment_cap_message.md) | none | todo |
| 09 | [Gate](09_gate.md) | 01, 07 | todo |
| 10 | [Core recovery](10_core_recovery.md) | 06, 09 | todo |
| 11 | [Guard](11_guard.md) | 05, 09 | todo |
| 12 | [Deployment and versioning](12_deployment_and_versioning.md) | 09, 10 | todo |
| 13 | [Tuning and go-live](13_tuning_and_go_live.md) | all, plus the external prerequisite | todo |

Tasks 01 and 02 together are the feasibility test (design section 10). Their verdict comes before any other hosted work.

## External prerequisite

The catalog (out-of-run) purchase mode is removed by a separate task, outside this backlog (design section 3.2). It must be done before task 13 opens the demo to visitors. Earlier tasks do not depend on it.
