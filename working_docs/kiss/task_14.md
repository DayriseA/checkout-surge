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

- [x] Database schema/seed contain only mutable policy values; no cap hydration or duplicated cap column remains.
- [x] Environment configuration is the sole source of hard caps and is merged once at the DTO/validation boundary.
- [x] API read/write semantics distinguish editable values from immutable effective caps.
- [x] Demo run creation and administration enforce the effective policy server-side.
- [x] Docs/examples and focused contract/API/DB tests describe the same ownership.

## Focused verification

Run `pnpm --filter @checkout-surge/contracts test:unit`, `pnpm --filter @checkout-surge/db test:unit`, `pnpm --filter api test:api`, and affected package type-checks. Run DB integration policy tests when persistence changes. Do not run composition or characterization suites.

## Working record

- Status: complete.
- Persisted shape: PostgreSQL now stores only `isPublicRunBudgetEnforced`, `publicRunBudget`, `publicCustomDefaults`, and `publicCustomLimits`. Removed the persisted `deploymentHardCaps` object and its seven fields: `maxBuyers`, `maxTotalRequests`, `maxRequestsPerSecond`, `maxTrafficDurationSeconds`, `maxTrafficStartDelaySeconds`, `maxPreAllocatedVus`, and `maxVus`. The Drizzle JSON type, deterministic seed, migration validation, typed-JSON round trip, and compile-time persistence boundary all use `PublicRuntimePolicyMutable`. Strict `publicRuntimePolicyPersistedSchema` validation retains intrinsic min/max and default-within-public-limit checks and rejects obsolete cap-bearing rows rather than translating them.
- Canonical effective policy: `resolveEffectivePublicRuntimePolicy` in `apps/api/src/services/demo-run-service.ts` is the sole merge/validation path. It strictly parses the persisted mutable structure, combines it with the `DeploymentHardCaps` passed from API runtime configuration, and parses the effective `PublicRuntimePolicy`. Persisted validation checks relationships before defaults against public limits only. Effective validation preserves the existing admin error priority: public-limit/deployment-cap violations, mutable relationships, default/deployment violations, then default/public-limit violations, with each default cause wrapped once. This includes deployment validation of automatically resolved steady-arrival VUs. Public/admin reads, admin updates, run starts, and startup validation all use this boundary. Effective response DTOs still include current environment caps, updates still accept only mutable fields, cap violations retain `DemoRunValidationError` vocabulary, and updates persist the mutable request only after effective validation. `PublicRunBudgetStore` now accepts only `PublicRunBudget`, the fields it consumes.
- Baseline/migration outcome: No SQL migration or baseline amendment was created. The physical column remains the same non-null `policy` JSONB column, so this is a strict TypeScript/runtime JSON-shape change under Tasks 09/12's disposable-data policy. The existing one-baseline migration remains unchanged; the migration runner now validates only intrinsic mutable-policy semantics because setup has no deployment-cap authority.
- Runtime setup and documentation: Removed all seven `DEMO_MAX_*` variables and the cap-mirroring comment from the Compose `runtime-setup` service. The API service and API environment examples retain those settings as the sole hard-cap source. Updated `.env.example` and five files under `docs/` (`architecture.md`, `runtime_topology.md`, `local_development.md`, `core_business_entities.md`, and `admin_access_protection.md`) to describe mutable PostgreSQL ownership, API-only caps, strict disposable-row rejection, and canonical effective DTO construction.
- Verification passed: `pnpm --filter @checkout-surge/contracts type-check`; `pnpm --filter @checkout-surge/contracts test:unit` (115 tests, including multiply-invalid persisted/effective ordering); `pnpm --filter @checkout-surge/db type-check` including the persistence boundary; `pnpm --filter @checkout-surge/db test:unit` (54 tests); `pnpm --filter @checkout-surge/db test:integration` (81 tests, run sequentially); `pnpm --filter @checkout-surge/db test:db:migrate`; `pnpm --filter api type-check`; focused `demo-run-service.test.ts` (74 tests, including effective automatic-VU validation and multiply-invalid first-error mapping); focused `api.test.ts` (83 tests); affected contracts/DB/API lint commands; focused Biome check; resolved Compose inspection showing `runtime-setup` has `PUBLIC_*` seed inputs and no `DEMO_MAX_*`; and `git diff --check`.
- Verification exceptions: The required full `pnpm --filter api test:api` was run earlier in the task after starting dedicated test infrastructure and passed 478 of 481 tests. Its only failures were the three unrelated uniqueness-race cases in `postgres-buy-persistence.test.ts`: their durable-winner fixtures intentionally differ in correlation/timestamps while the existing `isPersistedBuyForReservation` implementation requires exact equality. After the final validation-order correction, the affected policy/lifecycle file passed all 74 tests; the unchanged full suite was not rerun merely for ceremony. The API route file passed all 83 tests earlier in the task. `pnpm type-check:test` also remains red on three unrelated stale transport-shape fixtures in `demo-maintenance-service.test.ts` and `demo-run-finalization-service.test.ts`. Neither failing area is changed by Task 14. The initial API attempt without test infrastructure was interrupted after Redis connection refusals, then rerun with `pnpm test:infra:up`; the final focused rerun also used dedicated test infrastructure, and `pnpm test:infra:down` removed its containers and volumes. `pnpm test:composition` and `pnpm test:characterization` were not run by instruction.
- Follow-up boundary: Task 28 still owns extracting preset/runtime-policy administration from `DemoRunService`; this task added only the small pure effective-policy boundary needed to remove duplicate cap ownership and did not begin that broader service split.
