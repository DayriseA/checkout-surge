# Task 29 — Separate run lifecycle from traffic-completion ingestion and business finalization

## Execution context

- **Execution order:** Task 29 of 45, in Phase 5 (repair ownership boundaries).
- **Dependencies:** Metric ingestion, the traffic HTTP gateway, and preset/policy administration must already have left DemoRunService. Canonical transport accounting and the single pending-persistence repair owner must be in place.
- **Standalone scope:** This file describes the complete target without requiring the audit. Verify symbols against the current checkout before changing them.
- **Primary ownership boundary:** API application services for run start/lifecycle, immutable traffic-completion acceptance, and asynchronous business finalization.
- **Working expectations:** Follow working_docs/quality_checklists.md. Routes only validate/delegate, transactions remain in persistence/application boundaries, and each workflow gets tests at its own service boundary.

## Why this task exists

DemoRunService still combines run creation/start delegation, startup reconciliation, immutable completion acceptance, completion enrichment, transition to draining, and coordination with DemoRunFinalizationService. Traffic completion and business completion are deliberately different product concepts; hiding both inside one large owner makes their guarantees harder to see.

## Required outcome

Leave one focused run-lifecycle owner for creating and starting the single current run. Give immutable load completion acceptance to a focused traffic-completion service. Keep post-traffic drain and terminal business decisions in DemoRunFinalizationService, with one explicit handoff between the two.

## Scope and implementation guidance

- Move recordTrafficCompletion and its transaction/binding/enrichment orchestration out of apps/api/src/services/demo-run-service.ts.
- Reuse and clarify apps/api/src/services/traffic-completion-binding.ts, traffic-completion-enrichment-service.ts, terminal-demo-run-transition.ts, and terminal-demo-run-writer.ts rather than duplicating their work. Completion enrichment here means ordinary synchronous/transactional derivation needed to accept the immutable traffic report; remove or redirect any enrichment entry point that discovers pending-persistence cases, schedules repair, retries them, or drives their resolution.
- Let the completion service validate run/config identity, accept one immutable canonical report, make semantic redelivery idempotent, close buy/metric admission as required, claim draining, and request finalization.
- Keep DemoRunFinalizationService responsible for reading settled business evidence, applying drain/failure precedence, and writing one immutable terminal summary behind its fence. It may observe pending-persistence state and defer or fail finalization, but must not poll for, enqueue, retry, scan, or resolve pending-persistence work; those actions remain exclusively with the Task 22 owner.
- Move startup-only reconciliation to apps/api/src/services/demo-run-startup-reconciliation-service.ts or another explicit startup owner; do not leave a background-repair method on the normal run controller.
- Narrow the route-facing interfaces and update apps/api/src/routes/demo-run-routes.ts and apps/api/src/index.ts accordingly.
- Split completion/finalization fixtures out of apps/api/test/demo-run-service.test.ts and keep regression coverage in the binding, finalization, startup, and new completion-service suites.

## Retained behavior and non-goals

- Preserve starting to active to draining to completed/failed, single-nonterminal-run enforcement, correlation IDs, exact accepted configuration, and semantic completion replay.
- Traffic completion must not imply business completion. Accepted orders, ERP attempts, notifications, pending persistence, and queue dispatch must still settle before success.
- This refactor must preserve exactly one pending-persistence repair authority. Startup reconciliation, traffic completion, finalization, workers, and maintenance may invoke or observe the Task 22 owner's bounded interface where required, but must not implement an independent scanner, polling loop, failed-set consumer, recovery sweep, or retry schedule.
- Do not merge completion and finalization into one large replacement service.
- Do not move business logic into demo-run-routes.ts or apps/api/src/index.ts.
- Do not change public/admin start permissions, inventory reservation, worker behavior, or terminal reason precedence except where a prior vocabulary task already required it.

## Acceptance criteria

- [x] The run-lifecycle owner starts and reports runs but does not parse or persist completion reports.
- [x] One completion owner accepts immutable load evidence and hands draining runs to one finalization owner.
- [x] Completion enrichment is limited to ordinary completion acceptance; no completion, finalization, startup, worker, or maintenance component becomes a second pending-persistence discovery or repair scheduler.
- [x] Startup reconciliation is owned outside the request-facing lifecycle service.
- [x] Duplicate completion delivery is idempotent and conflicting evidence still fails before mutation.
- [x] Terminal summaries remain fenced, atomic, and delayed until business work settles.
- [x] The old orchestration block and forwarding methods are deleted.

## Verification

- Run traffic-completion binding, completion-service, demo-run lifecycle, startup reconciliation, terminal writer/transition, and finalization tests.
- Run relevant PostgreSQL integration cases for immutable redelivery and terminal fencing.
- Run pnpm --filter api type-check and pnpm type-check.
- Do not run composition or characterization without explicit authorization.

## Working record

- **Status:** complete
- **Completed scope:** Extracted immutable traffic-completion validation, binding, transactional acceptance, semantic redelivery, draining claim, enrichment/admission handoff, dashboard update, and finalization request into `TrafficCompletionService`. Narrowed demo routes, server composition, and `DemoRunLifecycleController` so lifecycle owns starts only. Centralized the two owners' identical nonterminal snapshot read and dashboard-update publication behavior in focused demo-run snapshot operations without changing finalization's terminal publication semantics. Moved periodic starting-intent replay into `DemoRunStartupReconciliationService` with a focused PostgreSQL starting-run store, while retaining its startup-only draining projection repair. Split completion, binding, and starting-reconciliation coverage out of the lifecycle suite and removed obsolete lifecycle fixtures. Added PostgreSQL regressions for pre-mutation binding rejection, acceptance-transaction rollback, restart convergence of a durable pending enrichment, and immutable traffic-boundary capture failure followed by normal terminal inventory capture. Updated the directly affected API ownership documentation.
- **Material decisions or deviations:** Extended the existing explicit startup reconciliation owner rather than adding another service or loop. Deleted the periodic completion-enrichment scanner: exact durable completion redelivery and the one startup reconciliation pass already re-drive incomplete ordinary enrichment, while `PendingPersistenceRecoveryService` remains the sole owner of pending-persistence discovery, retry scheduling, and resolution. Reused the existing enrichment, binding, finalization, and terminal writer/transition boundaries without changing their transaction or terminal precedence behavior.
- **Verification performed:** Focused API/PostgreSQL matrix passed from `apps/api`: `node ../../scripts/run-with-test-env.mjs pnpm exec vitest run --config vitest.api.config.ts test/traffic-completion-binding.test.ts test/traffic-completion-service.test.ts test/demo-run-service.test.ts test/demo-run-startup-reconciliation-service.test.ts test/demo-run-finalization-service.test.ts test/demo-maintenance-service.test.ts test/api.test.ts` (7 files, 200 tests). After consolidating the shared snapshot operations, the directly affected `test/traffic-completion-service.test.ts test/demo-run-service.test.ts` rerun passed (2 files, 42 tests). `pnpm --filter api type-check`, `pnpm type-check`, focused `pnpm exec biome lint` for all changed API source/tests, and `git diff --check` passed. Test PostgreSQL/Redis were started with `pnpm test:infra:up` and stopped after verification.
- **Remaining blockers or follow-up:** none
