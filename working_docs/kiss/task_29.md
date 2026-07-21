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

- [ ] The run-lifecycle owner starts and reports runs but does not parse or persist completion reports.
- [ ] One completion owner accepts immutable load evidence and hands draining runs to one finalization owner.
- [ ] Completion enrichment is limited to ordinary completion acceptance; no completion, finalization, startup, worker, or maintenance component becomes a second pending-persistence discovery or repair scheduler.
- [ ] Startup reconciliation is owned outside the request-facing lifecycle service.
- [ ] Duplicate completion delivery is idempotent and conflicting evidence still fails before mutation.
- [ ] Terminal summaries remain fenced, atomic, and delayed until business work settles.
- [ ] The old orchestration block and forwarding methods are deleted.

## Verification

- Run traffic-completion binding, completion-service, demo-run lifecycle, startup reconciliation, terminal writer/transition, and finalization tests.
- Run relevant PostgreSQL integration cases for immutable redelivery and terminal fencing.
- Run pnpm --filter api type-check and pnpm type-check.
- Do not run composition or characterization without explicit authorization.

## Working record

- **Status:** pending
- **Completed scope:** none
- **Material decisions or deviations:** none
- **Verification performed:** not run
- **Remaining blockers or follow-up:** none
