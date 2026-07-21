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

- [ ] Duplicate builders/fakes are consolidated only where their behaviour is truly shared.
- [ ] Cross-package test utilities are available through a documented public testing entry point; private imports are removed.
- [ ] Unnecessary command graph/Compose-text harness complexity is deleted.
- [ ] Each suite split has an ownership or navigation rationale; no split alone is claimed as simplification.
- [ ] Retained tests remain clear, deterministic, and cover the Task 42 inventory.
- [ ] The working record identifies concrete maintenance burden removed and contributes evidence to Task 42's material suite-reduction judgment without using a quota.

## Focused verification

Run tests importing changed helpers, affected package type checks, and the focused suites refactored here. Run normal required gates as feasible. Do not run composition or characterization unless explicitly authorized.

## Working record

Pending — helper classification, harness removals, suite-structure rationale, maintenance-burden evidence, and focused verification remain to be recorded.
