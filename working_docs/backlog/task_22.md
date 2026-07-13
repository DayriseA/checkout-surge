# Task 22: Enforce run–sale-offer ownership after guarded insertion

## Execution context

- **Execution order:** This is task 22 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1
- **Area:** database / schema integrity
- **Source:** independent review (medium)
- **Solved elsewhere:** none — shared class; GLM's own maintenance test demonstrated the same weakness at the storage boundary. Needs a DB-level constraint or update-guard trigger.
- **Locations:** `packages/db/src/schema.ts:198`, `packages/db/drizzle/0000_initial_schema.sql:455`, `apps/api/src/services/generated-run-sale-gate.ts:10`

Run and sale-context rows store sale-offer ownership independently with no constraint tying them together, and the guard trigger fires only on context insertion. A later contradictory write can make the durable admission gate approve Redis holds whose PostgreSQL rows are rejected, stranding secured stock in pending persistence.

## Implementation record

### Status

Complete.

### Completed scope

- Added a unique `demo_runs(id, sale_offer_id)` key and a composite foreign key from `demo_run_sale_contexts(run_id, sale_offer_id)` to it, with cascading context deletion when a run is deleted.
- Added incremental migration `0007_enforce_run_sale_context_ownership.sql` and kept the Drizzle schema and migration journal aligned.
- Added real-PostgreSQL coverage for schema presence, normal matching creation, mismatched insertion, updates to both context ownership columns, updates to the referenced run ownership, and safe migration failure on contradictory legacy data.
- Updated the core entity documentation to distinguish the non-null context foreign-key invariant from the nullable business-row attribution trigger rationale.

### Decisions and deviations

- Used a declarative composite foreign key rather than an update trigger. It enforces both mutation directions without application queries and preserves the existing transactional creation order (`SaleOffer` -> `DemoRun` -> `DemoRunSaleContext`).
- Verified the recorded trigger description had drifted: the current purpose trigger already runs on context insertion and `sale_offer_id` updates, but it checks only `purpose = generated_run`; it does not tie the context pair to the run row. The composite foreign key closes that separate gap.
- Kept the existing single-column `run_id` foreign key. The new composite key adds ownership enforcement while the existing key remains compatible; both preserve `ON DELETE CASCADE` cleanup behavior.
- The migration checks existing rows with `IS DISTINCT FROM` before adding the constraint. If any run/context ownership differs, it aborts with SQLSTATE `23514` and constraint identity `demo_run_sale_contexts_existing_ownership_consistency`; it never chooses or rewrites an owner.
- The previously recorded `apps/api/src/services/generated-run-sale-gate.ts` location no longer exists. No application hot-path change was needed because current admission is Redis-first and the invariant belongs at the database boundary.

### Verification

- `pnpm test:db:migrate` — passed.
- `pnpm --filter @checkout-surge/db exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.integration.config.ts test/integration/db.integration.test.ts` — passed, 45 tests.
- `pnpm --filter @checkout-surge/db test:integration` — passed, 46 tests across 2 files.
- `pnpm --filter @checkout-surge/db type-check` — passed.
- `pnpm --filter @checkout-surge/db lint` — passed, 25 files.
- `pnpm exec biome check packages/db/src/schema.ts packages/db/test/integration/db.integration.test.ts packages/db/drizzle/meta/_journal.json` — passed.
- `git diff --check` — passed.

### Blockers and follow-ups

- None.
