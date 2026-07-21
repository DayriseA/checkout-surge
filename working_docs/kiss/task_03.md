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

- [x] All 20 named current test-source errors are repaired at their owning test boundaries.
- [x] No suppressions or source/test exclusions were added.
- [x] Production typings and public vocabulary remain intact.
- [x] `pnpm type-check` exits successfully from the repository root.
- [x] Any type-check verification recorded after this repair reports the full root command result; package-scoped checks are supplemental only.

## Verification

Run `pnpm type-check`; also run focused affected tests where practical. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record command output/result, including any checkout drift from the stated 20-error baseline.

## Working record

- Status: completed
- Completed scope: Repaired the two finalization overlap narrowings, updated the stale terminal-writer fake to the fenced `writePrepared` contract, precisely typed the readiness deferred resolver, and modeled only the PostgreSQL enum metadata consumed by the inventory test while retaining runtime `isPgEnum` checks. No production source, compiler configuration, or vocabulary changed.
- Decisions: Returned the captured recovery response from the lock transaction instead of mutating outer state. The terminal-writer fake now prepares inside the real writer fence, injects its first failure before persistence, and delegates normally on retry. The retry restores coherent Redis evidence before the fresh in-fence terminal read; the enrichment record remains immutable while the terminal summary asserts the newer fenced snapshot accepted by Task 02. The enum inventory uses a small test-only metadata shape rather than forcing heterogeneous literal `PgEnum` signatures into one tuple type.
- Verification: `pnpm type-check` passed from the repository root (11/11 Turbo tasks, then the full `tsconfig.test.json` check). `pnpm --filter @checkout-surge/db exec vitest run --config vitest.unit.config.ts test/unit/vocabulary-parity.test.ts` passed (17 tests). `pnpm --filter api exec vitest run --config vitest.api.config.ts test/readiness.test.ts` passed (2 tests). From `apps/api`, `node ../../scripts/run-with-test-env.mjs pnpm exec vitest run --config vitest.api.config.ts test/demo-run-finalization-service.test.ts -t "publishes the terminal event at a post-commit time after an overlapping stale recovery"` passed (1 test, 30 skipped by the name filter), and `node ../../scripts/run-with-test-env.mjs pnpm exec vitest run --config vitest.api.config.ts test/demo-run-service.test.ts -t "re-drives real finalization after enrichment commits and Redis inventory is removed"` passed (1 test, 73 skipped by the name filter). `pnpm exec biome lint apps/api/test/demo-run-finalization-service.test.ts apps/api/test/demo-run-service.test.ts apps/api/test/readiness.test.ts packages/db/test/unit/vocabulary-parity.test.ts` passed. No focused affected test was skipped. An earlier package-script attempt inserted `--`, unintentionally started the broad API suite, and was interrupted; before interruption it reported the then-unrepaired owned retry case plus two unrelated failures. The exact owned regression subsequently passed. Composition and characterization tests were not run, per repository guidance.
- Follow-up: The accidental broad invocation also reported `keeps a claimed completion non-terminal until enrichment durably concludes` timing out and `keeps a completed Redis capture failure as an immutable no-snapshot result` failing. They are outside this test-source type-gate scope and were not investigated.
