# Task 17 — Reduce database validation to declarative invariant core

## Execution context

Task 17 of 45, Phase 3, applying decision D4 after task 12's single migration baseline and task 16's vocabulary cutover. Primary ownership is `@checkout-surge/db`: schema and migrations enforce durable structural invariants; application services retain workflow validation. Amend the post-squash baseline in place; do not add a legacy upgrade path. This record is standalone and requires the checklist's DB boundary/testing rules, not route-level validation substitutes.

## Why

Procedural triggers duplicate service checks, re-query relationships keys could encode, and defend against writers outside the accepted application topology. They add opaque failure paths and migration complexity.

## Required outcome

Keep primary/foreign keys, uniqueness, the single-nonterminal-run invariant, and understandable row-local quantity/window/state checks. Prefer composite keys and foreign keys for ownership/attribution. Remove triggers that duplicate service validation, re-query key relationships, or protect against impossible writers. Retain a trigger only when a required invariant cannot be expressed clearly as a key/check and cannot safely belong to the single application owner; document that reason beside it.

## Scope and concrete current paths

- `packages/db/src/schema.ts`, `packages/db/drizzle/` baseline and `meta/` snapshots/journal.
- The post-task-12 baseline's current trigger definitions and migration metadata tests.
- DB integration/migration tests, API persistence code only where a deleted trigger revealed an actual service-owned check, and schema documentation.

## Retained behavior and non-goals

Do not remove no-oversell protections, durable business constraints, lifecycle correctness, or single-active-run protection. Do not replace deleted triggers with a generalized validation framework or reimplement DB constraints in routes. Task 12 controls the baseline form; task 16 controls vocabulary reduction.

## Acceptance

- [ ] The baseline has PK/FK/unique constraints, one nonterminal run, and necessary row-local checks.
- [ ] Ownership/attribution uses composite keys/FKs where feasible instead of procedural relationship lookups.
- [ ] Every retained trigger has a concise required-invariant rationale and focused test.
- [ ] Removed trigger tests are replaced only by tests for retained observable invariants or service-owned validation.
- [ ] Migration/integration tests prove both valid writes and representative rejected invariant violations.

## Focused verification

Run `pnpm --filter @checkout-surge/db test:unit`, `pnpm --filter @checkout-surge/db test:db:migrate`, DB integration tests, affected API persistence tests, and DB/API type-checks. Do not run composition or characterization suites.

## Working record

Pending — inventory each trigger as retained/removed with rationale, list declarative replacement constraints, baseline/meta changes, tests run, and skipped checks.
