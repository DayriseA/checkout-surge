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

- [x] Mock ERP starts and its readiness endpoint succeeds with no PostgreSQL dependency/configuration.
- [x] PostgreSQL ledger class/table, advisory lock, client, config, dependencies, tests, docs, Compose/env wiring, and baseline references are removed.
- [x] Confirmation latency, capacity limiting, configured failures/outage, and in-process idempotent replay retain focused coverage.
- [x] Task 24's restart/replay regression remains green and worker accepted-result recovery still converges.
- [x] No dormant database implementation or fallback mode remains reachable.

## Focused verification

Run `pnpm --filter mock-erp test:unit`, mock-ERP integration tests if present, the task-24 focused worker integration regression, relevant DB migration/unit tests, and affected package type-checks. Do not run composition or characterization suites.

## Working record

Completed 2026-07-22.

- Task 24 commit `d572920` supplied the prerequisite worker boundary evidence. Its focused PostgreSQL-backed regression remained green after this change: `pnpm --filter worker test:integration erp-attempt-recovery.integration.test.ts` passed 1 file / 3 tests, proving a replacement mock with fresh in-memory history receives no second call after the worker has durably accepted the result.
- Deleted the PostgreSQL confirmation ledger and readiness probe, the ledger-only integration test/config/scripts, the `erp_confirmation_results` schema/table/types/baseline/snapshot metadata, generated-run maintenance deletion and fixtures, and Mock ERP's database/readiness-timeout dependencies and environment/Compose wiring. `pnpm install --lockfile-only` removed the Mock ERP importer edges for `@checkout-surge/db` and `drizzle-orm`; package-isolated test-database and Redis allowances for the deleted lane were also removed from the shared test-environment tooling.
- `ConfirmationService` now owns one in-memory ledger with direct scalar comparison of immutable order identity. Successful duplicates and concurrent duplicates replay in-process, contradictory reuse still returns the existing conflict, and failed decisions remain retryable. No alternate ledger injection, optional `perform` mode, persistence fallback, or replacement store remains.
- Mock ERP health routes now report only `confirmation_endpoint_ready`. A production-mode listener launched on `127.0.0.1:45100` with `DATABASE_URL` explicitly unset, and `GET /health/ready` returned HTTP 200 with `status: ok` and that single check.
- Retained behavior verification passed: `pnpm --filter mock-erp test:unit` (3 files / 62 tests, including measured latency, TPS limiting, configured error/outage, retryable failed decisions, successful replay, concurrent replay, and immutable conflict); `pnpm --filter mock-erp type-check`; and `pnpm --filter mock-erp build`.
- Database and maintenance verification passed: `pnpm --filter @checkout-surge/db test:unit migration-metadata.test.ts` (1 file / 3 tests, including no generated drift), `pnpm --filter @checkout-surge/db test:integration test-database-reset.integration.test.ts` (1 file / 5 tests), `pnpm --filter @checkout-surge/db test:integration db.integration.test.ts -t "applies the baseline"` (1 passed / 63 skipped by focus), `pnpm --filter @checkout-surge/db type-check`, and `pnpm --filter api test:api demo-maintenance-service.test.ts` (1 file / 30 tests). The first focused maintenance run exposed a stale built DB artifact; `pnpm --filter @checkout-surge/db build` refreshed it and the rerun passed.
- Runtime and type verification passed: `node --test scripts/runtime-image-contract.test.mjs scripts/test-command-graph.test.mjs` (14 tests), `node scripts/run-with-env.mjs docker compose config --quiet`, `pnpm --filter api type-check`, `pnpm --filter worker type-check`, and `pnpm type-check:test`.
- Final repository checks passed: `pnpm lint` and `pnpm format:check` (393 files each), plus `git diff --check`.
- Review cleanup verification passed after removing the dormant Mock ERP test-database/Redis isolation allowances: `node --test scripts/test-environment-safety.test.mjs` (7 tests) and `pnpm --filter @checkout-surge/db test:unit test-environment-safety.test.ts` (1 file / 19 tests).
- Composition and characterization were intentionally not run, as required by repository guidance. The deleted Mock ERP integration lane had no ownership after removing its PostgreSQL-specific test.
