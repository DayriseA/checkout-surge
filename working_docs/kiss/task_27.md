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

- [x] demo-run-service.ts contains no fetch, load-orchestrator URL, HTTP timeout, or traffic-response parsing logic.
- [x] Start and abort consumers depend on explicit, minimal gateway interfaces.
- [x] The concrete gateway is built once in API composition and validates all responses with shared contracts.
- [x] Exact-run mismatch, timeout, malformed response, correlation propagation, and idempotent no-current-run behavior remain tested.
- [x] Old gateway definitions and duplicate test paths are removed.

## Verification

- Run apps/api/test/traffic-execution-gateway.test.ts and the affected demo-run and maintenance service tests.
- Run pnpm --filter api type-check and pnpm type-check.
- Run a focused lint/format check on changed files.
- Do not run the composition or characterization suites unless the user explicitly asks.

## Working record

- **Status:** complete
- **Completed scope:** Extracted `TrafficExecutionGateway`, `TrafficAbortGateway`, and `HttpTrafficExecutionGateway` into `apps/api/src/services/traffic-execution-gateway.ts`; moved all load-orchestrator URLs, service-token/correlation headers, start/status/abort request deadlines, response reading and parsing, and adapter-local errors/helpers with them. `DemoRunService` now imports only the start capability, `DemoMaintenanceService` imports only the exact-run abort capability, and `apps/api/src/index.ts` constructs the one HTTP gateway and injects it into both consumers. Consolidated HTTP adapter coverage in `apps/api/test/traffic-execution-gateway.test.ts` and removed the duplicate HTTP fixture/path from `demo-run-service.test.ts`. Updated architecture, repository ownership, and load-generation documentation.
- **Material decisions or deviations:** Ordinary start and ambiguous-status responses now require both the requested run ID and canonical correlation ID after shared-contract validation. The complete successful response body is covered by the request deadline; malformed, identity-mismatched, incomplete, and server-failed starts use exact durable-status recovery and otherwise preserve `load_orchestrator_start_ambiguous`, so the API does not falsely fail a run that may own traffic. Clearly definitive request/auth/conflict 4xx responses remain `load_orchestrator_unavailable` without status recovery. Abort preserves its distinct idempotent `no_current_run`, exact current-run success, and conflicting-current-run paths. The shared abort capability exposes only the outcome needed by maintenance, while the concrete adapter still returns the complete validated contract response. No load-orchestrator lifecycle, supervision, completion-redelivery, or run-transition code changed.
- **Verification performed:** `pnpm --filter api test:api test/traffic-execution-gateway.test.ts test/demo-run-service.test.ts test/demo-maintenance-service.test.ts` (passed: 3 files, 119 tests); after review correction, `pnpm --filter api test:api test/traffic-execution-gateway.test.ts` (passed: 1 file, 28 tests); `pnpm --filter api type-check` (passed); `pnpm type-check` (passed, including all eight workspace packages and test-source type-check); `pnpm exec biome check apps/api/src/index.ts apps/api/src/services/demo-maintenance-service.ts apps/api/src/services/demo-run-service.ts apps/api/src/services/traffic-execution-gateway.ts apps/api/test/demo-run-service.test.ts apps/api/test/traffic-execution-gateway.test.ts` (passed); focused post-review Biome on the gateway source/test (passed); `git diff --check` (passed). Composition and characterization suites were not run, as required.
- **Remaining blockers or follow-up:** none
