# Task 42 — Prune tests by authoritative behavioural evidence

## Execution context

- **Position:** 42/45; Phase 7, after replaced mechanisms and their tests can be identified.
- **Dependencies:** Task 03 must have made the full root `pnpm type-check` gate green, and Tasks through 41 must identify deleted protocol/tooling paths and required runtime checks. If the root type-check is red, this task is blocked; do not prune tests against an untrusted baseline.
- **Standalone:** Simplify the suite by retaining the cheapest authoritative evidence for each required guarantee, removing tests that only pin deleted mechanisms and redundant cross-layer duplicates; no numeric line target applies.
- **Checklist / working record:** Primary ownership is test inventory and pruning across existing suites. Behavioural tests remain at the boundary they protect; shared fakes only through public testing entry points. Record the guarantee-to-authoritative-test inventory, deleted mechanism tests, retained multilayer rationale, gates, and skipped checks below.

## Why

Test code is a maintainability surface, but an arbitrary size quota would reward weak coverage. The correct reduction follows removal of states and mechanisms while preserving proof of the resilience story.

## Required outcome

Inventory and retain the least costly authoritative tests for: no oversell, idempotent replay, durable queue handoff, ERP backoff/circuit behaviour, run accounting, gold projection behaviour, destructive target guards, and observed P0 regressions. Delete mechanism-specific and redundant cross-layer tests only after identifying what still proves each outcome.

Evaluate and record whether these evidence-based decisions made the suite materially smaller and reduced its maintenance burden. Use concrete before/after evidence such as retired mechanism tests, duplicate scenarios, fixtures, harnesses, runtime, or reliability; these observations explain the result and are not numeric acceptance targets. If the reduction is not material, record why the retained tests protect distinct required guarantees rather than deleting assertions to manufacture a reduction.

## Concrete scope and paths

- Existing `**/*.test.*`, `**/*.spec.*`, browser/integration suites, fixtures, test helpers, root test scripts, and test documentation affected by removed code.
- Public test-helper entry points when a retained cross-package helper is genuinely shared.

For each retained guarantee, document one primary test location, boundary, runtime cost, and why it is authoritative. Keep multiple layers only where they prove distinct contracts—for example, a contract schema plus a Redis/PostgreSQL handoff integration—not merely the same UI result twice. Remove tests with deleted delta/replay/fan-out, command-graph, compatibility, or other retired mechanisms in the same change. Remove duplicate cross-layer scenarios after comparing their failure boundary; do not replace them with opaque generic test frameworks. Preserve explicit observed P0 regressions, including C1/dashboard convergence where applicable.

## Retained behaviour and non-goals

Retain confidence in all listed guarantees, focused integration at Redis/PostgreSQL/queue/worker boundaries, and required gates. Do not set a test-line quota, mass-delete assertions, run prohibited slow suites, or use test splitting alone as evidence of simplification. Do not reopen numeric size-target debate because an observed count is above or below a proposal; revisit it only when a concrete delivery constraint requires a new testing tradeoff.

## Acceptance

- [ ] A guarantee-to-cheapest-authoritative-test inventory covers all required behaviours and observed P0 regressions.
- [ ] Tests for deleted mechanisms are removed with their implementation.
- [ ] Remaining multilayer tests have documented distinct boundary value.
- [ ] No line-count target or assertion quota is used.
- [ ] Required gates pass, and retained suite runtime/reliability is recorded.
- [ ] The working record evaluates material suite reduction through mechanism/duplicate deletion and records the resulting maintenance-burden change without treating a count as a quota.
- [ ] The full root `pnpm type-check` passes before and after pruning; no accepted test-source errors are hidden.

## Focused verification

Run affected package/unit/contract/integration/browser tests and the repository's required non-prohibited gates. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization; record them as opt-in when relevant.

## Working record

Pending — inventory, pruning rationale, material-reduction and maintenance-burden evaluation, gate results, and skipped-check reasons remain to be recorded.
