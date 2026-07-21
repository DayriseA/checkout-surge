# Task 03 — Restore the full root type-check gate

## Execution context

Task 3 of 45. Phase 0: establish a trusted baseline. Primary ownership boundary: test-source type correctness and root package verification configuration. Dependencies: none beyond the current repository checkout; it must finish before later cleanup can rely on a green baseline. This record is standalone. Use the quality checklist to keep production contracts and tests aligned; do not hide errors through exclusions or suppressions.

## Why this task exists

Production package type checks pass, but the advertised root `pnpm type-check` is red due to exactly 20 current test-source errors. A predictably red required gate cannot identify new regressions.

## Required outcome

Make `pnpm type-check` green without suppressions, test-directory exclusions, or weakening production typings. Repair the existing narrow defects: two `never`-narrowing errors in finalization tests, one obsolete terminal-writer method in a demo-run test, one deferred-resolver readiness test typing issue, and 16 overly broad `ExportedPgEnum` assignments. Future records that report type-check verification must report the result of the full root `pnpm type-check`; package-scoped checks may be additional evidence but are not a substitute for the root gate.

## Scope and implementation guidance

Verify paths before editing because the checkout may drift: `apps/api/test/demo-run-finalization-service.test.ts` (two errors), `apps/api/test/demo-run-service.test.ts` (obsolete writer-method test), `apps/api/test/readiness.test.ts` (deferred resolver), and `packages/db/test/unit/vocabulary-parity.test.ts` (16 `ExportedPgEnum` assignments). Prefer precise test fixtures, narrowing, or appropriately generic test-only helpers that model the real contract. Do not alter source code merely to accommodate a malformed test double.

## Retained behavior and non-goals

Retain strict root checking of production and test sources. Do not use `@ts-ignore`, `@ts-nocheck`, unsafe blanket casts, compiler exclusion changes, or a reduced command as a substitute for repair.

## Acceptance criteria

- [ ] All 20 named current test-source errors are repaired at their owning test boundaries.
- [ ] No suppressions or source/test exclusions were added.
- [ ] Production typings and public vocabulary remain intact.
- [ ] `pnpm type-check` exits successfully from the repository root.
- [ ] Any type-check verification recorded after this repair reports the full root command result; package-scoped checks are supplemental only.

## Verification

Run `pnpm type-check`; also run focused affected tests where practical. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record command output/result, including any checkout drift from the stated 20-error baseline.

## Working record

- Status: pending
- Completed scope: none
- Decisions: none
- Verification: not run
- Follow-up: none
