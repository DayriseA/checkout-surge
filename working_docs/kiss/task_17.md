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

- [x] The baseline has PK/FK/unique constraints, one nonterminal run, and necessary row-local checks.
- [x] Ownership/attribution uses composite keys/FKs where feasible instead of procedural relationship lookups.
- [x] No trigger was retained; the inventory documents why every prior mechanism is unnecessary.
- [x] Removed trigger tests were replaced only by tests for retained observable invariants or service-owned validation.
- [x] Migration/integration tests prove both valid writes and representative rejected invariant violations.

## Focused verification

Run `pnpm --filter @checkout-surge/db test:unit`, `pnpm --filter @checkout-surge/db test:db:migrate`, DB integration tests, affected API persistence tests, and DB/API type-checks. Do not run composition or characterization suites.

## Working record

### Trigger inventory and decision

The Task 16 baseline started with 9 trigger functions and 22 non-internal triggers. Task 17 retains none: every durable invariant in scope is clearer as a key, foreign key, unique/index, or row-local check, while remaining workflow validation already has one application owner.

| Baseline trigger | Decision | Concrete rationale or replacement |
| --- | --- | --- |
| `orders_enforce_backing_reservation` | Removed | `orders_backing_reservation_fk` binds reservation ID, sale offer, correlation ID, and quantity. Its former nullable-run comparison is application-owned: `PostgresBuyPersistence` validates run/sale under the run lock and constructs the reservation and order from the same secured hold. |
| `reservations_preserve_order_backing_reservation` | Removed | The composite FK rejects changes to its referenced offer/correlation/quantity identity. It does not watch nullable run attribution; production never mutates reservation identity after `PostgresBuyPersistence` constructs it from the validated hold. |
| `erp_attempts_enforce_order_attribution` | Removed | `erp_attempts_order_correlation_fk` binds order/correlation. Before the handler reaches ERP-attempt persistence, transition persistence locks the order and validates the complete delivered identity, including nullable run; the ERP writer consumes that already-validated job. |
| `order_events_enforce_parent_attribution` | Removed | API/worker adapters construct events from freshly inserted or locked parents. Ordinary nullable parent FKs preserve `ON DELETE SET NULL`; a wider composite FK would contort those history semantics. |
| `orders_preserve_child_attribution` | Removed | Production does not mutate order identity, including nullable run attribution. ERP and notification children have composite parent FKs for the fields they structurally carry; event construction remains service-owned. |
| `reservations_preserve_event_attribution` | Removed | Production does not mutate reservation identity, including nullable run attribution. Event construction remains service-owned, and the order backing FK protects the referenced offer/correlation/quantity identity. |
| `products_set_updated_at` | Removed | Products have no production update path; seed writes timestamps explicitly. |
| `sale_offers_set_updated_at` | Removed | Generated/catalog offer construction writes timestamps explicitly; no production update relies on an implicit bump. |
| `demo_presets_set_updated_at` | Removed | Seed and preset create/save/archive paths explicitly write `updatedAt`. |
| `demo_runs_set_updated_at` | Removed | Traffic-start, completion, and terminal transition paths explicitly write `updatedAt`. |
| `demo_run_sale_contexts_set_updated_at` | Removed | Context creation writes timestamps explicitly and contexts have no production update workflow. |
| `reservations_set_updated_at` | Removed | Reservation creation writes the durable fact; no production update path relies on an implicit bump. |
| `orders_set_updated_at` | Removed | Worker processing/confirmed/failed transitions explicitly write `updatedAt`. |
| `reservation_pending_persistence_set_updated_at` | Removed | Upsert and reconciliation paths explicitly write `updatedAt`. |
| `demo_run_finalizations_set_updated_at` | Removed | Completion creation and enrichment compare-and-set explicitly write `updatedAt`. |
| `public_runtime_policies_set_updated_at` | Removed | Policy update and seed/bootstrap paths explicitly write `updatedAt`. |
| `demo_run_sale_contexts_enforce_offer_purpose` | Removed | The single run-creation transaction creates the offer with `purpose = generated_run` and immediately binds it; guarding hypothetical outside writers is outside the accepted topology. |
| `reservations_enforce_run_owned_sale_offer_attribution` | Removed | `reservations_run_sale_context_fk` binds every non-null run/sale pair to `demo_run_sale_contexts`. `MATCH SIMPLE` skips the pair when `runId` is null, so preventing a generated offer from losing run attribution is owned by `PostgresBuyPersistence`. |
| `orders_enforce_run_owned_sale_offer_attribution` | Removed | `orders_run_sale_context_fk` provides the declarative ownership pair. |
| `rpp_enforce_run_sale_attribution` | Removed | `reservation_pending_persistence_run_sale_context_fk` provides the declarative ownership pair. |
| `order_events_enforce_run_owned_sale_offer_attribution` | Removed | `order_events_run_sale_context_fk` provides the declarative ownership pair. |
| `sim_notifications_enforce_run_sale_attribution` | Removed | `simulated_notifications_run_sale_context_fk` provides the declarative ownership pair. |

The removed functions were `enforce_order_backing_reservation`, `preserve_order_backing_reservation`, `enforce_erp_attempt_order_attribution`, `enforce_order_event_parent_attribution`, `preserve_order_child_attribution`, `preserve_reservation_only_event_attribution`, `set_updated_at`, `enforce_demo_run_sale_context_offer_purpose`, and `enforce_run_owned_sale_offer_attribution`. No replacement trigger function or compatibility alias was added.

### Declarative invariant core

- Existing PKs, ordinary FKs, uniqueness, positive/nonnegative quantity checks, valid sale windows, lifecycle/timestamp checks, terminal-summary status, policy singleton, and the constant-expression partial unique index for one nonterminal run remain.
- `demo_run_sale_contexts_run_sale_offer_demo_runs_fk` continues to bind the non-null context pair to the run's unique `(id, saleOfferId)` pair.
- New composite context FKs bind non-null `(runId, saleOfferId)` pairs on reservations, orders, pending persistence, order events, and simulated notifications to `demo_run_sale_contexts`. With PostgreSQL's default `MATCH SIMPLE`, a null `runId` skips that structural check regardless of sale purpose; selecting nullable catalog attribution and preventing a generated offer from losing its run attribution remain service-owned.
- `orders_backing_reservation_fk` plus `reservations_backing_order_identity_unique` express the durable order/reservation offer, correlation, and quantity identity without relationship lookup code.
- `erp_attempts_order_correlation_fk` and `simulated_notifications_order_attribution_fk` express parent attribution that fits cleanly with their cascade semantics.
- The Redis atomic reservation path and its concurrent no-oversell integration coverage are unchanged; Task 17 adds no PostgreSQL stock counter or second oversell authority.

### Application ownership confirmation

- `PostgresBuyPersistence` validates generated run/sale ownership and admissible lifecycle under the run lock, builds reservation/order/events from one secured hold, and explicitly updates pending-persistence timestamps.
- `DemoRunService.createAcceptedRun` creates the `generated_run` offer, run, and context in one transaction and writes timestamps explicitly.
- `OrderProcessJobHandler` first calls transition persistence, which locks the durable order and validates the complete delivered job identity; ERP-attempt persistence later consumes that already-validated job and constructs its event. Notification persistence independently locks and validates its order before constructing the notification and event. Order transitions explicitly write `updatedAt`.
- Completion enrichment, run lifecycle transitions, preset mutations, runtime-policy mutations, and seed repair paths explicitly write `updatedAt`. No route gained database validation and no generalized validator was introduced.

### Baseline, metadata, tests, and documentation

- Regenerated and reviewed the disposable `0000_baseline.sql`, `0000_snapshot.json`, and one-entry journal as one empty-database final state. The only snapshot-invisible custom objects are `pgcrypto` and the documented one-nonterminal-run expression index; the baseline contains no trigger functions or non-internal triggers.
- Updated schema/integration tests to assert the declarative constraint set, valid writes, representative FK/check/unique violations, nullable event-link delete behavior, and concurrent single-run/no-oversell behavior. Deleted tests that existed only to pin trigger mechanics.
- Updated architecture, entity, local-development, and repository-layout documentation to describe the declarative DB core and application-owned workflow checks.

### Verification record

- `pnpm --filter @checkout-surge/db test:unit` — passed, 49 tests in 7 files.
- `pnpm --filter @checkout-surge/db test:db:migrate` — passed after starting the isolated test services. The first attempt was infrastructure-only `ECONNREFUSED`; a subsequent schema attempt exposed generated unique-index ordering and was corrected before the passing run.
- `pnpm --filter @checkout-surge/db test:integration` — passed, 73 tests in 5 files. This includes fresh-schema/custom-object inspection, valid and rejected declarative writes, single-nonterminal-run concurrency, and the unchanged concurrent no-oversell case.
- `pnpm exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.integration.config.ts test/integration/order-processing-workflow.test.ts` from `apps/worker` — passed, 21 tests. This covers the service-owned order/job identity checks and durable order/event/ERP/notification paths.
- `pnpm --filter @checkout-surge/db type-check`, `pnpm --filter api type-check`, and `pnpm --filter worker type-check` — passed.
- `pnpm lint` — passed across 397 files. Changed-file `pnpm exec biome check ...` passed across the 7 changed TypeScript/config/metadata files after applying formatting. `git diff --check` passed.
- Focused API persistence evidence: the exact `postgres-buy-persistence.test.ts` run passed 9 of 12 tests and reproduced only the three documented pre-existing Task 16 uniqueness-race fake failures (`reservations_pkey`, `reservations_reservation_token_unique`, and the wrapped-cause case). An earlier argument form ran the full API suite: 483 of 486 passed with the same three failures and no Task 17 regression. Per instruction, this unrelated issue was isolated and not weakened or expanded into Task 17.
- The isolated PostgreSQL/Redis test services and generated temporary baseline backup were removed after verification.
- `pnpm test:composition` and `pnpm test:characterization` were not run by instruction.
