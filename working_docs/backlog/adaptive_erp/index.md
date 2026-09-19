# Adaptive ERP — Sequential Execution Index

Status: implementation backlog prepared; task 01 is completed (uncommitted at handoff); tasks 02–21 are pending. Creating these documents implements no runtime behavior and certifies no performance result.

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

Task 01 recorded the D14 calibration criteria and the provisional policy parameters in [calibration criteria](calibration_criteria.md); task 20 owns the measurements and the mandatory approval gate.

## Consumer/ownership map

Task 01 refined this map with concrete current symbols and test names, verified by repository inspection at execution time. Successors record actual changes here. This is an inspection record, not a claim that the implementation already conforms.

### Retired engine-knob inventory (D13; retirement owned by task 12 unless stated otherwise)

| Concern | Owner file/symbol | Test(s) | Owning task(s) |
| --- | --- | --- | --- |
| `retryPolicy`/`maxAttempts`/`initialBackoffMs` schema | `packages/contracts/src/load.ts` (`retryPolicySchema`, `backpressureConfigSchema`); `packages/contracts/src/public-runtime-policy-validation.ts` (`collectPublicProtectedConfigViolations`); `packages/contracts/src/testing.ts` (`previewRunConfigSnapshotFixture`) | `packages/contracts/test/contracts.test.ts` | 01 (contracts frozen), 12 |
| `retryPolicy` seeds and JSONB backfill | `packages/db/src/scripts/seed.ts` (`backpressureConfig()`, retryPolicy backfill SQL) | `packages/db/test/integration/db.integration.test.ts` | 12 |
| API delivery retry resolution | `apps/api/src/services/run-retry-policy-resolver.ts` (`RunRetryPolicyResolver`); `apps/api/src/queue/postgres-run-retry-policy-resolver.ts`; `apps/api/src/services/reserve-order-service.ts` (`resolveRunRetryPolicy`) | `apps/api/test/postgres-run-retry-policy-resolver.test.ts`, `apps/api/test/reserve-order-service.test.ts` | 04, 05, 12 |
| API order-process publication budget | `apps/api/src/queue/bullmq-order-process-job-publisher.ts` (`retryOptions`, `runPolicy`) | `apps/api/test/order-process-job-publisher.test.ts`, `apps/api/test/order-process-job-publisher.integration.test.ts` | 05, 12 |
| Worker delivery attempt budget | `apps/worker/src/queue/bullmq-order-process-job-publisher.ts` (`retryOptions`); `apps/worker/src/queue/bullmq-order-process-consumer.ts` (`normalizeMaxAttempts`); `apps/worker/src/application/order-process-job-handler.ts` (`DeliveryDescriptor.maxAttempts`, `hasRemainingAttempts`) | `apps/worker/test/unit/order-process-job-publisher.test.ts`, `apps/worker/test/unit/order-process-job-handler.test.ts`, `apps/worker/test/integration/order-processing-workflow.test.ts` | 04, 05, 12 |
| Recovery-publication limits | `apps/worker/src/application/order-recovery-scanner.ts` (`maxRecoveryAttempts` default 100, `recoveryLeaseMs` default 30 s); `apps/worker/src/persistence/postgres-order-recovery-persistence.ts` (`claimForPublication`, `markEscalated`, `findRecoverable` with `nextAttemptAt` filtering) | `apps/worker/test/unit/order-recovery-scanner.test.ts`, `apps/worker/test/unit/order-recovery-persistence.test.ts`, `apps/worker/test/integration/erp-attempt-recovery.integration.test.ts`, `apps/worker/test/integration/order-recovery-boundary.integration.test.ts` | 02, 05, 06 |
| `drainTimeoutSeconds` schema | `packages/contracts/src/load.ts` (`backpressureConfigSchema`) | `packages/contracts/test/contracts.test.ts` | 12 |
| `drainTimeoutSeconds` seeds | `packages/db/src/scripts/seed.ts` (`drainTimeoutSeconds: 300`) | `packages/db/test/integration/db.integration.test.ts` | 12 |
| `business_drain_timeout` finalization | `apps/api/src/services/demo-run-finalization-service.ts` (drain deadline, `"business_drain_timeout"` reason); `apps/api/src/runtime/config.ts` (`demoRunDrainTimeoutSeconds`); `apps/api/src/index.ts` (wiring) | `apps/api/test/demo-run-finalization-service.test.ts`, `apps/api/test/runtime-config.test.ts` | 10, 12 |
| `business_drain_timeout` vocabulary | `packages/contracts/src/run-result.ts` (`internalRunFailureReasonValues`, `toPublicRunFailureCategory`) | `packages/contracts/test/contracts.test.ts` | 10, 12 |
| Circuit settings schema and seeds | `packages/contracts/src/load.ts` (`backpressureConfigSchema`); `packages/contracts/src/public-runtime-policy-validation.ts`; `packages/db/src/scripts/seed.ts` (`ERP_CIRCUIT_FAILURE_THRESHOLD`, `ERP_CIRCUIT_RESET_TIMEOUT_MS`) | `packages/contracts/test/contracts.test.ts`, `packages/db/test/integration/db.integration.test.ts` | 07, 12 |
| Circuit breaker consumption | `apps/worker/src/application/erp-circuit-breaker.ts` (`resetTimeoutMs`, probe timing); `apps/worker/src/application/run-backpressure.ts` (thresholds from snapshot, `doubledDurationMs`); `apps/worker/src/index.ts` (wiring) | `apps/worker/test/unit/erp-circuit-breaker.test.ts`, `apps/worker/test/unit/run-backpressure.test.ts` | 07, 09, 12 |
| ERP `requestTimeoutMs` schema | `packages/contracts/src/load.ts` (`erpRunConfigSchema`); `packages/contracts/src/public-runtime-policy-validation.ts` (`public_erp_request_timeout_override_not_allowed`); `packages/contracts/src/testing.ts` (`previewRunConfigSnapshotFixture`); `packages/db/src/scripts/seed.ts` (`ERP_REQUEST_TIMEOUT_MS`) | `packages/contracts/test/contracts.test.ts`, `packages/db/test/integration/db.integration.test.ts` | 08, 12 |
| ERP `requestTimeoutMs` consumption | `apps/worker/src/application/erp-confirmation-client.ts` (`requestTimeoutMs`, `ErpConfirmationTimeoutError`); `apps/worker/src/index.ts` (`config.erpRequestTimeoutMs`) | `apps/worker/test/unit/erp-confirmation-client.test.ts`, `apps/worker/test/integration/postgres-run-config-reader.integration.test.ts` | 04, 08, 12 |
| Unrelated same-named `requestTimeoutMs` HTTP-client options (do not retire) | `apps/api/src/services/traffic-execution-gateway.ts` (`defaultStartRequestTimeoutMs`); `apps/load-orchestrator/src/application/api-client.ts` | `apps/api/test/traffic-execution-gateway.test.ts`, `apps/load-orchestrator/test/*` | none (guard note) |
| Retired knobs in web drafts/forms/presentation | `apps/web/src/app/lib/admin-drafts.ts` (draft fields, rebuild, rules); `apps/web/src/app/components/admin/admin-feature-views.tsx` (form fields, label map); `apps/web/src/app/components/admin/admin-authenticated-surface.tsx` (`erp`/`retry` field lists, policy comparison); `apps/web/src/app/components/run-history-detail.tsx` (history rows); `apps/web/src/app/components/public-demo-entry.tsx` (`requestTimeoutMs` display); `apps/web/src/app/lib/presentation/custom-run-issue-presentation.ts` (field grouping) | `apps/web/test/admin-drafts.test.ts`, `apps/web/test/dashboard-phase6.test.ts`, `apps/web/test/api-read-fallback.test.ts` | 12, 17, 18 |
| Retired knobs in the load-orchestrator journal | `apps/load-orchestrator/src/application/execution-store.ts` (`materializedTrafficExecutionStartRequestSchema.parse` over the journal snapshot) | `apps/load-orchestrator/test/k6-summary.test.ts`, `apps/load-orchestrator/test/correlation-boundary.test.ts`, `apps/load-orchestrator/test/completion-delivery-coordinator.test.ts`, `apps/load-orchestrator/test/load-orchestrator-test-helper.ts` | 12 (history reads accept and ignore) |
| Pending-persistence recovery policy (same field names, NOT retired — reservation-persistence concern per D13) | `apps/api/src/runtime/pending-persistence-recovery-policy.ts` (`pendingPersistenceRecoveryDefaults`); `apps/api/src/services/pending-persistence-recovery-service.ts` (`maxAttempts`, `initialBackoffMs`, exponential backoff); `apps/api/src/runtime/pending-persistence-operation-factory.ts`; `apps/api/src/runtime/config.ts`; `apps/api/src/index.ts` | `apps/api/test/pending-persistence-recovery-service.test.ts`, `apps/api/test/runtime-config.test.ts` | 02 (reviews coupling), not 12 |

### Lifecycle, identity, and runtime inventory

| Concern | Owner file/symbol | Test(s) | Owning task(s) |
| --- | --- | --- | --- |
| Lifecycle vocabularies and new operational vocabulary (waiting reasons, failure categories, administrative codes) | `packages/contracts/src/lifecycle.ts` (`orderStatusValues`, `demoRunStatusValues`, `orderWaitingReasonValues`, `orderFailureCategoryValues`, `administrativeOrderFailureCodeValues`) | `packages/contracts/test/vocabulary.test.ts` | 01 (done), 10, 11 |
| ERP outcome/lookup/replay vocabulary | `packages/contracts/src/erp-outcomes.ts` (`erpErrorCodeValues`, `erpPermanentRejectionCodeValues`, `recognizedErpErrorCodeDispositions`, `erpLookupResultSchema`, `erpReplayedResponseHeaderName`) | `packages/contracts/test/erp-outcomes.test.ts` | 01 (done), 03, 04 |
| ERP-call identity, processing generation, admin-stop evidence, engine-policy identity | `packages/contracts/src/processing-control.ts` (`erpCallReferenceSchema`, `processingGenerationSchema`, `administrativeStopEvidenceSchema`, `enginePolicyIdentitySchema`) | `packages/contracts/test/processing-control.test.ts` | 01 (done), 02, 11 |
| ERP attempt persistence (delivery-coupled attempt identity) | `apps/worker/src/persistence/postgres-erp-attempt-persistence.ts` (order/delivery/attempt-number key) | `apps/worker/test/unit/postgres-erp-attempt-persistence.test.ts`, `apps/worker/test/integration/erp-attempt-recovery.integration.test.ts` | 02, 06 |
| Run config transport to ERP calls | `apps/worker/src/application/run-config.ts` (`RunConfigReader`, `toErpRequestConfig`); `apps/worker/src/persistence/postgres-run-config-reader.ts` | `apps/worker/test/integration/postgres-run-config-reader.integration.test.ts`, `apps/worker/test/integration/erp-run-snapshot-precedence.integration.test.ts` | 09, 13 |
| Terminal publication guards | `apps/worker/src/persistence/postgres-generated-run-publication-fence.ts`; `apps/worker/src/application/generated-run-publication-fence.ts`; `apps/worker/src/queue/bullmq-order-process-job-publisher.ts`; `apps/worker/src/queue/bullmq-notification-record-publisher.ts` | `apps/worker/test/integration/order-processing-workflow.test.ts` | 10, 11 |
| Run terminality writes | `apps/api/src/services/terminal-demo-run-transition.ts`; `apps/api/src/services/terminal-demo-run-writer.ts`; `apps/api/src/services/postgres-demo-reset-workflow-fence.ts`; `apps/api/src/services/demo-run-finalization-service.ts` | `apps/api/test/demo-run-service.test.ts`, `apps/api/test/demo-run-finalization-service.test.ts`, `apps/api/test/demo-maintenance-workflows.test.ts`, `apps/api/test/traffic-completion-service.test.ts` | 10, 11 |
| Run-sale eligibility TTL (7-day assumption) | `packages/db/src/redis-inventory.ts` (`runSaleEligibilityTtlSeconds`, `setRunSaleEligibility`, `isRunSaleEligible`); `packages/db/src/redis-stock-reservation.ts` (Lua eligibility checks, reservation expirations) | `packages/db/test/integration/db.integration.test.ts` | 02, 06, 10 |
| Reservation hold lifetime | `apps/api/src/services/reserve-order-service.ts` (`reservationHoldMinutes`, `expiresAt`); `apps/api/src/runtime/config.ts`; `packages/db/src/scripts/seed.ts` (`RESERVATION_HOLD_MINUTES`) | `apps/api/test/reserve-order-service.test.ts` | 02, 10 |
| Mock ERP idempotency, codes, and TPS | `apps/mock-erp/src/application/confirmation-service.ts` (process-local ledger, `ConfirmationIdempotencyConflictError`); `apps/mock-erp/src/server.ts` (409 literal `idempotency_conflict`); `apps/mock-erp/src/application/chaos-control-service.ts` (`erp_forced_outage`, `erp_capacity_exceeded`, `erp_injected_error` literals); `apps/mock-erp/src/application/tps-limiter.ts` | `apps/mock-erp/test/unit/mock-erp.test.ts`, `apps/mock-erp/test/unit/tps-limiter.test.ts`, `apps/mock-erp/test/unit/correlation-boundary.test.ts` | 03 (ledger/lookup), 04 (code alignment) |
| Effective policy, visitor budget, start serialization | `apps/api/src/services/public-runtime-policy-service.ts`; `apps/api/src/services/demo-run-service.ts`; `apps/api/src/services/public-run-budget-store.ts` | `apps/api/test/demo-run-service.test.ts`, `apps/api/test/api.test.ts` | 14, 15, 17 |
| Estimator contracts and fixtures | `packages/contracts/src/estimate.ts` (`estimatorInputSchema`, `estimatorResultSchema`, `estimateStaleRejectionSchema`, `acceptedEstimateSnapshotSchema`, `estimateObservationSchema`, `estimatedDemoOccupancyCeilingSeconds`); `packages/contracts/src/erp-profile.ts` (`erpProfileSchema`, `erpProfileAnchorSchema`); `packages/contracts/src/acceptance-fixtures.ts` (via `@checkout-surge/contracts/testing`) | `packages/contracts/test/estimate.test.ts`, `packages/contracts/test/processing-control.test.ts`, `packages/contracts/test/acceptance-fixtures.test.ts` | 01 (done), 13, 14, 15 |
| Bounded diagnostics, history, notifications and SSE | DB dashboard/timeline readers; API ERP/history/projection fanout; web live/history views (coarse pending task 06/16 inspection) | `packages/db/test/integration/business-outcome-dashboard.integration.test.ts`, `apps/api/test/run-history-service.test.ts` | 06, 10, 16, 18 |

## Common guardrails and reporting

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep routes thin, application policy in services and infrastructure construction in composition roots. Do not broaden public capabilities, add replicas/services, introduce stock release/payment expiry, or silently change a locked decision.

Run focused tests, `pnpm type-check` and affected unit/API/integration lanes for code changes. Use `pnpm test:infra:up` for isolated DB/Redis resources. Do not run `pnpm test:composition` or `pnpm test:characterization` unless explicitly asked. Long resilience experiments are explicit and isolated, not hidden inside routine smoke. Report every executed/skipped check honestly.

Schema changes follow the pre-release baseline policy: regenerate/review SQL and metadata together, preserve required custom SQL and validate an isolated migration. No compatibility migration or silent reference-data wipe. Preserve the historic incident and do not use the user's active runtime for unannounced smoke/reset.

A completed task handoff should identify its commit, actual changed interfaces/files, acceptance evidence, commands/results, intentionally temporary adapters and any blocker. A deviation from D01–D14 requires explicit user approval, not a convenient local reinterpretation. The existence of this backlog does not itself satisfy task 20's approval gate.
