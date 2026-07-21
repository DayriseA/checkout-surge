# Task 23 — Replace fingerprint reset with deterministic rebuild

## Execution context

Task 23 of 45, Phase 4. Primary ownership is `@checkout-surge/db` test-reset infrastructure; root scripts invoke its approved interface. This is destructive infrastructure work: follow the checklist and retain fail-closed safeguards before considering speed. It must remain independently understandable if audit records disappear.

## Why

Catalog/object/migration/filesystem fingerprinting and truncate-versus-rebuild modes turn test reset into a second schema-management product, while a measured reviewed-migration rebuild may be simple enough.

## Required outcome

Measure unconditional rebuild through reviewed migrations. If acceptable, make it the only reset path and delete fingerprints and truncate mode. Preserve exact DB allowlisting, `NODE_ENV=test`, port checks, connected-database identity checks, and one reliable serialization lock. The operation must fail closed and rebuild deterministically; destructive safety never trades for speed.

## Scope and concrete current paths

- `scripts/reset-test-infra.mjs`, `scripts/run-with-test-env.mjs`, `packages/db/src/test-environment-safety.ts`, `packages/db/src/testing.ts`, and test-database/migration scripts.
- `packages/db/test/unit/test-environment-safety.test.ts`, migration/reset integration tests, root test-env safety test, docs and package scripts.
- Filesystem/PostgreSQL lock, catalog/object/migration fingerprint, and truncate/rebuild mode paths; verify exact locations before editing.

## Retained behavior and non-goals

Keep all target identity checks, exact allowlist, test-only environment gate, port protection, and one serialization lock. Do not broaden destructive targets, make an unsafe fast path, or change production/runtime wipe behavior from task 12.

## Acceptance

- [ ] A benchmark records reviewed-migration rebuild cost and the decision that it is acceptable for this suite.
- [ ] Reset has one deterministic rebuild path; fingerprint and truncate-vs-rebuild modes are removed.
- [ ] It refuses non-test environment, unallowlisted database, wrong port, or mismatched connected identity before destructive action.
- [ ] One reliable lock prevents concurrent rebuilds without a second overlapping lock protocol.
- [ ] Focused tests prove fail-closed guards, serialization, and a successful clean rebuild.

## Focused verification

Run `node --test scripts/test-environment-safety.test.mjs`, `pnpm --filter @checkout-surge/db test:unit`, `pnpm --filter @checkout-surge/db test:integration`, `pnpm --filter @checkout-surge/db test:db:migrate`, and DB type-check when test infrastructure is available. Do not run composition or characterization suites.

## Working record

Pending — record benchmark environment/result, selected rebuild command, retained guard inventory, lock choice, commands run, and skipped checks.
