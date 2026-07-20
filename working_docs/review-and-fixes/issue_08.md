# Issue 08 — Mock ERP readiness reports healthy without its required PostgreSQL ledger

## Classification

- Priority: P2
- Status: Resolved — implemented and independently verified on 2026-07-20
- Affected path: Reference-runtime readiness, order confirmation, Compose dependency gating

## Issue observed

The mock ERP readiness response reports HTTP 200 with only `confirmation_endpoint_ready`, regardless of whether the PostgreSQL confirmation ledger is usable.

The production reference configuration uses `PostgresConfirmationLedger` for idempotent confirmation processing. Its database client connects lazily, so the mock ERP can bind its HTTP listener and report healthy while PostgreSQL is unavailable. The failure appears only when an order reaches the confirmation endpoint.

Compose also does not gate mock ERP startup/readiness on PostgreSQL health. As a result, the runtime can advertise a healthy downstream dependency while the core accepted-order path is guaranteed to fail at confirmation.

## How to reproduce

1. Start the mock ERP with its normal PostgreSQL ledger configuration.
2. Make PostgreSQL unavailable before the ledger has connected, or interrupt PostgreSQL after startup.
3. Call the mock ERP health endpoint.
4. Attempt an order confirmation.

Health remains `200` and reports the endpoint ready, while confirmation fails on ledger access.

## Identified cause

- The health route returns a constant successful check and has no injected dependency check (`apps/mock-erp/src/routes/health-routes.ts`).
- The runtime wires `PostgresConfirmationLedger` as a required production dependency (`apps/mock-erp/src/index.ts`, `apps/mock-erp/src/application/postgres-confirmation-ledger.ts`).
- PostgreSQL access is lazy, so successful process/listener startup does not validate ledger readiness.
- The mock ERP service lacks a healthy-PostgreSQL Compose dependency, and its current health check trusts the constant route (`docker-compose.yml`).

The readiness route therefore proves only that the HTTP confirmation endpoint was registered, while Compose and operators interpret it as dependency-aware readiness. A separate, cheap `/health/live` route already exists.

## Implemented resolution

- Mock ERP now receives an explicit readiness dependency while `/health/live` remains a cheap process/listener check.
- Healthy readiness reports both `confirmation_endpoint_ready=ok` and `confirmation_ledger_reachable=ok`.
- The PostgreSQL readiness adapter performs a bounded, cancellable, read-only query against the `erp_confirmation_results` relation used by the production ledger. It does not insert or update ledger data.
- `MOCK_ERP_READINESS_TIMEOUT_MS` configures the deadline, defaults to 2000ms, and must remain below the reference Compose healthcheck's 3-second timeout.
- Ledger failures and timeouts produce HTTP 503 with stable structured checks. Database URLs, credentials, and raw driver errors are not returned.
- Each readiness request performs a fresh probe, so readiness returns to HTTP 200 after PostgreSQL connectivity recovers.
- Reference Compose now gates Mock ERP creation on healthy PostgreSQL. The worker's existing `mock-erp: service_healthy` dependency therefore waits for ledger-aware readiness rather than listener-only health.
- Runtime health smoke requires the nested `confirmation_ledger_reachable` check, and the Compose contract test asserts both dependency gates.
- Confirmation processing and the PostgreSQL ledger's first-write-wins idempotency behavior were not changed.

## Recommended actions

1. Keep the existing process-liveness route cheap and make `/health/ready` dependency-aware.
2. Add an injected, bounded ledger/database readiness check. Keep the HTTP route thin and return a stable `503` payload when the required ledger cannot serve confirmations.
3. Avoid mutating ledger data during readiness; use a bounded connection/query check appropriate to the actual adapter.
4. Add PostgreSQL `service_healthy` gating for mock ERP in the reference Compose topology while retaining runtime readiness checks for later outages.
5. Extend health smoke assertions to validate the nested ledger check, not just HTTP 200.
6. Return safe structured errors without exposing connection strings, credentials, or raw driver messages.

## Acceptance criteria

- [x] Process liveness can remain `200` while the listener/event loop is alive.
- [x] Readiness returns `503` within a bounded time when the PostgreSQL ledger is unavailable.
- [x] Readiness automatically returns `200` after ledger connectivity recovers.
- [x] During initial Compose startup, the worker is not started until mock ERP ledger readiness is healthy.
- [x] A healthy readiness payload includes a successful ledger check, and smoke coverage asserts it.
- [x] Confirmation behavior and ledger idempotency are unchanged when PostgreSQL is healthy.

## Verification

Final implementation and independent review confirmed:

- Mock ERP unit suite: 65 tests passed, including healthy, unavailable, sanitized, bounded-timeout, liveness, and recovery readiness behavior.
- Mock ERP PostgreSQL integration suite: 5 tests passed, including the non-mutating relation probe and existing replay, conflict, concurrency, and retry behavior.
- Runtime image/Compose contract tests passed with assertions for PostgreSQL-to-Mock-ERP gating, Mock-ERP-to-worker gating, and the required nested smoke check.
- Mock ERP type-check, lint, and production build passed.
- Targeted Biome checks, `docker compose config --quiet`, and `git diff --check` passed.
- Dedicated PostgreSQL/Redis test infrastructure started successfully for integration verification and was removed afterward.

The full running-runtime smoke was not executed because the reference runtime was not started. The prohibited composition and characterization suites were not run. The repository-wide test type-check still reports unrelated pre-existing API/database test typing failures; none reference the changed Mock ERP files.

## Scope guard

This makes existing runtime health signaling truthful. It does not require a general service-discovery system or additional mock ERP features.
