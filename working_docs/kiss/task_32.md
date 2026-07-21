# Task 32 — Move readiness implementations out of the API composition root

## Execution context

- **Execution order:** Task 32 of 45, in Phase 5 (repair ownership boundaries).
- **Dependencies:** Per-operation resource factories and cleanup semantics must already be extracted from apps/api/src/index.ts.
- **Standalone scope:** This document carries the full requirement if the audit is removed. Confirm current readiness symbols and configuration before editing.
- **Primary ownership boundary:** API runtime readiness implementation; the health route remains an HTTP adapter and index.ts remains composition.
- **Working expectations:** Read working_docs/quality_checklists.md. Keep infrastructure probes bounded, construct their clients through runtime/composition factories, and keep route behavior contract-validated.

## Why this task exists

The API composition root currently contains concrete PostgreSQL, Redis, and BullMQ readiness checks and their cancellation/disconnection mechanics. This obscures startup wiring and makes readiness policy difficult to test without assembling the application entry point.

## Required outcome

Place concrete bounded readiness checks in apps/api/src/runtime/readiness.ts or focused sibling modules. Construct one ApiReadiness implementation in composition and inject it into the health route/server. index.ts should supply configuration and factories, not implement the probes.

## Scope and implementation guidance

- Move PostgreSQL, Redis, and order-queue readiness implementations and their stable failure mapping out of apps/api/src/index.ts.
- Preserve concurrent dependency checks under one configured API_READINESS_TIMEOUT_MS deadline and the current HTTP 200/503 contract.
- Use operation-owned resources so a timeout cancels active or queued PostgreSQL work and disconnects readiness-owned Redis/BullMQ connections.
- Preserve single-flight behavior per API process if it is still required by the accepted local topology; do not add distributed coordination.
- Keep liveness cheap and separate from readiness.
- Update apps/api/src/routes/health-routes.ts or server registration only to receive the completed readiness dependency.
- Consolidate apps/api/test/readiness.test.ts around the runtime owner, and keep route tests focused on HTTP mapping.

## Retained behavior and non-goals

- Retain stable, sanitized readiness messages and correlation handling; never expose URLs, credentials, or driver errors.
- Preserve the Compose healthcheck time budget and recovery on a later fresh request.
- Do not make health probes perform dashboard recovery, business reads, migrations, or mutation.
- Do not create clients in the health route or readiness application logic.
- Do not alter worker, load-orchestrator, web, or mock-ERP readiness except for shared documentation that must remain accurate.

## Acceptance criteria

- [ ] apps/api/src/index.ts contains no concrete query, Redis PING, BullMQ probe, timeout race, or readiness result mapping.
- [ ] One focused runtime implementation owns bounded concurrent checks and cleanup.
- [ ] The health route remains a thin adapter over ApiReadiness.
- [ ] Hung, queued, rejected, successful, concurrent, and recovery-on-next-request cases remain tested.
- [ ] Readiness resources cannot survive their deadline or server shutdown.

## Verification

- Run apps/api/test/readiness.test.ts, health/API route coverage, operation-lifecycle tests, and resource cleanup tests.
- Run pnpm --filter api type-check and pnpm type-check.
- Validate any changed Compose healthcheck configuration with docker compose config; this is configuration validation, not the prohibited composition suite.
- Do not run pnpm test:composition or pnpm test:characterization without explicit permission.

## Working record

- **Status:** pending
- **Completed scope:** none
- **Material decisions or deviations:** none
- **Verification performed:** not run
- **Remaining blockers or follow-up:** none
