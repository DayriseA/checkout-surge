# Automated Testing Infrastructure - Decisions & Rationale

This document records the implemented testing foundation for Checkout-Surge. It is a repository-wide working agreement, not a feature of one service.

The goal is to make tests reliable across host-native development, local Dev Containers, GitHub Codespaces, and later CI. Tests must never depend on normal development data or leave shared infrastructure in an unknown state.

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
| Test serialization | Per-database filesystem lock plus a PostgreSQL advisory lock (`acquireTestInfrastructureLock` and `resetTestDatabase` in `@checkout-surge/db`) | The filesystem lock serializes cooperating processes on one host. The database-session lock also serializes containers or hosts with different filesystems. Locks are scoped to the package database and are always acquired filesystem-first, database-second. |
| Test PostgreSQL port | `56432` on the host, overrideable with `TEST_POSTGRES_HOST_PORT` | Avoids conflicting with the development PostgreSQL service on `5432` and common Windows reserved port ranges. |
| Test Redis port | `6380` on the host | Avoids conflicting with the development Redis service on `6379`. |
| Test env convention | Use `.env.test.example` as the committed default and optional `.env.test` for local overrides | Gives contributors a safe default without committing local overrides. |
| Reset strategy | `resetTestDatabase` truncates when the schema is verifiably current (migration journal + schema fingerprint match) and only rebuilds from migrations otherwise | Full schema rebuilds per test file were the dominant cost of the old design. The fingerprint check keeps chaos-style tests (which intentionally break schema) self-healing. Destructive reset remains acceptable only against dedicated test infrastructure. |
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

### Integration Tests

- Use real PostgreSQL and/or Redis through dedicated test services.
- Validate migrations, seed data, Redis inventory operations, persistence behavior, and cross-package boundaries.
- Must explicitly reset their state before or between suites.

### API / Service Tests

- Exercise service boundaries such as Fastify routes through in-process testing tools like `server.inject()`.
- Use test PostgreSQL and test Redis dependencies, not module-level production clients.
- Should validate response codes, response shapes, persistence side effects, and error behavior.

### Browser Workflow and Deployed-Topology Characterization

- Focused browser-workflow tests exercise recovery behavior with controlled backend boundaries.
- `pnpm test:composition` starts an isolated deployed API, worker, mock ERP, load orchestrator, web app, dashboard proxy, PostgreSQL, and Redis topology. It covers wiring, SSE reconnect, sold-out and duplicate behavior, worker/ERP/notification handoffs, finalization/history, and the representative 10,000-buyer scenario.
- `pnpm test:characterization` runs the focused browser workflow followed by the same deployed topology.
- `pnpm test:k6-compat` builds the production `load-orchestrator-runtime` image and runs a required, non-skipping compatibility smoke with its pinned k6 2.0.0 binary. It inspects both generated executor modes and parses a real loopback `--summary-export`; it is correctness coverage, not a benchmark.
- `pnpm test:required` is the repository merge gate: the default automated suite followed by the container-backed k6 compatibility lane. There is no checked-in hosted CI workflow, so CI or merge automation must invoke this command rather than `pnpm test` alone.
- Composition state uses a unique Compose project and disposable volumes and is removed by default. `COMPOSITION_KEEP_RUNTIME=true` retains a failed runtime for inspection.
- The composition and characterization suites are intentionally excluded from `pnpm test` because they are slow and require a functioning Docker daemon. Repository agents must not run those two suites unless explicitly requested. The focused k6 compatibility lane remains mandatory through `pnpm test:required`, while host-native unit tests remain independent of a host k6 installation.
- k6 characterization complements correctness tests; it does not replace focused boundary coverage.

---

## Root Command Contract

The repository must provide root scripts with stable names:

- `pnpm type-check` is the authoritative static TypeScript gate. It runs production package/app checks through Turbo, then runs the root test-source compiler only if production checks pass; either failure returns a non-zero status.
- `pnpm type-check:test` is the focused, Docker-free strict compiler check for root/package/app Vitest configs and test sources through `tsconfig.test.json`.
- `pnpm test` runs the full automated test suite, including unit, API/service-boundary, and integration tests.
- `pnpm test:required` runs `pnpm test` and the mandatory production-image k6 compatibility smoke.
- `pnpm test:k6-compat` runs only that container-backed smoke and fails if the pinned binary or expected stable export fields are unavailable.
- `pnpm test:unit` runs only unit tests and must not require Docker.
- `pnpm test:integration` runs only tests that require PostgreSQL and/or Redis test services.
- `pnpm test:api` runs only API/service-boundary tests.
- `pnpm test:watch` runs the fast unit test loop for active development.
- `pnpm test:coverage` is the bounded full coverage gate. It discovers all seven unit owners, the API/service owner, and the DB, mock ERP, and worker integration owners through package-local Turbo scripts. Start clean dedicated PostgreSQL and Redis services with `pnpm test:infra:up` before running it and always stop them with `pnpm test:infra:down` afterward.
- `pnpm test:coverage:unit` is the explicitly fast, infrastructure-free unit-only coverage command.
- `pnpm test:infra:up` starts the dedicated test PostgreSQL and Redis services and waits for their declared healthchecks before returning.
- `pnpm test:infra:down` stops dedicated test services.
- `pnpm test:infra:reset` resets only the dedicated test database and Redis instance.
- `pnpm test:db:migrate` rehearses the real incremental `drizzle-kit` migration path (the one deployment uses) against the db package's isolated test database, creating it on demand. Useful when authoring a new migration; not required before running tests, which provision and migrate their databases automatically.
- `pnpm test:composition` runs the slow isolated deployed-topology characterization.
- `pnpm test:characterization` runs focused browser recovery coverage and then the deployed-topology characterization.

Package and app-level scripts should use the same names where applicable so Turbo can orchestrate them predictably.

Tier membership lives in package manifests. Root unit, API, integration, watch, and coverage commands use unfiltered Turbo discovery; absence of a package-local tier script means non-membership. Watch is persistent and includes unit owners only. API, integration, watch, and coverage tasks are not cached.

Coverage uses V8 and the shared policy in `vitest.coverage.config.ts`. Every lane explicitly includes all production `src/**/*.ts` and `src/**/*.tsx` files and excludes only source declaration files, so unexecuted production modules count against the initial 10% statements, branches, functions, and lines floor and named high-risk paths remain visible. The floors are evaluated independently for each package/tier lane, not against a globally merged repository report. Every lane writes text output and `coverage-summary.json` to its unique `coverage/<owner>-<tier>` directory, including reports from failed test runs where Vitest permits. A future CI caller should provision and clean up test infrastructure around the same root command and retain those directories; this repository does not currently claim a hosted CI coverage gate.

---

## Test Infrastructure

The test infrastructure should be separate from the normal development infrastructure.

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

The test services may use disposable container storage or dedicated test volumes. If volumes are used, reset scripts must make state deterministic before tests run.

Tests must never call broad destructive operations against `DATABASE_URL` or `REDIS_URL`. Destructive setup belongs only to `TEST_DATABASE_URL` and `TEST_REDIS_URL`, or to an explicitly loaded test environment.

The test command wrapper validates the final, package-rewritten URLs before spawning a child process. It requires `NODE_ENV=test`, a valid PostgreSQL URL whose decoded database name is exactly `checkout_surge_test` or one of the repository's package-isolated names, and valid PostgreSQL/Redis URLs that do not use the effective default ports (`5432`/`6379`). An omitted port is treated as the protocol default. Diagnostics identify only the variable and host/port and never print URL credentials.

Dedicated CI or Dev Container service containers may use their internal default ports only when their test command environment explicitly sets `ALLOW_TEST_DEFAULT_PORTS=1`. This waiver bypasses only the port deny; environment, URL validity, exact database naming, connected-database identity, migration journal, and fingerprint checks still apply. It is intentionally absent from `.env.test.example` because local host execution uses `56432` and `6380`.

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
```

Application code may continue to use `DATABASE_URL` and `REDIS_URL` for normal development. Test commands load `.env.test.example` first and then optional `.env.test` through `scripts/run-with-test-env.mjs`, so local overrides can change ports or credentials without changing committed files.

After loading the env files, `run-with-test-env.mjs` rewrites both URLs per package: the database name gains a suffix derived from the package name (`checkout_surge_test_api`, `_worker`, `_db`, ...), and packages with Redis-backed tests get a dedicated logical database index. Tests and app configs keep reading the plain `TEST_DATABASE_URL` / `TEST_REDIS_URL` variables and stay unaware of the isolation.

Caller environment values win during environment loading, but they cannot weaken the safety boundary: the wrapper checks the resulting URLs and `NODE_ENV` after package isolation. The DB package repeats the PostgreSQL checks in every destructive test helper so direct imports cannot bypass the wrapper.

If a contributor overrides `TEST_POSTGRES_HOST_PORT` for Docker Compose, their local `.env.test` should set `TEST_DATABASE_URL` to the same host port.

---

## Database Reset and Fixtures

Integration tests need deterministic database state.

`resetTestDatabase` holds the per-database filesystem lock and then a PostgreSQL advisory lock for the complete decision, rebuild/fingerprint write, or truncate operation. It verifies `current_database()` against the already validated URL name before destructive SQL. It compares the complete ordered Drizzle `drizzle.__drizzle_migrations` rows with hashes and timestamps derived by Drizzle's own migration reader, and independently compares a stored `public.__test_schema_fingerprint` marker with the live public schema. Only a double match takes the fast truncate path.

Missing, malformed, duplicate, or stale markers, journal drift, and schema drift drop and recreate `public` and Drizzle's journal schema, then apply the existing checked-in Drizzle migrator from the beginning. The marker is written only after migration succeeds and the new journal is verified. A failed migration therefore leaves no trusted marker and the next reset retries the rebuild.

The fingerprint covers public relations, columns (including types, nullability, identity/generated state, collation, and defaults), constraints, indexes, non-internal triggers, functions/procedures and their definitions, enum/domain/standalone composite types, sequence settings and sequence-to-column dependency links, views/materialized views, RLS flags and policies, and public extensions. These are the object classes current Surge migrations and chaos tests can mutate. General object ownership, grants, security labels, and comments are not fingerprinted because current migrations/tests do not manage them; a future migration that relies on one of those classes must extend the fingerprint first.

When the journal and fingerprint match, reset discovers ordinary and partitioned public tables from PostgreSQL, excludes only the fingerprint metadata table, quotes every identifier, and issues one `TRUNCATE ... RESTART IDENTITY CASCADE`. The real Drizzle journal lives in its separate `drizzle` schema and is therefore outside the target set. A nonsensical current state with no business tables fails closed. Migration and fingerprint metadata remain intact.

The test database setup should:

- apply migrations before integration/API tests run,
- clean tables in dependency-safe order between suites or test files,
- seed only the fixtures required by the test,
- avoid relying on the normal demo seed unless the test is explicitly validating demo seed behavior.

Schema and seed verification belongs in the schema/seed test suite. API and reservation behavior should create the data it needs through test fixtures so failures remain easy to diagnose.

---

## Redis Reset and Fixtures

Redis integration tests should use the dedicated test Redis service and test-only keys.

The reset strategy should:

- flush only the package's own logical database (`FLUSHDB`), never the whole instance (`FLUSHALL`) — other packages run concurrently against their own logical databases (`pnpm test:infra:reset` is the only place `FLUSHALL` is allowed),
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

## CI Readiness

CI can be added after the local testing foundation exists, but the local design should not block it.

Expected future CI behavior:

- run `pnpm test:required` on every merge-bound push and pull request,
- run integration/API tests with service containers or compose-backed infrastructure,
- fail fast on the root production-plus-test-source type-check, lint, and contract/schema test failures,
- keep full load tests and benchmarks separate from regular correctness CI; the tiny k6 compatibility smoke remains part of the correctness gate.

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
- opt-in browser and deployed-topology characterization without slowing the default suite.
