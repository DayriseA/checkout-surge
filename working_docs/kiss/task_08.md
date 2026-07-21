# Task 08 — Deduplicate exact projection and status helpers

## Execution context

Task 8 of 45. Phase 1: remove unambiguous residue. Primary ownership boundary: canonical, equivalent snapshot/status mapping helper at the smallest shared owning module. Dependencies: task 07 should first narrow impossible fallback contracts; later dashboard redesign remains out of scope. This record is standalone. Follow the quality checklist: shared packages stay focused, public/admin semantics remain deliberate, and tests cover the shared behavior rather than copies.

## Why this task exists

Demo-run, finalization, maintenance, and recovery areas contain equivalent projection/status mapping and synthetic-summary helpers. Repeated mappings create multiple authorities for the same exact output and tests that only pin copies.

## Required outcome

Centralize only byte-for-byte or demonstrably equivalent snapshot/status mappings and synthetic summary helpers across demo-run, finalization, maintenance, and recovery. Delete duplicate implementations and tests whose only purpose was pinning a copy.

## Scope and implementation guidance

Verify paths before editing because the checkout may drift. Inspect `apps/api/src/services/demo-run-service.ts`, `apps/api/src/services/demo-run-finalization-service.ts`, `apps/api/src/services/terminal-demo-run-writer.ts`, maintenance/recovery service modules, and relevant tests. Identify identical inputs, output contracts, and defaults before extraction; place the helper in the narrowest existing module that owns its shared domain, not a new generic mapper package. Preserve distinct public/admin responses and durable/live semantics when fields, authority, or behavior differ. Update tests to cover the canonical helper and retain boundary tests that validate externally distinct views.

## Retained behavior and non-goals

Retain different public/admin projections and durable/live read semantics. Do not introduce a generic mapper framework, normalize merely similar structures, or combine dashboard protocol work with this small deduplication.

## Acceptance criteria

- [ ] Every centralized helper is byte-for-byte/equivalent in contract and semantics.
- [ ] Demo-run/finalization/maintenance/recovery copies are removed where centralized.
- [ ] Copy-pinning tests are removed or replaced by canonical-helper coverage.
- [ ] Deliberately distinct public/admin and durable/live mappings remain separate.
- [ ] No generic mapping framework is introduced.

## Verification

Run focused service tests for each affected mapping and `pnpm type-check` when signatures move. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record commands and deleted-copy evidence.

## Working record

- Status: complete
- Completed scope:
  - Added the API-local `demo-run-projections.ts` owner for the exact durable demo-run row projection, the exact live-Redis terminal inventory projection, and the zero-evidence business outcome summary. Demo-run lifecycle/failure handling, finalization, dashboard recovery, traffic-completion enrichment, maintenance, and admin run history now import only the applicable canonical helpers.
  - Replaced four byte-for-byte `demo_runs` row-to-`DemoRunSnapshot` implementations in demo-run, finalization, dashboard recovery, and admin run history with one schema-parsed mapper. The mapper retains every lifecycle field, conditional omission, ISO timestamp conversion, and contract parse.
  - Replaced three equivalent live-Redis terminal inventory projections in demo-run failure handling, traffic-completion enrichment, and finalization with one helper. It retains Redis sold-out pressure, pending-persistence evidence, accepted-reservation business evidence, the capture timestamp, and `source: "redis"` exactly.
  - Replaced the two identical empty `BusinessOutcomeSummary` builders used by pre-sale demo-run failure and maintenance with one helper.
  - Added `syntheticFailedTrafficSummary` beside the existing traffic-delivery-plan helper and removed both duplicated zero-attempt HTTP summary builders plus maintenance's duplicate planned-request calculation. Each caller still supplies its exact diagnostic note.
  - Added focused canonical-helper coverage for full durable run projection, live Redis terminal inventory evidence, empty business outcome, and the combined zero-attempt failed traffic summary. Existing service-boundary tests remain because they prove lifecycle, finalization, recovery, maintenance, enrichment, and public/admin response behavior rather than pinning private copies. No copy-only tests existed to delete.
- Decisions:
  - Kept the public run-history projection separate because it deliberately omits admin-only identifiers, failure diagnostics, and sale-offer scope. Only the admin full snapshot uses the canonical `DemoRunSnapshot` mapper.
  - Kept maintenance terminal inventory construction separate because its sold-out rejection count prefers durable `demo_run_reservation_outcomes` PostgreSQL evidence and only falls back to the live Redis counter. Routing it through the live-Redis helper would hide that authority distinction.
  - Did not extract lifecycle/status predicates, alter schema validation or legacy normalization, change terminal writer responsibilities, introduce a generic mapper framework, or redesign dashboard projection delivery.
  - Inspected durable documentation references in `docs/core_business_entities.md` and `docs/redis_inventory_hot_path.md`. They already document contract-typed persisted snapshots and the distinct traffic-boundary versus terminal Redis observations; this internal ownership refactor changes no public, durable, or operational behavior, so no durable documentation edit was warranted.
- Verification:
  - `pnpm --filter api exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.api.config.ts test/demo-run-service.test.ts test/demo-run-finalization-service.test.ts test/demo-maintenance-service.test.ts test/dashboard-recovery-service.test.ts test/run-history-service.test.ts test/demo-run-projections.test.ts test/traffic-delivery-plan.test.ts` — passed (7 files, 162 tests).
  - `pnpm --filter api type-check` — passed.
  - `pnpm type-check` — passed (11 Turbo tasks and the root test TypeScript project).
  - `pnpm lint` — passed (410 files, no warnings).
  - `pnpm exec biome check apps/api/src/services/dashboard-recovery-service.ts apps/api/src/services/demo-maintenance-service.ts apps/api/src/services/demo-run-finalization-service.ts apps/api/src/services/demo-run-projections.ts apps/api/src/services/demo-run-service.ts apps/api/src/services/run-history-service.ts apps/api/src/services/traffic-completion-enrichment-service.ts apps/api/src/services/traffic-delivery-plan.ts apps/api/test/demo-run-projections.test.ts apps/api/test/traffic-delivery-plan.test.ts` — passed (10 files, no fixes needed after formatting).
  - `git diff --check` — passed.
  - `pnpm test:composition` and `pnpm test:characterization` were not run because repository instructions reserve both slow Docker-dependent lanes for explicit requests.
- Follow-up: none
