# Task 81: Compute the smoke's budget-cleanup window at consumption time

## Execution context

- **Execution order:** This is task 81 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P4 (hardening note)
- **Area:** smoke tooling
- **Source:** independent review (note)
- **Locations:** `scripts/runtime-smoke-load.mjs:10`, `scripts/runtime-smoke-load.mjs:226`

The smoke computes its budget window at process start while the API consumes the current window later; crossing a window boundary makes cleanup decrement earlier keys, possibly reducing other visitors' shared count. Narrow window; fix opportunistically with entry 32.

## Implementation record

- **Status:** Complete; superseded by Task 32's removal of the hazardous smoke-owned cleanup path.
- **Audit conclusion:** `scripts/runtime-smoke-load.mjs` no longer calculates a public-budget window and contains no direct Redis, SQL, Docker, or public-budget key mutation. It starts through the public dashboard path and cleans up only the captured run through the protected `DELETE /admin/demo/runs/:runId` targeted teardown. That teardown owns the run's durable graph, run-scoped Redis namespaces, and attributed queue jobs; it does not release an accepted public-start budget reservation.
- **Current budget behavior:** `RedisPublicRunBudgetStore.reserve()` calculates the fixed-window namespace from the API's reservation-time `now` and returns the exact global, visitor, and unique reservation keys used by the atomic increment. If a later synchronous start step rejects or fails, `DemoRunService.startRun()` passes that unchanged reservation object to the store's idempotent release script, which first deletes the unique marker and then decrements only those exact global/visitor keys. A successful accepted start deliberately does not call `release()`, so the smoke consumes one visitor/global start-budget reservation until expiry. Restoring a smoke-side cleanup-window calculation would reintroduce cross-window and cross-visitor mutation risk and is explicitly not part of the solution.
- **Existing proof:** `apps/api/test/demo-run-service.test.ts` covers exact-once compensation after an accepted-start failure, preservation of the primary failure when compensation fails, retention after a successful accepted response, visitor/global enforcement, concurrent limiting, idempotent release, and release of an old reservation without changing the next window. `scripts/runtime-smoke-load.test.mjs` covers exact-run cleanup preparation, bodyless protected teardown/retry, response identity, and primary-error preservation. `README.md` and `docs/local_development.md` already document that `runtime:smoke:load` consumes the accepted start's visitor/global reservation until expiry and that exact-run teardown does not release it; no documentation correction was needed.
- **Verification:** `pnpm --filter @checkout-surge/contracts build && node --test scripts/runtime-smoke-load.test.mjs` passed 13/13. From `apps/api`, `pnpm --filter api exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.api.config.ts test/demo-run-service.test.ts -t 'releases exactly once after a reserved acceptance failure and retains successful reservations|preserves the primary failure and logs safe metadata when compensation fails|retains the public budget reservation after a successful accepted response|enforces updated public run-budget windows through Redis|atomically enforces concurrent budgets and exact-window idempotent release'` was attempted, but all five selected tests stopped in fixture setup because the isolated PostgreSQL endpoint at `localhost:56432` was unavailable (`ECONNREFUSED`); no assertion executed. `git diff --check` and scoped documentation formatting/diff inspection passed. The prohibited composition and characterization suites were not run. No live runtime smoke, broad application suite, or unrelated heavy suite was run because this task makes no runtime or test-code change and the focused script proof is green.
- **Remaining blockers/follow-up:** None. No production, test, README, or `docs/` file changed for Task 81.
