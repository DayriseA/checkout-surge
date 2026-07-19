# Issue 06 — Preserved databases with the legacy public runtime policy can prevent API startup

## Classification

- Priority: P1
- Status: Fixed (2026-07-19)
- Affected path: Reference runtime startup with preserved named volumes, seeded runtime policy

## Resolution

The preserved-data upgrade path now repairs only the repository-owned legacy omission and keeps policy validation strict:

- Append-only migration `0014_hydrate_legacy_public_runtime_policy` adds only absent `maxPreAllocatedVus`, `maxVus`, `minErpMaxTps`, and `maxErpMaxTps` keys. Existing values—including explicit JSON `null`—remain authoritative and are never overwritten as if they were missing.
- Compatibility VU limits are derived within the persisted deployment caps and existing sibling limits, preserving `maxPreAllocatedVus <= maxVus`. The ERP maximum is derived to accommodate the persisted public-custom default, producing 150 TPS for the historical `a2f6192` fixture rather than copying today's 100 TPS seed limit.
- The database migration runner validates an existing active policy with the complete `publicRuntimePolicySchema` after applying migrations, including semantic refinements and field-level violation diagnostics. Invalid operator data makes migration/setup exit nonzero; because the SQL entry may already be journaled, every retry still performs the full validation until the operator explicitly remediates the policy.
- Seed conflict-do-nothing behavior and strict API pre-listener validation remain unchanged. Valid current/customized policies and repeated migration/setup/seed runs are semantic no-ops.
- Database integration coverage reconstructs the historical seed shape, verifies exactly the four compatibility additions, preserves all prior values, validates the complete hydrated policy, exercises partial legacy/customized policies, proves rerun/seed idempotency, and confirms explicit `null` fails without replacement. API coverage accepts the hydrated 150 TPS policy through the existing startup validator.
- Runtime setup, topology, entity, and automated-testing documentation now describes the compatibility migration and fail-closed behavior.

Verification completed:

- Full database integration suite: 5 files and 90 tests passed.
- Database unit suite: 7 files and 54 tests passed.
- Focused API startup-policy tests passed.
- Incremental `pnpm test:db:migrate`, contracts/database builds, database/API type checks, database/API lint, and `git diff --check` passed.
- The prohibited composition and characterization suites were not run.

## Issue observed

The repository intentionally preserves Compose named volumes across ordinary `runtime:up` and `runtime:setup` operations. A database originally seeded before the public custom-limit schema was expanded can therefore contain an active policy that the current API refuses to parse.

The legacy seeded `publicCustomLimits` object lacks four fields that are now required:

- `maxPreAllocatedVus`;
- `maxVus`;
- `minErpMaxTps`;
- `maxErpMaxTps`.

Validating the historical seed shape with the current contract produces four missing-number validation issues. Because the API loads and strictly validates the active runtime policy before listening, this preserved data can stop the API from starting at all.

Hydration cannot blindly copy today's seed defaults. The historical policy's persisted public-custom ERP default is 150 TPS, while today's default for the newly required `maxErpMaxTps` limit is 100. Adding 100 would satisfy the structural schema but still fail the full policy refinement because the persisted default would exceed its new limit.

This is especially damaging in the reference workflow: the documented setup preserves state, reports migrations/seeding as successful, and can still leave the main service unable to boot.

## How to reproduce

1. Create a database from the earlier seed shape in commit `a2f6192`, or insert an active runtime-policy row whose `publicCustomLimits` omits the four fields above.
2. Run the current migrations and seed script without deleting the volume.
3. Start the current API.

The migrations do not add the missing JSON fields, the seed uses conflict-do-nothing behavior for the active policy, and startup validation rejects the row.

## Identified cause

The data contract evolved without a matching persisted-data migration:

- the historical seed's `publicCustomLimits` did not contain the four fields;
- the current contract requires all four (`packages/contracts/src/demo.ts`);
- no database migration hydrates legacy policy JSON;
- the current seed inserts the active policy with conflict-do-nothing semantics (`packages/db/src/scripts/seed.ts`), so setup does not repair an existing row;
- the API strictly validates the loaded active policy before opening its listener (`apps/api/src/services/demo-run-service.ts`, `apps/api/src/index.ts`).

Strict startup validation is useful because it prevents silently running with an unknown policy. The missing piece is a forward migration for data that this repository itself previously wrote.

## Recommended actions

1. Add an idempotent data migration that fills only absent legacy keys with explicitly defined, legacy-compatible values rather than blindly copying today's seed/environment defaults.
2. Derive or choose the new limits so the persisted default snapshot remains valid and all limit relationships/deployment caps hold. For the historical fixture, `maxErpMaxTps` must be at least the persisted 150 TPS default even though today's newly seeded limit defaults to 100; VU limits must obey `maxPreAllocatedVus <= maxVus` and the persisted deployment hard caps.
3. Validate the complete hydrated object with `publicRuntimePolicySchema`, including its semantic refinements, before considering the migration successful. A structural four-key check is insufficient.
4. Preserve every existing operator-supplied value, including values for the four keys when they are already present. Do not replace the whole JSON object with today's seed.
5. Decide how explicit JSON `null` should be treated and test it. Prefer failing clearly for invalid operator data rather than silently overwriting it unless the migration policy explicitly defines `null` as legacy-missing.
6. Keep strict runtime validation after migration.
7. Add an upgrade fixture based on the actual historical seed shape and run migrations against it in database integration coverage.
8. Make repeated migration/setup/seed runs idempotent and verify that they do not change a valid customized policy.

## Acceptance criteria

- Migrating the historical seed fixture adds exactly the four missing required keys with legacy-compatible values.
- The fixture's hydrated `maxErpMaxTps` accommodates its persisted 150 TPS public-custom default, and all VU-limit/deployment-cap relationships remain valid.
- Every pre-existing policy key remains semantically unchanged.
- The complete migrated policy passes `publicRuntimePolicySchema`, including semantic refinements, and the API begins listening.
- A current policy with customized limits is not reset by migration or seeding.
- Re-running migrations and setup produces no further policy changes.
- An invalid non-legacy value still causes a clear, bounded startup failure rather than being silently replaced.

## Scope guard

This is a compatibility migration for repository-owned data. It does not call for weakening policy validation or building a general policy-versioning product.
