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

- [ ] One baseline migration and matching generated metadata reproduce the intended current schema from an empty approved database.
- [ ] The documented command names exact disposable targets and refuses unsafe/retained targets before destructive work.
- [ ] Seed/setup remains deterministic after the intentional wipe.
- [ ] No retired migration, snapshot, journal entry, compatibility test, or documentation path remains reachable.
- [ ] A later pre-release schema adjustment has a documented baseline-amendment workflow, not a compatibility-upgrade workflow.
- [ ] DB ownership, contracts, implementation, and boundary tests agree.

## Focused verification

Run `pnpm --filter @checkout-surge/db test:unit`, `pnpm --filter @checkout-surge/db test:db:migrate`, and the focused DB integration reset/migration tests through `pnpm --filter @checkout-surge/db test:integration` when test infrastructure is available. Run `pnpm --filter @checkout-surge/db type-check`. Do not run composition or characterization suites for this task.

## Working record

Pending — record the approved disposable target, exact wipe command, baseline generation method, metadata review, commands run, and any verification skipped.
