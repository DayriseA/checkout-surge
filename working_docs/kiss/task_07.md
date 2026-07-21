# Task 07 — Make production-required interfaces mandatory

## Execution context

Task 7 of 45. Phase 1: remove unambiguous residue. Primary ownership boundary: application-service interface contracts and composition-root dependency provision. Dependencies: task 06 may remove dead consumers first; retain true product-semantic optional projections. This record is standalone. Apply the quality checklist: explicit dependencies, composition-owned clients, thin routes, and test fakes at the same boundary.

## Why this task exists

Many interfaces expose optional dependencies or fallback paths that production always supplies. This creates impossible runtime modes and forces callers/tests to understand behavior that cannot occur in the deployed local topology.

## Required outcome

Make production-required dependencies mandatory and construct explicit in-memory fakes in tests. Targets include recovery operation factories/readers, execution stores, durable claim/failure/resolution methods, and queue-maintenance dependencies. Do not introduce a generic DI framework.

## Scope and implementation guidance

Verify paths before editing because the checkout may drift. Build a before-change inventory that names each optional member, its production provider, and whether absence has a real product meaning. Current candidates include `DashboardRecoveryService.openOperation`; `SpawnK6Runner.executionStore`; `DemoRunService.finalizationService`; `DemoRunFinalizationService.pendingPersistenceReconciler`; startup reconciliation's production readers/eligibility closer; maintenance traffic-abort, live-state reset, reset-fence, durable-delete, Redis-delete, prepare/complete-teardown dependencies; worker order-recovery claim/failure/resolution persistence; and the production notification/recovery publishers. Treat optional dashboard projection readers separately: retain absence only when the public contract deliberately represents a degraded optional panel. Update `apps/api/src/index.ts` and the worker/load-orchestrator composition roots to supply real implementations, never construct clients inside services/routes. Replace partial casts with small, explicit in-memory fakes that implement required contracts.

## Retained behavior and non-goals

Retain real optional product projections where an unavailable external observation is a meaningful degraded state. Do not add service locators, reflection-based containers, or broad abstraction layers; this is contract narrowing, not a framework project.

## Acceptance criteria

- [x] Production-always-supplied dependencies are non-optional at their owning interface.
- [x] The Working record maps every changed optional member to its production provider and explains every retained optional member's product semantics.
- [x] Composition roots explicitly supply required dependencies.
- [x] Tests use explicit in-memory fakes rather than impossible fallback branches.
- [x] Genuine product-semantic degradation remains optional and documented by behavior.
- [x] No generic DI framework or client creation in routes/services is added.

## Verification

Run focused type checks and service tests for each changed owner, then root `pnpm type-check` if the scope is broad. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record exact commands.

## Working record

- Status: complete
- Completed scope:
  - Made the dashboard recovery operation factory, every per-operation reader/service, and operation cleanup mandatory. `apps/api/src/index.ts` supplies the request-scoped Postgres readers, Redis inventory/traffic readers, BullMQ queue inspector, composed ERP reader, and database/Redis/queue cleanup. None has an absence meaning in production. Nullable and empty dashboard response fields remain the degradation contract for no active scope, incomplete evidence, or a caught reader failure; the readers themselves are not optional.
  - Made the load orchestrator execution store mandatory behind a small `ExecutionStore` contract. `apps/load-orchestrator/src/index.ts` supplies `FileExecutionStore`; journal absence was an impossible deployed mode, while `read()` returning no current execution remains valid state.
  - Made `DemoRunService.finalizationService` and `DemoRunFinalizationService.pendingPersistenceReconciler` mandatory. The API composition root supplies `DemoRunFinalizationService` and `PendingPersistenceReconciler`; omitting either disabled required completion or pending-reservation recovery work.
  - Made startup reconciliation's `listDrainingRuns` and `closeRunSaleEligibility` operations mandatory. The API composition root supplies a `demoRuns` Postgres query and `setRunSaleEligibility` Redis operation; the old service-owned database/Redis fallback path had no production absence meaning.
  - Made all generated-run queue maintenance operations and teardown/reset collaborators mandatory. The API composition root supplies the BullMQ queue-maintenance adapter; `deleteGeneratedRunDurable`, `deleteGeneratedRunRedisState`, `prepareGeneratedRunTeardown`, and `completeGeneratedRunTeardown` database package operations; `clearErpCircuitBreakerSnapshots`; `HttpTrafficExecutionGateway`; the Redis dashboard metric/publication stores; and `PostgresDemoResetWorkflowFence`. Their omission only represented incomplete wiring.
  - Made worker recovery claims, publication-failure recording, resolution, terminal reconciliation, failed-job ingestion, dead-letter/recoverable handoff, business-outcome publication, notification publication, and realtime publication mandatory. Worker composition supplies `PostgresOrderRecoveryPersistence`, the BullMQ order/notification publishers, business-outcome publication scheduler, and realtime Redis publisher. Removed the obsolete `markEnqueued` fallback because the mandatory atomic publication claim owns attempt advancement and leases.
  - Replaced omission-based unit setup with explicit, typed in-memory stores/readers/publishers and no-op fakes. Tests that previously asserted impossible missing-recovery behavior now assert the required durable handoff behavior.
- Decisions:
  - Retained clocks, retry/timing knobs, request abort context, conditional diagnostic/reporting callbacks, and teardown `afterRestored` callbacks as optional because they are genuine test/configuration or best-effort observation seams rather than required production infrastructure.
  - Retained nullable/empty dashboard projection values rather than optional dependencies: no active run/sale scope, a not-yet-complete transport account, and an isolated projection read failure still intentionally degrade individual panels.
  - Kept the unrelated optional reserve-order business-outcome callback outside this task's ownership boundary; changing that request-path contract would be broader than the named recovery/finalization/maintenance/worker owners.
  - Inspected `docs/architecture.md`, `docs/cross_service_conventions.md`, and `docs/load_generation_metrics_streaming.md`. They already describe durable worker recovery, mandatory journaled load execution, scoped dashboard recovery, and generated-run teardown; narrowing internal constructor contracts did not change public or operational behavior, so no durable documentation update was needed.
  - Added no container, service locator, or generic DI abstraction. Production implementations remain explicit in existing composition roots, while service constructors only accept narrow contracts.
- Verification:
  - `pnpm --filter api type-check && pnpm --filter load-orchestrator type-check && pnpm --filter worker type-check` — passed.
  - `pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false` — passed.
  - `pnpm --filter load-orchestrator test:focused:service` — passed (1 file, 89 tests).
  - `pnpm --filter worker test:unit` — passed (14 files, 91 tests).
  - `pnpm --filter worker test:integration` — passed (8 files, 46 tests).
  - `pnpm --filter api exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.api.config.ts test/api.test.ts test/dashboard-recovery-service.test.ts test/demo-run-startup-reconciliation-service.test.ts test/demo-run-service.test.ts test/demo-maintenance-service.test.ts` — passed (5 files, 204 tests).
  - `pnpm --filter api exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.api.config.ts test/demo-run-finalization-service.test.ts` — passed (1 file, 30 tests).
  - `pnpm type-check` — passed (11 Turbo tasks and the root test TypeScript project).
  - `pnpm --filter worker type-check` — passed after the review cleanup.
  - `pnpm lint` — passed (408 files, no warnings).
  - `pnpm exec biome check apps/api/src/index.ts apps/api/src/services/dashboard-recovery-service.ts apps/api/src/services/demo-maintenance-service.ts apps/api/src/services/demo-run-finalization-service.ts apps/api/src/services/demo-run-service.ts apps/api/src/services/demo-run-startup-reconciliation-service.ts apps/api/test/api.test.ts apps/api/test/dashboard-recovery-service.test.ts apps/api/test/demo-maintenance-service.test.ts apps/api/test/demo-run-finalization-service.test.ts apps/api/test/demo-run-service.test.ts apps/api/test/demo-run-startup-reconciliation-service.test.ts apps/load-orchestrator/src/application/execution-store.ts apps/load-orchestrator/src/application/k6-runner.ts apps/load-orchestrator/src/index.ts apps/load-orchestrator/test/load-orchestrator.test.ts apps/worker/src/application/notification-record-job-handler.ts apps/worker/src/application/order-process-job-handler.ts apps/worker/src/application/order-recovery-scanner.ts apps/worker/src/persistence/postgres-order-recovery-persistence.ts apps/worker/src/queue/bullmq-order-process-consumer.ts apps/worker/test/integration/bullmq-order-process-admission.test.ts apps/worker/test/integration/bullmq-order-process-consumer.test.ts apps/worker/test/integration/order-dispatch-recovery.test.ts apps/worker/test/integration/order-processing-workflow.test.ts apps/worker/test/unit/order-process-admission-boundary.test.ts apps/worker/test/unit/order-process-job-handler.test.ts apps/worker/test/unit/order-recovery-scanner.test.ts` — passed with formatter enabled (28 changed code/test files, no fixes needed).
  - `git diff --check` — passed.
- Follow-up: none
