# Task 23: Validate seeded runtime policy through the shared contract (and make reruns repair bad rows)

## Execution context

- **Execution order:** This is task 23 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1
- **Area:** database / seed / config
- **Source:** independent review (medium)
- **Solved elsewhere:** No donor checkout is required. The current branch's admin-update path already contains the required cross-field rules; the standalone reuse and seed-repair map is below.
- **Locations:** `packages/db/src/scripts/seed.ts:32`, `packages/db/src/scripts/env.ts:11`, `packages/db/src/scripts/seed.ts:146`

The seed writes policy JSON without shared-contract parsing or the cross-field validation used by admin updates; env parsing accepts partial, decimal, zero, and negative values; and the insert's conflict-do-nothing behavior means a corrected rerun never repairs a bad row. Setup can succeed while later policy reads fail schema parsing or the displayed default run is rejected.

## Standalone implementation context

### Current seed path and failure modes

- `packages/db/src/scripts/seed.ts` is the only seed entry point. It reads `DATABASE_URL` and `REDIS_URL`, opens a one-connection PostgreSQL client, seeds all PostgreSQL rows inside one transaction, then reads the baseline sale offer and initializes its Redis inventory. Any runtime-policy validation must happen before the policy write (and preferably before starting the transaction's mutations), so a bad environment fails setup and the PostgreSQL transaction cannot partially commit; Redis is already reached only after the PostgreSQL transaction succeeds.
- `buildPublicRuntimePolicy()` currently returns the unvalidated storage-oriented `JsonRecord`. It composes `publicCustomDefaults` through `buyerSpikeTraffic()`, `inventoryConfig()`, `erpConfig()`, and `backpressureConfig()`, then adds the public budget, public-custom limits, and deployment hard caps. Change this boundary to build and return the shared `PublicRuntimePolicy` (or immediately parse its object before returning) with `publicRuntimePolicySchema` from `@checkout-surge/contracts`. `@checkout-surge/db` already declares `@checkout-surge/contracts` as a production dependency, so this respects the package boundary; do not import anything from `apps/api` into the DB package.
- The nested defaults are also covered by the shared contract: `acceptedRunConfigSnapshotSchema` in `packages/contracts/src/load.ts` validates the traffic, inventory, ERP, and backpressure objects. In particular, positive/nonnegative integers, ERP `errorRate` in `[0, 1]`, the literal queue names, and the two traffic-mode shapes must all remain valid. The outer schemas are `publicRunBudgetSchema`, `publicCustomLimitsSchema`, `deploymentHardCapsSchema`, `publicRuntimePolicyMutableSchema`, and `publicRuntimePolicySchema` in `packages/contracts/src/demo.ts`.
- `packages/db/src/scripts/env.ts` currently uses `Number.parseInt()` and `Number.parseFloat()`. Those accept prefixes such as `"10.5" -> 10`, `"10oops" -> 10`, or `"0.25oops" -> 0.25`; integers also pass through zero and negatives. Parse the complete trimmed string (for example, `Number(value)` followed by `Number.isFinite()` and `Number.isInteger()` for integer settings), then let the field's shared schema enforce positive versus nonnegative and percentage bounds, or introduce explicitly named positive/nonnegative/unit-interval helpers. Do not globally reject zero: `startDelaySeconds`, ERP latency, and error-rate fields legitimately allow it. Errors should identify the environment variable and fail the seed rather than silently falling back.
- The singleton insert at the end of the transaction currently writes `{ id: "active", policy: buildPublicRuntimePolicy(), createdAt: now, updatedAt: now }` and uses `onConflictDoNothing({ target: publicRuntimePolicies.id })`. Replace that with an upsert which writes the already-validated policy on conflict and advances `updatedAt` while preserving the original `createdAt`. This makes an explicit seed rerun repair an existing malformed/stale `active` row. The table and singleton constraint are `publicRuntimePolicies` in `packages/db/src/schema.ts` and `public_runtime_policies` in `packages/db/drizzle/0000_initial_schema.sql`.

### Reuse the existing semantic validation without a dependency inversion

`publicRuntimePolicySchema` currently checks the shape and each field independently, but the complete policy also has relationships between fields. The existing authoritative behavior is `validatePublicRuntimePolicyUpdate()` in `apps/api/src/services/demo-run-service.ts`, which calls `validateAcceptedRunSnapshot()` for the default run. Preserve all of these rules:

1. Public-custom `maxTotalRequests`, `maxRequestsPerSecond`, `maxTrafficDurationSeconds`, `maxTrafficStartDelaySeconds`, `maxBuyers`, `maxPreAllocatedVus`, and `maxVus` cannot exceed their corresponding `deploymentHardCaps` values.
2. `publicCustomLimits.minErpMaxTps` cannot exceed `maxErpMaxTps`, and `maxPreAllocatedVus` cannot exceed `maxVus`.
3. `publicCustomDefaults` must fit both the deployment caps and public-custom limits. Planned requests are `buyerCount * (duplicateEachBuyerAttempt ? 2 : 1)` for buyer-spike and `ratePerSecond * durationSeconds` for steady-arrival. Buyer-spike request rate is `ceil(buyerCount / max(maxDurationSeconds, 1))`; steady-arrival uses `ratePerSecond`. Validate duration, start delay, allowed traffic mode, starting stock, ERP latency/TPS/error rate/forced outage, buyer count, and steady-arrival VU values exactly as `validateAcceptedRunSnapshot(..., { operatorMode: "public", enforcePublicCustomLimits: true })` does today.

Do not copy these comparisons into `seed.ts`, and do not make the DB package depend on the API application service. Extract the pure policy-invariant calculation to the shared-contract package (the package that already owns the policy schema and public types), then have both the schema/seed boundary and the API's domain-error adapter consume that one result. A practical shape is a shared refinement or pure violation collector carrying a stable `{ code, message, details, path }`; `publicRuntimePolicySchema` can consume it as Zod issues, while `validatePublicRuntimePolicyUpdate()` translates the same first violation into `DemoRunValidationError`. This keeps contract validity shared and leaves HTTP/application error ownership in the API.

Preserve the current admin-update error vocabulary and status behavior. The cap violations use:

- `public_limit_total_requests_exceeds_deployment_cap`
- `public_limit_request_rate_exceeds_deployment_cap`
- `public_limit_duration_exceeds_deployment_cap`
- `public_limit_start_delay_exceeds_deployment_cap`
- `public_limit_buyers_exceeds_deployment_cap`
- `public_limit_preallocated_vus_exceeds_deployment_cap`
- `public_limit_max_vus_exceeds_deployment_cap`

The two direct relationship errors are `public_erp_tps_limit_invalid` (including `minErpMaxTps` and `maxErpMaxTps` details) and `public_vus_limit_invalid` (including `maxPreAllocatedVus` and `maxVus`). A default-run violation remains wrapped as `public_custom_default_${causeCode}`, with message `Public custom defaults must fit within the active public runtime policy.` and the cause details. `mapDemoRunError()` in `apps/api/src/routes/demo-run-routes.ts` maps these `DemoRunValidationError`s to HTTP 400. Do not accidentally turn existing semantic admin failures into the generic `ZodError`/`invalid_request` response emitted by `apps/api/src/server.ts`; structural request failures should continue to use that generic contract-error path.

For the seed there is no HTTP vocabulary. Surface the shared parse/refinement failure as a startup error with enough path/code information to identify the bad environment setting. A validation failure must happen before the upsert, not be stored for a later API read to discover.

### Persistence semantics, defaults, and compatibility

- No database migration is required. The singleton check already enforces only `id = 'active'`; the policy remains JSONB and its semantic validity is enforced at application/seed boundaries.
- Normal runtime ownership does not change: the protected API remains the only path that edits public budgets, defaults, and custom limits during operation, and it continues preserving the stored deployment hard caps on an admin update. The seed is the explicit bootstrap/reset path described in `docs/admin_access_protection.md` and `working_docs/project_planning.md`.
- Because the seed rerun becomes an upsert, it intentionally replaces all policy JSON—including admin-edited mutable values—with the environment-backed seeded baseline. This is what lets it repair malformed rows and apply corrected seed/environment values. Preserve `createdAt`, update `updatedAt`, and document/cover this reset behavior rather than pretending the seed is a no-op on an existing valid policy.
- The checked-in fallback values already form a valid policy: a 300-second budget window with visitor/global start counts 2/6; buyer-spike defaults of 500 buyers over 10 seconds with stock 100 and ERP 100 ms/100 TPS/0 error; public limits of 10,000 requests/buyers, 1,000 requests/s and VUs, 120 seconds, 10 seconds start delay, stock 1,000, ERP latency 2,000 ms/TPS 1..100/error 0.25; and deployment caps of 100,000 requests/buyers, 10,000 requests/s and VUs, 300 seconds, and 30 seconds start delay. Keep these defaults unless a separate task explicitly changes product policy.
- Invalid existing JSON is repaired only by a successful rerun with a valid newly built policy. If new environment values are invalid, the transaction must fail and leave the previously committed row untouched.

### Focused verification

- Extend `packages/contracts/test/contracts.test.ts` at the policy-contract boundary to cover the semantic refinement, not only the current happy shape and empty `allowedTrafficModes` case. Include at least: a public limit above a deployment cap; ERP minimum above maximum; preallocated VUs above max VUs; and a structurally valid default run that violates one of the updated public limits. Assert stable issue paths/codes if the shared validator exposes them.
- Extend `packages/db/test/integration/db.integration.test.ts`. Its existing `runSeedScript()` executes `src/scripts/seed.ts` twice and only asserts that `publicRuntimePolicySchema.parse(policyRow.policy)` succeeds. Let the helper accept environment overrides, corrupt or replace the existing `active` policy row between runs, rerun the seed, and assert that exactly one row remains and its policy is the validated seeded baseline with a newer `updated_at` and unchanged `created_at`. Also prove an invalid override (for example a partial integer, a public limit above its deployment cap, or a public limit below the seeded default) makes the seed subprocess reject and does not commit that invalid policy.
- Retain/update `apps/api/test/demo-run-service.test.ts` assertions that admin updates over deployment caps and defaults outside public limits throw `DemoRunValidationError`, including the existing persisted-row-is-unchanged check and stable error code `public_limit_total_requests_exceeds_deployment_cap`. This guards the adapter while the invariant moves to shared code.
- Run the focused contracts, DB integration, and API service tests plus the affected packages' type-check/lint commands. The DB integration suite requires its configured PostgreSQL and Redis test services; if unavailable, report that explicitly rather than substituting a shape-only test.

### Non-goals

- Do not move runtime-policy administration into the DB package, import API services from the seed, add route/web behavior, or redesign the public policy vocabulary.
- Do not add a PostgreSQL JSON CHECK constraint or migration, validate every unrelated seeded preset as part of this task, or change the normal admin rule that deployment hard caps are read-only.
- Do not broaden this into Task 24's compose/runtime-setup environment wiring and service-startup configuration audit. This task makes the seed's inputs strict and its persisted policy valid/repairable; it does not decide which deployment service receives each environment variable.

## Implementation record

- **Status:** Complete.
- **Completed scope:** Moved accepted-run and complete-policy invariant calculation into pure shared-contract violation collectors in the focused `public-runtime-policy-validation.ts` module; refined `publicRuntimePolicySchema` with the shared results; adapted API validation to preserve the existing `DemoRunValidationError` codes, messages, details, and validation-before-persistence behavior; made numeric seed environment parsing strict, including explicitly empty and whitespace-only values; validated the assembled policy before opening the database connection; changed the active singleton write to a full policy upsert that preserves `createdAt` and advances `updatedAt`; retained preset JSONB backfill behavior while removing the superseded runtime-policy preservation backfill; and documented explicit setup/reseed reset semantics.
- **Decisions:** Shared violations carry stable application codes, messages, details, and field paths. The dedicated validation module uses type-only imports for policy/run shapes, while `demo.ts` retains schema ownership and refinement wiring without a runtime cycle. Zod issues remain standard custom issues and include the shared violation code/details in issue parameters. Admin updates assemble and validate the semantic policy through the domain-error adapter before the refined schema parse so semantic failures do not become generic request errors.
- **Deviations:** None from Task 23. Task 24 still states that setup should preserve conflict-do-nothing behavior and admin-edited policy values; that future-task text conflicts with Task 23's explicit full-reset/upsert requirement and must be reconciled before Task 24 implementation.
- **Verification:** Contracts build, type-check, lint, and unit suite passed (43 tests). The DB build refreshed ignored generated package output; DB type-check and lint passed. Focused API service tests passed (3 selected, including unchanged persistence), and API type-check/lint passed against the rebuilt shared package. Focused DB integration tests passed against PostgreSQL and Redis (3 selected: repair/reset, strict invalid/empty-input no-commit behavior, and preset-backfill/policy-reset behavior). `git diff --check` passed.
- **Blockers:** None.
