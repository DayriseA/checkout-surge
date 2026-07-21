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

- Status: pending
- Completed scope: none
- Decisions: none
- Verification: not run
- Follow-up: none
