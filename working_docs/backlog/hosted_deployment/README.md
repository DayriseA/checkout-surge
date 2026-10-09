# Hosted Deployment Backlog

Work breakdown for the hosted deployment on Fly.io.

- [design.md](design.md) is the working design for this backlog. Tasks point to its sections instead of restating them. Choices that pass the inclusion test of `docs/decisions/README.md` are recorded in `docs/decisions/`, in its format.
- Each numbered file is one task and its working document.

## Rules

- **Order.** Tasks are handled in numeric order. A task whose dependencies are done can be pulled forward. Task 14 was added after the initial breakdown and should be done before task 13. Task 13 was split into 13a–13d when it started; 13a and 13b run in parallel. Task 15 was split into 15a–15d. Task 16 was split into 16a–16c; its runner counters became task 21. A first task 21, a study, became the founding study of the separate [Redis and Order Queue Proof](../redis_and_order_queue_proof/README.md) backlog, and the runner counters took its number.
- **Notes stay in the task.** Findings, measurements and annotations go into the task's own "Working notes" section, never into another task or into `design.md`.
- **Decisions stay in the design.** When a task changes or refines a decision, update `design.md` in the same change.
- **Open points are not decided.** They are settled with the owner when the task starts.
- **Status lives here only,** in the table below: `todo`, `in progress` or `done`.

## Tasks

| # | Task | Depends on | Status |
| :-- | :-- | :-- | :-- |
| 01 | [Core on Fly](01_core_on_fly.md) | none | done |
| 02 | [Runner on Fly](02_runner_on_fly.md) | 01 | done |
| 03 | [Unavailable traffic evidence](03_unavailable_traffic_evidence.md) | none | done |
| 04 | [Runner control contract](04_runner_control_contract.md) | none | done |
| 05 | [Runner lifecycle](05_runner_lifecycle.md) | 02, 04 | done |
| 06 | [Runner failure handling](06_runner_failure_handling.md) | 03, 05 | done |
| 07 | [Core idle stop](07_core_idle_stop.md) | 01 | done |
| 08 | [Deployment-cap message](08_deployment_cap_message.md) | none | done |
| 09 | [Gate](09_gate.md) | 01, 07 | done |
| 10 | [Core recovery](10_core_recovery.md) | 06, 09 | done |
| 11 | [Guard](11_guard.md) | 05, 09 | done |
| 12 | [Deployment and versioning](12_deployment_and_versioning.md) | 09, 10 | done |
| 13a | [Measurement and tuning](13a_measurement_and_tuning.md) | 01–12, 14 | done |
| 13b | [Documentation and continuous deployment](13b_docs_and_ci.md) | 01–12, 14 | done |
| 13c | [Go-live](13c_go_live.md) | 13a, 13b, plus the external prerequisite | done |
| 13d | [Bot review](13d_bot_review.md) | 13c, plus a few days of real traffic | todo |
| 14 | [Clean-run generator warnings](14_clean_run_generator_warnings.md) | 03 | done |
| 15a | [Capacity measurement](15a_capacity_measurement.md) | 13c | done |
| 15b | [Capacity-aware admission](15b_capacity_aware_admission.md) | 15a, 18 | done |
| 15c | [Public limits](15c_public_limits_and_explanations.md) | 15b, deployed | done |
| 15d | [Narrative and visitor explanations](15d_narrative_and_explanations.md) | 15b; figures from 15c | done |
| 16a | [Gate pages](16a_gate_pages.md) | 17 | done |
| 16b | [Demo messages](16b_demo_messages.md) | 17 | done |
| 16c | [Redis claims and known limits](16c_narrative_honesty.md) | none | done |
| 17 | [Runner capacity on update](17_runner_capacity_on_update.md) | 06, 12, plus the findings of 13c | done |
| 18 | [Interrupted requests in the run outcome](18_interrupted_requests_in_run_outcome.md) | none | done |
| 19 | [Runner start while the previous runner stops](19_runner_start_while_stopping.md) | 17 | done |
| 20 | [Core incidents under saturation](20_core_incidents_under_saturation.md) | 15c | todo |
| 21 | [Runner counters](21_runner_counters.md) | none | in progress |

Tasks 01 and 02 together are the feasibility test (design section 10). Their verdict comes before any other hosted work.

## External prerequisite

The catalog (out-of-run) purchase mode is removed by a separate task, outside this backlog (design section 3.2). It must be done before task 13c opens the demo to visitors. Earlier tasks do not depend on it. Done: PR #4 (`a7f06d59`, 2026-10-02) removed catalog purchases.
