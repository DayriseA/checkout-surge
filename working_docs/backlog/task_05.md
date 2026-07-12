# Task 05: Fence all run lifecycle transitions with compare-and-set (late start acknowledgement can resurrect a terminal run)

## Execution context

- **Execution order:** This is task 5 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P0
- **Area:** API / run lifecycle
- **Source:** independent review (high)
- **Solved elsewhere:** none — shared defect; Opus can regress a fast completion back to active, and GLM refuses a fast completion and never replays it. Fix is well-understood: expected-status predicates on every transition write.
- **Locations:** `apps/api/src/services/demo-run-service.ts:827`, `apps/api/src/services/demo-run-service.ts:628`, `apps/load-orchestrator/src/application/k6-runner.ts:63`

A short run can complete — or an admin can reset — while `startRun()` still awaits the orchestrator; the late acknowledgement then updates the run by ID with no expected-status predicate, writing `active` over a draining or terminal state. The resurrected run keeps its terminal timestamps and immutable summary, the finalizer ignores it, and future starts stay blocked. Implement compare-and-set transitions across the lifecycle (this is the umbrella fix; entries 6 and 9 depend on the same fence).

## Implementation record

- **Status:** Implemented the focused activation fence and race coverage.
- **Completed scope:** `DemoRunService.updateRunAfterTrafficStart()` now performs a `starting -> active` compare-and-set. If the predicate loses to completion, finalization, or reset, it reads and returns the authoritative persisted run instead of resurrecting it. Added integration-level delayed orchestrator acknowledgement races against fast traffic completion and admin reset, covering returned responses and persisted terminal/draining state and summaries.
- **Decisions/deviations:** Existing completion and terminal transitions already use expected-status predicates and were left unchanged. Reset sequencing, run-store refactoring, and durable completion delivery remain out of scope.
- **Verification:** `pnpm --filter api exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.api.config.ts test/demo-run-service.test.ts` (25 passed); `pnpm --filter api type-check` (passed); `pnpm exec biome check apps/api/src/services/demo-run-service.ts apps/api/test/demo-run-service.test.ts` (passed); `git diff --check` (passed). Test infrastructure was started with `pnpm test:infra:up` because the focused API suite requires PostgreSQL/Redis.
- **Blockers/follow-ups:** None known. The prohibited composition and characterization suites were not run.
