# Task 16 — Converge outcome and error vocabulary

## Execution context

Task 16 of 45, Phase 3. Primary ownership is `@checkout-surge/contracts` for public schemas/types and API runtime error handling for error/correlation vocabulary. DB enum/schema and worker/web are consumers. Follow the checklist: preserve thin routes, use services for workflows, and change every producer/consumer with a vocabulary cutover.

## Why

Overlapping buy outcomes, mechanical error-code variants, and single-value enums/tables make callers translate distinctions that do not change behavior, HTTP status, or UI.

## Required outcome

Audit contract buy/error/lifecycle/dashboard vocabularies, API runtime errors/routes/services, DB enums, worker, and web. Retain only values that alter behavior, status, operator meaning, or UI. Remove mechanical duplicate codes, overlapping outcome names, and single-value enum/table machinery where a plain invariant/literal is clearer. API owns error and correlation vocabulary; update all producers, consumers, tests, and docs together.

## Scope and concrete current paths

- `packages/contracts/src/buy.ts`, `error.ts`, `lifecycle.ts`, `dashboard-events.ts`, `entities.ts`, `demo.ts`, index exports, and vocabulary tests.
- `apps/api/src/runtime/errors.ts`, routes/services, correlation plumbing, and API tests.
- `packages/db/src/schema.ts`, Drizzle baseline/meta, vocabulary-parity tests; `apps/load-orchestrator/src/` outcome/error producers and tests; worker outcome/error producers and web displays/tests.

## Retained behavior and non-goals

Do not collapse correctness failures, authorization/validation distinctions, retry decisions, correlation IDs, or UI states that are materially different. This is not permission to alter transport accounting (task 15), load-process lifecycle or completion-redelivery ownership (tasks 33–34), or database invariants (task 17). Prefer explicit literal invariants only when the removed enum/table had one possible value.

## Acceptance

- [ ] Each retained value has a documented behavior/status/UI consequence and one canonical owner.
- [ ] Duplicate/overlapping values and single-value machinery are removed from contracts, API and load-orchestrator runtime, DB, worker, web, docs, and tests.
- [ ] API errors retain stable correlation behavior and routes only map validated service failures to HTTP responses.
- [ ] DB constraints and contract validators use the reduced vocabulary consistently.
- [ ] Focused tests distinguish retained correctness failures rather than merely snapshotting renamed strings.

## Focused verification

Run `pnpm --filter @checkout-surge/contracts test:unit`, `pnpm --filter @checkout-surge/db test:unit`, `pnpm --filter api test:api`, worker/web affected tests, and package type-checks. Run DB integration tests if enum/schema changes. Do not run composition or characterization suites.

## Working record

Pending — record the retained vocabulary matrix, removed terms and replacements, API status/correlation checks, migration/baseline work, and verification results.
