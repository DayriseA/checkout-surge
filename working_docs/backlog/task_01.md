# Task 01: Add an automated cross-service composition test (and the frozen-behavior characterization suite)

## Execution context

- **Execution order:** This is task 1 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P3 — placed first: the safety net for the whole P0 tier
- **Area:** test strategy
- **Source:** independent review (medium)
- **Solved elsewhere:** none — a gap shared with Opus. The consolidation plan specifies the characterization scope: a representative 10k surge, sold-out-only traffic, duplicate/idempotent attempts, the active→draining→completed lifecycle, durable terminal summary plus history detail, and browser recovery after reconnect and finalization.
- **Locations:** `package.json:20`, `apps/api/test/api.test.ts:1932`, `apps/worker/test/integration/order-processing-workflow.test.ts:544`

The full test suite never starts the deployed service topology; every cross-service handoff stops at a substitute (API/BullMQ with no worker, worker with mocked ERP, web smoke with stubbed reads). Wrong compose URLs, tokens, or wiring break the demo while the suite stays green. This suite is also the safety net for the P0 spine work, which is why it leads the backlog.

## Working record

- **Status:** completed
- **Completed scope:** Added an isolated deployed-topology composition characterization that starts PostgreSQL, Redis, API, worker, mock ERP, load orchestrator, web, and dashboard proxy from the current checkout. It verifies health and wiring, same-origin SSE connect/disconnect/reconnect, a deterministic sold-out-only run, a duplicate idempotent replay, the active → draining → completed lifecycle, worker/ERP/notification handoffs, terminal summary and detailed history, post-finalization browser recovery through Run History, and a representative 10,000-buyer surge.
- **Test integration:** The default `pnpm test` remains limited to unit, API, and integration tests. The slow deployed topology is intentionally opt-in through `pnpm test:composition`; `pnpm test:characterization` runs the focused browser workflow suite followed by that topology. Both topology commands require a functioning Docker daemon and must not be run by agents unless explicitly requested. Composition state uses a unique Compose project and volumes and is removed in a `finally` path by default.
- **Material decisions:** Normal runtime host ports are parameterized without changing their defaults so the isolated topology can use non-conflicting ports. The 10k scenario retains 10,000 simultaneous buyers but gives constrained hosts a longer completion grace window. Fully delivered runs must preserve the exact 1,000 accepted / 9,000 sold-out result; hosts that drop k6 iterations must still account for all planned iterations and prove invariant consistency across HTTP outcomes, inventory, worker/ERP processing, notifications, and history. Post-finalization dashboard recovery is characterized as clearing `currentRun`; the completed run is recovered through Run History.
- **Non-goals preserved:** No production route, workflow, persistence, contract, worker, or browser behavior was changed.
- **Verification:** `pnpm build:shared`; focused `apps/web/test/browser-workflows.test.ts` (6 tests passed); `pnpm test:composition` equivalent direct invocation (passed, including the real 10k scenario); Biome checks for changed JSON/JavaScript; `docker compose config --quiet`; `node --check scripts/composition-characterization.mjs`; `git diff --check`.
- **Remaining follow-up:** None for this task. The original backlog wording implied placing composition coverage in the default full suite; this was deliberately corrected because its runtime cost would impede routine development and agent work. With no CI/CD planned, developers run the opt-in topology suite when they deem it necessary. The full root unit/API/integration stages were not rerun because their implementation boundaries were unchanged; the new focused browser and composition stages were run directly.
