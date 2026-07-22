# Task 12 — Squash disposable pre-release database history

## Execution context

Task 12 of 45, Phase 3. Depends on task 09's explicit disposable-data policy. This is a standalone implementation record: it remains actionable if the audit is removed. The primary ownership boundary is `@checkout-surge/db` migration/bootstrap ownership; runtime setup only invokes that boundary. Follow `working_docs/quality_checklists.md`: keep migration mechanics in the DB package, do not put database work in routes/services, and update the boundary tests with the schema change.

## Why

Fifteen pre-release migrations and compatibility metadata preserve local history that the accepted policy deliberately discards. They make every schema simplification pay for obsolete upgrade paths.

## Required outcome

Replace migrations `0000` through `0014` with one reviewed baseline representing the current schema and seed behavior. The intentional wipe must be exact, documented, and required before applying the baseline. Future pre-release schema simplifications amend this baseline rather than adding compatibility migrations. Drizzle metadata and migration tests must describe only the retained baseline.

## Scope and concrete current paths

- `packages/db/drizzle/0000_initial_schema.sql` through `0014_hydrate_legacy_public_runtime_policy.sql` and `packages/db/drizzle/meta/`.
- `packages/db/src/schema.ts`, `src/migrations.ts`, `src/scripts/migrate.ts`, `src/scripts/seed.ts`, and DB migration/reset tests.
- Runtime setup/wipe entry points: root `package.json`, `scripts/`, Compose/runtime setup documentation, and `docs/` references that tell users how to reset local data.
- Verify paths before editing: generated Drizzle paths and setup scripts may move with adjacent work.

## Retained behavior and non-goals

Preserve the current schema, seed data, Drizzle migration integrity, and fail-closed destructive-target protections. The wipe applies only to explicitly selected disposable local runtime volumes/databases; **never** migrate, delete, or advise wiping a retained external volume. This task does not redesign transport evidence (task 15), policy semantics (task 14), or database invariants (task 17).

## Acceptance

- [x] One baseline migration and matching generated metadata reproduce the intended current schema from an empty approved database.
- [x] The documented command names exact disposable targets and refuses unsafe/retained targets before destructive work.
- [x] Seed/setup remains deterministic after the intentional wipe.
- [x] No retired migration, snapshot, journal entry, compatibility test, or documentation path remains reachable.
- [x] A later pre-release schema adjustment has a documented baseline-amendment workflow, not a compatibility-upgrade workflow.
- [x] DB ownership, contracts, implementation, and boundary tests agree.

## Focused verification

Run `pnpm --filter @checkout-surge/db test:unit`, `pnpm --filter @checkout-surge/db test:db:migrate`, and the focused DB integration reset/migration tests through `pnpm --filter @checkout-surge/db test:integration` when test infrastructure is available. Run `pnpm --filter @checkout-surge/db type-check`. Do not run composition or characterization suites for this task.

## Working record

- Status: complete.
- Approved disposable target and rebuild path: The only approved destructive target remains the explicitly selected local Compose project and its project-scoped PostgreSQL, Redis, and load-orchestrator journal named volumes. Confirm `COMPOSE_PROJECT_NAME` selects the intended disposable project, then run `pnpm runtime:wipe`, `pnpm runtime:setup`, and `pnpm runtime:up`. The wipe maps to `docker compose down --volumes --remove-orphans`; it does not target external volumes, another Compose project, or the host-native `.checkout-surge/load-orchestrator` journal. No runtime wipe was run during this task.
- Baseline generation and review: Generated a fresh declarative migration from the current `packages/db/src/schema.ts` with Drizzle Kit 0.31.10. A temporary generation first confirmed 19 tables and a 398-line declarative migration; the checked-in artifact was then generated as `0000_baseline.sql` with `pnpm exec drizzle-kit generate --config drizzle.config.ts --name baseline`. Review moved the generated `demo_runs_id_sale_offer_id_unique` index before the composite foreign key that requires it, after the first isolated migration exposed Drizzle's invalid generated ordering. The final journal has one `0000_baseline` entry and one linked PostgreSQL v7 snapshot.
- Retained custom SQL: The baseline keeps `pgcrypto`, the single-nonterminal-run constant-expression partial unique index, and the current final-state custom functions/triggers previously represented across the reservation, lifecycle/child-attribution, timestamp, sale-purpose, and run-owned-sale attribution migrations. Integration coverage confirms all 9 trigger functions and 22 non-internal triggers are installed, representative current invariants reject invalid writes, and the single-nonterminal-run index governs concurrent direct writers.
- Removed compatibility history: Deleted the fifteen retired SQL files, snapshots `0001` through `0014`, and fourteen retired journal entries. The baseline contains no historical locks, old-row audits, data backfills, policy hydration, `NOT VALID` convergence sequence, or trigger reinstall/drop scaffolding. Removed nine incremental-upgrade integration fixtures/tests covering embedded historical triggers, policy hydration, ownership audit remediation, legacy completion/config/archive/terminal backfills, and legacy lifecycle/attribution audits. Reset and migration tests now expect one baseline entry while retaining schema-drift, fail-closed target, current-policy validation, seed idempotency, packaging, and custom-object coverage.
- Documentation: Updated architecture, domain, runtime topology, local development, repository layout, and testing documentation to describe the one-baseline model. `docs/local_development.md` retains the exact selected-project wipe/rebuild path and now documents the pre-release workflow: generate and review a fresh empty-database baseline, replace SQL/snapshot/journal together, restore snapshot-invisible custom SQL, and verify it without adding compatibility migrations or backfills. Removed active documentation references to retired migration tags and incremental policy hydration.
- Verification: `pnpm --filter @checkout-surge/db test:unit` passed 54 tests in 7 files; `pnpm --filter @checkout-surge/db test:integration` passed 81 tests in 5 files against isolated Compose PostgreSQL/Redis; `pnpm --filter @checkout-surge/db type-check` passed both package and boundary checks; `pnpm --filter @checkout-surge/db lint` passed 42 files; focused `pnpm exec biome check ...` passed the five changed TypeScript/config files after applying its formatting/import fixes; and `git diff --check` passed. `pnpm --filter @checkout-surge/db test:db:migrate` initially failed on the generated composite-index ordering, then passed after the reviewed baseline correction. The isolated integration fresh-schema path and deterministic reseed tests passed. Retired-tag/count/hydration sweeps found no active source/test/documentation reference outside this completed task's historical scope statement.
- Skipped by instruction: `pnpm test:composition` and `pnpm test:characterization` were not run.
- Follow-up boundary: Tasks 13–17 still own persisted-JSON normalization, runtime-policy authority, transport accounting, vocabulary, and invariant simplification. This task retained their current schema/runtime behavior and added no replacement compatibility framework.
