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

- [ ] Production-always-supplied dependencies are non-optional at their owning interface.
- [ ] The Working record maps every changed optional member to its production provider and explains every retained optional member's product semantics.
- [ ] Composition roots explicitly supply required dependencies.
- [ ] Tests use explicit in-memory fakes rather than impossible fallback branches.
- [ ] Genuine product-semantic degradation remains optional and documented by behavior.
- [ ] No generic DI framework or client creation in routes/services is added.

## Verification

Run focused type checks and service tests for each changed owner, then root `pnpm type-check` if the scope is broad. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record exact commands.

## Working record

- Status: pending
- Completed scope: none
- Decisions: none
- Verification: not run
- Follow-up: none
