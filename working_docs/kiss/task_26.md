# Task 26 — Extract dashboard metric storage and ingestion from run orchestration

## Execution context

- **Execution order:** Task 26 of 45, in Phase 5 (repair ownership boundaries).
- **Dependencies:** The trusted baseline must be green, production dependencies must already be explicit, and transport accounting must already use its canonical model. This task assumes the public runtime policy and topology decisions have also been recorded.
- **Standalone scope:** This file is authoritative even if the overengineering audit is unavailable. Verify the named paths against the current checkout because earlier tasks may have moved code.
- **Primary ownership boundary:** API application services for live traffic-metric ingestion and the API-owned Redis dashboard metric projection.
- **Working expectations:** Read working_docs/quality_checklists.md before editing. Keep routes thin, construct Redis clients only in the composition root, update tests at the service and Redis boundaries, and use this document as the implementation and handoff record.

## Why this task exists

apps/api/src/services/demo-run-service.ts currently contains the Redis metric store, metric admission and batching rules, dashboard publication, run fencing, cleanup, reads, and the run lifecycle itself. That makes changes to a gold signal depend on an already oversized lifecycle owner.

The dashboard must continue to show the request surge, but metric persistence and ingestion do not need to be methods of the service that starts and completes runs.

## Required outcome

Create focused owners for:

1. the Redis-backed live traffic-metric projection, including append, bounded retention, publish, read, run fence, clear, and state inspection; and
2. validated metric ingestion, including run/sale attribution, admission, bounded pending work, and advisory publication.

The run lifecycle service should depend on narrow interfaces where it needs to initialize or fence metric state. The internal metric route should call the ingestion owner directly.

## Scope and implementation guidance

- Move RedisDashboardTrafficMetricStore, DashboardTrafficMetricReader, traffic-metric key helpers, publish-result parsing, and directly related constants out of apps/api/src/services/demo-run-service.ts into a clearly named dashboard metric module.
- Move DemoRunService.ingestMetrics() and its warning/admission helpers into a small traffic-metric ingestion service.
- Preserve the current recent-sample bound, metric reset fence, run and sale-offer attribution, one-second upstream aggregation, correlation-aware logging, and best-effort realtime publication semantics.
- Inject the shared Redis-backed store and any publication scheduler from apps/api/src/index.ts. Neither the route nor either service may create a Redis client.
- Adapt apps/api/src/routes/demo-run-routes.ts or the current internal-load route registration so HTTP parsing and status selection remain separate from ingestion workflow logic.
- Delete moved exports, helpers, constructor options, and duplicate fixtures from demo-run-service.ts in the same change.
- Update or relocate apps/api/test/dashboard-traffic-metric-store-unit.test.ts, apps/api/test/dashboard-traffic-metric-store.test.ts, apps/api/test/demo-run-service.test.ts, and relevant API route coverage.

## Retained behavior and non-goals

- Retain one-second k6 aggregation, bounded Redis history, run fencing, cancellation-safe shutdown, and the request-surge gold signal.
- Do not redesign the dashboard wire protocol in this task; the revisioned projection migration occurs later.
- Do not introduce a generic repository, event bus, or ports-and-adapters framework.
- Do not move API-owned dashboard projection behavior into @checkout-surge/db merely because Redis is used; that package should expose clients/helpers, not own this application workflow.
- Do not change run start, traffic completion, inventory reservation, queue, ERP, or finalization semantics.

## Acceptance criteria

- [x] demo-run-service.ts contains no Redis traffic-metric storage implementation or metric-ingestion workflow.
- [x] One focused store owns append/read/fence/clear behavior and one focused service owns ingestion decisions.
- [x] The internal HTTP route parses and delegates without Redis or lifecycle orchestration.
- [x] Redis clients and concrete schedulers are supplied by the API composition root.
- [x] Existing bounds, attribution checks, publication behavior, and cleanup semantics remain covered.
- [x] The replaced code and mechanism-specific duplicate tests are deleted rather than retained as a fallback.

## Verification

- Run the focused dashboard traffic-metric store, demo-run service, and API route tests.
- Run pnpm --filter api type-check and pnpm type-check.
- Run pnpm lint or an equivalent focused Biome check for changed source and tests.
- Do not run pnpm test:composition or pnpm test:characterization without explicit user authorization.

## Working record

- **Status:** complete
- **Completed scope:** Extracted the Redis-backed dashboard traffic projection into `dashboard-traffic-metric-store.ts`; extracted validation, durable lifecycle admission, bounded single-flight ingestion, event construction, warning containment, retention/publication ordering, and reset-fence handling into `traffic-metric-ingestion-service.ts`; routed `/internal/load/metrics` directly to the ingestion controller; composed both owners in `index.ts`; moved recovery reader imports; removed metric ingestion/storage dependencies and exports from `DemoRunService`; relocated and simplified tests at the new service and Redis boundaries; updated architecture and load-metric ownership documentation.
- **Material decisions or deviations:** The ingestion service owns its small ten-batch process-local queue directly rather than introducing a separate scheduler abstraction. The shared `DemoRunValidationError` moved to a focused module so ingestion does not load or depend on the run-orchestration implementation. The metric wire contract remains run-scoped and unchanged; no `saleOfferId` field or protocol fallback was added.
- **Verification performed:** Started approved PostgreSQL/Redis test infrastructure with `pnpm test:infra:up`. Passed 22 focused store/ingestion tests, including real Redis reset races; passed four focused internal metric-route tests; passed the full `demo-run-service.test.ts` suite; passed `pnpm --filter api type-check`; passed `pnpm type-check` including all package and test-source type checks; passed focused Biome check for all changed TypeScript source/tests; passed `git diff --check`.
- **Remaining blockers or follow-up:** none
