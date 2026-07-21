# Task 25 — Remove PostgreSQL from mock ERP

## Execution context

Task 25 of 45, Phase 4, strictly after task 24's replay/restart regression is green. Primary ownership is the mock-ERP application/runtime composition boundary; worker `erp_attempts` remains the durable idempotency owner. Follow the checklist: mock runtime composition constructs dependencies, and no dormant fallback keeps an obsolete database client alive.

## Why

The mock ERP simulates latency, TPS, failures, and outage—not a second durable ERP database. Its PostgreSQL ledger, advisory lock, readiness dependency, and schema create an unnecessary idempotency authority.

## Required outcome

Use the existing in-memory confirmation ledger only. Remove the PostgreSQL ledger class/table/advisory lock/client/config/readiness/dependencies/tests/docs and amend baseline/Compose/environment. Preserve latency, TPS limits, configured failure/forced outage behavior, and in-process idempotent replay. Worker durable `erp_attempt` accepted-result recovery remains. The mock must start and report ready without PostgreSQL; no dormant fallback remains.

## Scope and concrete current paths

- `apps/mock-erp/src/application/postgres-confirmation-ledger.ts`, confirmation service, readiness, runtime config/index/server, tests, package dependencies, and `.env.example`.
- `packages/db/src/schema.ts`, Drizzle baseline/meta and DB tests for mock-ERP ledger table/lock references.
- `docker-compose*.yml`, root runtime docs/env/setup/readiness checks, and worker configuration only where mock-ERP DB coupling appears.

## Retained behavior and non-goals

Keep mock latency/TPS/failure/forced-outage simulation and in-process idempotent replay. Keep worker `erp_attempts` as durable accepted-result/replay protection. Do not add a replacement persistence store, retain a PostgreSQL fallback, or claim restart-stable ERP confirmation history.

Durable mock-ERP persistence may be reintroduced only if restart-stable external-ERP idempotency becomes an explicit project requirement with demonstrated behavior and a clear ownership boundary.

## Acceptance

- [ ] Mock ERP starts and its readiness endpoint succeeds with no PostgreSQL dependency/configuration.
- [ ] PostgreSQL ledger class/table, advisory lock, client, config, dependencies, tests, docs, Compose/env wiring, and baseline references are removed.
- [ ] Confirmation latency, capacity limiting, configured failures/outage, and in-process idempotent replay retain focused coverage.
- [ ] Task 24's restart/replay regression remains green and worker accepted-result recovery still converges.
- [ ] No dormant database implementation or fallback mode remains reachable.

## Focused verification

Run `pnpm --filter mock-erp test:unit`, mock-ERP integration tests if present, the task-24 focused worker integration regression, relevant DB migration/unit tests, and affected package type-checks. Do not run composition or characterization suites.

## Working record

Pending — record the task-24 evidence, removed DB artifacts/dependencies, no-Postgres readiness evidence, retained mock behaviors, commands run, and skipped checks.
