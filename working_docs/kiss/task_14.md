# Task 14 — Persist only mutable runtime policy

## Execution context

Task 14 of 45, Phase 3. It requires task 09's disposable-data decision and task 12's single baseline migration to be complete. Amend that baseline in place; do not create a new compatibility migration. Primary ownership is the runtime-policy application service and persistence adapter; contracts define DTOs and environment configuration supplies immutable caps. Keep routes thin and keep configuration/client composition in runtime roots, per the checklist.

## Why

Environment hard caps are duplicated in PostgreSQL policy, then hydrated and overlaid at read time. That creates conflicting authorities and unnecessary migration/compatibility work.

## Required outcome

Persist only administrator-editable defaults and budgets in PostgreSQL. Environment configuration owns hard caps. At the API DTO/validation boundary, merge mutable stored policy with environment caps so clients see/enforce the effective policy. Remove cap persistence, hydration, and duplicate merge paths while preserving server-side enforcement and current admin edit semantics.

## Scope and concrete current paths

- `packages/db/src/schema.ts`, seed/migration baseline, runtime-policy persistence helpers, and DB tests.
- `packages/contracts/src/public-runtime-policy-validation.ts`, demo/load contracts, and contract tests.
- `apps/api/src/services/demo-run-service.ts`, `public-run-budget-store.ts`, policy routes/runtime config, `apps/api/src/index.ts`, and related API tests.
- DemoRun/preset policy paths, `.env.example`, setup docs, and web/admin callers where the DTO is consumed. Verify exact locations before editing.

## Retained behavior and non-goals

Keep server enforcement even if a client bypasses DTO validation; preserve authorized admin edits of mutable fields and deterministic defaults/seeding. Do not make environment caps admin editable, create another policy store, or change transport evidence/vocabulary beyond necessary contract references.

## Acceptance

- [ ] Database schema/seed contain only mutable policy values; no cap hydration or duplicated cap column remains.
- [ ] Environment configuration is the sole source of hard caps and is merged once at the DTO/validation boundary.
- [ ] API read/write semantics distinguish editable values from immutable effective caps.
- [ ] Demo run creation and administration enforce the effective policy server-side.
- [ ] Docs/examples and focused contract/API/DB tests describe the same ownership.

## Focused verification

Run `pnpm --filter @checkout-surge/contracts test:unit`, `pnpm --filter @checkout-surge/db test:unit`, `pnpm --filter api test:api`, and affected package type-checks. Run DB integration policy tests when persistence changes. Do not run composition or characterization suites.

## Working record

Pending — record each removed persisted cap, DTO merge location, migration/baseline outcome, verification results, and skipped checks.
