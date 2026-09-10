# Agent Quality Checklists

Use these checklists before and after implementation work. They translate the repo's general engineering standards into concrete rules that are easier to verify.

## Before Starting Work

- Read any domain or convention docs touched by the task
- Identify the intended ownership boundary before editing:
  - API route
  - application service
  - persistence adapter
  - shared contract
  - shared package
  - frontend component
- Identify the non-goals before coding. Do not implement adjacent future behavior unless the task explicitly asks for it.

## Architecture Checklist

- Keep HTTP routes thin: parse/validate input, call a service, choose HTTP status, send response.
- Put business workflows in application services, not route files or startup files.
- Keep infrastructure construction in composition roots only.
- Do not create module-level PostgreSQL, Redis, BullMQ, or HTTP clients inside route or service modules.
- Use explicit dependencies for app factories and services.
- Do not add queue, ERP, worker, or dashboard behavior to the API route layer.
- Prefer small functions with one clear responsibility over large orchestration blocks.
- Avoid broad rewrites while implementing a targeted feature.

## Package Boundary Checklist

- Keep shared packages focused:
  - `@checkout-surge/contracts` owns schemas and public types.
  - `@checkout-surge/db` owns schema, DB clients, Redis inventory helpers, seed/reset helpers.
  - `@checkout-surge/logger` owns logging and correlation ID helpers.

## API Checklist

- `apps/api/src/index.ts` should stay limited to startup and dependency composition.
- `buildApiServer()` should receive dependencies explicitly.
- Route modules should not directly call Redis, Drizzle, PostgreSQL clients, or BullMQ publishers.
- Reservation workflow changes belong in `ReserveOrderService`.
- Correlation IDs must continue to flow through responses, logs, and persisted records.
- API responses must be validated against shared contract schemas; skipping is acceptable for hot paths where validation cost matters.

## Testing Checklist

- Add or update tests at the same boundary where behavior changed.
- Prefer service-level tests for application workflow rules.
- Prefer contract tests for schema and vocabulary changes.
- Prefer integration tests for Redis, PostgreSQL, queue, and worker boundaries.
- Do not depend on another package's private test helpers; expose shared test helpers through a public testing entry point.
- If tests cannot be run, clearly state which tests were skipped and why.

## Final Self-Review Checklist

Before handing work back, verify:

- The change stayed inside the requested scope.
- The current phase boundary was respected.
- Routes/controllers stayed thin.
- Infrastructure clients were not created in the wrong layer.
- Shared package boundaries were respected.
- Contracts, implementation, and tests agree.
- Error and status vocabulary stayed consistent.
- Relevant tests were run, or skipped with a clear reason.
- Would a senior engineer say this is overcomplicated? If yes, simplify.
