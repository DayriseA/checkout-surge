# Task 43 — Simplify fixtures, harnesses, and oversized suites

## Execution context

- **Position:** 43/45; Phase 7, after Task 42 identifies the tests that must remain.
- **Dependencies:** Task 42's behavioural inventory is required so helper/harness cleanup cannot erase required evidence. Coordinate with package owners before moving shared test APIs.
- **Standalone:** Make retained tests easier to understand and maintain by consolidating genuinely duplicated builders/fakes through a public testing entry point, removing harness complexity that does not protect distinct behaviour, and splitting suites only for ownership/navigation.
- **Checklist / working record:** Primary ownership is fixtures, harnesses, and oversized test-suite structure. Do not import another package's private helpers; expose a stable public testing entry point for true cross-package reuse. Record duplicated helper inventory, public API decisions, removed harnesses, split rationale, and verification below.

## Why

Duplicated builders and generalized command/Compose text harnesses make tests harder to read without adding boundary confidence. Conversely, indiscriminate consolidation or splitting can hide dependencies and increase abstraction.

## Required outcome

Simplify the retained test surface without creating a generic testing framework. Consolidate exact duplicate builders/fakes only where cross-package reuse is real; delete command-graph/Compose-text/meta harnesses that do not protect distinct runtime behaviour; split oversized suites only when it improves ownership or navigation.

Record the maintenance effect of fixture and harness changes: which duplicate update points, setup paths, abstractions, or mechanism-specific harnesses disappeared, and whether the retained suite is materially easier to change. This supplements Task 42's material-reduction evaluation; it is not a line-count target and does not justify deleting readable assertions.

## Concrete scope and paths

- Existing package test helpers, fixture/builders/fakes, public testing exports, oversized test files, and root harness/meta-test scripts identified by Task 42.
- Relevant imports and docs/test commands affected by public helper changes.

First classify each helper: local-only, same-package shared, or cross-package shared. Keep local fixtures beside the tests; for cross-package helpers, expose an intentional public `testing` entry point owned by the package rather than importing private paths. Merge only identical behaviours and preserve readable domain names. Remove meta command-graph/Compose-text harness machinery when retained runtime smoke or a real integration test is the authoritative proof. A suite split must name the resulting ownership/boundary or navigation benefit; do not split merely to reduce file size. Avoid a universal factory, dependency-injection test framework, or broad rewrite.

## Retained behaviour and non-goals

Retain deterministic fakes, necessary integration fixtures, readable assertions, and public package boundaries. Do not change product behaviour, reduce coverage as a proxy for helper cleanup, or expose private infrastructure clients through test exports.

## Acceptance

- [x] Duplicate builders/fakes are consolidated only where their behaviour is truly shared.
- [x] Cross-package test utilities are available through a documented public testing entry point; private imports are removed.
- [x] Unnecessary command graph/Compose-text harness complexity is deleted.
- [x] Each suite split has an ownership or navigation rationale; no split alone is claimed as simplification.
- [x] Retained tests remain clear, deterministic, and cover the Task 42 inventory.
- [x] The working record identifies concrete maintenance burden removed and contributes evidence to Task 42's material suite-reduction judgment without using a quota.

## Focused verification

Run tests importing changed helpers, affected package type checks, and the focused suites refactored here. Run normal required gates as feasible. Do not run composition or characterization unless explicitly authorized.

## Working record

Completed on 2026-07-23.

### Helper classification and public API decisions

| Classification | Decision | Rationale |
| :-- | :-- | :-- |
| Local-only | Retained scenario-specific accepted-run snapshots, non-empty business outcomes, clocks, deferreds, response helpers, environment getters, and small polling helpers beside the tests that use them. | Their values or timing encode a particular scenario. Moving them would hide the arranged behavior or create a configurable fixture factory rather than remove true duplication. In particular, the traffic-completion and startup-reconciliation accepted-run snapshots deliberately model ten-request runs, while demo-administration fixtures model different public/admin limits. |
| Same-package shared | Added one worker integration helper for the exact default `createBullMqOrderProcessConsumer` recovery dependency used by four suites; reused production `emptyBusinessOutcomeSummary()` in four API suites; added one load-orchestrator test helper for the exact config and start-request fixtures plus the polling helper shared by its correlation, runner, and boundary suites. | These defaults are identical inside one package and have one semantic meaning. The helpers remain package-local test files and do not create a public production surface. |
| Cross-package shared | Added `previewRunConfigSnapshotFixture()` to the package-owned `@checkout-surge/contracts/testing` export and used it in three API and four web suites. Retained the existing `@checkout-surge/db/testing` reset export unchanged. | Preview 1k is a contract-valid fixture with the same identity and values at API and web boundaries. The explicit `testing` export removes eight copied object bodies without exposing a database, Redis, BullMQ, HTTP, or other infrastructure client. |

Repository search found no cross-package test helper imported through another package's private `src` or `test` path. `docs/automated_testing_infrastructure.md` now documents both public testing entry points, the local-helper rule, and the infrastructure-client prohibition. No universal factory, generic fake/DI framework, fixture directory hierarchy, or configurable fixture zoo was added.

The concrete duplicate update points removed are:

- eight identical Preview 1k config bodies became one package-owned contract fixture, removing seven update points;
- four identical worker consumer wrappers became one worker integration helper, removing three update points;
- two identical load-orchestrator config builders became one same-package helper, removing one update point;
- four copied zero-valued API business outcomes now call the existing production projection helper, removing all four test-owned copies; and
- the two polling helpers that the load-orchestrator ownership split would otherwise retain became one same-package helper, removing one update point.

Other visually similar builders were not consolidated when their values expressed different behavior. This preserves readable domain setup instead of forcing unrelated tests through overrides.

### Harness removal and retention

- Deleted `apps/web/test/admin-route-architecture.test.ts`. Its two cases recursively read route source and asserted internal symbol names. The admin control proxy suite exercises authorization, exact upstream requests, and failure behavior through the route boundary, so the source-text mirror had no distinct Task 42 guarantee.
- Deleted `apps/web/test/caddy-dashboard-events-config.test.ts`. Its two parameterized cases parsed Caddyfile text and comments. The exact SSE route is exercised by the deployed runtime workflows and the direct Next streaming boundary has behavior tests; maintaining a second hand-written Caddy parser did not add a runtime authority.
- Reduced `scripts/runtime-image-contract.test.mjs` from eight broad repository-text tests to four focused packaging tests. Retained non-root direct entrypoints, deployable artifact allowlists, standalone/migration packaging, and build-context secret exclusion because these are explicit runtime-packaging/security requirements whose cheapest evidence is static. Removed Compose service-block/environment parsing, health-probe text matching, Mock ERP dependency text matching, and Dev Container provisioning string matching because runtime health/readiness and executable workflows own those outcomes.
- Task 42 had already deleted the command-graph parser. Task 43 did not recreate it; documentation now states that executable commands/configurations and behavior boundaries are authoritative.

The runtime-image contract still passed through the default script lane, and the production-image k6 compatibility build/run passed. The opt-in full deployed runtime smoke was not run, so this record does not claim fresh end-to-end Caddy evidence.

### Suite structure

`apps/load-orchestrator/test/load-orchestrator.test.ts` was split at a source-owner boundary:

- the retained main file owns configuration, durable execution storage, k6 mapping/diagnostics, and the `SpawnK6Runner` process/completion lifecycle; and
- `load-orchestrator-boundaries.test.ts` owns the HTTP API client/batcher, readiness adapters, and Fastify HTTP boundary.

The split moves 18 tests into a 574-line boundary suite and leaves 78 tightly coupled execution tests in the main suite. `test:focused:service` names both files so the focused command cannot silently omit the new boundary. This is a navigation/ownership improvement, not a reduction claim. The remaining runner sections share the in-memory execution store, start request, process fixture, completion report helpers, and lifecycle vocabulary; splitting them further now would duplicate or generalize setup.

No split was made solely because of size:

- `packages/contracts/test/contracts.test.ts` already has named domain sections and shares contract fixture vocabulary; a mechanical file split would not remove a maintenance authority.
- `apps/api/test/api.test.ts` shares one server/controller fixture and separates route, persistence, and correlation sections visibly.
- DB integration, finalization, maintenance, and worker workflow suites share expensive reset/seed/lifecycle setup at the real boundary they protect. Moving cases without changing that ownership would increase setup paths and navigation.

### Maintenance effect

Task 42 ended with 128 test files and 52,802 test lines. This task ends with 127 test files and 52,181 test lines. The observation is evidence, not an acceptance target: one new load boundary suite replaced one oversized ownership mix while two text harness files disappeared. Across tracked and new files, the implementation adds 745 lines and removes 1,226, a net 481-line reduction; the useful burden change is the sixteen duplicate update points, two source parsers, four broad runtime-image meta cases, and mixed load boundary ownership removed.

The retained suite is materially easier to change because Preview 1k contract changes, worker recovery-default changes, load config-default changes, and zero-outcome field changes each have one update authority. Runtime config changes no longer require updating hand-written Compose/Caddy/admin-route parsers merely to match source text. No readable Task 42 behavioral assertion was compressed or removed to reach a count.

### Verification and skipped checks

- `pnpm --filter @checkout-surge/contracts test:unit` passed 112 tests.
- `pnpm --filter load-orchestrator test:focused:service` passed both split files, 96 tests.
- Focused web `browser-workflows.test.ts` and `admin-control-proxy.test.ts` passed 33 tests.
- Focused API files importing changed fixtures passed 156 tests across `api.test.ts`, dashboard recovery, demo-run lifecycle, startup reconciliation, and traffic completion.
- Focused worker suites importing the shared consumer helper passed 36 integration tests across consumer, admission, dispatch recovery, and the complete processing workflow.
- The reduced `scripts/runtime-image-contract.test.mjs` passed 4 tests.
- Full root `pnpm test` passed: test-environment safety 7; scripts 48; contracts 112; logger 10; DB unit 54; Mock ERP 62; worker unit 86; load orchestrator 135; web 194; API 551; worker integration 48; DB integration 72.
- `pnpm test:k6-compat` rebuilt the pinned production-image boundary and passed 4 real-k6 tests.
- Root `pnpm type-check` passed all 11 Turbo tasks and `tsc -p tsconfig.test.json --noEmit`.
- Root `pnpm lint` passed across 422 files. Focused Biome formatting/import checks and `git diff --check` passed.
- Root `pnpm format:check` remains red only on the pre-existing untouched import ordering in `apps/api/src/runtime/pending-persistence-operation-factory.ts`, the same failure recorded by Task 42.
- Dedicated PostgreSQL/Redis test infrastructure was started for focused/full tests and removed with volumes afterward. The empty Compose network created by k6 compatibility was also removed.
- `pnpm test:composition` and `pnpm test:characterization` were not run because repository instructions prohibit them without explicit authorization. The executable full runtime smoke was not run because product/runtime behavior did not change; its script-unit boundary ran through `pnpm test`.

Correction cycle 1 closed the remaining consolidation gaps found during review:

- The remaining Preview 1k object bodies in admin-control proxy, dashboard hooks, dashboard projection state, and dashboard projection revision now call the public contracts fixture. Focused web verification passed 39 tests across three files; focused API verification passed 27 tests across dashboard projection revision and dashboard recovery.
- Dashboard recovery now calls the production empty business-outcome helper, and both load-orchestrator split files now call the package-local polling helper. `pnpm --filter load-orchestrator test:focused:service` passed both files and all 96 tests.
- The load-orchestrator, web, and API package type checks passed, followed by the root type check (all 11 Turbo tasks plus the test compiler). Root lint passed across 422 files; focused Biome and `git diff --check` passed.
- A structural search confirmed only one `waitForCondition` implementation remains across the split load suites. The other 1,000-buyer fixtures found by the review search intentionally encode different admin/custom behavior and were retained locally.

### Final self-review

- Scope stayed within fixtures, test helpers/exports, retained packaging evidence, test-suite ownership, the affected command/documentation, and this working record. Product code and behavior were not changed.
- API routes/controllers, application services, composition roots, and infrastructure-client ownership were not broadened.
- Shared contracts remain the public shape authority; the new `contracts/testing` entry point contains only a typed value builder. DB test reset remains behind `db/testing`, and no private cross-package import or infrastructure client escaped.
- Task 42's authoritative no-oversell, replay, durable handoff, ERP resilience, accounting, gold-signal, destructive-guard, and P0 regression evidence remains in place and passed through the full default suite.
- Error/status vocabulary and contracts remain unchanged. Relevant focused tests, package/root type checks, lint, full default tests, and k6 compatibility passed; prohibited and non-run checks are reported explicitly above.
