# Adaptive ERP — Sequential Execution Index

Status: implementation backlog prepared; all numbered tasks are pending. Creating these documents implements no runtime behavior and certifies no performance result.

Target branch: `feat/adaptive-erp-and-admission`.

Source: [Adaptive ERP Processing and Bounded Demo Admission](../../adaptive_erp_processing_implementation_plan.md), read at commit `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58` (source blob `93a513b316bfb9ecb197b78eddfb3f1d84b98d05`). The source is retained unchanged. Its locked decisions D01–D14 remain binding; this index and the handoffs distribute execution, not reopen product/architecture choices.

## Execution contract

Process only `working_docs/backlog/adaptive_erp/xx_*.md`, in ascending numeric order, on the target branch. This index is named `index.md`, so a sequential task runner does not treat it as another implementation task.

Each numbered document contains the local context, fixed rules, expected prerequisites, ownership, repository entry points, work, non-goals, acceptance criteria, validation and next handoff. Reading the entire monolithic plan is not required to discover the assigned task's scope; source references provide provenance and adjudicate conflicts. Read the actual code and repository instructions at execution time, since earlier tasks will have changed the baseline.

Complete and validate each runnable slice before proceeding. Coordinate producer/consumer and schema changes in the same slice; do not activate half a protocol. Record actual commits, checks, evidence and temporary adapters for successors. Tests belong with their implementation task; task 19 fills and verifies the cross-boundary matrix rather than postponing all testing until the end. No task status in this initial backlog means work has been implemented.

Task 20 contains the source plan's mandatory user-approval gate. After calibration/reporting, pause there until the user explicitly approves the exact frozen constants/versions. Do not auto-complete it or proceed to task 21 merely because automated tests pass.

## Ordered tasks and phase coverage

| Order | Standalone handoff | Source phase | Main deliverable |
| --- | --- | --- | --- |
| 01 | [Contracts and acceptance fixtures](01_define_contracts_and_acceptance_fixtures.md) | 1 | Shared vocabulary, fixtures, consumer inventory |
| 02 | [Durable control and ERP-attempt persistence](02_add_durable_control_and_attempt_persistence.md) | 2 | Single-owner claim/intent/schema primitives |
| 03 | [Mock ERP ledger and status lookup](03_persist_mock_erp_ledger_and_status_lookup.md) | 2 | Durable canonical result, lookup/replay |
| 04 | [ERP classification and reconciliation](04_implement_erp_classification_and_reconciliation.md) | 2 | Explicit outcomes and uncertainty resolution |
| 05 | [Worker scheduling and queue handoffs](05_unify_worker_scheduling_and_queue_handoffs.md) | 2 | Complete producer/consumer cutover |
| 06 | [Bounded attempt history and aggregates](06_bound_attempt_history_and_preserve_aggregates.md) | 2 | Bounded diagnostics, preserved obligations |
| 07 | [Paced adaptive admission policy](07_implement_paced_adaptive_admission_policy.md) | 3 | Deterministic AIMD and protection rules |
| 08 | [Bounded adaptive deadlines](08_implement_bounded_adaptive_request_deadlines.md) | 3 | Observed latency window and resource bounds |
| 09 | [Adaptive runtime and restart safety](09_wire_adaptive_runtime_and_restart_safety.md) | 3 | All-call wiring and durable safety-state restore |
| 10 | [Finalization, retention and long-lived work](10_align_finalization_retention_and_long_lived_work.md) | 4 | Truthful normal settlement and expiry protection |
| 11 | [Truthful reset and intervention resume](11_implement_truthful_reset_and_intervention_resume.md) | 4 | Administrative stop/reconciliation/resume |
| 12 | [Retire scenario engine controls](12_retire_scenario_engine_controls.md) | 1/4 completion | Coordinated configuration retirement/history reads |
| 13 | [Reproducible admin profiles](13_add_reproducible_admin_erp_profiles.md) | 5 | Changing conditions on a durable timeline |
| 14 | [Conservative duration estimator](14_implement_conservative_duration_estimator.md) | 6 | Pure API model and provisional measured margins |
| 15 | [Preview and authoritative start admission](15_enforce_estimate_preview_and_start_admission.md) | 6 | Effective ceiling, fingerprint, side-effect ordering |
| 16 | [Operational progress/history projections](16_project_operational_progress_and_history.md) | 7 | Bounded truthful API/SSE/history evidence |
| 17 | [Dashboard estimate/admission flow](17_build_dashboard_estimate_and_admission_flow.md) | 7 | Current-input preview and explicit re-confirmation |
| 18 | [Runtime/history/admin UX](18_build_runtime_progress_history_and_admin_controls.md) | 7 | Visible waiting, settlement and admin progression |
| 19 | [Acceptance matrix and runtime verification](19_complete_acceptance_matrix_and_runtime_verification.md) | 8 | Full 15-scenario coverage and isolated evidence |
| 20 | [Calibration and explicit approval](20_calibrate_policy_and_obtain_approval.md) | 8 | Measured constants/report; mandatory user gate |
| 21 | [Authoritative docs and delivery closure](21_update_authoritative_docs_and_close_delivery.md) | 8 | Approved claims, evidence and consistency review |

The sequence splits broad source phases by ownership but preserves their dependencies. Contracts/schema/client policies are prepared before live cutovers; task 05 coordinates all queue producers/consumers, task 09 activates all adaptive dispatch paths, and task 12 removes obsolete configuration only after replacement behavior exists. Initial estimator measurements occur in task 14; final cross-scenario calibration/approval remains task 20.

## Locked-decision traceability

| Decision | Implementation owners | Verification/closure |
| --- | --- | --- |
| D01 Existing lifecycles plus operational dimension | 01, 02, 05, 10, 16, 18 | 19, 21 |
| D02 Truthful reset without rollback/stock release | 02, 10, 11, 18 | 19, 21 |
| D03 Automatic transient recovery; explicit intervention resume | 01, 04, 05, 11, 18 | 19, 21 |
| D04 One durable owner from first dispatch | 02, 05, 09 | 19, 21 |
| D05 Terminal ERP ledger, lookup and idempotent replay | 03, 04, 05, 11 | 19, 21 |
| D06 Paced AIMD, separate capacity/availability feedback | 04, 07, 09 | 19, 20, 21 |
| D07 Persist safety state; relearn on restart | 02, 05, 09, 12 | 19, 21 |
| D08 Bounded observed-latency deadlines | 04, 08, 09, 12 | 19, 20, 21 |
| D09 Bounded history and cumulative aggregates | 02, 06, 16 | 19, 20, 21 |
| D10 Versioned admin profiles and accepted-time anchor | 01, 13, 14 | 19, 21 |
| D11 Conservative API-owned envelope | 01, 14, 15 | 19, 20, 21 |
| D12 Fingerprint and explicit stale-preview re-confirmation | 01, 15, 17 | 19, 21 |
| D13 Internal versioned engine policy; retire scenario knobs | 01, 07, 08, 10, 12, 15, 16, 18 | 19, 20, 21 |
| D14 Bounded calibration and user approval | Criteria in 01; provisional values in 07, 08, 14 | 19, 20 mandatory gate, 21 closure |

The full acceptance matrix is embedded in task 19. The source section 13 completion checklist is operationalized in task 21. Each task also owns focused tests before its exit.

## Initial consumer/ownership map

Task 01 must refine this map with concrete current symbols and test names, then successors record actual changes. This is an inspection starting point, not a claim that the implementation already conforms.

| Concern to inventory | Current entry points | Execution owners |
| --- | --- | --- |
| Delivery retry identity/budgets, initial publication | API/worker order-process publishers; API retry-policy resolvers; `packages/contracts/src/queue.ts` | 01, 04, 05, 12 |
| Recovery limits, pending due-time filtering, claim/publication ownership | Worker `order-recovery-scanner.ts`, handler and PostgreSQL recovery/attempt adapters | 02, 05, 06, 09 |
| ERP protocol, timeout, breaker and concurrency-only gate | Worker `erp-confirmation-client.ts`, `erp-circuit-breaker.ts`, `order-process-admission.ts`, `run-config.ts` | 04, 07–09, 12 |
| Mock in-memory idempotency and changing conditions | Mock `confirmation-service.ts`, chaos/TPS services; contracts/ERP | 03, 13 |
| Drain timeout, terminal publication, reset and retention | API finalization/reset/teardown services; worker publication/notification recovery; DB locks/maintenance | 10, 11, 12 |
| Sale eligibility/hold/idempotency lifetimes | `packages/db/src/redis-inventory-policy.ts`, inventory/reservation helpers and recovery readers | 02, 06, 10 |
| Retired scenario controls and persisted readers | Contracts/demo/ERP, seeds, accepted snapshots, load-orchestrator journal, web drafts/forms | 01, 12 |
| Effective policy, visitor budget and start serialization | API `public-runtime-policy-service.ts`, `demo-run-service.ts`, existing access/budget adapters | 14, 15, 17 |
| Bounded diagnostics, history, notifications and SSE | DB dashboard/timeline readers; API ERP/history/projection fanout; web live/history views | 06, 10, 16, 18 |

## Common guardrails and reporting

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep routes thin, application policy in services and infrastructure construction in composition roots. Do not broaden public capabilities, add replicas/services, introduce stock release/payment expiry, or silently change a locked decision.

Run focused tests, `pnpm type-check` and affected unit/API/integration lanes for code changes. Use `pnpm test:infra:up` for isolated DB/Redis resources. Do not run `pnpm test:composition` or `pnpm test:characterization` unless explicitly asked. Long resilience experiments are explicit and isolated, not hidden inside routine smoke. Report every executed/skipped check honestly.

Schema changes follow the pre-release baseline policy: regenerate/review SQL and metadata together, preserve required custom SQL and validate an isolated migration. No compatibility migration or silent reference-data wipe. Preserve the historic incident and do not use the user's active runtime for unannounced smoke/reset.

A completed task handoff should identify its commit, actual changed interfaces/files, acceptance evidence, commands/results, intentionally temporary adapters and any blocker. A deviation from D01–D14 requires explicit user approval, not a convenient local reinterpretation. The existence of this backlog does not itself satisfy task 20's approval gate.
