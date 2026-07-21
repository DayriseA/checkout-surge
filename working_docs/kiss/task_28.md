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

- [ ] Run lifecycle code no longer implements preset CRUD/listing or runtime-policy persistence.
- [ ] Preset and policy routes depend on narrow explicit application interfaces and stay thin.
- [ ] Accepted run snapshots still contain the exact validated configuration and hard caps remain environment-authoritative.
- [ ] Public/admin visibility, archival safeguards, policy mutation, and concurrency behavior remain covered at their new owners.
- [ ] Moved helpers and obsolete DemoRunController methods are deleted rather than forwarded indefinitely.

## Verification

- Run the focused preset, runtime-policy, demo-run route, and run-lifecycle API tests.
- Run contract tests when route DTOs or service interfaces change.
- Run pnpm --filter api type-check, pnpm --filter @checkout-surge/contracts type-check, and pnpm type-check.
- Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit approval; both slow suites are outside this task's focused verification.

## Working record

- **Status:** pending
- **Completed scope:** none
- **Material decisions or deviations:** none
- **Verification performed:** not run
- **Remaining blockers or follow-up:** none
