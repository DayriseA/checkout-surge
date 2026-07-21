# Task 41 — Consolidate runtime smoke, health, SSE, and bounded-load verification

## Execution context

- **Position:** 41/45; Phase 7, following dashboard protocol convergence.
- **Dependencies:** Retained runtime behaviour, health surface, SSE projection protocol, and representative bounded-load scenario must be stable. Preserve composition and 10k characterization as deliberate opt-in lanes.
- **Standalone:** Provide one understandable routine runtime smoke workflow that proves a local reference runtime is healthy, can stream a dashboard projection, and handles one representative bounded load; delete redundant wrappers rather than adding another command layer.
- **Checklist / working record:** Primary ownership is root verification command/script/documentation consolidation. Runtime routes remain thin and services retain their own logic. Record old/new command map, chosen smoke inputs, deletions, command output, and skipped opt-in lanes below.

## Why

Separate smoke, health, SSE, load, soak, wrapper, meta-test, and Compose-text workflows form a secondary product. A maintainer should be able to run one small, legible verification path without losing the expensive lanes that serve different evidence.

## Required outcome

Converge routine runtime verification on one workflow containing health, dashboard SSE/projection observation, and a representative bounded load. Remove confirmed redundant commands, scripts, wrappers, tests, and documentation while leaving the existing `pnpm test:composition` and `pnpm test:characterization` commands explicitly available but not implicit. Both use the repository's composition-characterization implementation, which contains the 10k scenario; do not invent a third standalone 10k command.

## Concrete scope and paths

- Root `package.json`, workspace package scripts, and any `runtime-smoke*`, health, recovery-soak/load, or `run-in-compose` scripts.
- Root and relevant package tests/docs that describe or mechanically assert the old command graph.
- Runtime smoke fixtures/configuration only when needed for the one workflow.

Choose one command and one implementation path. It must start against the documented local runtime (or validate an already-started documented runtime), verify health/readiness, open/validate an SSE dashboard projection including heartbeat/lifecycle expectations, run one bounded representative load, and report a useful failure location. Reuse existing public interfaces; do not couple the command to private test helpers or create another generalized orchestration framework. Delete redundant aliases/wrappers/soak variants only after mapping them to the retained workflow or an explicit opt-in lane. Preserve `pnpm test:composition` and `pnpm test:characterization` as clearly labelled opt-in commands; document that their shared composition-characterization implementation owns the 10k scenario, and ensure the normal smoke never invokes either.

## Retained behaviour and non-goals

Retain meaningful health checks, bounded load evidence, dashboard delivery verification, and separately valuable recovery/compose/10k coverage. Do not weaken runtime checks into package-text assertions, fold composition into ordinary smoke, or make broad deployment/Compose changes.

## Acceptance

- [ ] One documented routine workflow covers health, SSE/projection, and representative bounded load.
- [ ] Its inputs, timeout/bounds, and expected output make failures actionable.
- [ ] Redundant scripts, wrappers, meta-tests, and docs are removed or mapped to a distinct retained purpose.
- [ ] Composition and 10k characterization remain explicit opt-in lanes and are not run by normal smoke.
- [ ] No new command graph or generic harness remains alongside the old one.

## Focused verification

Run the retained runtime smoke in the available local environment, plus affected script/unit tests and lint/type checks for changed script code. If services are unavailable, record the exact prerequisite failure. Do not run composition or characterization absent explicit authorization.

## Working record

Pending — command inventory, consolidation, deletions, and focused verification remain to be recorded.
