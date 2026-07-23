# Task 28 — Separate preset and runtime-policy administration from run lifecycle

## Execution context

- **Execution order:** Task 28 of 45, in Phase 5 (repair ownership boundaries).
- **Dependencies:** Mutable runtime policy must already be separated from environment hard caps, and production interfaces must be required. Dashboard metrics and the traffic HTTP adapter must already have moved out of DemoRunService.
- **Standalone scope:** The requirements below remain authoritative if the audit is deleted. Recheck current file locations before implementation.
- **Primary ownership boundary:** API application services for demo-preset administration and public runtime-policy administration.
- **Working expectations:** Read working_docs/quality_checklists.md. Keep preset/policy workflows out of route and startup files, retain explicit persistence dependencies, and update service-level tests.

## Why this task exists

DemoRunService currently lists, saves, duplicates, copies, archives, and maps presets; reads and updates the public runtime policy; and also owns live run lifecycle. Preset catalog administration and deployment-bounded policy administration change for different reasons than starting or completing a run.

## Required outcome

Create focused application owners for preset administration and runtime-policy administration, with narrow route-facing interfaces. Leave the run lifecycle service responsible only for live run operations and the accepted immutable run configuration it receives.

## Scope and implementation guidance

- Move listPublicPresets, listAdminPresets, saveAdminPreset, duplicatePreset, copyPresetToCustom, archiveAdminPreset, preset row mappers, slug rules, archivable predicates, and editable-preset validation out of apps/api/src/services/demo-run-service.ts.
- Move getPublicRuntimePolicy, getAdminPublicRuntimePolicy, updateAdminPublicRuntimePolicy, policy hydration/DTO mapping, and policy-specific validation into a focused policy service.
- Keep the accepted configuration snapshot assembly at one clear boundary. A run must continue to persist the exact validated configuration used for execution.
- Split DemoRunController into route-facing preset, policy, and lifecycle interfaces. Update apps/api/src/routes/demo-run-routes.ts to receive the appropriate service explicitly without adding business decisions to the route.
- Keep PostgreSQL access behind the application service and shared schema/types in @checkout-surge/contracts and @checkout-surge/db.
- Refocus apps/api/test/demo-run-service.test.ts: move preset and policy cases into owner-specific suites, share only small public fixtures, and delete duplicated setup.

## Retained behavior and non-goals

- Preserve public/admin visibility, immutable system presets, editable Custom behavior, duplicate/copy/archive rules, historical preset references, and server-enforced caps.
- Preserve public run budgets and the distinction between admin and public starts.
- Do not redesign the preset product, create a generic CRUD framework, or combine unrelated policy and run repositories.
- Do not weaken route authentication, Origin/CSRF protection, or shared contract validation.

## Acceptance criteria

- [x] Run lifecycle code no longer implements preset CRUD/listing or runtime-policy persistence.
- [x] Preset and policy routes depend on narrow explicit application interfaces and stay thin.
- [x] Accepted run snapshots still contain the exact validated configuration and hard caps remain environment-authoritative.
- [x] Public/admin visibility, archival safeguards, policy mutation, and concurrency behavior remain covered at their new owners.
- [x] Moved helpers and obsolete DemoRunController methods are deleted rather than forwarded indefinitely.

## Verification

- Run the focused preset, runtime-policy, demo-run route, and run-lifecycle API tests.
- Run contract tests when route DTOs or service interfaces change.
- Run pnpm --filter api type-check, pnpm --filter @checkout-surge/contracts type-check, and pnpm type-check.
- Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit approval; both slow suites are outside this task's focused verification.

## Working record

- **Status:** complete
- **Completed scope:** Extracted preset catalog reads and administration into `DemoPresetService`, including active lookup, DTO mapping, slug normalization, editable/immutable rules, duplication/copy behavior, soft archival, and guarded archive concurrency. Extracted public runtime-policy reads, effective-policy hydration, DTO mapping, mutation validation/persistence, and startup validation into `PublicRuntimePolicyService`. Renamed and narrowed the remaining route-facing lifecycle boundary to `DemoRunLifecycleController`/`DemoRunLifecycleService`; lifecycle now receives only active-preset and effective-policy readers, while retaining visibility/override rules, public budgets, accepted snapshot assembly/validation, persistence, traffic completion, and reconciliation. Split route/server/composition dependencies into explicit preset, policy, and lifecycle owners. Refocused lifecycle tests and added owner-specific preset and policy suites plus three narrow route fixtures. Updated durable ownership documentation in `docs/repository_layout.md` and `docs/core_business_entities.md`.
- **Material decisions or deviations:** Kept accepted snapshot assembly and public/admin start rules in the lifecycle service because they are run-start decisions; the extracted services expose only the two minimal read capabilities needed there. Kept traffic-completion acceptance/finalization/reconciliation in the existing lifecycle owner to avoid Task 29. Shared wire DTOs were unchanged. Ran the existing contracts suite as regression evidence despite no schema change. No compatibility layer, generic repository/service framework, or forwarding methods were retained.
- **Verification performed:** Started and later removed dedicated test infrastructure with `pnpm test:infra:up` / `pnpm test:infra:down`. Passed `pnpm --filter api test:api test/demo-preset-service.test.ts --reporter=dot --silent=passed-only` (10 tests, including ordered active public/admin visibility, archived-list exclusion, repeat-archive rejection, and guarded archive races), `pnpm --filter api test:api test/public-runtime-policy-service.test.ts --reporter=dot --silent=passed-only` (8 tests, including automatic steady-arrival derived-VU cap rejection with unchanged persistence), `pnpm --filter api test:api test/demo-run-service.test.ts --silent=passed-only` (45 tests), and `pnpm --filter api test:api test/api.test.ts -t "demo|preset|runtime policy|traffic completion" --silent=passed-only` (14 focused route tests; 76 unrelated tests skipped). Passed `pnpm --filter @checkout-surge/contracts test` (109 tests), `pnpm --filter api type-check`, `pnpm --filter @checkout-surge/contracts type-check`, and `pnpm type-check` (all 11 workspace tasks plus test-source type-check). Passed focused `pnpm exec biome check` across all 11 changed supported TypeScript files and `git diff --check`.
- **Remaining blockers or follow-up:** None. Traffic-completion extraction/finalization ownership remains intentionally deferred to Task 29.
