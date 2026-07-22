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

- [x] A benchmark records reviewed-migration rebuild cost and the decision that it is acceptable for this suite.
- [x] Reset has one deterministic rebuild path; fingerprint and truncate-vs-rebuild modes are removed.
- [x] It refuses non-test environment, unallowlisted database, wrong port, or mismatched connected identity before destructive action.
- [x] One reliable lock prevents concurrent rebuilds without a second overlapping lock protocol.
- [x] Focused tests prove fail-closed guards, serialization, and a successful clean rebuild.

## Focused verification

Run `node --test scripts/test-environment-safety.test.mjs`, `pnpm --filter @checkout-surge/db test:unit`, `pnpm --filter @checkout-surge/db test:integration`, `pnpm --filter @checkout-surge/db test:db:migrate`, and DB type-check when test infrastructure is available. Do not run composition or characterization suites.

## Working record

Completed 2026-07-22.

### Benchmark and decision

- Environment: the repository's dedicated `postgres:17-alpine` Docker service on Docker 29.6.1, Node.js 24.18.0, two available Intel Xeon Platinum 8370C vCPUs, and the checked-in `packages/db/drizzle/0000_baseline.sql` migration.
- Method: from `packages/db`, warm the package-isolated `checkout_surge_test_db`, then time ten consecutive complete reset calls with the exact one-off invocation below. The pre-change forced-rebuild upper-bound samples were 465.4–923.7 ms (591.5 ms mean, 563.7 ms median). The selected final path samples were 351.4, 367.6, 373.6, 381.2, 393.8, 400.7, 449.2, 511.8, 533.1, and 617.8 ms (438.0 ms mean, 397.3 ms median).

```bash
node ../../scripts/run-with-test-env.mjs pnpm exec tsx -e 'import { performance } from "node:perf_hooks"; import { resetTestDatabase } from "./src/testing.ts"; void (async()=>{ const url=process.env.TEST_DATABASE_URL; if (!url) throw new Error("missing TEST_DATABASE_URL"); await resetTestDatabase({databaseUrl:url}); const samples=[]; for (let i=0;i<10;i+=1){ const started=performance.now(); await resetTestDatabase({databaseUrl:url}); samples.push(performance.now()-started); } samples.sort((a,b)=>a-b); const mean=samples.reduce((sum,value)=>sum+value,0)/samples.length; console.log(JSON.stringify({samplesMs:samples.map(v=>Number(v.toFixed(1))),meanMs:Number(mean.toFixed(1)),medianMs:Number(((samples[4]+samples[5])/2).toFixed(1)),p95Ms:Number(samples[9].toFixed(1))})); })();'
```

- Decision: unconditional reviewed-migration rebuild is acceptable. A static source sweep found 33 external `resetTestDatabase` call expressions across 21 files; at the measured mean, one serial execution of each would consume about 14.5 seconds in rebuild calls, while package-isolated databases may rebuild concurrently. This is total measured rebuild time, not an incremental delta over the deleted truncate path. The focused DB integration suite completed in 53.09 seconds.

### Selected path and retained safeguards

- `resetTestDatabase` validates the test-only target, connects to the stable `postgres` administration database, acquires one target-name-scoped session advisory lock, creates the approved target database if missing, verifies `current_database()`, drops and recreates `public` and `drizzle`, and invokes the existing Drizzle migration runner. The administration session remains open through migration and releases the lock on success or failure.
- Retained guards: exact `NODE_ENV=test`; exact repository database allowlist; effective default-port rejection with only the existing `ALLOW_TEST_DEFAULT_PORTS=1` dedicated-service waiver; connected-target identity checks before schema destruction and before migration; credential-safe validation diagnostics; and one PostgreSQL advisory lock.
- Deleted mechanisms: filesystem/stale-lock protocol, target-database advisory lock, catalog fingerprint and marker table, custom migration-journal matching, dynamic truncate, and truncate-versus-rebuild mode. `scripts/reset-test-infra.mjs` still separately owns dedicated Docker-volume recreation; production/runtime wipe behavior is unchanged.

### Verification

- `node --test scripts/test-environment-safety.test.mjs` — passed, 7 tests.
- `pnpm --filter @checkout-surge/db test:unit` — passed, 7 files and 49 tests.
- `pnpm --filter @checkout-surge/db test:integration` — passed, 5 files and 72 tests in 53.09 seconds.
- `pnpm --filter @checkout-surge/db test:db:migrate` — passed; rebuilt the package database from the reviewed baseline.
- `pnpm --filter @checkout-surge/db type-check` — passed, including the package boundary check, after building the contracts dependency.
- `pnpm --filter @checkout-surge/db lint` — passed, 42 files.
- Focused `biome check` for changed TypeScript files — passed.
- `pnpm type-check:test` — run but failed on current API and worker schema mismatches outside Task 23; no diagnostic referenced the reset implementation or its tests.
- `pnpm test:composition` and `pnpm test:characterization` — intentionally not run because repository instructions prohibit them unless explicitly requested.
