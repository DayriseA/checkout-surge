# Automated Testing Infrastructure - Decisions & Rationale

This document records the implemented testing foundation for Checkout-Surge. It is a repository-wide working agreement, not a feature of one service.

The checked-in commands support Linux host-native development, local Dev Containers, and GitHub Codespaces. Tests run on Linux; Windows contributors run them from the Dev Container. There is no hosted CI workflow in this repository. Tests must never depend on normal development data or leave shared infrastructure in an unknown state.

---

## Confirmed Decisions

| Decision | Choice | Rationale |
| :-- | :-- | :-- |
| Baseline TypeScript test runner | Vitest | Fits the TypeScript monorepo, supports fast unit tests, integration tests, coverage, and watch mode without heavy configuration. |
| Test taxonomy | Separate unit, integration, API/service, browser-workflow, and opt-in deployed-topology characterization tests | Keeps fast feedback fast while making external-service and expensive cross-service tests explicit. |
| Test infrastructure isolation | Dedicated PostgreSQL and Redis test services | Prevents tests from mutating normal development data and makes destructive reset operations safe. |
| Test compose strategy | Add `docker-compose.test.yml` instead of overloading the baseline compose file | Keeps local development infrastructure simple while giving tests their own ports, names, and lifecycle. |
| Test database | Per-package databases derived from `checkout_surge_test` (e.g. `checkout_surge_test_api`, `_worker`, `_db`) | Makes the database purpose obvious, avoids accidental use of the development database, and lets packages run integration/API suites concurrently. `scripts/run-with-test-env.mjs` derives the name from the package at its working directory; missing databases are created on demand by `resetTestDatabase`. |
| Test Redis isolation | Per-package logical databases on the test Redis instance (`api` → `/1`, `worker` → `/2`, `db` → `/3`) | Prevents concurrently running packages from wiping or polluting each other's keys. Derived by `scripts/run-with-test-env.mjs`; test-time resets must use `FLUSHDB`, never `FLUSHALL`. |
| Test serialization | One per-database PostgreSQL advisory lock held by `resetTestDatabase` on the stable `postgres` administration database | The session lock serializes all callers that reach the same PostgreSQL service, including callers with different filesystems, and protects database creation as well as schema rebuild. Closing the administration session releases the lock after success or failure. |
| Test PostgreSQL port | `56432` on the host, overrideable with `TEST_POSTGRES_HOST_PORT` | Avoids conflicting with the development PostgreSQL service on `5432` and common Windows reserved port ranges. |
| Test Redis port | `6380` on the host | Avoids conflicting with the development Redis service on `6379`. |
| Test env convention | Use `.env.test.example` as the committed default and optional `.env.test` for local overrides | Gives contributors a safe default without committing local overrides. |
| Reset strategy | `resetTestDatabase` always drops and recreates `public` and `drizzle`, then applies the checked-in reviewed migration | One deterministic path clears data, resets generated sequences, and heals arbitrary schema drift without a fingerprint, custom migration-journal comparison, or truncate mode. A 10-run PostgreSQL 17 Alpine benchmark of the selected final path measured a 438.0 ms mean and 397.3 ms median rebuild, which is acceptable for this suite. Destructive reset remains acceptable only against dedicated test infrastructure. |
| Frontend DOM unit tests | React Testing Library with jsdom | Covers reusable React control markup and browser-accessible labels without requiring a real browser or full end-to-end stack. |
| App testability rule | Services should expose app factories that accept dependencies/configuration | Integration tests should inject test DB/Redis clients and close resources cleanly. |
| Dev Container and Codespaces support | Use the same compose and pnpm commands; forward test ports `56432` and `6380` | Keeps the workflow identical across supported development modes. |

---

## Test Taxonomy

### Unit Tests

- No PostgreSQL, Redis, network calls, or Docker dependency.
- Validate pure business logic, shared contracts, schema parsing, small helpers, and error-shape behavior.
- Frontend DOM component tests may use jsdom and React Testing Library when the behavior depends on rendered markup, accessible names, or label/control associations.
- Must be safe to run frequently in watch mode.
- Infra-free test files belong in the owning package's unit lane (for example `apps/api/test/unit/`), not in an infra-backed lane. A package whose unit lane covers production sources declares its own `test:coverage:unit` script so moved files keep counting toward coverage; the move and the script land together.

### Integration Tests

- Use real PostgreSQL and/or Redis through dedicated test services.
- Validate migrations, seed data, Redis inventory operations, persistence behavior, and cross-package boundaries.
- Migration integration coverage applies the baseline from an empty approved database, verifies its current declarative and custom objects, checks idempotent reruns, preserves valid current policy data, and fails closed on invalid current policy data.
- Must explicitly reset their state before or between suites.

### API / Service Tests

- Exercise service boundaries such as Fastify routes through in-process testing tools like `server.inject()`.
- Use test PostgreSQL and test Redis dependencies, not module-level production clients.
- Should validate response codes, response shapes, persistence side effects, and error behavior.

### Browser Workflow and Deployed-Topology Characterization

- Focused browser-workflow tests exercise recovery behavior with controlled backend boundaries.
- `pnpm test:composition` starts an isolated deployed API, worker, mock ERP, load orchestrator, web app, dashboard proxy, PostgreSQL, and Redis topology through `scripts/composition-characterization.mjs`. That implementation owns wiring, SSE reconnect, sold-out and duplicate behavior, worker/ERP/notification handoffs, finalization/history, and the representative 10,000-buyer scenario.
- `pnpm test:characterization` runs the same `scripts/composition-characterization.mjs` deployed topology. The focused browser workflow runs in the web unit lane.
- Composition state uses a unique Compose project and disposable volumes and is removed by default. `COMPOSITION_KEEP_RUNTIME=true` retains a failed runtime for inspection.
- The composition and characterization suites are intentionally excluded from `pnpm test` because they are slow and require a functioning Docker daemon. Repository agents must not run those two suites unless explicitly requested. Host-native unit tests remain independent of a host k6 installation.
- k6 characterization complements correctness tests; it does not replace focused boundary coverage.

---

## Root Command Contract

The repository provides these root scripts:

- `pnpm type-check` is the authoritative static TypeScript gate. It runs production package/app checks through Turbo, then runs the root test-source compiler only if production checks pass; either failure returns a non-zero status.
- `pnpm type-check:test` is the focused, Docker-free strict compiler check for root/package/app Vitest configs and test sources through `tsconfig.test.json`.
- `pnpm test` runs the full automated test suite, including unit, API/service-boundary, and integration tests.
- `pnpm test:unit` runs only unit tests and must not require Docker.
- `pnpm test:integration` runs only tests that require PostgreSQL and/or Redis test services.
- `pnpm test:api` runs only API/service-boundary tests.
- `pnpm test:watch` runs the fast unit test loop for active development.
- `pnpm test:coverage` is the bounded full coverage gate. It discovers all eight unit owners, the API/service owner, and the DB, worker, and Mock ERP integration owners through package-local Turbo scripts. Mock ERP has a PostgreSQL confirmation-ledger integration lane, also run by `pnpm test`. Start clean dedicated PostgreSQL and Redis services with `pnpm test:infra:up` before running coverage and always stop them with `pnpm test:infra:down` afterward.
- `pnpm test:coverage:unit` is the explicitly fast, infrastructure-free unit-only coverage command.
- `pnpm test:infra:up` starts the dedicated test PostgreSQL and Redis services and waits for their declared healthchecks before returning.
- `pnpm test:infra:down` stops dedicated test services and deletes their named volumes.
- `pnpm test:infra:reset` deletes and recreates only the dedicated test PostgreSQL/Redis services and volumes, then waits for readiness.
- `pnpm test:db:migrate` destructively rebuilds only the approved `@checkout-surge/db` package-isolated test database from the reviewed baseline, creating it on demand. It is a focused verification aid; tests provision and rebuild their package-isolated databases automatically.
- `pnpm test:composition` runs the slow isolated deployed-topology and 10,000-buyer characterization through `scripts/composition-characterization.mjs`.
- `pnpm test:characterization` runs the same `scripts/composition-characterization.mjs` implementation.

Package and app-level scripts should use the same names where applicable so Turbo can orchestrate them predictably.

Tier membership lives in package manifests. Root unit, API, integration, watch, and coverage commands use unfiltered Turbo discovery; absence of a package-local tier script means non-membership. Watch is persistent and includes unit owners only. API, integration, watch, and coverage tasks are not cached.

The repository does not maintain a separate test that parses package manifests and asserts the command graph as text. The commands themselves, package-local Vitest configurations, root type-check, and focused script tests are the authoritative evidence; this avoids turning test-runner wiring into a second mechanically synchronized product.

The suite does not parse every admin route as source text. Admin proxy behavior is exercised through the route tests, and exact SSE routing is exercised by the deployed runtime workflows. `scripts/runtime-image-contract.test.mjs` checks non-root direct entrypoints, deployable artifact allowlists, standalone web tracing, build-context secret exclusions, and Caddy/Compose fragments for the Codespaces origin rewrite. The fragment checks do not prove the combined proxy behavior.

Coverage uses V8 and the shared policy in `vitest.coverage.config.ts`. Every lane explicitly includes all production `src/**/*.ts` and `src/**/*.tsx` files and excludes only source declaration files, so unexecuted production modules count against the initial 10% statements, branches, functions, and lines floor and named high-risk paths remain visible. The floors are evaluated independently for each package/tier lane, not against a globally merged repository report. Every lane writes text output and `coverage-summary.json` to its unique `coverage/<owner>-<tier>` directory, including reports from failed test runs where Vitest permits. A future CI caller should provision and clean up test infrastructure around the same root command and retain those directories; this repository does not currently claim a hosted CI coverage gate.

---

## Test Infrastructure

The test infrastructure is separate from the normal development infrastructure.

Current `docker-compose.test.yml` shape:

- `postgres-test`
  - image aligned with the development PostgreSQL version
  - host port `56432` by default, overrideable with `TEST_POSTGRES_HOST_PORT`
  - database `checkout_surge_test`
  - user/password matching local development unless there is a reason to diverge
- `redis-test`
  - image aligned with the development Redis version
  - host port `6380`
  - no shared data with the development Redis service

Both test services use dedicated named volumes. `pnpm test:infra:down` removes those volumes; `pnpm test:infra:reset` first removes them, recreates both services, and waits for PostgreSQL and Redis readiness.

Tests must never call broad destructive operations against `DATABASE_URL` or `REDIS_URL`. Destructive setup belongs only to `TEST_DATABASE_URL` and `TEST_REDIS_URL`, or to an explicitly loaded test environment.

The test command wrapper validates the final, package-rewritten URLs before spawning a child process. It requires `NODE_ENV=test`, a valid PostgreSQL URL whose decoded database name is exactly `checkout_surge_test` or one of the repository's package-isolated names, and valid PostgreSQL/Redis URLs that do not use the effective default ports (`5432`/`6379`). An omitted port is treated as the protocol default. Diagnostics identify only the variable and host/port and never print URL credentials.

Dedicated CI or Dev Container service containers may use their internal default ports only when their test command environment explicitly sets `ALLOW_TEST_DEFAULT_PORTS=1`. This waiver bypasses only the port deny; environment, URL validity, exact database naming, and connected-database identity checks still apply. It is intentionally absent from `.env.test.example` because local host execution uses `56432` and `6380`.

---

## Environment Variables

`.env.test.example` provides values like:

```env
NODE_ENV=test
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:56432/checkout_surge_test
TEST_REDIS_URL=redis://localhost:6380
CONTROL_SERVICE_TOKEN=test-control-token
ADMIN_DASHBOARD_PASSPHRASE=test-admin-passphrase
ADMIN_SESSION_SECRET=test-admin-session-secret
PUBLIC_CLIENT_COOKIE_SECRET=test-public-client-cookie-secret
RESERVATION_HOLD_MINUTES=15
IDEMPOTENCY_TTL_SECONDS=1800
PENDING_PERSISTENCE_RETRY_AFTER_SECONDS=30
PENDING_PERSISTENCE_RECOVERY_WINDOW_SECONDS=300
PENDING_PERSISTENCE_RECOVERY_MAX_ATTEMPTS=6
PENDING_PERSISTENCE_RECOVERY_INITIAL_BACKOFF_MS=1000
PENDING_PERSISTENCE_RECOVERY_MAX_BACKOFF_MS=30000
PENDING_PERSISTENCE_RECOVERY_POLL_INTERVAL_MS=1000
PENDING_PERSISTENCE_RECOVERY_DISCOVERY_TIMEOUT_MS=2000
PENDING_PERSISTENCE_RECOVERY_MAX_CONCURRENT_DIRECT_ATTEMPTS=3
```

Application code may continue to use `DATABASE_URL` and `REDIS_URL` for normal development. Test commands load `.env.test.example` first and then optional `.env.test` through `scripts/run-with-test-env.mjs`, so local overrides can change ports or credentials without changing committed files.

After loading the env files, `run-with-test-env.mjs` rewrites both URLs per package: the database name gains a suffix derived from the package name (`checkout_surge_test_api`, `_worker`, `_db`, ...), and packages with Redis-backed tests get a dedicated logical database index. Tests and app configs keep reading the plain `TEST_DATABASE_URL` / `TEST_REDIS_URL` variables and stay unaware of the isolation.

Caller environment values win during environment loading, but they cannot weaken the safety boundary: the wrapper checks the resulting URLs and `NODE_ENV` after package isolation. The DB package repeats the PostgreSQL checks in every destructive test helper so direct imports cannot bypass the wrapper.

If a contributor overrides `TEST_POSTGRES_HOST_PORT` for Docker Compose, their local `.env.test` should set `TEST_DATABASE_URL` to the same host port.

---

## Database Reset and Fixtures

Integration tests need deterministic database state.

`resetTestDatabase` first enforces `NODE_ENV=test`, validates the exact allowlisted database name and isolated port, and connects to the stable `postgres` administration database. It acquires one session-scoped advisory lock keyed by the target database name before checking or creating that target. The lock remains held through target connection, `current_database()` identity verification, schema recreation, and migration. Closing the administration connection releases it on both success and failure; there is no filesystem or stale-lock protocol and no second target-database lock.

Every reset drops `public` and Drizzle's `drizzle` journal schema, recreates `public`, and applies the selected reviewed migrations from the beginning. This is the only reset mode. It clears all data, resets migration and generated-sequence state, removes unexpected objects, and restores deleted or modified schema objects without maintaining a second schema representation. A migration failure leaves an incomplete schema, releases the session lock, and the next reset retries the same deterministic rebuild.

The retained destructive guards are exact test-database allowlisting, exact `NODE_ENV=test`, default-port rejection with the existing narrow dedicated-service waiver, connected-database identity verification before schema drops and before migration, credential-safe diagnostics, and the single administration-database advisory lock. The root `test:infra:reset` command composes `test:infra:down` and `test:infra:up` to recreate the dedicated Docker volumes; per-suite schema rebuild never manages service volumes or changes production/runtime wipe behavior.

The test database setup should:

- apply migrations before integration/API tests run,
- clean tables in dependency-safe order between suites or test files,
- seed only the fixtures required by the test,
- avoid relying on the normal demo seed unless the test is explicitly validating demo seed behavior.

Schema and seed verification belongs in the schema/seed test suite. API and reservation behavior should create the data it needs through test fixtures so failures remain easy to diagnose.

Cross-package test fixtures are allowed only through a package-owned public `testing` export. `@checkout-surge/contracts/testing` owns the shared contract-valid Preview 1k configuration used by API and web tests, while `@checkout-surge/db/testing` owns the guarded database reset and fail-closed test database URL access. Same-package defaults may use a focused test helper beside their suites. Scenario-specific values, clocks, deferreds, response helpers, and non-database environment guards stay local so tests continue to show the behavior they arrange. Testing exports must not expose PostgreSQL, Redis, BullMQ, or other infrastructure clients.

---

## Redis Reset and Fixtures

Redis integration tests should use the dedicated test Redis service and test-only keys.

The reset strategy should:

- flush only the package's own logical database (`FLUSHDB`), never the whole instance (`FLUSHALL`) — other packages run concurrently against their own logical databases; `pnpm test:infra:reset` clears all test Redis data by deleting and recreating the dedicated Redis volume,
- initialize inventory snapshots explicitly inside each suite,
- use unique sale offer IDs or reset Redis state between tests when idempotency behavior is involved,
- avoid sharing idempotency keys across unrelated tests.

The Redis hot-path tests should include concurrency scenarios, but those tests should run in the integration suite rather than the unit suite.

---

## Testability Rules for Services

Services should avoid creating long-lived external clients at module import time when those clients are needed by tests.

Preferred shape:

- expose a `build...Server` or app factory that accepts configuration and dependencies,
- keep process startup in a small `start...` function,
- guard startup with `NODE_ENV !== "test"` or an equivalent entrypoint split,
- return handles that tests can close cleanly,
- make loggers injectable or easy to silence in tests.

Executable app `src/index.ts` files are private startup/composition roots, not library surfaces: package manifests declare dependencies, and tests import their focused app modules directly.

For the API gateway, `buildApiServer()` should follow this pattern by accepting explicit configuration, PostgreSQL, Redis, queue, service, and realtime dependencies; tests should use that factory rather than constructing infrastructure clients in route modules.

---

## Development Environment Support

### Host-Native

- Contributors run test services through Docker Compose on ports `56432` and `6380`.
- Unit tests must work without Docker.
- Integration tests should fail clearly if test services are not reachable.

### Local Dev Container

- Docker-in-Docker is available through the seed Dev Container setup.
- The Dev Container forwards test ports `56432` and `6380` for the dedicated services.
- The same root pnpm commands should work inside the container.
- Named `node_modules` volumes remain the dependency isolation strategy.

### GitHub Codespaces

- Codespaces should use the same Dev Container image and Docker-in-Docker setup.
- Test service ports should be forwarded like normal development ports.
- Integration tests should not require contributors to install PostgreSQL or Redis directly in the Codespace.

---

## Future CI Integration

No hosted CI workflow is checked in. A future CI system can call the existing local command contract without changing the test taxonomy.

Expected future CI behavior:

- run `pnpm test` on every merge-bound push and pull request,
- run integration/API tests with service containers or compose-backed infrastructure,
- fail fast on the root production-plus-test-source type-check, lint, and contract/schema test failures,
- keep full load tests and benchmarks separate from regular correctness CI.

---

## Summary

The repository's testing foundation provides:

- Vitest as the baseline TypeScript test runner,
- separate test commands for unit, integration, and API tests,
- dedicated PostgreSQL and Redis test infrastructure,
- `.env.test.example` and explicit test URLs,
- deterministic DB and Redis reset rules,
- Dev Container and Codespaces port/config support,
- service app factories and dependency injection for clean integration tests,
- browser workflow tests in the default web unit lane, and opt-in deployed-topology characterization without slowing the default suite.
