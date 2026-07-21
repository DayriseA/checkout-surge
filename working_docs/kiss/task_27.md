# Task 27 — Extract the load-orchestrator HTTP gateway from run lifecycle code

## Execution context

- **Execution order:** Task 27 of 45, in Phase 5 (repair ownership boundaries).
- **Dependencies:** Task 26 must have removed dashboard metric concerns from the run service. Production-required interfaces must be explicit rather than optional fallbacks.
- **Standalone scope:** This task contains the required context without relying on the audit. Confirm paths and symbols in the current checkout before editing.
- **Primary ownership boundary:** API infrastructure adapter for starting, inspecting, and aborting traffic through the load-orchestrator HTTP API.
- **Working expectations:** Follow working_docs/quality_checklists.md. HTTP routes remain thin, business workflows stay in application services, and concrete HTTP-client configuration remains in composition.

## Why this task exists

apps/api/src/services/demo-run-service.ts currently defines HttpTrafficExecutionGateway and the start/abort interfaces beside database-backed run lifecycle code. HTTP request deadlines, response parsing, errors, and abort behavior are infrastructure concerns. Keeping them in the lifecycle owner forces readers and tests to understand two unrelated responsibilities.

## Required outcome

Move the load-orchestrator client into a focused traffic-execution gateway module. The run lifecycle and maintenance workflows must receive required narrow interfaces for start and exact-run abort; they must not know fetch details, service URLs, authentication headers, response parsing, or HTTP timeout mechanics.

## Scope and implementation guidance

- Move TrafficExecutionGateway, TrafficAbortGateway, HttpTrafficExecutionGateway, abort timeout/invalid-response errors, and directly related parsing helpers from apps/api/src/services/demo-run-service.ts into apps/api/src/services/traffic-execution-gateway.ts or an equivalently focused adapter.
- Preserve accepted start response validation, exact run-ID binding, canonical correlation propagation, service-token authentication, bounded requests, and the distinction between no current run, exact-run abort, and a conflicting current run.
- Keep fetch injection only where it supports a real adapter test seam. Production construction belongs in apps/api/src/index.ts.
- Let the run lifecycle depend on start capability and maintenance depend on abort capability; do not force either consumer to receive unrelated methods.
- Consolidate apps/api/test/traffic-execution-gateway.test.ts around the extracted adapter and remove duplicate HTTP fixtures from demo-run-service tests.
- Update exports and documentation that currently imply the gateway is part of DemoRunService.

## Retained behavior and non-goals

- Cancelling or resetting a run must still stop exact-run traffic within its existing bound and must never abort a different run.
- Preserve the containerized load-orchestrator boundary and server-only control authentication.
- Do not change k6 process supervision, completion redelivery, run-state transitions, or the load contracts.
- Do not create a generic HTTP client framework or hide contract parsing behind untyped values.

## Acceptance criteria

- [ ] demo-run-service.ts contains no fetch, load-orchestrator URL, HTTP timeout, or traffic-response parsing logic.
- [ ] Start and abort consumers depend on explicit, minimal gateway interfaces.
- [ ] The concrete gateway is built once in API composition and validates all responses with shared contracts.
- [ ] Exact-run mismatch, timeout, malformed response, correlation propagation, and idempotent no-current-run behavior remain tested.
- [ ] Old gateway definitions and duplicate test paths are removed.

## Verification

- Run apps/api/test/traffic-execution-gateway.test.ts and the affected demo-run and maintenance service tests.
- Run pnpm --filter api type-check and pnpm type-check.
- Run a focused lint/format check on changed files.
- Do not run the composition or characterization suites unless the user explicitly asks.

## Working record

- **Status:** pending
- **Completed scope:** none
- **Material decisions or deviations:** none
- **Verification performed:** not run
- **Remaining blockers or follow-up:** none
